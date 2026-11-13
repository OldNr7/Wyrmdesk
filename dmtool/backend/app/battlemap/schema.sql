CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    map_file TEXT,
    map_w INTEGER NOT NULL DEFAULT 0,
    map_h INTEGER NOT NULL DEFAULT 0,
    -- Grid in map image pixels: size of one cell and where the first line sits.
    grid_size REAL NOT NULL DEFAULT 70,
    grid_ox REAL NOT NULL DEFAULT 0,
    grid_oy REAL NOT NULL DEFAULT 0,
    show_grid INTEGER NOT NULL DEFAULT 0,
    fog_enabled INTEGER NOT NULL DEFAULT 1,
    -- Fog is an append-only list of reveal/hide shapes, replayed on a mask canvas.
    fog_ops TEXT NOT NULL DEFAULT '[]',
    -- Older fog ops flattened into a mask image in the maps folder; fog_ops apply on top of it.
    fog_base TEXT,
    -- Named polygons (rooms) that can be revealed with one click or Stream Deck button.
    areas TEXT NOT NULL DEFAULT '[]',
    -- Player viewport: centre in map pixels plus zoom on top of the 1-inch-per-cell scale.
    view_x REAL NOT NULL DEFAULT 0,
    view_y REAL NOT NULL DEFAULT 0,
    view_zoom REAL NOT NULL DEFAULT 1,
    -- Wall segments {id, a, b, kind: wall|door, open}; closed doors and walls block sight.
    walls TEXT NOT NULL DEFAULT '[]',
    vision_enabled INTEGER NOT NULL DEFAULT 0,
    -- Current visibility polygons, one per vision token, recomputed whenever they can change.
    vision_polys TEXT NOT NULL DEFAULT '[]',
    -- Spell areas {id, shape: cone|circle|square|line, x, y, size, width, angle, on_player}.
    -- Sizes in feet; (x, y) is the cone tip, the line start or the circle/square centre.
    templates TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- The campaign the scene belongs to (campaigns.id); NULL: not assigned yet, shown in every one.
    campaign_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    size REAL NOT NULL DEFAULT 1,
    color TEXT NOT NULL DEFAULT '#c0392b',
    image TEXT,
    -- Link to a combatant in the combat tracker (turn highlight, dead, hidden).
    combatant_id INTEGER,
    -- Off for creatures standing on the table as a miniature.
    on_player INTEGER NOT NULL DEFAULT 1,
    -- DM-only viewpoint: never drawn on the beamer, sight is computed from here.
    vision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tokens_scene ON tokens(scene_id);

-- Images the DM can show on the beamer instead of a battlemap, e.g. while nothing is on the table.
CREATE TABLE IF NOT EXISTS beamer_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
