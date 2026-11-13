"""Kampagnenbuch, Combat Tracker and Battlemap in one process.

The three parts still talk to each other the way they did as separate services, through their HTTP
APIs, but without the network: a request to a registered host ("http://tracker.intern/…") goes straight
to that app in this process (httpx.ASGITransport). Any other host goes out over the network as before.
run.py registers the apps and points the parts' URLs here; phase 2 replaces these calls with shared
tables.
"""
import httpx

KB_URL = "http://kampagnenbuch.intern"
TRACKER_URL = "http://tracker.intern"

_apps: dict[str, object] = {}


def register(url: str, app) -> None:
    _apps[httpx.URL(url).host] = app


class _Transport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self._net = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        app = _apps.get(request.url.host)
        if app is None:
            return await self._net.handle_async_request(request)
        return await httpx.ASGITransport(app=app).handle_async_request(request)

    async def aclose(self) -> None:
        await self._net.aclose()


# Called when something in a fight changed (tracker writes, a character's HP): the battlemap's
# watcher looks again right away instead of at its next round (run.py registers it).
_listeners: list = []


def on_change(fn) -> None:
    _listeners.append(fn)


def changed() -> None:
    for fn in _listeners:
        fn()


# Called when the campaign changes (Kampagnenbuch, tracker or battlemap): the battlemap lists its scenes.
_campaign_listeners: list = []


def on_campaign(fn) -> None:
    _campaign_listeners.append(fn)


def campaign_changed() -> None:
    for fn in _campaign_listeners:
        fn()


def client(**kwargs) -> httpx.AsyncClient:
    """httpx.AsyncClient that reaches the registered apps in-process."""
    return httpx.AsyncClient(transport=_Transport(), **kwargs)
