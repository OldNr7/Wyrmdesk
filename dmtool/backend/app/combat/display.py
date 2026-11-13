import json

from .db import get_setting, set_setting

DISPLAY_ENCOUNTER_KEY = "display_encounter_id"


def get_display_encounter_id(conn) -> int | None:
    value = get_setting(conn, DISPLAY_ENCOUNTER_KEY)
    return int(value) if value is not None else None


def set_display_encounter_id(conn, encounter_id: int | None) -> None:
    set_setting(conn, DISPLAY_ENCOUNTER_KEY, str(encounter_id) if encounter_id is not None else None)


def current_position(order: list, encounter) -> int | None:
    """Index in the turn order of whoever has the turn.

    The turn belongs to a combatant, not to a place in the list, so it survives
    initiative changes and added or removed combatants. current_turn_index is only
    the fallback for encounters last advanced before current_combatant_id existed.
    """
    if not order:
        return None
    for i, c in enumerate(order):
        if c["id"] == encounter["current_combatant_id"]:
            return i
    idx = encounter["current_turn_index"]
    return idx if 0 <= idx < len(order) else 0


def display_payload(conn) -> dict:
    encounter_id = get_display_encounter_id(conn)
    if encounter_id is None:
        return {"encounter_id": None, "combatants": []}

    encounter = conn.execute(
        "SELECT id, current_turn_index, current_combatant_id FROM encounters WHERE id = ?", (encounter_id,)
    ).fetchone()
    if encounter is None:
        return {"encounter_id": None, "combatants": []}

    rows = conn.execute(
        "SELECT id, kind, max_hp, current_hp, temp_hp, ac, avatar_path, creature_type, status_effects, "
        "is_boss, is_hidden FROM combatant_view WHERE encounter_id = ? "
        "ORDER BY (initiative IS NULL), initiative DESC, sort_order ASC",
        (encounter_id,),
    ).fetchall()

    idx = current_position(rows, encounter)
    current_id = rows[idx]["id"] if idx is not None else None

    combatants = []
    for r in rows:
        # Hidden monsters (lurking, not yet revealed) never reach the player display.
        # The turn index above still counts them, so while it's their turn nobody is highlighted.
        if r["is_hidden"]:
            continue
        hp_critical = r["max_hp"] > 0 and (r["current_hp"] / r["max_hp"]) <= 0.15
        entry = {
            "id": r["id"],
            "kind": r["kind"],
            "avatar_path": r["avatar_path"],
            "creature_type": r["creature_type"],
            "is_current": r["id"] == current_id,
            "hp_critical": hp_critical,
            "dead": r["current_hp"] <= 0,
            # Conditions are visible at the table anyway, so shown for monsters too.
            "status_effects": json.loads(r["status_effects"] or "[]"),
            "is_boss": bool(r["is_boss"]),
        }
        # HP and AC are only exposed for player characters; monster stats stay hidden.
        if r["kind"] == "pc":
            entry.update(current_hp=r["current_hp"], max_hp=r["max_hp"], ac=r["ac"], temp_hp=r["temp_hp"])
        combatants.append(entry)

    return {"encounter_id": encounter_id, "combatants": combatants}
