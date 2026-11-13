"""Line of sight: what a viewpoint can see past walls and closed doors.

Classic visibility polygon by ray casting: one ray towards every wall endpoint
(plus two slightly to either side, to slip past corners), each stopped at the
nearest wall. Vectorised with numpy so maps with thousands of wall segments
(Dungeondraft caves) stay well under a second.
"""
import math

import numpy as np

# Angular nudge for the corner rays, in radians.
CORNER_EPS = 1e-4
# Rays per numpy batch; bounds the temporary arrays to a few MB.
RAY_BATCH = 256


def blocking_segments(walls: list[dict]) -> list[tuple]:
    return [
        (w["a"][0], w["a"][1], w["b"][0], w["b"][1])
        for w in walls
        if w["kind"] == "wall" or (w["kind"] == "door" and not w.get("open"))
    ]


def visibility_polygon(origin: tuple[float, float], segments: list[tuple], width: float, height: float,
                       tolerance: float = 1.0) -> list[list[float]]:
    ox, oy = origin
    # The map border closes the polygon, so every ray hits something.
    border = [(0, 0, width, 0), (width, 0, width, height), (width, height, 0, height), (0, height, 0, 0)]
    segs = np.array(segments + border, dtype=np.float64)
    ax, ay, bx, by = segs[:, 0], segs[:, 1], segs[:, 2], segs[:, 3]
    sx, sy = bx - ax, by - ay
    qx, qy = ax - ox, ay - oy

    ends = np.unique(np.round(np.concatenate([segs[:, :2], segs[:, 2:]]), 2), axis=0)
    base = np.arctan2(ends[:, 1] - oy, ends[:, 0] - ox)
    angles = np.unique(np.concatenate([base - CORNER_EPS, base, base + CORNER_EPS]))

    points = []
    for i in range(0, len(angles), RAY_BATCH):
        a = angles[i:i + RAY_BATCH]
        dx, dy = np.cos(a)[:, None], np.sin(a)[:, None]
        # Ray O + t*d meets segment A + u*s where t = (q x s)/(d x s), u = (q x d)/(d x s).
        denom = dx * sy - dy * sx
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (qx * sy - qy * sx) / denom
            u = (qx * dy - qy * dx) / denom
        valid = (np.abs(denom) > 1e-12) & (t > 1e-9) & (u >= -1e-9) & (u <= 1 + 1e-9)
        t = np.where(valid, t, np.inf).min(axis=1)
        hit = np.isfinite(t)
        px = ox + t[hit] * dx[hit, 0]
        py = oy + t[hit] * dy[hit, 0]
        points.extend(zip(px.tolist(), py.tolist()))

    return _simplify(points, tolerance)


def _simplify(points: list[tuple], tolerance: float) -> list[list[float]]:
    """Drop points lying on the line between their neighbours; most rays end mid-wall."""
    if len(points) < 4:
        return [[round(x, 1), round(y, 1)] for x, y in points]
    kept = [points[0]]
    for i in range(1, len(points) - 1):
        (x0, y0), (x1, y1), (x2, y2) = kept[-1], points[i], points[i + 1]
        length = math.hypot(x2 - x0, y2 - y0)
        dist = abs((x2 - x0) * (y0 - y1) - (x0 - x1) * (y2 - y0)) / length if length else 0
        if dist > tolerance:
            kept.append(points[i])
    kept.append(points[-1])
    return [[round(x, 1), round(y, 1)] for x, y in kept]


def point_in_polygon(x: float, y: float, poly: list[list[float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside
