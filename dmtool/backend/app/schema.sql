CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- All campaigns. Ids were taken over from the combat tracker, which reads this list from here.
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    -- {"type": "harptos" | "custom" | "none", "months": [{"name", "days", "festival"}], "era": ".."}
    calendar TEXT,
    -- Current date in the game world, {"y", "m", "d"} or {"text"}.
    today TEXT
);

-- NPCs, places, factions, items, quests, decisions, handouts and player characters.
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    secrets TEXT NOT NULL DEFAULT '',
    image TEXT,
    status TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    fields TEXT NOT NULL DEFAULT '{}',
    known INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_campaign ON entries(campaign_id, type);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    number INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    played_on TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    game_start TEXT,
    game_end TEXT,
    prep TEXT NOT NULL DEFAULT '',
    recap TEXT NOT NULL DEFAULT '',
    -- Notes taken at the table: [{"t": "20:15", "text": ".."}]
    log TEXT NOT NULL DEFAULT '[]',
    encounter_ids TEXT NOT NULL DEFAULT '[]',
    tracker_session_id INTEGER,
    -- Made from a chapter of a D&D Beyond adventure ("lmop/goblin-arrows#Part1GoblinArrows").
    ddb_ref TEXT,
    -- The English original, once the prep was translated (content_translate.py).
    prep_en TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id);

-- Timeline events, dated in the game world's calendar.
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    sort_key REAL NOT NULL DEFAULT 0,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id);

-- Diverse Dokumente of a campaign: PDFs and pictures (file, an /uploads/ address), texts (body,
-- Markdown) and tables (data, {"rows": [["Kopf", ..], [..]]}, the first row is the header).
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    -- "pdf", "image", "text" or "table"
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    file TEXT,
    body TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_campaign ON documents(campaign_id, sort_order);

-- Rules data, moved here from the combat tracker, which now reads it from the Kampagnenbuch.
-- Ids were kept on the move, so encounters in the tracker still point at the right rows.

-- Player characters with their full sheet. Each has a 'pc' entry for notes and links (entry_id).
CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    max_hp INTEGER NOT NULL,
    ac INTEGER NOT NULL,
    initiative_bonus INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    avatar_path TEXT,
    stat_block TEXT,
    -- Changes with every save; a save that names an older value is refused (DM and player editing at once).
    updated_at TEXT,
    -- Play state, changed outside the sheet editor (players, DM, tracker, battlemap) and never touched by a
    -- sheet save. current_hp/temp_hp follow the character's combatants in every encounter of the tracker;
    -- play_state is JSON ({"slots_used": {"1": 2}, "pact_used": 1, "res_used": {"short:ki": 2}, "hd_used": 1,
    --   "ammo": [{"name": "Pfeile", "count": 20}], "inventory": [{"name": "Seil", "qty": 1, "item_id": null}]}).
    current_hp INTEGER,
    temp_hp INTEGER NOT NULL DEFAULT 0,
    play_state TEXT,
    state_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id);

-- Bestiary, item and spell library, shared by all campaigns.
CREATE TABLE IF NOT EXISTS custom_monsters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    max_hp INTEGER NOT NULL,
    ac INTEGER NOT NULL,
    initiative_bonus INTEGER NOT NULL DEFAULT 0,
    challenge_rating TEXT,
    notes TEXT,
    stat_block TEXT,
    avatar_path TEXT,
    creature_type TEXT,
    source TEXT NOT NULL DEFAULT 'custom',
    verified INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    item_type TEXT,
    rarity TEXT,
    requires_attunement INTEGER NOT NULL DEFAULT 0,
    desc TEXT,
    source TEXT NOT NULL DEFAULT 'custom',
    avatar_path TEXT,
    stat_block TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_spells (
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
    source TEXT NOT NULL DEFAULT 'custom',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Classes, subclasses, peoples and backgrounds for the character sheet's dropdowns (char_options.py).
CREATE TABLE IF NOT EXISTS char_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- classes | subclasses | races | backgrounds
    name TEXT NOT NULL,
    name_en TEXT,                    -- Open5e name; a class's name_en matches the spells' class list
    parent TEXT,                     -- subclass: English class name; subrace: its people
    is_2024 INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    desc TEXT,
    source TEXT NOT NULL DEFAULT 'custom',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_char_options_kind ON char_options(kind);

-- German translations of the library texts (translate.py): single English lines -> German,
-- plus whole texts corrected by hand (manual = 1, keyed "m:<hash>").
CREATE TABLE IF NOT EXISTS translations (
    source_hash TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    text_de TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

-- Campaign templates (templates.py): a snapshot of one campaign with everything in it, as JSON, to
-- start it anew for another group. Map images it needs are copies of its own (tpl-… in the maps folder).
CREATE TABLE IF NOT EXISTS campaign_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    source_campaign_id INTEGER,
    source_name TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
