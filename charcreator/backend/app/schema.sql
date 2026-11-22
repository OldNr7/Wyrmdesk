CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- One campaign per group of players. The token is the secret players need to reach it;
-- nobody without the link can see or create anything here.
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    -- Optional extra password (salted hash, see security.py), checked in addition to the token.
    password_hash TEXT,
    -- Open mode (open_mode.py): a player's own collection, deleted after OPEN_DAYS days without use.
    is_open INTEGER NOT NULL DEFAULT 0,
    last_active TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Classes, subclasses, peoples and backgrounds, uploaded from the Kampagnenbuch's own
-- char_options table (same shape, so the uploaded JSON rows can be inserted as they are).
CREATE TABLE IF NOT EXISTS char_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- classes | subclasses | races | backgrounds
    name TEXT NOT NULL,
    name_en TEXT,
    parent TEXT,
    is_2024 INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    desc TEXT,
    source TEXT NOT NULL DEFAULT 'import',
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_char_options_kind ON char_options(kind);

-- Items and spells, uploaded from the Kampagnenbuch's custom_items/custom_spells (same shape).
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    item_type TEXT,
    rarity TEXT,
    requires_attunement INTEGER NOT NULL DEFAULT 0,
    desc TEXT,
    stat_block TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS spells (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    school TEXT,
    level_int INTEGER,
    dnd_class TEXT,
    casting_time TEXT,
    range TEXT,
    components TEXT,
    material TEXT,
    duration TEXT,
    concentration INTEGER NOT NULL DEFAULT 0,
    ritual INTEGER NOT NULL DEFAULT 0,
    higher_level TEXT,
    desc TEXT,
    notes TEXT
);

-- Characters players build here. Same fields as the Kampagnenbuch's characters table
-- (max_hp/ac/initiative_bonus/notes/stat_block), so a finished one imports there as is.
CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    player_name TEXT,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | fertig
    max_hp INTEGER NOT NULL DEFAULT 1,
    ac INTEGER NOT NULL DEFAULT 10,
    initiative_bonus INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    stat_block TEXT NOT NULL DEFAULT '{}',
    avatar_path TEXT,
    -- Share link (share.py): download of this one character, NULL while there is none.
    share_token TEXT,
    -- Equipping gear (and HP, once play starts) changes these outside the sheet editor, same
    -- split as the Kampagnenbuch's characters table.
    current_hp INTEGER,
    temp_hp INTEGER NOT NULL DEFAULT 0,
    play_state TEXT NOT NULL DEFAULT '{}',
    state_updated_at TEXT,
    exported_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id);

-- Termine (session date poll): the DM proposes dates per campaign, players answer each with
-- yes/maybe/no. No player accounts here either - player_name is free text, same trust model
-- as the token link itself (see player.py).
CREATE TABLE IF NOT EXISTS session_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    date TEXT NOT NULL,  -- YYYY-MM-DD
    note TEXT,           -- e.g. "ab 19 Uhr", "Oneshot"
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_dates_campaign ON session_dates(campaign_id);

CREATE TABLE IF NOT EXISTS session_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_id INTEGER NOT NULL REFERENCES session_dates(id) ON DELETE CASCADE,
    player_name TEXT NOT NULL,
    answer TEXT NOT NULL,  -- yes | maybe | no
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date_id, player_name)
);
CREATE INDEX IF NOT EXISTS idx_session_votes_date ON session_votes(date_id);
