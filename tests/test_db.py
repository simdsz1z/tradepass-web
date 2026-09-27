"""
DB layer verification — runs the same SQL the Node.js lib/db.ts will run,
against Python's stdlib sqlite3 (same SQLite engine as libsql).
This proves the schema + queries work end-to-end with the actual DB engine.
"""

import os
import sqlite3
import sys
import tempfile

results = []
def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))


def with_temp_db(fn):
    """Run fn(conn, path) with a fresh file-backed DB."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user','assistant')),
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, created_at);
        """)
        conn.commit()
        fn(conn, path)
        conn.close()
    finally:
        try: os.unlink(path)
        except OSError: pass


def test_seed_and_fetch(conn, path):
    seeds = [
        ("AfCFTA-ROO-1", "AfCFTA Rules of Origin", "To qualify..."),
        ("AfCFTA-QA-1", "AfCFTA Q&A", "Apply before export..."),
        ("KRA-EAC-1", "KRA EAC", "KRA PIN..."),
        ("UBOS-1", "UNBS", "UNBS conformity..."),
        ("NTB-1", "tralac", "Common barriers..."),
    ]
    for sid, title, text in seeds:
        conn.execute(
            "INSERT OR IGNORE INTO sources (id, title, text) VALUES (?, ?, ?)",
            (sid, title, text),
        )
    conn.commit()

    n = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    check("DB-S1 seed inserts 5 sources", n == 5, f"got {n}")

    ids = [r[0] for r in conn.execute("SELECT id FROM sources ORDER BY id ASC")]
    check("DB-S2 ORDER BY id returns sorted ids",
          ids == sorted(ids), f"got {ids}")

    conn.execute(
        "INSERT OR IGNORE INTO sources (id, title, text) VALUES (?, ?, ?)",
        ("AfCFTA-ROO-1", "dup", "dup"),
    )
    conn.commit()
    n2 = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    check("DB-S3 INSERT OR IGNORE prevents duplicates on re-seed", n2 == 5, f"got {n2}")


def test_messages_crud(conn, path):
    session = "test-session"

    conn.execute("DELETE FROM messages WHERE session_id = ?", (session,))
    conn.commit()

    msgs = [
        (session, "user", "first question", 1000),
        (session, "assistant", "first reply", 1001),
        (session, "user", "follow-up", 1002),
    ]
    for s, role, content, ts in msgs:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s, role, content, ts),
        )
    conn.commit()

    rows = conn.execute(
        """SELECT id, role, content FROM messages
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC
           LIMIT 40""",
        (session,),
    ).fetchall()
    check("DB-M1 fetched 3 messages", len(rows) == 3, f"got {len(rows)}")
    check("DB-M2 message order preserved",
          [r[2] for r in rows] == ["first question", "first reply", "follow-up"])
    check("DB-M3 roles preserved",
          [r[1] for r in rows] == ["user", "assistant", "user"])

    conn.execute("DELETE FROM messages WHERE session_id = ?", (session,))
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM messages WHERE session_id = ?", (session,)).fetchone()[0]
    check("DB-M4 clearSession removes all", n == 0, f"got {n}")


def test_role_constraint(conn, path):
    raised = False
    try:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            ("s", "system", "x", 1),
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        raised = True
        check("DB-C1 CHECK constraint rejects invalid role",
              "CHECK" in str(e).upper(), str(e)[:120])
    if not raised:
        check("DB-C1 CHECK constraint rejects invalid role", False, "no exception raised")


with_temp_db(test_seed_and_fetch)
with_temp_db(test_messages_crud)
with_temp_db(test_role_constraint)


print("\n" + "=" * 70)
print(f"  TRADEPASS WEB - DB LAYER VERIFICATION ({len(results)} checks)")
print("=" * 70)
for name, status, detail in results:
    flag = "[PASS]" if status == "PASS" else "[FAIL]"
    line = f"  {flag} {name}"
    if detail and status == "FAIL":
        line += f"\n      -> {detail}"
    print(line)

passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print("=" * 70)
print(f"  RESULT: {passed} passed / {failed} failed / {len(results)} total")
print("=" * 70)
sys.exit(0 if failed == 0 else 1)
