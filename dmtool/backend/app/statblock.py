"""The one shape of a monster's stat_block, built from already-parsed values.

Three importers fill custom_monsters.stat_block from three different source formats — the Open5e
API (open5e.py), D&D-Beyond chapter/appendix HTML (book_import.py) and pasted .odt/.docx stat
blocks (monster_import.py) — each with its own extraction logic that cannot be shared (different
sources, different parsing). What they all built by hand, separately, was the same dict shape
afterwards; build_stat_block fixes that one shape in one place, so a renamed or added field needs
changing here, not in three importers that otherwise have nothing in common.
"""


def build_stat_block(
    *,
    abilities: dict,
    challenge_rating: str | None,
    size: str | None,
    speed,
    senses: str | None,
    languages: str | None,
    passive_perception: int | None = None,
    damage_vulnerabilities: str | None = None,
    damage_resistances: str | None = None,
    damage_immunities: str | None = None,
    condition_immunities: str | None = None,
    special_abilities: list | None = None,
    actions: list | None = None,
    reactions: list | None = None,
    legendary_desc: str | None = None,
    legendary_actions: list | None = None,
) -> dict:
    return {
        "abilities": abilities,
        "challenge_rating": challenge_rating,
        "size": size,  # "Medium", for the sheet
        "speed": speed,
        "senses": senses,
        "passive_perception": passive_perception,
        "languages": languages,
        "damage_vulnerabilities": damage_vulnerabilities,
        "damage_resistances": damage_resistances,
        "damage_immunities": damage_immunities,
        "condition_immunities": condition_immunities,
        "special_abilities": special_abilities or [],
        "actions": actions or [],
        "reactions": reactions or [],
        "legendary_desc": legendary_desc,
        "legendary_actions": legendary_actions or [],
    }
