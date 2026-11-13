"""Live state: what each kind of client sees, and pushing it over WebSocket.

Both FastAPI apps (DM and player display) run in the same process and event loop
(see run.py), so one in-memory registry of sockets serves both.
"""
import json
import os

from fastapi import WebSocket

from . import tracker, vision
from .db import current_campaign, get_conn, get_settings, row_to_dict

# The Kampagnenbuch's handout display, laid over the map by the beamer browser itself.
DMTOOL_DISPLAY_URL = os.environ.get("DMTOOL_DISPLAY_URL", "").rstrip("/")
# The handout display laid over the map; run.py sets it to the same origin as the beamer.
HANDOUT_URL = f"{DMTOOL_DISPLAY_URL}/?overlay=1" if DMTOOL_DISPLAY_URL else None

dm_sockets: set[WebSocket] = set()
player_sockets: set[WebSocket] = set()


def scene_detail(conn, scene_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
    if row is None:
        return None
    scene = row_to_dict(row)
    scene["fog_ops"] = json.loads(scene["fog_ops"])
    scene["areas"] = json.loads(scene["areas"])
    scene["walls"] = json.loads(scene["walls"])
    scene["vision_polys"] = json.loads(scene["vision_polys"])
    scene["templates"] = json.loads(scene["templates"])
    scene["map_url"] = f"/maps/{scene['map_file']}" if scene["map_file"] else None
    scene["fog_base_url"] = f"/maps/{scene['fog_base']}" if scene["fog_base"] else None
    tokens = conn.execute("SELECT * FROM tokens WHERE scene_id = ? ORDER BY id", (scene_id,)).fetchall()
    scene["tokens"] = [row_to_dict(t) for t in tokens]
    return scene


def beamer_image_list(conn) -> list[dict]:
    rows = conn.execute("SELECT id, name, file FROM beamer_images ORDER BY sort_order, id").fetchall()
    return [{"id": r["id"], "name": r["name"], "url": f"/beamer-images/{r['file']}"} for r in rows]


def scene_list(conn) -> list[dict]:
    """The scenes of the campaign open in the Kampagnenbuch, and those not assigned to any yet."""
    campaign = current_campaign(conn)
    rows = conn.execute(
        "SELECT id, name, map_file, campaign_id FROM scenes WHERE ? IS NULL OR campaign_id = ? OR campaign_id IS NULL "
        "ORDER BY (campaign_id IS NULL), sort_order, id", (campaign, campaign)).fetchall()
    return [row_to_dict(r) for r in rows]


def player_payload(conn) -> dict:
    settings = get_settings(conn)
    image_url = None
    if settings["active_beamer_image_id"] is not None:
        row = conn.execute(
            "SELECT file FROM beamer_images WHERE id = ?", (settings["active_beamer_image_id"],)
        ).fetchone()
        if row:
            image_url = f"/beamer-images/{row['file']}"
    scene = None
    if image_url is None and settings["active_scene_id"] is not None:
        scene = scene_detail(conn, settings["active_scene_id"])
    if scene is not None:
        # Line of sight is active once the DM has placed at least one vision token.
        sight = [p["points"] for p in scene["vision_polys"]] if scene["vision_enabled"] else []
        tokens = []
        for t in scene["tokens"]:
            if not t["on_player"] or t["vision"]:
                continue
            status = tracker.combatant_status(t["combatant_id"])
            # Lurking monsters stay off the table until the DM reveals them in the tracker.
            if status.get("hidden"):
                continue
            # Creatures in explored but currently unseen rooms aren't shown either.
            if sight and not any(vision.point_in_polygon(t["x"], t["y"], p) for p in sight):
                continue
            tokens.append({
                "id": t["id"], "x": t["x"], "y": t["y"], "size": t["size"], "color": t["color"],
                "image": t["image"], "current": status.get("current", False), "dead": status.get("dead", False),
            })
        scene = {
            "id": scene["id"], "map_url": scene["map_url"], "map_w": scene["map_w"], "map_h": scene["map_h"],
            "grid_size": scene["grid_size"], "grid_ox": scene["grid_ox"], "grid_oy": scene["grid_oy"],
            "show_grid": scene["show_grid"], "fog_enabled": scene["fog_enabled"], "fog_ops": scene["fog_ops"],
            "fog_base_url": scene["fog_base_url"],
            "view_x": scene["view_x"], "view_y": scene["view_y"], "view_zoom": scene["view_zoom"],
            "tokens": tokens, "sight": sight,
            "templates": [t for t in scene["templates"] if t.get("on_player", True)],
        }
    return {
        "blackout": settings["blackout"], "calibrate": settings["calibrate"], "ppi": settings["ppi"],
        "rotation": settings["rotation"], "keystone": settings["keystone"], "scene": scene,
        "image_url": image_url,
        # The custom image replaces the battlemap and its tracker strip, not just the map.
        "tracker_strip_url": tracker.TRACKER_DISPLAY_URL if settings["tracker_strip"] and not image_url else None,
        "tracker_strip_px": settings["tracker_strip_px"],
        "handout_url": HANDOUT_URL if HANDOUT_URL and settings["handout_overlay"] else None,
    }


async def _send_all(sockets: set[WebSocket], message: dict) -> None:
    text = json.dumps(message)
    for ws in list(sockets):
        try:
            await ws.send_text(text)
        except Exception:
            sockets.discard(ws)


async def push_player() -> None:
    with get_conn() as conn:
        payload = player_payload(conn)
    await _send_all(player_sockets, {"type": "state", "state": payload})


async def notify(scene_id: int | None = None, settings: bool = False, scenes: bool = False,
                  images: bool = False) -> None:
    """Tell DM views what changed and refresh the player display."""
    with get_conn() as conn:
        if scenes:
            await _send_all(dm_sockets, {"type": "scenes", "scenes": scene_list(conn)})
        if images:
            await _send_all(dm_sockets, {"type": "beamer-images", "images": beamer_image_list(conn)})
        if settings:
            await _send_all(dm_sockets, {"type": "settings", "settings": get_settings(conn)})
        if scene_id is not None:
            scene = scene_detail(conn, scene_id)
            if scene is not None:
                await _send_all(dm_sockets, {"type": "scene", "scene": scene})
    await push_player()


async def notify_tracker() -> None:
    await _send_all(dm_sockets, {"type": "tracker", "tracker": tracker.state})
    await push_player()
