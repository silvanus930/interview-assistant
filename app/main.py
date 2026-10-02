import json
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import auth, claude_runner, db, telegram, workflow
from .claude_runner import ClaudeError, run_claude
from .config import (ALLOWED_HOSTS, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD, EFFORT_LEVELS,
                     MAX_RESUME_BYTES, MIN_PASSWORD_LENGTH, WEB_DIR)
from .resume import ResumeError, extract_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx logs full request URLs at INFO, and Telegram URLs contain the bot token.
logging.getLogger("httpx").setLevel(logging.WARNING)

User = dict[str, Any]


async def on_telegram_question(profile: dict[str, Any], text: str, chat_id: str) -> None:
    wf = workflow.resolve_workflow(profile)
    if not wf:
        await telegram.send_message(chat_id, "No workflow is configured. Create one in the Interview Assistant.")
        return
    workflow.start_run(profile, wf, text, source="telegram", reply_chat_id=chat_id, session=f"tg:{chat_id}")


listener = telegram.TelegramListener(on_telegram_question)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    if db.count_users() == 0:
        db.create_user(email=DEFAULT_ADMIN_EMAIL, name=DEFAULT_ADMIN_NAME,
                       password_hash=auth.hash_password(DEFAULT_ADMIN_PASSWORD), role="admin")
    await listener.restart()
    yield
    await listener.stop()
    await claude_runner.shutdown()


app = FastAPI(title="Interview Assistant", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# The extension calls /api/ext/* from its own origin and signs in with a key in
# a header (never a cookie), so those routes can be open to any origin.
EXT_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Extension-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
}


@app.middleware("http")
async def guard(request: Request, call_next):
    """Reject requests for a hostname this server is not meant to answer for
    (DNS rebinding), and cookie-authenticated writes that come from another
    website (CSRF)."""
    host = (request.headers.get("host") or "").lower()
    hostname = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    if "*" not in ALLOWED_HOSTS and hostname not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "This server does not answer for that host name."}, status_code=403)

    is_ext = request.url.path.startswith("/api/ext/")
    if is_ext and request.method == "OPTIONS":
        return Response(status_code=204, headers=EXT_CORS)
    origin = request.headers.get("origin")
    if not is_ext and origin and request.method not in ("GET", "HEAD", "OPTIONS"):
        if urlparse(origin).netloc.lower() != host:
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)

    response = await call_next(request)
    if is_ext:
        response.headers.update(EXT_CORS)
    elif not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ------------------------------------------------------------------ schemas

def _password(value: str) -> str:
    if len(value) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Use at least {MIN_PASSWORD_LENGTH} characters.")
    return value


def _email(value: str) -> str:
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise ValueError("Enter a valid email address.")
    return value


def _role(value: str) -> str:
    if value not in ("user", "admin"):
        raise ValueError("Role must be 'user' or 'admin'.")
    return value


def _effort(value: str) -> str:
    if value and value not in EFFORT_LEVELS:
        raise ValueError(f"Effort must be one of: {', '.join(EFFORT_LEVELS)}.")
    return value


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    target_role: str = ""
    company: str = ""
    job_description: str = ""
    notes: str = ""
    resume_filename: str = ""
    resume_text: str = ""
    telegram_chat_id: str = ""
    telegram_listen: bool = True
    workflow_id: int | None = None

    @field_validator("name", "telegram_chat_id", "target_role", "company")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("telegram_chat_id")
    @classmethod
    def chat_id_format(cls, value: str) -> str:
        if value and not re.fullmatch(r"-?\d+|@[A-Za-z0-9_]{4,}", value):
            raise ValueError("Chat ID must be a number (e.g. 123456789) or a public @channelname.")
        return value


class StepIn(BaseModel):
    key: str = ""
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1)
    model: str = ""
    effort: str = ""
    send_to_telegram: bool = False
    enabled: bool = True

    _check_effort = field_validator("effort")(_effort)


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    system_prompt: str = ""
    telegram_template: str = "{{output}}"
    steps: list[StepIn] = Field(min_length=1)


class RunIn(BaseModel):
    profile_id: int
    workflow_id: int | None = None
    question: str = Field(min_length=1)
    send_telegram: bool = True


class PreviewIn(BaseModel):
    workflow: WorkflowIn
    profile_id: int | None = None
    question: str = ""


class ChatIn(BaseModel):
    chat_id: str = Field(min_length=1)


class LoginIn(BaseModel):
    email: str
    password: str


class SetupIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str
    password: str

    _check_email = field_validator("email")(_email)
    _check_password = field_validator("password")(_password)


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str
    model: str = ""
    effort: str = ""
    current_password: str = ""
    new_password: str = ""

    _check_email = field_validator("email")(_email)
    _check_effort = field_validator("effort")(_effort)


class AccessDecisionIn(BaseModel):
    decision: Literal["approve", "reject", "revoke"]


class UserCreateIn(SetupIn):
    role: str = "user"

    _check_role = field_validator("role")(_role)


class UserUpdateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str
    role: str
    is_active: bool = True
    model: str = ""
    effort: str = ""
    new_password: str = ""

    _check_email = field_validator("email")(_email)
    _check_effort = field_validator("effort")(_effort)
    _check_role = field_validator("role")(_role)


class ModelIn(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = ""


class AdminSettingsIn(BaseModel):
    auth_mode: str = "subscription"
    # None leaves a stored secret unchanged; "" clears it.
    anthropic_api_key: str | None = None
    telegram_bot_token: str | None = None
    default_model: str = "opus"
    default_effort: str = "low"
    models: list[ModelIn] = Field(min_length=1)
    telegram_listener_enabled: bool = True

    _check_effort = field_validator("default_effort")(_effort)

    @field_validator("auth_mode")
    @classmethod
    def mode(cls, value: str) -> str:
        if value not in ("subscription", "api_key"):
            raise ValueError("auth_mode must be 'subscription' or 'api_key'.")
        return value


class WarmIn(BaseModel):
    profile_id: int | None = None
    workflow_id: int | None = None


class ExtQuestionIn(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    context: str = Field(default="", max_length=20000)
    session: str = Field(default="", max_length=200)  # one id per call, groups an interview's answers
    profile_id: int | None = None
    send_telegram: bool = True


# ------------------------------------------------------------------ helpers

def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "step"


def _workflow_data(body: WorkflowIn) -> dict[str, Any]:
    data = body.model_dump()
    seen: set[str] = set()
    for step in data["steps"]:
        base = _slug(step["key"] or step["name"])
        key, n = base, 2
        while key in seen:
            key, n = f"{base}_{n}", n + 1
        seen.add(key)
        step["key"] = key
    return data


def _or_404(value: Any, what: str) -> Any:
    if value is None:
        raise HTTPException(404, f"{what} not found.")
    return value


def _hint(secret: str) -> str:
    return f"…{secret[-4:]}" if len(secret) >= 8 else ("saved" if secret else "")


def _public_user(user: User) -> dict[str, Any]:
    hidden = {"password_hash", "extension_key"}
    return {k: v for k, v in user.items() if k not in hidden}


def _check_model(model: str) -> str:
    model = model.strip()
    if model and model not in {m["id"] for m in db.allowed_models()}:
        raise HTTPException(422, f"“{model}” is not one of the models the administrator has enabled.")
    return model


# --------------------------------------------------------------------- auth

@app.get("/api/auth/state")
def auth_state(request: Request) -> dict[str, Any]:
    user = auth.session_user(request)
    return {"user": _public_user(user) if user else None}


@app.post("/api/auth/login")
def auth_login(body: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    user = auth.authenticate(request, body.email, body.password)
    auth.start_session(response, request, user["id"])
    return {"user": _public_user(user)}


@app.post("/api/auth/logout", status_code=204)
def auth_logout(request: Request, response: Response) -> None:
    auth.end_session(response, request)


@app.get("/api/account")
def account_get(user: User = Depends(auth.signed_in)) -> dict[str, Any]:
    return {**_public_user(user), "extension_key": user["extension_key"]}


@app.put("/api/account")
def account_update(body: AccountIn, user: User = Depends(auth.signed_in)) -> dict[str, Any]:
    fields: dict[str, Any] = {"name": body.name.strip(), "model": _check_model(body.model), "effort": body.effort}
    if body.email != user["email"]:
        if db.get_user_by_email(body.email):
            raise HTTPException(409, "Another account already uses that email.")
        fields["email"] = body.email
    if body.new_password:
        if not auth.verify_password(body.current_password, user["password_hash"]):
            raise HTTPException(403, "Your current password is not correct.")
        try:
            fields["password_hash"] = auth.hash_password(_password(body.new_password))
        except ValueError as exc:
            raise HTTPException(422, f"New password: {exc}") from exc
    updated = db.update_user(user["id"], **fields)
    # Changing the password signs out every session, including this one; the UI logs in again.
    return {**_public_user(updated), "extension_key": updated["extension_key"],
            "signed_out": "password_hash" in fields}


@app.post("/api/account/access-request")
def account_request_access(user: User = Depends(auth.signed_in)) -> dict[str, Any]:
    """Ask an administrator for permission to generate answers on the server's API key."""
    if user["role"] == "admin":
        raise HTTPException(409, "Administrators can always generate answers.")
    if user["access_status"] == "approved":
        raise HTTPException(409, "Your account already has access.")
    if db.get_settings()["auth_mode"] != "api_key":
        raise HTTPException(409, workflow.SUBSCRIPTION_ONLY_ADMIN)
    updated = db.update_user(user["id"], access_status="pending", access_requested_at=db.now())
    return _public_user(updated)


@app.delete("/api/account/access-request")
def account_cancel_access(user: User = Depends(auth.signed_in)) -> dict[str, Any]:
    if user["access_status"] != "pending":
        raise HTTPException(409, "There is no pending request to cancel.")
    return _public_user(db.update_user(user["id"], access_status="none"))


@app.post("/api/account/extension-key")
def account_new_key(user: User = Depends(auth.signed_in)) -> dict[str, Any]:
    """Sign the browser extension out everywhere by replacing its key."""
    updated = db.update_user(user["id"], extension_key=auth.new_extension_key())
    return {"extension_key": updated["extension_key"]}


# ------------------------------------------------------------------- status

@app.get("/api/status")
def status(user: User = Depends(auth.current_user), me: User = Depends(auth.signed_in)) -> dict[str, Any]:
    settings = db.get_settings()
    bot = listener.status()
    return {
        "auth_mode": settings["auth_mode"],
        "default_model": settings["default_model"],
        "can_generate": workflow.can_generate(user, settings),
        "access_message": workflow.access_block(user, settings),
        "telegram": {
            "state": bot["state"], "bot_username": bot["bot_username"], "bot_name": bot["bot_name"],
            "error": bot["error"] if me["role"] == "admin" else "",
            "token_set": bool(settings["telegram_bot_token"].strip()),
            "listener_enabled": settings["telegram_listener_enabled"] == "1",
        },
        "counts": db.counts(user["id"]),
    }


@app.get("/api/meta")
def meta(_: User = Depends(auth.signed_in)) -> dict[str, Any]:
    settings = db.get_settings()
    return {
        "models": db.allowed_models(),
        "efforts": EFFORT_LEVELS,
        "default_model": settings["default_model"],
        "default_effort": settings["default_effort"],
        "variables": workflow.VARIABLES,
        "telegram_variables": workflow.TELEGRAM_VARIABLES,
    }


# ----------------------------------------------------------------- telegram

@app.get("/api/telegram/chats")
def telegram_chats(user: User = Depends(auth.current_user), me: User = Depends(auth.signed_in)) -> list[dict[str, Any]]:
    """Chats that messaged the bot recently, to help a user find their chat ID."""
    chats = sorted(listener.recent_chats.values(), key=lambda c: c["seen_at"], reverse=True)
    if me["role"] == "admin":
        return chats
    # Other users only see fresh chats that are not already someone else's.
    visible = []
    for chat in chats:
        owner = db.find_profile_by_chat(chat["chat_id"])
        if (owner is None and time.time() - chat["seen_at"] < 900) or (owner and owner["user_id"] == user["id"]):
            visible.append(chat)
    return visible


@app.post("/api/telegram/send-test")
async def telegram_send_test(body: ChatIn, _: User = Depends(auth.current_user)) -> dict[str, Any]:
    try:
        await telegram.send_message(body.chat_id, "✅ Interview Assistant is connected to this chat.")
    except telegram.TelegramError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


# ------------------------------------------------------------------- resume

@app.post("/api/resume/extract")
async def resume_extract(file: UploadFile = File(...), _: User = Depends(auth.current_user)) -> dict[str, Any]:
    data = await file.read(MAX_RESUME_BYTES + 1)
    if len(data) > MAX_RESUME_BYTES:
        raise HTTPException(413, "File is larger than 15 MB.")
    try:
        text = extract_text(file.filename or "resume", data)
    except ResumeError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"filename": file.filename, "text": text, "chars": len(text)}


# ----------------------------------------------------------------- profiles

def _profile_data(body: ProfileIn, user: User) -> dict[str, Any]:
    data = body.model_dump()
    if data["workflow_id"] and not db.get_workflow(data["workflow_id"], user["id"]):
        data["workflow_id"] = None  # not this user's workflow, or deleted meanwhile
    return data


@app.get("/api/profiles")
def profiles_list(user: User = Depends(auth.current_user)) -> list[dict[str, Any]]:
    return db.list_profiles(user["id"])


@app.post("/api/profiles", status_code=201)
def profiles_create(body: ProfileIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return db.create_profile(_profile_data(body, user), user["id"])


@app.put("/api/profiles/{profile_id}")
def profiles_update(profile_id: int, body: ProfileIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    _or_404(db.get_profile(profile_id, user["id"]), "Profile")
    return db.update_profile(profile_id, _profile_data(body, user), user["id"])


@app.delete("/api/profiles/{profile_id}", status_code=204)
def profiles_delete(profile_id: int, user: User = Depends(auth.current_user)) -> None:
    db.delete_profile(profile_id, user["id"])


# ---------------------------------------------------- workflows & templates
# The same operations serve a user's own workflows (owner = their id) and the
# shared templates (owner = None, admins only).

def _wf_list(owner: int | None) -> list[dict[str, Any]]:
    return db.list_workflows(owner)


def _wf_create(body: WorkflowIn, owner: int | None) -> dict[str, Any]:
    return db.create_workflow(_workflow_data(body), owner)


def _wf_update(workflow_id: int, body: WorkflowIn, owner: int | None) -> dict[str, Any]:
    _or_404(db.get_workflow(workflow_id, owner), "Workflow")
    return db.update_workflow(workflow_id, _workflow_data(body), owner)


def _wf_default(workflow_id: int, owner: int | None) -> dict[str, Any]:
    _or_404(db.get_workflow(workflow_id, owner), "Workflow")
    db.set_default_workflow(workflow_id, owner)
    return db.get_workflow(workflow_id, owner)


def _wf_duplicate(workflow_id: int, owner: int | None) -> dict[str, Any]:
    source = _or_404(db.get_workflow(workflow_id, owner), "Workflow")
    return db.create_workflow({**source, "name": f"{source['name']} (copy)"}, owner)


def _wf_delete(workflow_id: int, owner: int | None) -> None:
    if len(db.list_workflows(owner)) <= 1:
        raise HTTPException(409, "Keep at least one.")
    db.delete_workflow(workflow_id, owner)


@app.get("/api/workflows")
def workflows_list(user: User = Depends(auth.current_user)) -> list[dict[str, Any]]:
    return _wf_list(user["id"])


@app.post("/api/workflows", status_code=201)
def workflows_create(body: WorkflowIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return _wf_create(body, user["id"])


@app.post("/api/workflows/preview")
def workflows_preview(body: PreviewIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    profile = db.get_profile(body.profile_id, user["id"]) if body.profile_id else None
    if profile is None:
        profile = {"name": "", "target_role": "", "company": "", "job_description": "",
                   "notes": "", "resume_text": ""}
    return workflow.preview(_workflow_data(body.workflow), profile,
                            body.question.strip() or "Tell me about yourself.")


@app.put("/api/workflows/{workflow_id}")
def workflows_update(workflow_id: int, body: WorkflowIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return _wf_update(workflow_id, body, user["id"])


@app.post("/api/workflows/{workflow_id}/default")
def workflows_set_default(workflow_id: int, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return _wf_default(workflow_id, user["id"])


@app.post("/api/workflows/{workflow_id}/duplicate", status_code=201)
def workflows_duplicate(workflow_id: int, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return _wf_duplicate(workflow_id, user["id"])


@app.delete("/api/workflows/{workflow_id}", status_code=204)
def workflows_delete(workflow_id: int, user: User = Depends(auth.current_user)) -> None:
    _wf_delete(workflow_id, user["id"])


@app.get("/api/templates")
def templates_list(_: User = Depends(auth.signed_in)) -> list[dict[str, Any]]:
    """Templates any user can start a workflow from."""
    return db.list_workflows(None)


@app.post("/api/templates/{template_id}/use", status_code=201)
def templates_use(template_id: int, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    """Copy a template into the user's own workflows."""
    template = _or_404(db.get_workflow(template_id, None), "Template")
    return db.create_workflow(template, user["id"])


# --------------------------------------------------------------------- runs

def _visible_run(run_id: int, request: Request) -> dict[str, Any]:
    """A run the signed-in person may see: their own, or any run for an admin."""
    me = auth.signed_in(request)
    return _or_404(db.get_run(run_id, None if me["role"] == "admin" else me["id"]), "Run")


@app.get("/api/runs")
def runs_list(limit: int = 100, profile_id: int | None = None,
              user: User = Depends(auth.current_user)) -> list[dict[str, Any]]:
    return db.list_runs(user["id"], max(1, min(limit, 500)), profile_id)


@app.post("/api/runs", status_code=201)
async def runs_create(body: RunIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    profile = _or_404(db.get_profile(body.profile_id, user["id"]), "Profile")
    wf = _or_404(workflow.resolve_workflow(profile, body.workflow_id), "Workflow")
    return workflow.start_run(profile, wf, body.question.strip(), source="ui", send_telegram=body.send_telegram)


def _prepare(user: User, body: WarmIn) -> dict[str, Any]:
    """Start Claude ahead of the next question for one of the user's profiles."""
    if body.profile_id:
        profile = db.get_profile(body.profile_id, user["id"])
    else:
        profile = next(iter(db.list_profiles(user["id"])), None)
    wf = workflow.resolve_workflow(profile, body.workflow_id) if profile else None
    return {"ready": bool(profile and wf and workflow.prepare(profile, wf))}


@app.post("/api/runs/warm")
async def runs_warm(body: WarmIn, user: User = Depends(auth.current_user)) -> dict[str, Any]:
    return _prepare(user, body)


@app.get("/api/runs/{run_id}")
def runs_get(run_id: int, request: Request) -> dict[str, Any]:
    return _visible_run(run_id, request)


@app.get("/api/runs/{run_id}/events")
async def runs_events(run_id: int, request: Request) -> StreamingResponse:
    run = _visible_run(run_id, request)
    live = workflow.live_events(run_id)

    async def stream():
        if live is None:
            # Finished long ago (or before a restart): replay the stored result.
            kind = "done" if run["status"] == "done" else "error"
            yield f"data: {json.dumps({'type': kind, 'run': run})}\n\n"
            return
        async for event in live.stream():
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/runs/{run_id}/resend")
async def runs_resend(run_id: int, request: Request) -> dict[str, Any]:
    run = _visible_run(run_id, request)
    if not run["final_output"]:
        raise HTTPException(409, "This run has no answer to send.")
    try:
        await workflow.resend(run)
    except telegram.TelegramError as exc:
        raise HTTPException(502, str(exc)) from exc
    return db.get_run(run_id)


@app.delete("/api/runs/{run_id}", status_code=204)
def runs_delete(run_id: int, user: User = Depends(auth.current_user)) -> None:
    db.delete_run(run_id, user["id"])


@app.delete("/api/runs", status_code=204)
def runs_clear(user: User = Depends(auth.current_user)) -> None:
    db.clear_runs(user["id"])


# -------------------------------------------------------------------- admin

@app.get("/api/admin/overview")
def admin_overview(_: User = Depends(auth.admin_user)) -> dict[str, Any]:
    settings = db.get_settings()
    return {**db.overview(), "auth_mode": settings["auth_mode"], "default_model": settings["default_model"],
            "telegram": listener.status()}


@app.get("/api/admin/users")
def admin_users(_: User = Depends(auth.admin_user)) -> list[dict[str, Any]]:
    return [_public_user(u) for u in db.list_users()]


@app.post("/api/admin/users", status_code=201)
def admin_user_create(body: UserCreateIn, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    if db.get_user_by_email(body.email):
        raise HTTPException(409, "An account with that email already exists.")
    user = db.create_user(email=body.email, name=body.name, password_hash=auth.hash_password(body.password),
                          role=body.role)
    return _public_user(user)


@app.put("/api/admin/users/{user_id}")
def admin_user_update(user_id: int, body: UserUpdateIn, me: User = Depends(auth.admin_user)) -> dict[str, Any]:
    target = _or_404(db.get_user(user_id), "User")
    other = db.get_user_by_email(body.email)
    if other and other["id"] != user_id:
        raise HTTPException(409, "Another account already uses that email.")
    losing_admin = target["role"] == "admin" and target["is_active"] and (body.role != "admin" or not body.is_active)
    if losing_admin and db.count_active_admins(excluding=user_id) == 0:
        raise HTTPException(409, "This is the only active administrator. Make someone else an administrator first.")
    if user_id == me["id"] and not body.is_active:
        raise HTTPException(409, "You cannot deactivate your own account.")
    fields: dict[str, Any] = {"name": body.name.strip(), "email": body.email, "role": body.role,
                              "is_active": body.is_active, "model": _check_model(body.model), "effort": body.effort}
    if body.new_password:
        try:
            fields["password_hash"] = auth.hash_password(_password(body.new_password))
        except ValueError as exc:
            raise HTTPException(422, f"New password: {exc}") from exc
    return _public_user(db.update_user(user_id, **fields))


@app.post("/api/admin/users/{user_id}/access")
def admin_user_access(user_id: int, body: AccessDecisionIn, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    """Approve or reject a request to generate answers, or revoke access already given."""
    target = _or_404(db.get_user(user_id), "User")
    if target["role"] == "admin":
        raise HTTPException(409, "Administrators can always generate answers.")
    status = {"approve": "approved", "reject": "rejected", "revoke": "none"}[body.decision]
    return _public_user(db.update_user(user_id, access_status=status))


@app.delete("/api/admin/users/{user_id}", status_code=204)
def admin_user_delete(user_id: int, me: User = Depends(auth.admin_user)) -> None:
    if user_id == me["id"]:
        raise HTTPException(409, "You cannot delete your own account.")
    _or_404(db.get_user(user_id), "User")
    db.delete_user(user_id)


def _admin_settings() -> dict[str, Any]:
    s = db.get_settings()
    return {
        "auth_mode": s["auth_mode"],
        "default_model": s["default_model"],
        "default_effort": s["default_effort"],
        "models": db.allowed_models(),
        "telegram_listener_enabled": s["telegram_listener_enabled"] == "1",
        "anthropic_api_key_hint": _hint(s["anthropic_api_key"]),
        "telegram_bot_token_hint": _hint(s["telegram_bot_token"]),
    }


@app.get("/api/admin/settings")
def admin_settings_get(_: User = Depends(auth.admin_user)) -> dict[str, Any]:
    return _admin_settings()


@app.put("/api/admin/settings")
async def admin_settings_put(body: AdminSettingsIn, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    models: list[dict[str, str]] = []
    for model in body.models:
        model_id = model.id.strip()
        if model_id and model_id not in {m["id"] for m in models}:
            models.append({"id": model_id, "label": model.label.strip() or model_id})
    default = body.default_model.strip() or models[0]["id"]
    if default not in {m["id"] for m in models}:
        raise HTTPException(422, "The default model must be one of the enabled models.")
    values = {
        "auth_mode": body.auth_mode,
        "default_model": default,
        "default_effort": body.default_effort,
        "models": json.dumps(models),
        "telegram_listener_enabled": "1" if body.telegram_listener_enabled else "0",
    }
    if body.anthropic_api_key is not None:
        values["anthropic_api_key"] = body.anthropic_api_key.strip()
    if body.telegram_bot_token is not None:
        values["telegram_bot_token"] = body.telegram_bot_token.strip()
        values["telegram_update_offset"] = "0"  # offsets belong to the bot they came from
    db.set_settings(values)
    await listener.restart()
    return _admin_settings()


@app.post("/api/admin/test-claude")
async def admin_test_claude(_: User = Depends(auth.admin_user)) -> dict[str, Any]:
    try:
        result = await run_claude(
            system_prompt="This is a connection test. Reply with the single word: OK",
            prompt="Connection test.",
        )
    except ClaudeError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True, "reply": result.text[:200], "model": result.model, "cli_version": result.cli_version,
        "auth_source": result.auth_source, "duration_ms": result.duration_ms,
    }


@app.post("/api/admin/test-telegram")
async def admin_test_telegram(_: User = Depends(auth.admin_user)) -> dict[str, Any]:
    try:
        bot = await telegram.call("getMe")
    except telegram.TelegramError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "username": bot.get("username", ""), "name": bot.get("first_name", "")}


@app.get("/api/admin/templates")
def admin_templates(_: User = Depends(auth.admin_user)) -> list[dict[str, Any]]:
    return _wf_list(None)


@app.post("/api/admin/templates", status_code=201)
def admin_template_create(body: WorkflowIn, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    return _wf_create(body, None)


@app.put("/api/admin/templates/{template_id}")
def admin_template_update(template_id: int, body: WorkflowIn, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    return _wf_update(template_id, body, None)


@app.post("/api/admin/templates/{template_id}/default")
def admin_template_default(template_id: int, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    return _wf_default(template_id, None)


@app.post("/api/admin/templates/{template_id}/duplicate", status_code=201)
def admin_template_duplicate(template_id: int, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    return _wf_duplicate(template_id, None)


@app.delete("/api/admin/templates/{template_id}", status_code=204)
def admin_template_delete(template_id: int, _: User = Depends(auth.admin_user)) -> None:
    _wf_delete(template_id, None)


@app.post("/api/admin/templates/{template_id}/distribute")
def admin_template_distribute(template_id: int, _: User = Depends(auth.admin_user)) -> dict[str, Any]:
    """Add a copy of this template to every user's workflows (existing workflows are left alone)."""
    template = _or_404(db.get_workflow(template_id, None), "Template")
    users = db.list_users()
    for user in users:
        db.create_workflow(template, user["id"])
    return {"users": len(users)}


# -------------------------------------------------------- browser extension
# The extension is the user's client: it signs in with an email and password,
# keeps the returned key, and sends it with every request.

@app.post("/api/ext/login")
def ext_login(body: LoginIn, request: Request) -> dict[str, Any]:
    user = auth.authenticate(request, body.email, body.password)
    return {"key": user["extension_key"], "name": user["name"], "email": user["email"]}


@app.get("/api/ext/ping")
def ext_ping(user: User = Depends(auth.extension_user)) -> dict[str, Any]:
    blocked = workflow.access_block(user)
    return {
        "ok": True,
        "app": "Interview Assistant",
        "user": {"name": user["name"], "email": user["email"]},
        "can_generate": not blocked,
        "message": blocked,
        "profiles": [
            {"id": p["id"], "name": p["name"], "has_resume": bool(p["resume_text"].strip()),
             "has_chat": bool(p["telegram_chat_id"])}
            for p in db.list_profiles(user["id"])
        ],
    }


@app.post("/api/ext/warm")
async def ext_warm(body: WarmIn, user: User = Depends(auth.extension_user)) -> dict[str, Any]:
    """Called by the extension when a call starts, so the first answer is fast too."""
    return _prepare(user, WarmIn(profile_id=body.profile_id))


@app.post("/api/ext/questions", status_code=201)
async def ext_question(body: ExtQuestionIn, user: User = Depends(auth.extension_user)) -> dict[str, Any]:
    if body.profile_id:
        profile = db.get_profile(body.profile_id, user["id"])
        if profile is None:
            raise HTTPException(404, "The selected profile no longer exists. Pick another in the extension settings.")
    else:
        profiles = db.list_profiles(user["id"])  # most recently edited first
        if not profiles:
            raise HTTPException(409, "Add a profile with your résumé in the Interview Assistant first.")
        profile = profiles[0]
    wf = _or_404(workflow.resolve_workflow(profile), "Workflow")
    run = workflow.start_run(profile, wf, body.question.strip(), source="extension",
                             send_telegram=body.send_telegram, context=body.context,
                             session=f"ext:{body.session}" if body.session else "")
    return {"run_id": run["id"], "profile": profile["name"], "workflow": wf["name"]}


@app.get("/api/ext/runs/{run_id}")
def ext_run(run_id: int, user: User = Depends(auth.extension_user)) -> dict[str, Any]:
    """Pollable state of a run: the answer so far while it is being written."""
    run = _or_404(db.get_run(run_id, user["id"]), "Run")
    output, step = run["final_output"], ""
    live = workflow.live_events(run_id)
    if run["status"] == "running" and live is not None and live.step_index >= 0:
        last = live.step_index == live.step_total - 1
        # Only the final step's text is the answer; earlier steps are working notes.
        output = live.partial if last else ""
        step = live.step_name if live.step_total == 1 else f"{live.step_name} ({live.step_index + 1}/{live.step_total})"
    return {"id": run["id"], "status": run["status"], "output": output, "step": step,
            "error": run["error"], "telegram_status": run["telegram_status"]}


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
