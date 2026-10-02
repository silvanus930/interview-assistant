# Interview Assistant

A multi-user platform that turns interview questions into short, spoken-style answers grounded in each user's résumé.

- **Dashboard (this web app)** — the admin console, plus a personal workspace for every user.
- **Browser extension (`ethos-transcript-extractor/`)** — each user's client during a call: it catches the interviewer's questions on the Ethos call page and shows the answers beside the call.
- **Telegram** — answers are also delivered to each user's chat, and questions sent to the bot are answered.

Claude runs through the Claude Agent SDK on the server.

## Start

Double-click `start.bat`, or:

```text
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python run.py
```

The app opens at <http://127.0.0.1:8765>. Requirements: Python 3.10+ and [Claude Code](https://claude.com/claude-code) installed on the server.

The first visit asks you to create the **administrator account**. If the server already held data from before accounts existed, that account takes it over (profiles, workflows, history, and the extension's existing connection).

## Roles

| | Administrator | User |
| --- | --- | --- |
| Own workspace: profiles (résumés), workflows, history, Ask | yes | yes |
| Account: name, password, model preference | yes | yes |
| Users: create, edit, disable, reset password, delete | yes | no |
| Open another user's workspace to help them | yes | no |
| Templates: the starting workflows every new user receives | yes | read, and copy into own workflows |
| Claude connection, allowed models, Telegram bot | yes | no |
| Overview: usage across all accounts | yes | no |

Accounts are created by an administrator; there is no public sign-up. A new user starts with their own copy of every template and is the only one (besides administrators) who can see their data.

## How Claude is reached, and who may use it

Set under **Claude & Telegram**:

- **Anthropic API key** — pay-per-use. Every account can generate answers. Use this when the server has users other than you.
- **Personal Claude subscription (Pro / Max)** — uses the Claude Code login on the server (`claude` once in a terminal to log in). A personal subscription is for its owner, so in this mode **only administrator accounts can generate answers**; other users see a message asking the administrator to switch to an API key. Anthropic does not allow a subscription's login or limits to be offered to other people through a product, and this rule keeps the server within that.

**Models.** The administrator keeps the list of models users may choose. For each answer the model is the workflow step's choice, else the user's preference (Account), else the server default. A choice that is not on the list falls back to the next one. The aliases `opus`, `sonnet` and `haiku` follow the newest version the server's Claude Code supports; update Claude Code to unlock newer models.

## A user's workspace

| Page | What it does |
| --- | --- |
| Ask | Pick a profile, ask a question, watch the answer stream in. Questions from the extension and Telegram appear here live. |
| Profiles | One profile = candidate + résumé + job description + notes + Telegram chat + workflow. |
| Workflows | The system prompt, the ordered Claude steps, and the Telegram message template. Start one from a template or from scratch. |
| History | Every question and answer, with each step's output and the conversation context. |
| Account | Name, email, password, model and effort preference, and how to sign the extension in. |

### Workflows and prompts

A workflow is a system prompt plus one or more steps. Each step is one Claude call with its own prompt and, optionally, its own model and effort. **Preview prompts** shows exactly what Claude will receive.

To change how answers sound, edit the workflow: the **system prompt** holds who the answers are for, the ground rules and the résumé; the **step prompt** holds the length ("3 or 4 sentences"), the tone, and the rule against repeating earlier answers. Details that change per interview (role, company, job posting, things to stress or avoid) belong on the profile.

Variables for the system prompt and step prompts:

| Variable | Value |
| --- | --- |
| `{{question}}` | What the interviewer just said: the whole message, lead-in included |
| `{{question_short}}` | Only the question sentence(s) of that message |
| `{{resume}}`, `{{job_description}}`, `{{notes}}` | From the profile |
| `{{candidate_name}}`, `{{role}}`, `{{company}}` | From the profile |
| `{{context}}` | The conversation before that message, sent by the extension |
| `{{history}}` | Answers already given earlier in this interview (last 3 hours) |
| `{{previous}}`, `{{steps.KEY}}` | Output of the previous step, or of the step with that key |
| `{{date}}` | Today's date |

The Telegram message template additionally has `{{output}}` and `{{step_name}}`. If a workflow's prompts mention neither `{{context}}` nor `{{history}}`, they are attached to the question automatically.

## The extension (client)

1. Load it: `chrome://extensions` → Developer mode → **Load unpacked** → the `ethos-transcript-extractor` folder.
2. Click its toolbar icon and sign in with the server address and the same email and password as the dashboard.
3. On the call page, open the panel's settings, pick the profile to answer with, and save.

Sign-in happens in the extension's own popup, so the password is never typed into the call page. The extension keeps a per-user key, not the password; **Account → Sign out the extension everywhere** replaces that key. See the extension's own README for the panel.

## Telegram

One bot serves every user. The administrator adds the bot token under **Claude & Telegram**. Each user opens the bot, sends `/start` to get their chat ID, and puts it on a profile. Answers for that profile go to that chat, and questions sent from it are answered with that profile.

## Serving other people

By default the server listens on this computer only. To let other machines reach it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `INTERVIEW_HOST` | `127.0.0.1` | Address to listen on (`0.0.0.0` for all interfaces) |
| `INTERVIEW_PORT` | `8765` | Port |
| `INTERVIEW_ALLOWED_HOSTS` | `127.0.0.1,localhost,[::1]` | Host names the server answers for, comma-separated (`*` for any) |
| `INTERVIEW_DATA_DIR` | `./data` | Where the database lives |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Self-hosted Bot API server |

Put it behind HTTPS (a reverse proxy such as Caddy or nginx) before exposing it beyond a trusted network: passwords and session cookies travel in the clear over plain HTTP. Switch Claude to an API key before giving anyone else an account.

## Security

- Passwords are stored as salted scrypt hashes. Sessions are random tokens in an HttpOnly, SameSite cookie; only their hash is stored. Changing a password or disabling an account signs it out everywhere.
- Repeated wrong passwords are slowed down (8 per account, 40 per address, per 10 minutes).
- Every workspace request is scoped to the signed-in user; another user's ids return "not found".
- The server rejects requests for host names it is not configured for, and cookie-authenticated writes from other websites. The extension routes (`/api/ext/*`) use a key in a header instead of the cookie.
- Claude runs with no tools: it cannot read files, run commands or browse.
- Everything is in `data/interview.db` (SQLite), including résumés, the bot token and the API key, unencrypted. Keep that folder private and back it up; deleting it resets the server.

## Layout

```text
app/
  main.py           FastAPI app and all /api routes
  auth.py           passwords, sessions, roles, sign-in limiter
  workflow.py       template rendering, the step runner, model and access rules
  claude_runner.py  one Claude call through the Claude Agent SDK
  telegram.py       Bot API client and the incoming-question listener
  resume.py         PDF / DOCX / text extraction
  db.py             SQLite storage and upgrades
  seeds.py          starter prompts, templates and settings
web/                the dashboard (plain HTML, CSS and ES modules; no build step)
ethos-transcript-extractor/   the browser extension
run.py              entry point
```
