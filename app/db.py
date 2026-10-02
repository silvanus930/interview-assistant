import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Generator

from .config import CLAUDE_CWD, DATA_DIR, DB_PATH, MODEL_SUGGESTIONS
from .seeds import DEFAULT_SETTINGS, SEED_WORKFLOWS

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user',
    is_active      INTEGER NOT NULL DEFAULT 1,
    model          TEXT NOT NULL DEFAULT '',
    effort         TEXT NOT NULL DEFAULT '',
    extension_key  TEXT NOT NULL UNIQUE,
    created_at     TEXT NOT NULL,
    last_login_at  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER,
    is_template       INTEGER NOT NULL DEFAULT 0,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    system_prompt     TEXT NOT NULL DEFAULT '',
    telegram_template TEXT NOT NULL DEFAULT '{{output}}',
    steps             TEXT NOT NULL DEFAULT '[]',
    is_default        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER,
    name             TEXT NOT NULL,
    target_role      TEXT NOT NULL DEFAULT '',
    company          TEXT NOT NULL DEFAULT '',
    job_description  TEXT NOT NULL DEFAULT '',
    notes            TEXT NOT NULL DEFAULT '',
    resume_filename  TEXT NOT NULL DEFAULT '',
    resume_text      TEXT NOT NULL DEFAULT '',
    telegram_chat_id TEXT NOT NULL DEFAULT '',
    telegram_listen  INTEGER NOT NULL DEFAULT 1,
    workflow_id      INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER,
    profile_id      INTEGER,
    profile_name    TEXT NOT NULL DEFAULT '',
    workflow_id     INTEGER,
    workflow_name   TEXT NOT NULL DEFAULT '',
    question        TEXT NOT NULL,
    context         TEXT NOT NULL DEFAULT '',
    session         TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'ui',
    status          TEXT NOT NULL DEFAULT 'running',
    steps           TEXT NOT NULL DEFAULT '[]',
    final_output    TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    telegram_status TEXT NOT NULL DEFAULT '',
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    finished_at     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
"""

# Columns added after the first release; older databases get them on start.
MIGRATIONS = {
    "runs": {"context": "TEXT NOT NULL DEFAULT ''", "session": "TEXT NOT NULL DEFAULT ''", "user_id": "INTEGER"},
    "profiles": {"user_id": "INTEGER"},
    "workflows": {"user_id": "INTEGER", "is_template": "INTEGER NOT NULL DEFAULT 0"},
}

PROFILE_FIELDS = (
    "name", "target_role", "company", "job_description", "notes",
    "resume_filename", "resume_text", "telegram_chat_id", "telegram_listen", "workflow_id",
)
WORKFLOW_FIELDS = ("name", "description", "system_prompt", "telegram_template", "steps")
USER_FIELDS = ("email", "name", "password_hash", "role", "is_active", "model", "effort", "extension_key",
               "last_login_at")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Generator[sqlite3.Connection, None, None]:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CLAUDE_CWD.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for column, definition in columns.items():
                if column not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id, is_template)")

        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
        conn.execute("UPDATE settings SET value = ? WHERE key = 'models' AND value = ''",
                     (json.dumps(MODEL_SUGGESTIONS),))

        # Templates are the shared starting workflows every new user gets a copy of.
        if conn.execute("SELECT COUNT(*) FROM workflows WHERE is_template = 1").fetchone()[0] == 0:
            for wf in SEED_WORKFLOWS:
                ts = now()
                conn.execute(
                    "INSERT INTO workflows(user_id, is_template, name, description, system_prompt, telegram_template,"
                    " steps, is_default, created_at, updated_at) VALUES (NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (wf["name"], wf["description"], wf["system_prompt"], wf["telegram_template"],
                     json.dumps(wf["steps"]), int(wf["is_default"]), ts, ts),
                )
        # A run left "running" means the server stopped mid-run.
        conn.execute(
            "UPDATE runs SET status = 'error', error = 'Interrupted: the server stopped during this run.',"
            " finished_at = ? WHERE status = 'running'",
            (now(),),
        )
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))


# ---------------------------------------------------------------- settings

def get_settings() -> dict[str, str]:
    with connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {**DEFAULT_SETTINGS, **{r["key"]: r["value"] for r in rows}}


def set_settings(values: dict[str, str]) -> None:
    with connect() as conn:
        for key, value in values.items():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )


def allowed_models() -> list[dict[str, str]]:
    """Models users may pick, as managed by the admin."""
    try:
        models = json.loads(get_settings()["models"] or "[]")
    except ValueError:
        models = []
    return [m for m in models if isinstance(m, dict) and m.get("id")] or list(MODEL_SUGGESTIONS)


# ------------------------------------------------------------------- users

def _user(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    user = dict(row)
    user["is_active"] = bool(user["is_active"])
    return user


def count_users() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def count_active_admins(excluding: int | None = None) -> int:
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id IS NOT ?", (excluding,)
        ).fetchone()[0]


def get_user(user_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        return _user(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def get_user_by_email(email: str) -> dict[str, Any] | None:
    with connect() as conn:
        return _user(conn.execute("SELECT * FROM users WHERE email = ?", (email.strip(),)).fetchone())


def get_user_by_key(key: str) -> dict[str, Any] | None:
    with connect() as conn:
        return _user(conn.execute("SELECT * FROM users WHERE extension_key = ?", (key,)).fetchone())


def list_users() -> list[dict[str, Any]]:
    """Every user with their usage, for the admin's Users page."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT u.*,"
            " (SELECT COUNT(*) FROM profiles p WHERE p.user_id = u.id) AS profile_count,"
            " (SELECT COUNT(*) FROM workflows w WHERE w.user_id = u.id AND w.is_template = 0) AS workflow_count,"
            " (SELECT COUNT(*) FROM runs r WHERE r.user_id = u.id) AS run_count,"
            " (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.user_id = u.id) AS cost_usd,"
            " (SELECT MAX(r.created_at) FROM runs r WHERE r.user_id = u.id) AS last_run_at"
            " FROM users u ORDER BY u.role = 'admin' DESC, u.name COLLATE NOCASE"
        ).fetchall()
    return [_user(r) for r in rows]  # type: ignore[misc]


def create_user(*, email: str, name: str, password_hash: str, role: str = "user") -> dict[str, Any]:
    """Create an account. The first account also takes over data from before accounts existed."""
    with connect() as conn:
        first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        # Before accounts, one key paired the extension with the app; the first
        # account inherits it so an already-connected extension keeps working.
        legacy_key = conn.execute("SELECT value FROM settings WHERE key = 'extension_key'").fetchone()
        key = legacy_key["value"] if first and legacy_key and legacy_key["value"] else secrets.token_urlsafe(24)
        cur = conn.execute(
            "INSERT INTO users(email, name, password_hash, role, extension_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (email.strip().lower(), name.strip(), password_hash, role, key, now()),
        )
        user_id = cur.lastrowid
        if first:
            for table in ("profiles", "runs"):
                conn.execute(f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (user_id,))
            conn.execute("UPDATE workflows SET user_id = ? WHERE user_id IS NULL AND is_template = 0", (user_id,))
            conn.execute("DELETE FROM settings WHERE key = 'extension_key'")
        if conn.execute("SELECT COUNT(*) FROM workflows WHERE user_id = ?", (user_id,)).fetchone()[0] == 0:
            _copy_templates(conn, user_id)
    return get_user(user_id)  # type: ignore[return-value,arg-type]


def update_user(user_id: int, **fields: Any) -> dict[str, Any] | None:
    fields = {k: v for k, v in fields.items() if k in USER_FIELDS}
    if "email" in fields:
        fields["email"] = fields["email"].strip().lower()
    if "is_active" in fields:
        fields["is_active"] = int(bool(fields["is_active"]))
    if fields:
        with connect() as conn:
            conn.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                         (*fields.values(), user_id))
            if fields.get("is_active") == 0 or "password_hash" in fields:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # sign them out everywhere
    return get_user(user_id)


def delete_user(user_id: int) -> None:
    """Remove an account and everything it owns."""
    with connect() as conn:
        for table in ("runs", "profiles"):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM workflows WHERE user_id = ? AND is_template = 0", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


# ---------------------------------------------------------------- sessions

def create_session(token_hash: str, user_id: int, expires_at: str) -> None:
    with connect() as conn:
        conn.execute("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                     (token_hash, user_id, now(), expires_at))


def get_session_user(token_hash: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
            (token_hash, now()),
        ).fetchone()
    return _user(row)


def delete_session(token_hash: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


# --------------------------------------------------------------- workflows
# A workflow belongs to one user. Templates (is_template = 1, no owner) are the
# shared starting points managed by admins; users work on their own copies.

def _workflow(row: sqlite3.Row) -> dict[str, Any]:
    wf = dict(row)
    wf["steps"] = json.loads(wf["steps"])
    wf["is_default"] = bool(wf["is_default"])
    wf["is_template"] = bool(wf["is_template"])
    return wf


def _insert_workflow(conn: sqlite3.Connection, data: dict[str, Any], user_id: int | None, is_template: bool,
                     is_default: bool) -> int:
    ts = now()
    cur = conn.execute(
        "INSERT INTO workflows(user_id, is_template, name, description, system_prompt, telegram_template, steps,"
        " is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, int(is_template), data["name"], data["description"], data["system_prompt"],
         data["telegram_template"], json.dumps(data["steps"]), int(is_default), ts, ts),
    )
    return cur.lastrowid  # type: ignore[return-value]


def _copy_templates(conn: sqlite3.Connection, user_id: int) -> None:
    templates = [_workflow(r) for r in conn.execute("SELECT * FROM workflows WHERE is_template = 1 ORDER BY id")]
    has_default = any(t["is_default"] for t in templates)
    for index, template in enumerate(templates):
        _insert_workflow(conn, template, user_id, False,
                         template["is_default"] if has_default else index == 0)


def _scope(user_id: int | None) -> tuple[str, tuple[Any, ...]]:
    """WHERE clause for one user's workflows, or for the templates when user_id is None."""
    if user_id is None:
        return "is_template = 1", ()
    return "is_template = 0 AND user_id = ?", (user_id,)


def list_workflows(user_id: int | None) -> list[dict[str, Any]]:
    where, params = _scope(user_id)
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM workflows WHERE {where} ORDER BY is_default DESC, name COLLATE NOCASE", params
        ).fetchall()
    return [_workflow(r) for r in rows]


def get_workflow(workflow_id: int, user_id: int | None) -> dict[str, Any] | None:
    """A workflow of that user, or a template when user_id is None."""
    where, params = _scope(user_id)
    with connect() as conn:
        row = conn.execute(f"SELECT * FROM workflows WHERE id = ? AND {where}", (workflow_id, *params)).fetchone()
    return _workflow(row) if row else None


def get_default_workflow(user_id: int | None) -> dict[str, Any] | None:
    where, params = _scope(user_id)
    with connect() as conn:
        row = conn.execute(
            f"SELECT * FROM workflows WHERE {where} ORDER BY is_default DESC, id LIMIT 1", params
        ).fetchone()
    return _workflow(row) if row else None


def create_workflow(data: dict[str, Any], user_id: int | None) -> dict[str, Any]:
    where, params = _scope(user_id)
    with connect() as conn:
        has_default = conn.execute(
            f"SELECT COUNT(*) FROM workflows WHERE is_default = 1 AND {where}", params
        ).fetchone()[0]
        workflow_id = _insert_workflow(conn, data, user_id, user_id is None, not has_default)
    return get_workflow(workflow_id, user_id)  # type: ignore[return-value]


def update_workflow(workflow_id: int, data: dict[str, Any], user_id: int | None) -> dict[str, Any] | None:
    where, params = _scope(user_id)
    values = [json.dumps(data[f]) if f == "steps" else data[f] for f in WORKFLOW_FIELDS]
    with connect() as conn:
        conn.execute(
            f"UPDATE workflows SET {', '.join(f'{f} = ?' for f in WORKFLOW_FIELDS)}, updated_at = ?"
            f" WHERE id = ? AND {where}",
            (*values, now(), workflow_id, *params),
        )
    return get_workflow(workflow_id, user_id)


def set_default_workflow(workflow_id: int, user_id: int | None) -> None:
    where, params = _scope(user_id)
    with connect() as conn:
        conn.execute(f"UPDATE workflows SET is_default = (id = ?) WHERE {where}", (workflow_id, *params))


def delete_workflow(workflow_id: int, user_id: int | None) -> None:
    where, params = _scope(user_id)
    with connect() as conn:
        conn.execute(f"DELETE FROM workflows WHERE id = ? AND {where}", (workflow_id, *params))
        if not conn.execute(f"SELECT COUNT(*) FROM workflows WHERE is_default = 1 AND {where}", params).fetchone()[0]:
            conn.execute(
                f"UPDATE workflows SET is_default = 1 WHERE id = (SELECT MIN(id) FROM workflows WHERE {where})", params
            )


# ---------------------------------------------------------------- profiles

def _profile(row: sqlite3.Row) -> dict[str, Any]:
    profile = dict(row)
    profile["telegram_listen"] = bool(profile["telegram_listen"])
    return profile


def list_profiles(user_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM profiles WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
    return [_profile(r) for r in rows]


def get_profile(profile_id: int, user_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ? AND user_id = ?", (profile_id, user_id)).fetchone()
    return _profile(row) if row else None


def find_profile_by_chat(chat_id: str) -> dict[str, Any] | None:
    """The profile (of any active user) that answers questions sent from this Telegram chat."""
    with connect() as conn:
        row = conn.execute(
            "SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id"
            " WHERE p.telegram_chat_id = ? AND p.telegram_listen = 1 AND u.is_active = 1"
            " ORDER BY p.updated_at DESC LIMIT 1",
            (chat_id,),
        ).fetchone()
    return _profile(row) if row else None


def create_profile(data: dict[str, Any], user_id: int) -> dict[str, Any]:
    ts = now()
    with connect() as conn:
        cur = conn.execute(
            f"INSERT INTO profiles(user_id, {', '.join(PROFILE_FIELDS)}, created_at, updated_at)"
            f" VALUES (?, {', '.join('?' for _ in PROFILE_FIELDS)}, ?, ?)",
            (user_id, *[data[f] for f in PROFILE_FIELDS], ts, ts),
        )
        profile_id = cur.lastrowid
    return get_profile(profile_id, user_id)  # type: ignore[return-value,arg-type]


def update_profile(profile_id: int, data: dict[str, Any], user_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute(
            f"UPDATE profiles SET {', '.join(f'{f} = ?' for f in PROFILE_FIELDS)}, updated_at = ?"
            " WHERE id = ? AND user_id = ?",
            (*[data[f] for f in PROFILE_FIELDS], now(), profile_id, user_id),
        )
    return get_profile(profile_id, user_id)


def delete_profile(profile_id: int, user_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM profiles WHERE id = ? AND user_id = ?", (profile_id, user_id))


# -------------------------------------------------------------------- runs

def _run(row: sqlite3.Row) -> dict[str, Any]:
    run = dict(row)
    run["steps"] = json.loads(run["steps"])
    return run


def create_run(profile: dict[str, Any], workflow: dict[str, Any], question: str, source: str,
               context: str = "", session: str = "") -> dict[str, Any]:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO runs(user_id, profile_id, profile_name, workflow_id, workflow_name, question, context,"
            " session, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (profile["user_id"], profile["id"], profile["name"], workflow.get("id"), workflow["name"], question,
             context, session, source, now()),
        )
        run_id = cur.lastrowid
    return get_run(run_id)  # type: ignore[return-value,arg-type]


def update_run(run_id: int, **fields: Any) -> None:
    if "steps" in fields:
        fields["steps"] = json.dumps(fields["steps"])
    with connect() as conn:
        conn.execute(
            f"UPDATE runs SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
            (*fields.values(), run_id),
        )


def get_run(run_id: int, user_id: int | None = None) -> dict[str, Any] | None:
    """A run by id. Pass user_id to only find it when it belongs to that user."""
    query, params = "SELECT * FROM runs WHERE id = ?", [run_id]
    if user_id is not None:
        query += " AND user_id = ?"
        params.append(user_id)
    with connect() as conn:
        row = conn.execute(query, params).fetchone()
    return _run(row) if row else None


def list_runs(user_id: int, limit: int = 100, profile_id: int | None = None) -> list[dict[str, Any]]:
    query, params = "SELECT * FROM runs WHERE user_id = ?", [user_id]
    if profile_id is not None:
        query += " AND profile_id = ?"
        params.append(profile_id)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_run(r) for r in rows]


def session_runs(session: str, user_id: int, hours: int, limit: int) -> list[dict[str, Any]]:
    """Finished runs of one interview session from the last `hours`, oldest first."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM runs WHERE session = ? AND user_id = ? AND status = 'done' AND created_at >= ?"
            " ORDER BY id DESC LIMIT ?",
            (session, user_id, since, limit),
        ).fetchall()
    return [_run(r) for r in reversed(rows)]


def delete_run(run_id: int, user_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM runs WHERE id = ? AND user_id = ?", (run_id, user_id))


def clear_runs(user_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM runs WHERE user_id = ? AND status != 'running'", (user_id,))


# ------------------------------------------------------------------- stats

def counts(user_id: int) -> dict[str, int]:
    with connect() as conn:
        return {
            "profiles": conn.execute("SELECT COUNT(*) FROM profiles WHERE user_id = ?", (user_id,)).fetchone()[0],
            "workflows": conn.execute(
                "SELECT COUNT(*) FROM workflows WHERE user_id = ? AND is_template = 0", (user_id,)).fetchone()[0],
            "runs": conn.execute("SELECT COUNT(*) FROM runs WHERE user_id = ?", (user_id,)).fetchone()[0],
        }


def overview() -> dict[str, Any]:
    """Platform-wide numbers for the admin's Overview page."""
    day_ago = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")
    with connect() as conn:
        one = lambda sql, *p: conn.execute(sql, p).fetchone()[0]  # noqa: E731
        by_day = conn.execute(
            "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs FROM runs WHERE created_at >= ?"
            " GROUP BY day ORDER BY day", (week_ago,)
        ).fetchall()
        by_source = conn.execute(
            "SELECT source, COUNT(*) AS runs FROM runs WHERE created_at >= ? GROUP BY source", (week_ago,)
        ).fetchall()
        recent_errors = conn.execute(
            "SELECT r.id, r.created_at, r.error, r.question, u.name AS user_name FROM runs r"
            " LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'error' ORDER BY r.id DESC LIMIT 5"
        ).fetchall()
        return {
            "users": one("SELECT COUNT(*) FROM users"),
            "active_users": one("SELECT COUNT(*) FROM users WHERE is_active = 1"),
            "users_active_week": one("SELECT COUNT(DISTINCT user_id) FROM runs WHERE created_at >= ?", week_ago),
            "templates": one("SELECT COUNT(*) FROM workflows WHERE is_template = 1"),
            "runs_total": one("SELECT COUNT(*) FROM runs"),
            "runs_day": one("SELECT COUNT(*) FROM runs WHERE created_at >= ?", day_ago),
            "runs_week": one("SELECT COUNT(*) FROM runs WHERE created_at >= ?", week_ago),
            "errors_week": one("SELECT COUNT(*) FROM runs WHERE status = 'error' AND created_at >= ?", week_ago),
            "cost_week": one("SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE created_at >= ?", week_ago),
            "avg_seconds_week": one(
                "SELECT COALESCE(AVG(duration_ms), 0) / 1000.0 FROM runs WHERE status = 'done' AND created_at >= ?",
                week_ago),
            "by_day": [dict(r) for r in by_day],
            "by_source": [dict(r) for r in by_source],
            "recent_errors": [dict(r) for r in recent_errors],
        }
