-- Combat Tracker tables in the Kampagnenbuch's database. Campaigns and
-- characters are the Kampagnenbuch's own tables; the tracker keeps only its encounters and combatants.

CREATE TABLE IF NOT EXISTS encounters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER REFERENCES campaigns(id),
    name TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    current_turn_index INTEGER NOT NULL DEFAULT 0,
    current_combatant_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- source: 'roster' (a player character, ref_id = characters.id), 'custom' (bestiary monster,
-- ref_id = custom_monsters.id), 'open5e' or 'manual'. Monsters are copies: every one has its own HP.
CREATE TABLE IF NOT EXISTS combatants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('pc','monster')),
    source TEXT NOT NULL DEFAULT 'manual',
    max_hp INTEGER NOT NULL,
    current_hp INTEGER NOT NULL,
    ac INTEGER NOT NULL,
    initiative INTEGER,
    initiative_bonus INTEGER NOT NULL DEFAULT 0,
    status_effects TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    avatar_path TEXT,
    stat_block TEXT,
    ref_id INTEGER,
    creature_type TEXT,
    is_boss INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    temp_hp INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_combatants_encounter ON combatants(encounter_id);
CREATE INDEX IF NOT EXISTS idx_encounters_campaign ON encounters(campaign_id);

-- What the tracker reads. A player character in a fight is the character itself: HP, temporary HP,
-- AC, initiative bonus, sheet and portrait come from characters, so a change on the player's sheet
-- and one in the fight are the same row (no copies to keep in step). The combatant's own columns
-- hold the last values, used once the character is gone. Its name stays the combatant's, which the
-- DM may change for the fight.
DROP VIEW IF EXISTS combatant_view;
CREATE VIEW combatant_view AS
SELECT c.id, c.encounter_id, c.name, c.kind, c.source,
       CASE WHEN ch.id IS NULL THEN c.max_hp ELSE ch.max_hp END AS max_hp,
       CASE WHEN ch.id IS NULL THEN c.current_hp ELSE MIN(ch.max_hp, COALESCE(ch.current_hp, ch.max_hp)) END AS current_hp,
       CASE WHEN ch.id IS NULL THEN c.ac ELSE ch.ac END AS ac,
       c.initiative,
       CASE WHEN ch.id IS NULL THEN c.initiative_bonus ELSE ch.initiative_bonus END AS initiative_bonus,
       c.status_effects, c.sort_order, c.notes,
       CASE WHEN ch.id IS NULL THEN c.avatar_path
            WHEN ch.avatar_path LIKE '/uploads/%' THEN '/kb' || ch.avatar_path
            ELSE ch.avatar_path END AS avatar_path,
       CASE WHEN ch.id IS NULL THEN c.stat_block ELSE ch.stat_block END AS stat_block,
       c.ref_id, c.creature_type, c.is_boss, c.is_hidden,
       CASE WHEN ch.id IS NULL THEN c.temp_hp ELSE ch.temp_hp END AS temp_hp
FROM combatants c
LEFT JOIN characters ch ON c.source = 'roster' AND ch.id = c.ref_id;
