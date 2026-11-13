"""[[Link]] upkeep shared by entries and characters."""
import json
import re


def rename_links(conn, campaign_id: int, old: str, new: str) -> None:
    """Keep [[links]] working when an entry is renamed."""
    pattern = re.compile(r"\[\[\s*" + re.escape(old.strip()) + r"\s*(\|[^\]]*)?\]\]", re.IGNORECASE)

    def fix(text: str) -> str:
        return pattern.sub(lambda m: f"[[{new}{m.group(1) or ''}]]", text or "")

    for r in conn.execute("SELECT id, summary, body, secrets FROM entries WHERE campaign_id = ?", (campaign_id,)).fetchall():
        conn.execute("UPDATE entries SET summary = ?, body = ?, secrets = ? WHERE id = ?",
                     (fix(r["summary"]), fix(r["body"]), fix(r["secrets"]), r["id"]))
    for r in conn.execute("SELECT id, prep, recap, log FROM sessions WHERE campaign_id = ?", (campaign_id,)).fetchall():
        log = [{**n, "text": fix(n.get("text", ""))} for n in json.loads(r["log"])]
        conn.execute("UPDATE sessions SET prep = ?, recap = ?, log = ? WHERE id = ?",
                     (fix(r["prep"]), fix(r["recap"]), json.dumps(log), r["id"]))
    for r in conn.execute("SELECT id, title, body FROM events WHERE campaign_id = ?", (campaign_id,)).fetchall():
        conn.execute("UPDATE events SET title = ?, body = ? WHERE id = ?", (fix(r["title"]), fix(r["body"]), r["id"]))
    for r in conn.execute("SELECT id, body FROM documents WHERE campaign_id = ?", (campaign_id,)).fetchall():
        conn.execute("UPDATE documents SET body = ? WHERE id = ?", (fix(r["body"]), r["id"]))
