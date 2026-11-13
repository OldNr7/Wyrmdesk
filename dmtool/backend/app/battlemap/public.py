import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from . import live
from .common import APP_DIR, setup_common
from .db import get_conn, get_settings, set_setting

app = FastAPI(title="Battlemap Display")


@app.get("/api/state")
def get_state():
    with get_conn() as conn:
        return live.player_payload(conn)


@app.websocket("/ws")
async def player_socket(ws: WebSocket):
    await ws.accept()
    live.player_sockets.add(ws)
    with get_conn() as conn:
        await ws.send_text(json.dumps({"type": "state", "state": live.player_payload(conn)}))
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "screen":
                # The DM view draws the beamer frame from this.
                with get_conn() as conn:
                    set_setting(conn, "player_screen", {"w": int(msg["w"]), "h": int(msg["h"])})
                await live.notify(settings=True)
            elif msg.get("type") == "keystone":
                # Corners are dragged on the beamer itself, and only while calibrating.
                with get_conn() as conn:
                    if not get_settings(conn)["calibrate"]:
                        continue
                    set_setting(conn, "keystone", msg["corners"])
                await live.notify(settings=True)
    except WebSocketDisconnect:
        pass
    finally:
        live.player_sockets.discard(ws)


setup_common(app)
app.mount("/", StaticFiles(directory=str(APP_DIR / "player_static"), html=True), name="static")
