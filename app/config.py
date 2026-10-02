import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"
DATA_DIR = Path(os.environ.get("INTERVIEW_DATA_DIR") or ROOT_DIR / "data")
# Override to point at a self-hosted Telegram Bot API server.
TELEGRAM_API_BASE = (os.environ.get("TELEGRAM_API_BASE") or "https://api.telegram.org").rstrip("/")
DB_PATH = DATA_DIR / "interview.db"
# Claude runs with this as its working directory so it never picks up
# project files or CLAUDE.md from wherever the server was started.
CLAUDE_CWD = DATA_DIR / "claude-cwd"

# The server listens on this machine only unless told otherwise. To serve other
# people, bind a reachable address, list the hostnames it is reached by, and put
# it behind HTTPS.
HOST = os.environ.get("INTERVIEW_HOST") or "127.0.0.1"
PORT = int(os.environ.get("INTERVIEW_PORT") or 8765)
ALLOWED_HOSTS = [
    h.strip().lower()
    for h in (os.environ.get("INTERVIEW_ALLOWED_HOSTS") or "127.0.0.1,localhost,[::1]").split(",")
    if h.strip()
]
# The administrator account created on first start, when the server has no
# accounts yet. There is no setup screen; change the password under Account.
DEFAULT_ADMIN_EMAIL = os.environ.get("INTERVIEW_ADMIN_EMAIL") or "silvanus97930@gmail.com"
DEFAULT_ADMIN_PASSWORD = os.environ.get("INTERVIEW_ADMIN_PASSWORD") or "!vidrnd930!"
DEFAULT_ADMIN_NAME = os.environ.get("INTERVIEW_ADMIN_NAME") or "Administrator"
SESSION_DAYS = 30
MIN_PASSWORD_LENGTH = 8

# The starting list of models users may choose from; the admin edits it in the
# dashboard. The bare aliases follow whatever the installed Claude Code version
# maps them to.
MODEL_SUGGESTIONS = [
    {"id": "opus", "label": "opus — latest Opus your Claude Code supports"},
    {"id": "sonnet", "label": "sonnet — latest Sonnet your Claude Code supports"},
    {"id": "haiku", "label": "haiku — fastest"},
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5 (needs Claude Code 2.1.280+)"},
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5"},
    {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5"},
    {"id": "claude-fable-5-1", "label": "Claude Fable 5.1"},
]
EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]

MAX_RESUME_BYTES = 15 * 1024 * 1024
CLAUDE_TIMEOUT_SECONDS = 240
MAX_CONCURRENT_CLAUDE_CALLS = 3
