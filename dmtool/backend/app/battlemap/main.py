import asyncio
import base64
import json
import math
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import internal
from . import kb, live, spells, tracker, vision
from .common import APP_DIR, setup_common
from .db import (
    BEAMER_IMG_DIR, IMAGE_EXTS, MAP_DIR, TOKEN_DIR, current_campaign, get_conn, get_settings, row_to_dict,
    set_setting,
)
from ..i18n import t as _t

app = FastAPI(title="Wyrmdesk – Battlemap")


# ---------- schemas ----------

class SceneIn(BaseModel):
    name: str


class CampaignChoice(BaseModel):
    campaign_id: int


class ScenePatch(BaseModel):
    name: Optional[str] = None
    campaign_id: Optional[int] = None  # assign a scene (one without a campaign) to one
    grid_size: Optional[float] = None
    grid_ox: Optional[float] = None
    grid_oy: Optional[float] = None
    show_grid: Optional[bool] = None
    fog_enabled: Optional[bool] = None
    view_x: Optional[float] = None
    view_y: Optional[float] = None
    view_zoom: Optional[float] = None
    vision_enabled: Optional[bool] = None


class WallIn(BaseModel):
    a: list[float]
    b: list[float]
    kind: str = "wall"  # wall | door


class WallsIn(BaseModel):
    segments: list[WallIn]


class FogOp(BaseModel):
    mode: str  # reveal | hide
    shape: str  # rect | poly | brush | all
    points: list[list[float]] = []
    radius: float = 0


class AreaIn(BaseModel):
    name: str
    points: list[list[float]]


TEMPLATE_SHAPES = {"cone", "circle", "square", "line"}


class TemplateIn(BaseModel):
    shape: str  # cone (quarter circle) | circle | square | line
    x: float
    y: float
    size: float = 20  # feet: cone and line length, circle radius, square side
    width: float = 5  # feet, lines only
    angle: float = 0  # radians; cones and lines turn around (x, y)
    on_player: bool = True
    label: Optional[str] = None  # spell name, shown to the DM only


class TemplatePatch(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    size: Optional[float] = None
    width: Optional[float] = None
    angle: Optional[float] = None
    on_player: Optional[bool] = None


class TokenIn(BaseModel):
    name: str
    x: float
    y: float
    size: float = 1
    color: str = "#c0392b"
    image: Optional[str] = None
    combatant_id: Optional[int] = None
    on_player: bool = True
    vision: bool = False


class TokenPatch(BaseModel):
    name: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    size: Optional[float] = None
    color: Optional[str] = None
    image: Optional[str] = None
    combatant_id: Optional[int] = None
    on_player: Optional[bool] = None


class SettingsPatch(BaseModel):
    active_scene_id: Optional[int] = None
    active_beamer_image_id: Optional[int] = None
    blackout: Optional[bool] = None
    calibrate: Optional[bool] = None
    ppi: Optional[float] = None
    rotation: Optional[int] = None
    keystone: Optional[list[list[float]]] = None
    reset_keystone: bool = False
    tracker_strip: Optional[bool] = None
    tracker_strip_px: Optional[int] = None
    handout_overlay: Optional[bool] = None


class BeamerImagePatch(BaseModel):
    name: str


# ---------- helpers ----------

def _scene_or_404(conn, scene_id: int) -> dict:
    scene = live.scene_detail(conn, scene_id)
    if scene is None:
        raise HTTPException(404, "scene not found")
    return scene


def _save_fog(conn, scene_id: int, ops: list) -> None:
    conn.execute("UPDATE scenes SET fog_ops = ? WHERE id = ?", (json.dumps(ops), scene_id))


def _drop_fog_base(conn, scene: dict) -> None:
    """Forget the flattened fog image, e.g. once a fill of the whole map covers it."""
    if scene["fog_base"]:
        conn.execute("UPDATE scenes SET fog_base = NULL WHERE id = ?", (scene["id"],))
        (MAP_DIR / scene["fog_base"]).unlink(missing_ok=True)


def _image_ext(filename: str) -> str:
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    if ext not in IMAGE_EXTS:
        raise HTTPException(400, f"unsupported image type: {ext}")
    return ext


def _save_walls(conn, scene_id: int, walls: list) -> None:
    conn.execute("UPDATE scenes SET walls = ? WHERE id = ?", (json.dumps(walls), scene_id))


async def update_vision(scene_id: int, force: bool = False) -> None:
    """Recompute line of sight for the scene's vision tokens and reveal what they see.

    Newly seen ground is appended to the fog as a reveal op, so explored areas stay
    open after the viewpoint moves on. `force` re-reveals the current view even if it
    didn't change (after the fog was reset).
    """
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if row is None:
            return
        viewers = conn.execute(
            "SELECT id, x, y FROM tokens WHERE scene_id = ? AND vision = 1 ORDER BY id", (scene_id,)
        ).fetchall()
        if not row["vision_enabled"] or not viewers or not row["map_w"]:
            conn.execute("UPDATE scenes SET vision_polys = '[]' WHERE id = ?", (scene_id,))
            return
        segments = vision.blocking_segments(json.loads(row["walls"]))
        old = {p["token_id"]: p["points"] for p in json.loads(row["vision_polys"])}
        width, height = row["map_w"], row["map_h"]
        tolerance = max(1.0, row["grid_size"] / 50)
        viewers = [(v["id"], v["x"], v["y"]) for v in viewers]

    def compute():
        return [{"token_id": vid, "points": vision.visibility_polygon((x, y), segments, width, height, tolerance)}
                for vid, x, y in viewers]

    polys = await asyncio.to_thread(compute)
    with get_conn() as conn:
        row = conn.execute("SELECT fog_ops FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        if row is None:
            return
        ops = json.loads(row["fog_ops"])
        for p in polys:
            if len(p["points"]) >= 3 and (force or old.get(p["token_id"]) != p["points"]):
                ops.append({"mode": "reveal", "shape": "poly", "points": p["points"], "radius": 0, "source": "vision"})
        conn.execute("UPDATE scenes SET vision_polys = ?, fog_ops = ? WHERE id = ?",
                     (json.dumps(polys), json.dumps(ops), scene_id))


def _token_is_viewer(conn, token_id: int) -> bool:
    row = conn.execute("SELECT vision FROM tokens WHERE id = ?", (token_id,)).fetchone()
    return bool(row and row["vision"])


# ---------- scenes ----------

@app.get("/api/scenes")
def list_scenes():
    with get_conn() as conn:
        return live.scene_list(conn)


# ---------- campaign: the Kampagnenbuch's choice, the same in all three parts ----------

@app.get("/api/campaigns")
def list_campaigns_here():
    with get_conn() as conn:
        rows = conn.execute("SELECT id, name FROM campaigns ORDER BY id").fetchall()
        return {"campaigns": [row_to_dict(r) for r in rows], "current": current_campaign(conn)}


@app.put("/api/campaign")
async def choose_campaign(body: CampaignChoice):
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM campaigns WHERE id = ?", (body.campaign_id,)).fetchone() is None:
            raise HTTPException(404, "campaign not found")
        conn.execute("INSERT INTO app_settings (key, value) VALUES ('campaign_id', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(body.campaign_id),))
    internal.campaign_changed()
    return {"ok": True}


@app.post("/api/scenes")
async def create_scene(body: SceneIn):
    with get_conn() as conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM scenes").fetchone()["n"]
        scene_id = conn.execute(
            "INSERT INTO scenes (name, sort_order, campaign_id) VALUES (?, ?, ?)",
            (body.name, order, current_campaign(conn))
        ).lastrowid
        scene = live.scene_detail(conn, scene_id)
    await live.notify(scenes=True)
    return scene


@app.get("/api/scenes/{scene_id}")
def get_scene(scene_id: int):
    with get_conn() as conn:
        return _scene_or_404(conn, scene_id)


@app.patch("/api/scenes/{scene_id}")
async def patch_scene(scene_id: int, body: ScenePatch):
    fields = body.model_dump(exclude_none=True)
    with get_conn() as conn:
        _scene_or_404(conn, scene_id)
        if "view_zoom" in fields:
            fields["view_zoom"] = min(8.0, max(0.05, fields["view_zoom"]))
        for key, value in fields.items():
            conn.execute(f"UPDATE scenes SET {key} = ? WHERE id = ?", (value, scene_id))
    if "vision_enabled" in fields:
        await update_vision(scene_id, force=True)
    await live.notify(scene_id=scene_id, scenes="name" in fields or "campaign_id" in fields)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}")
async def delete_scene(scene_id: int):
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        conn.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
        if get_settings(conn)["active_scene_id"] == scene_id:
            set_setting(conn, "active_scene_id", None)
    for name in (scene["map_file"], scene["fog_base"]):
        if name:
            (MAP_DIR / name).unlink(missing_ok=True)
    await live.notify(scenes=True, settings=True)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/map")
async def upload_map(scene_id: int, filename: str, width: int, height: int, request: Request):
    ext = _image_ext(filename)
    body = await request.body()
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        # A fresh name per upload, so browsers never show a cached older map.
        dest = MAP_DIR / f"scene-{scene_id}-{uuid4().hex[:8]}.{ext}"
        dest.write_bytes(body)
        conn.execute(
            "UPDATE scenes SET map_file = ?, map_w = ?, map_h = ?, view_x = ?, view_y = ? WHERE id = ?",
            (dest.name, width, height, width / 2, height / 2, scene_id),
        )
        if (width, height) != (scene["map_w"], scene["map_h"]):
            # The fog image is sized to the old map; its ops stay, they are in map pixels.
            _drop_fog_base(conn, scene)
    if scene["map_file"]:
        (MAP_DIR / scene["map_file"]).unlink(missing_ok=True)
    await update_vision(scene_id, force=True)
    await live.notify(scene_id=scene_id, scenes=True)
    return {"ok": True}


def _sniff_image_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    raise HTTPException(400, "Unbekanntes Bildformat in der .dd2vtt-Datei.")


@app.post("/api/scenes/import-uvtt")
async def import_uvtt(filename: str, request: Request):
    """New scene from a Universal VTT export (Dungeondraft .dd2vtt): map image, grid, walls and doors."""
    try:
        data = json.loads(await request.body())
        res = data["resolution"]
        ppg = float(res["pixels_per_grid"])
        origin = res.get("map_origin") or {"x": 0, "y": 0}
        size = res["map_size"]
        image = base64.b64decode(data["image"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, _t("Keine gültige .dd2vtt/.uvtt-Datei."))
    ext = _sniff_image_ext(image)
    width, height = round(size["x"] * ppg), round(size["y"] * ppg)

    def px(p):
        # UVTT coordinates are in grid units from the map origin.
        return [round((p["x"] - origin["x"]) * ppg, 1), round((p["y"] - origin["y"]) * ppg, 1)]

    walls = []
    for line in (data.get("line_of_sight") or []) + (data.get("objects_line_of_sight") or []):
        for p, q in zip(line, line[1:]):
            walls.append({"id": uuid4().hex[:8], "a": px(p), "b": px(q), "kind": "wall", "open": False})
    for portal in data.get("portals") or []:
        bounds = portal.get("bounds") or []
        if len(bounds) == 2:
            walls.append({"id": uuid4().hex[:8], "a": px(bounds[0]), "b": px(bounds[1]), "kind": "door",
                          "open": not portal.get("closed", True)})

    name = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ") or "Dungeondraft-Karte"
    with get_conn() as conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM scenes").fetchone()["n"]
        scene_id = conn.execute(
            "INSERT INTO scenes (name, sort_order, map_w, map_h, grid_size, view_x, view_y, walls, vision_enabled, "
            "campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (name, order, width, height, ppg, width / 2, height / 2, json.dumps(walls), 1 if walls else 0,
             current_campaign(conn)),
        ).lastrowid
        dest = MAP_DIR / f"scene-{scene_id}-{uuid4().hex[:8]}.{ext}"
        dest.write_bytes(image)
        conn.execute("UPDATE scenes SET map_file = ? WHERE id = ?", (dest.name, scene_id))
    await live.notify(scenes=True)
    return {"id": scene_id, "walls": sum(w["kind"] == "wall" for w in walls),
            "doors": sum(w["kind"] == "door" for w in walls)}


# ---------- walls and doors ----------

@app.post("/api/scenes/{scene_id}/walls")
async def add_walls(scene_id: int, body: WallsIn):
    with get_conn() as conn:
        walls = _scene_or_404(conn, scene_id)["walls"]
        for s in body.segments:
            walls.append({"id": uuid4().hex[:8], "a": s.a, "b": s.b, "kind": s.kind, "open": False})
        _save_walls(conn, scene_id, walls)
    await update_vision(scene_id)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}/walls")
async def clear_walls(scene_id: int):
    with get_conn() as conn:
        _scene_or_404(conn, scene_id)
        _save_walls(conn, scene_id, [])
    await update_vision(scene_id)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}/walls/{wall_id}")
async def delete_wall(scene_id: int, wall_id: str):
    with get_conn() as conn:
        walls = [w for w in _scene_or_404(conn, scene_id)["walls"] if w["id"] != wall_id]
        _save_walls(conn, scene_id, walls)
    await update_vision(scene_id)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/walls/{wall_id}/toggle")
async def toggle_door(scene_id: int, wall_id: str):
    with get_conn() as conn:
        walls = _scene_or_404(conn, scene_id)["walls"]
        door = next((w for w in walls if w["id"] == wall_id and w["kind"] == "door"), None)
        if door is None:
            raise HTTPException(404, "door not found")
        door["open"] = not door.get("open")
        _save_walls(conn, scene_id, walls)
    await update_vision(scene_id)
    await live.notify(scene_id=scene_id)
    return {"open": door["open"]}


# ---------- fog of war ----------

@app.post("/api/scenes/{scene_id}/fog")
async def add_fog_op(scene_id: int, op: FogOp):
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        ops = scene["fog_ops"]
        if op.shape == "all":
            # Covers everything below it, so older ops and the fog image are dead weight.
            ops = []
            _drop_fog_base(conn, scene)
        ops.append(op.model_dump())
        _save_fog(conn, scene_id, ops)
    if op.shape == "all" and op.mode == "hide":
        # Whatever the vision tokens see right now stays open.
        await update_vision(scene_id, force=True)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/fog/compact")
async def compact_fog(scene_id: int, count: int, base: str, request: Request):
    """Replace the first `count` fog ops by a mask image the DM view drew from them.

    Vision tokens add an op with every step, and the whole list goes to every view on
    each change, so long explorations would slow everything down. `base` is the fog
    image the mask was drawn on; if the fog changed underneath meanwhile, nothing happens.
    """
    data = await request.body()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(400, "Das Fog-Bild muss ein PNG sein.")
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        if (scene["fog_base"] or "") != base or not 0 < count <= len(scene["fog_ops"]):
            raise HTTPException(409, _t("Der Fog hat sich inzwischen geändert."))
        dest = MAP_DIR / f"fog-{scene_id}-{uuid4().hex[:8]}.png"
        dest.write_bytes(data)
        conn.execute("UPDATE scenes SET fog_base = ?, fog_ops = ? WHERE id = ?",
                     (dest.name, json.dumps(scene["fog_ops"][count:]), scene_id))
    if scene["fog_base"]:
        (MAP_DIR / scene["fog_base"]).unlink(missing_ok=True)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/fog/undo")
async def undo_fog(scene_id: int):
    with get_conn() as conn:
        ops = _scene_or_404(conn, scene_id)["fog_ops"]
        if ops:
            ops.pop()
        _save_fog(conn, scene_id, ops)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/areas")
async def add_area(scene_id: int, body: AreaIn):
    with get_conn() as conn:
        areas = _scene_or_404(conn, scene_id)["areas"]
        areas.append({"id": uuid4().hex[:8], "name": body.name, "points": body.points})
        conn.execute("UPDATE scenes SET areas = ? WHERE id = ?", (json.dumps(areas), scene_id))
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}/areas/{area_id}")
async def delete_area(scene_id: int, area_id: str):
    with get_conn() as conn:
        areas = [a for a in _scene_or_404(conn, scene_id)["areas"] if a["id"] != area_id]
        conn.execute("UPDATE scenes SET areas = ? WHERE id = ?", (json.dumps(areas), scene_id))
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.post("/api/scenes/{scene_id}/areas/{area_id}/reveal")
async def reveal_area(scene_id: int, area_id: str):
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        area = next((a for a in scene["areas"] if a["id"] == area_id), None)
        if area is None:
            raise HTTPException(404, "area not found")
        ops = scene["fog_ops"] + [{"mode": "reveal", "shape": "poly", "points": area["points"], "radius": 0}]
        _save_fog(conn, scene_id, ops)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


# ---------- spell areas ----------

def _save_templates(conn, scene_id: int, templates: list) -> None:
    conn.execute("UPDATE scenes SET templates = ? WHERE id = ?", (json.dumps(templates), scene_id))


def _check_template_size(fields: dict) -> None:
    for key in ("size", "width"):
        if fields.get(key) is not None and not 0 < fields[key] <= 1000:
            raise HTTPException(400, _t("Grösse und Breite müssen zwischen 0 und 1000 ft liegen."))


@app.post("/api/scenes/{scene_id}/templates")
async def add_template(scene_id: int, body: TemplateIn):
    if body.shape not in TEMPLATE_SHAPES:
        raise HTTPException(400, f"unknown shape: {body.shape}")
    _check_template_size(body.model_dump())
    template = {"id": uuid4().hex[:8], **body.model_dump()}
    with get_conn() as conn:
        templates = _scene_or_404(conn, scene_id)["templates"]
        templates.append(template)
        _save_templates(conn, scene_id, templates)
    await live.notify(scene_id=scene_id)
    return template


@app.patch("/api/scenes/{scene_id}/templates/{template_id}")
async def patch_template(scene_id: int, template_id: str, body: TemplatePatch):
    fields = body.model_dump(exclude_none=True)
    _check_template_size(fields)
    with get_conn() as conn:
        templates = _scene_or_404(conn, scene_id)["templates"]
        template = next((t for t in templates if t["id"] == template_id), None)
        if template is None:
            raise HTTPException(404, "template not found")
        template.update(fields)
        _save_templates(conn, scene_id, templates)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}/templates/{template_id}")
async def delete_template(scene_id: int, template_id: str):
    with get_conn() as conn:
        templates = [t for t in _scene_or_404(conn, scene_id)["templates"] if t["id"] != template_id]
        _save_templates(conn, scene_id, templates)
    await live.notify(scene_id=scene_id)
    return {"ok": True}


@app.delete("/api/scenes/{scene_id}/templates")
async def clear_templates(scene_id: int):
    with get_conn() as conn:
        _scene_or_404(conn, scene_id)
        _save_templates(conn, scene_id, [])
    await live.notify(scene_id=scene_id)
    return {"ok": True}


# ---------- tokens ----------

@app.post("/api/scenes/{scene_id}/tokens")
async def create_token(scene_id: int, body: TokenIn):
    with get_conn() as conn:
        _scene_or_404(conn, scene_id)
        token_id = conn.execute(
            "INSERT INTO tokens (scene_id, name, x, y, size, color, image, combatant_id, on_player, vision) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (scene_id, body.name, body.x, body.y, body.size, body.color, body.image,
             body.combatant_id, 0 if body.vision else int(body.on_player), int(body.vision)),
        ).lastrowid
        token = row_to_dict(conn.execute("SELECT * FROM tokens WHERE id = ?", (token_id,)).fetchone())
    if body.vision:
        await update_vision(scene_id)
    await live.notify(scene_id=scene_id)
    return token


@app.post("/api/scenes/{scene_id}/tokens/from-tracker")
async def tokens_from_tracker(scene_id: int):
    """One token per combatant in the tracker's displayed encounter that has none here yet."""
    with get_conn() as conn:
        scene = _scene_or_404(conn, scene_id)
        linked = {t["combatant_id"] for t in scene["tokens"]}
        missing = [c for c in tracker.state["combatants"] if c["id"] not in linked]
        g = scene["grid_size"]
        # Lay them out in a row around the player viewport centre, snapped to cell centres.
        cols = max(1, math.ceil(math.sqrt(len(missing))))
        for i, c in enumerate(missing):
            col, row = i % cols, i // cols
            x = scene["grid_ox"] + (math.floor((scene["view_x"] - scene["grid_ox"]) / g) + col + 0.5) * g
            y = scene["grid_oy"] + (math.floor((scene["view_y"] - scene["grid_oy"]) / g) + row + 0.5) * g
            conn.execute(
                "INSERT INTO tokens (scene_id, name, x, y, color, image, combatant_id, on_player) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (scene_id, c["name"], x, y, "#2e86c1" if c["kind"] == "pc" else "#c0392b", c["avatar"], c["id"],
                 # PCs usually stand on the table as miniatures.
                 0 if c["kind"] == "pc" else 1),
            )
    await live.notify(scene_id=scene_id)
    return {"added": len(missing)}


@app.delete("/api/scenes/{scene_id}/tokens")
async def clear_tokens(scene_id: int):
    """Remove every token of the scene; sight points (vision tokens) stay."""
    with get_conn() as conn:
        _scene_or_404(conn, scene_id)
        removed = conn.execute("DELETE FROM tokens WHERE scene_id = ? AND vision = 0", (scene_id,)).rowcount
    await live.notify(scene_id=scene_id)
    return {"removed": removed}


@app.patch("/api/tokens/{token_id}")
async def patch_token(token_id: int, body: TokenPatch):
    fields = body.model_dump(exclude_unset=True)
    with get_conn() as conn:
        row = conn.execute("SELECT scene_id FROM tokens WHERE id = ?", (token_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "token not found")
        for key, value in fields.items():
            if key == "on_player":
                value = int(value)
            conn.execute(f"UPDATE tokens SET {key} = ? WHERE id = ?", (value, token_id))
        viewer = _token_is_viewer(conn, token_id)
    if viewer and ("x" in fields or "y" in fields):
        await update_vision(row["scene_id"])
    await live.notify(scene_id=row["scene_id"])
    return {"ok": True}


@app.delete("/api/tokens/{token_id}")
async def delete_token(token_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT scene_id, vision FROM tokens WHERE id = ?", (token_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "token not found")
        conn.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
    if row["vision"]:
        await update_vision(row["scene_id"])
    await live.notify(scene_id=row["scene_id"])
    return {"ok": True}


@app.post("/api/token-images")
async def upload_token_image(filename: str, request: Request):
    ext = _image_ext(filename)
    dest = TOKEN_DIR / f"{uuid4().hex[:12]}.{ext}"
    dest.write_bytes(await request.body())
    return {"url": f"/tokens/{dest.name}"}


# ---------- beamer images (shown instead of the battlemap) ----------

@app.get("/api/beamer-images")
def list_beamer_images():
    with get_conn() as conn:
        return live.beamer_image_list(conn)


@app.post("/api/beamer-images")
async def upload_beamer_image(filename: str, name: str, request: Request):
    ext = _image_ext(filename)
    body = await request.body()
    with get_conn() as conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM beamer_images").fetchone()["n"]
        dest = BEAMER_IMG_DIR / f"{uuid4().hex[:12]}.{ext}"
        dest.write_bytes(body)
        image_id = conn.execute(
            "INSERT INTO beamer_images (name, file, sort_order) VALUES (?, ?, ?)",
            (name or filename, dest.name, order),
        ).lastrowid
    await live.notify(images=True)
    return {"id": image_id, "name": name or filename, "url": f"/beamer-images/{dest.name}"}


@app.patch("/api/beamer-images/{image_id}")
async def rename_beamer_image(image_id: int, body: BeamerImagePatch):
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM beamer_images WHERE id = ?", (image_id,)).fetchone() is None:
            raise HTTPException(404, "image not found")
        conn.execute("UPDATE beamer_images SET name = ? WHERE id = ?", (body.name, image_id))
    await live.notify(images=True)
    return {"ok": True}


@app.delete("/api/beamer-images/{image_id}")
async def delete_beamer_image(image_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT file FROM beamer_images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "image not found")
        conn.execute("DELETE FROM beamer_images WHERE id = ?", (image_id,))
        was_active = get_settings(conn)["active_beamer_image_id"] == image_id
        if was_active:
            set_setting(conn, "active_beamer_image_id", None)
    (BEAMER_IMG_DIR / row["file"]).unlink(missing_ok=True)
    await live.notify(images=True, settings=was_active)
    return {"ok": True}


# ---------- table setup ----------

@app.get("/api/settings")
def read_settings():
    with get_conn() as conn:
        return get_settings(conn)


@app.patch("/api/settings")
async def patch_settings(body: SettingsPatch):
    fields = body.model_dump(exclude_unset=True)
    with get_conn() as conn:
        if fields.pop("reset_keystone", False):
            set_setting(conn, "keystone", None)
        if "rotation" in fields:
            fields["rotation"] = fields["rotation"] % 360
        if fields.get("active_beamer_image_id") is not None:
            if conn.execute(
                "SELECT 1 FROM beamer_images WHERE id = ?", (fields["active_beamer_image_id"],)
            ).fetchone() is None:
                raise HTTPException(404, "image not found")
        for key, value in fields.items():
            set_setting(conn, key, value)
    await live.notify(settings=True)
    return {"ok": True}


@app.get("/api/tracker")
def tracker_state():
    return tracker.state


class TrackerCombatantPatch(BaseModel):
    current_hp: Optional[int] = None
    hp_delta: Optional[int] = None
    temp_hp_delta: Optional[int] = None
    initiative: Optional[int] = None
    status_effects: Optional[list[str]] = None
    is_hidden: Optional[bool] = None
    is_boss: Optional[bool] = None


# The tracker's remote actions work on its displayed encounter and make its own DM view follow.
TRACKER_TURN_ACTIONS = {"next": "next-turn", "prev": "prev-turn", "roll-initiative": "roll-monster-initiative"}


async def _tracker_call(method: str, path: str, body: dict | None = None) -> dict:
    try:
        return await tracker.call(method, path, body)
    except tracker.TrackerError as err:
        raise HTTPException(err.status, err.detail)


def _tracker_encounter_id() -> int:
    encounter_id = tracker.state.get("encounter_id")
    if encounter_id is None:
        raise HTTPException(409, "Im Tracker ist kein Encounter in der Anzeige.")
    return encounter_id


@app.post("/api/tracker/turn/{action}")
async def tracker_turn(action: str):
    if action not in TRACKER_TURN_ACTIONS:
        raise HTTPException(404, "unknown action")
    return await _tracker_call("POST", f"/api/remote/{TRACKER_TURN_ACTIONS[action]}")


@app.get("/api/spells")
async def search_spells(q: str):
    """Spells from the tracker's library whose name contains q, each with the area read from its text."""
    try:
        return await spells.search(q)
    except tracker.TrackerError as err:
        raise HTTPException(err.status, err.detail)


@app.get("/api/tracker/encounters")
async def tracker_encounters():
    try:
        campaigns = (await kb.call("GET", "/api/campaigns"))["campaigns"]
        return await tracker.encounters(campaigns)
    except tracker.TrackerError as err:
        raise HTTPException(err.status, err.detail)


class TrackerEncounterIn(BaseModel):
    encounter_id: int


@app.put("/api/tracker/encounter")
async def tracker_show_encounter(body: TrackerEncounterIn):
    """Switch the tracker's displayed encounter; its DM view follows. Tokens are not touched."""
    return await _tracker_call("POST", f"/api/remote/show-encounter/{body.encounter_id}")


@app.post("/api/tracker/reset")
async def tracker_reset():
    return await _tracker_call("POST", f"/api/encounters/{_tracker_encounter_id()}/reset")


@app.patch("/api/tracker/combatants/{combatant_id}")
async def tracker_patch_combatant(combatant_id: int, body: TrackerCombatantPatch):
    fields = body.model_dump(exclude_none=True)
    return await _tracker_call("PATCH", f"/api/encounters/{_tracker_encounter_id()}/combatants/{combatant_id}", fields)


# ---------- remote control (Elgato Stream Deck webhooks) ----------
# Same convention as the combat tracker: plain HTTP, every action accepts GET and POST,
# and all actions work on the scene currently shown on the beamer.

def _active_scene(conn) -> dict:
    scene_id = get_settings(conn)["active_scene_id"]
    scene = live.scene_detail(conn, scene_id) if scene_id is not None else None
    if scene is None:
        raise HTTPException(409, "Keine Szene auf dem Beamer. In der DM-Ansicht eine Szene anzeigen.")
    return scene


def _set_view(conn, scene: dict, x: float, y: float, zoom: Optional[float] = None) -> None:
    x = min(max(x, 0), scene["map_w"])
    y = min(max(y, 0), scene["map_h"])
    zoom = scene["view_zoom"] if zoom is None else min(8.0, max(0.05, zoom))
    conn.execute("UPDATE scenes SET view_x = ?, view_y = ?, view_zoom = ? WHERE id = ?", (x, y, zoom, scene["id"]))


async def _remote_done(**extra) -> dict:
    with get_conn() as conn:
        settings = get_settings(conn)
        scene_id = settings["active_scene_id"]
        name = None
        if scene_id is not None:
            row = conn.execute("SELECT name FROM scenes WHERE id = ?", (scene_id,)).fetchone()
            name = row["name"] if row else None
    await live.notify(scene_id=scene_id, settings=True)
    return {"ok": True, "scene": name, "blackout": settings["blackout"], **extra}


@app.api_route("/api/remote/blackout", methods=["GET", "POST"])
async def remote_blackout():
    with get_conn() as conn:
        set_setting(conn, "blackout", not get_settings(conn)["blackout"])
    return await _remote_done()


@app.api_route("/api/remote/calibrate", methods=["GET", "POST"])
async def remote_calibrate():
    with get_conn() as conn:
        set_setting(conn, "calibrate", not get_settings(conn)["calibrate"])
    return await _remote_done()


@app.api_route("/api/remote/tracker-strip", methods=["GET", "POST"])
async def remote_tracker_strip():
    with get_conn() as conn:
        set_setting(conn, "tracker_strip", not get_settings(conn)["tracker_strip"])
    return await _remote_done()


@app.api_route("/api/remote/scene/{direction}", methods=["GET", "POST"])
async def remote_scene(direction: str):
    if direction not in ("next", "prev"):
        raise HTTPException(404, "direction must be next or prev")
    with get_conn() as conn:
        ids = [s["id"] for s in live.scene_list(conn)]
        if not ids:
            raise HTTPException(409, "Keine Szenen vorhanden.")
        current = get_settings(conn)["active_scene_id"]
        idx = ids.index(current) if current in ids else -1
        idx = (idx + (1 if direction == "next" else -1)) % len(ids)
        set_setting(conn, "active_scene_id", ids[idx])
    return await _remote_done()


@app.api_route("/api/remote/area/{number}", methods=["GET", "POST"])
async def remote_reveal_area(number: int):
    """Reveal the n-th area (1-based, as numbered in the DM view) of the beamer scene."""
    with get_conn() as conn:
        scene = _active_scene(conn)
        if not 1 <= number <= len(scene["areas"]):
            raise HTTPException(404, f"Bereich {number} gibt es in dieser Szene nicht.")
        area = scene["areas"][number - 1]
        _save_fog(conn, scene["id"], scene["fog_ops"] + [
            {"mode": "reveal", "shape": "poly", "points": area["points"], "radius": 0}])
    return await _remote_done(area=area["name"])


@app.api_route("/api/remote/fog/undo", methods=["GET", "POST"])
async def remote_fog_undo():
    with get_conn() as conn:
        scene = _active_scene(conn)
        _save_fog(conn, scene["id"], scene["fog_ops"][:-1])
    return await _remote_done()


@app.api_route("/api/remote/fog/toggle", methods=["GET", "POST"])
async def remote_fog_toggle():
    with get_conn() as conn:
        scene = _active_scene(conn)
        conn.execute("UPDATE scenes SET fog_enabled = ? WHERE id = ?", (0 if scene["fog_enabled"] else 1, scene["id"]))
    return await _remote_done()


@app.api_route("/api/remote/vision/toggle", methods=["GET", "POST"])
async def remote_vision_toggle():
    with get_conn() as conn:
        scene = _active_scene(conn)
        conn.execute("UPDATE scenes SET vision_enabled = ? WHERE id = ?",
                     (0 if scene["vision_enabled"] else 1, scene["id"]))
    await update_vision(scene["id"], force=True)
    return await _remote_done()


@app.api_route("/api/remote/grid/toggle", methods=["GET", "POST"])
async def remote_grid_toggle():
    with get_conn() as conn:
        scene = _active_scene(conn)
        conn.execute("UPDATE scenes SET show_grid = ? WHERE id = ?", (0 if scene["show_grid"] else 1, scene["id"]))
    return await _remote_done()


@app.api_route("/api/remote/move/{direction}", methods=["GET", "POST"])
async def remote_move(direction: str, cells: float = 5):
    """Pan the beamer view. Directions are as seen on the table, whatever the rotation."""
    screen = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}.get(direction)
    if screen is None:
        raise HTTPException(404, "direction must be up, down, left or right")
    with get_conn() as conn:
        scene = _active_scene(conn)
        rot = math.radians(get_settings(conn)["rotation"])
        # The player view draws the map rotated by +rot, so undo that to get map axes.
        dx = screen[0] * math.cos(rot) + screen[1] * math.sin(rot)
        dy = -screen[0] * math.sin(rot) + screen[1] * math.cos(rot)
        step = cells * scene["grid_size"]
        _set_view(conn, scene, scene["view_x"] + dx * step, scene["view_y"] + dy * step)
    return await _remote_done()


@app.api_route("/api/remote/zoom/{direction}", methods=["GET", "POST"])
async def remote_zoom(direction: str):
    factors = {"in": 1.25, "out": 0.8}
    with get_conn() as conn:
        scene = _active_scene(conn)
        if direction == "reset":
            zoom = 1.0
        elif direction in factors:
            zoom = scene["view_zoom"] * factors[direction]
        else:
            raise HTTPException(404, "direction must be in, out or reset")
        _set_view(conn, scene, scene["view_x"], scene["view_y"], zoom)
    return await _remote_done()


@app.api_route("/api/remote/center-current", methods=["GET", "POST"])
async def remote_center_current():
    """Centre the beamer on the token of whoever has the turn in the combat tracker."""
    current = tracker.state["current_combatant_id"]
    with get_conn() as conn:
        scene = _active_scene(conn)
        token = next((t for t in scene["tokens"] if current is not None and t["combatant_id"] == current), None)
        if token is None:
            raise HTTPException(409, _t("Kein Token für den aktiven Kämpfer in dieser Szene."))
        _set_view(conn, scene, token["x"], token["y"])
    return await _remote_done(current=token["name"])


@app.api_route("/api/remote/turn/{direction}", methods=["GET", "POST"])
async def remote_turn(direction: str):
    """Next or previous turn in the combat tracker, so one Stream Deck profile covers both tools."""
    if direction not in ("next", "prev"):
        raise HTTPException(404, "unknown direction")
    return await tracker_turn(direction)


# ---------- backup ----------

# One database for the whole Kampagnenbuch now: its backup holds the maps too (⚙ Einrichtung there).

KB_PORT = 8440


@app.get("/api/backup")
def download_backup(request: Request):
    # Inside the Kampagnenbuch (/tracker/, /map/) its own backup; at the old address the one on its port.
    if request.scope.get("root_path"):
        return RedirectResponse("/api/backup")
    return RedirectResponse(f"{request.url.scheme}://{request.url.hostname}:{KB_PORT}/api/backup")


@app.post("/api/backup/restore")
async def restore_backup():
    raise HTTPException(409, _t("Szenen und Karten sind jetzt Teil des Kampagnenbuchs: Sicherungen dort einspielen (⚙ Einrichtung im Kampagnenbuch)."))


# ---------- live updates ----------

@app.websocket("/ws")
async def dm_socket(ws: WebSocket):
    await ws.accept()
    live.dm_sockets.add(ws)
    with get_conn() as conn:
        await ws.send_text(json.dumps({"type": "settings", "settings": get_settings(conn)}))
        await ws.send_text(json.dumps({"type": "scenes", "scenes": live.scene_list(conn)}))
        await ws.send_text(json.dumps({"type": "beamer-images", "images": live.beamer_image_list(conn)}))
    await ws.send_text(json.dumps({"type": "tracker", "tracker": tracker.state}))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        live.dm_sockets.discard(ws)


setup_common(app)
app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")
