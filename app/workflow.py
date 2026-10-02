"""Workflow engine: renders prompt templates and runs a workflow's steps in order."""

import asyncio
import logging
import re
import time
from datetime import date
from typing import Any

from . import db, telegram
from . import claude_runner
from .claude_runner import ClaudeError, run_claude

log = logging.getLogger("workflow")

VARIABLES = [
    {"name": "question", "description": "What the interviewer just said: the whole message, lead-in included"},
    {"name": "question_short", "description": "Only the question sentence(s) of that message"},
    {"name": "resume", "description": "Résumé text of the profile"},
    {"name": "job_description", "description": "Job description of the profile"},
    {"name": "notes", "description": "Extra notes of the profile"},
    {"name": "candidate_name", "description": "Profile name"},
    {"name": "role", "description": "Target role"},
    {"name": "company", "description": "Target company"},
    {"name": "context", "description": "The conversation before that message, sent by the browser extension"},
    {"name": "history", "description": "Answers already given earlier in this interview (extension and Telegram)"},
    {"name": "previous", "description": "Output of the previous step"},
    {"name": "steps.KEY", "description": "Output of the earlier step with that key"},
    {"name": "date", "description": "Today's date"},
]
TELEGRAM_VARIABLES = [
    {"name": "output", "description": "The step's answer"},
    {"name": "question_short", "description": "Only the question sentence(s)"},
    {"name": "question", "description": "The interviewer's whole message"},
    {"name": "step_name", "description": "Name of the step that produced the answer"},
    {"name": "candidate_name", "description": "Profile name"},
]

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][\w.\-]*)\s*\}\}")


def render(template: str, variables: dict[str, str]) -> str:
    """Replace {{name}} placeholders. Unknown names are left as written."""
    return _PLACEHOLDER.sub(lambda m: variables.get(m.group(1), m.group(0)), template)


# An interview session's earlier answers are shown to Claude so it does not repeat itself.
HISTORY_HOURS = 3
HISTORY_LIMIT = 12


def short_question(text: str) -> str:
    """Only the question sentences of an interviewer message, for compact display."""
    sentences = re.split(r"(?<=[.!?…])\s+", " ".join(text.split()))
    questions = [s for s in sentences if re.search(r"\?[)\"'”’\]]*$", s)]
    if questions:
        return " ".join(questions)
    return text if len(text) <= 200 else text[:197].rstrip() + "…"


def session_history(session: str, user_id: int, question: str) -> str:
    """Earlier questions and answers of this interview, oldest first."""
    if not session:
        return ""
    entries = []
    for run in db.session_runs(session, user_id, HISTORY_HOURS, HISTORY_LIMIT):
        if run["question"].strip() == question.strip():
            continue  # regenerating: the previous attempt at this same message is not "already said"
        answer = run["final_output"]
        if len(answer) > 700:
            answer = answer[:700].rstrip() + "…"
        entries.append(f"Asked: {short_question(run['question'])}\nAnswered: {answer}")
    return "\n\n".join(entries)


def base_variables(profile: dict[str, Any], question: str, context: str = "",
                   history: str = "") -> dict[str, str]:
    return {
        "question": question,
        "question_short": short_question(question),
        "context": context.strip() or "(nothing before this)",
        "history": history.strip() or "(none yet)",
        "resume": profile["resume_text"].strip() or "(no résumé uploaded)",
        "job_description": profile["job_description"].strip() or "(not provided)",
        "notes": profile["notes"].strip() or "(none)",
        "candidate_name": profile["name"].strip() or "the candidate",
        "role": profile["target_role"].strip() or "the target role",
        "company": profile["company"].strip() or "the company",
        "previous": "",
        "date": date.today().isoformat(),
    }


def prompt_variables(workflow: dict[str, Any], profile: dict[str, Any], question: str,
                     context: str = "", history: str = "") -> dict[str, str]:
    """Variables for rendering a workflow's prompts.

    A workflow places the earlier conversation with {{context}} and the answers
    already given with {{history}}. If its prompts mention neither, they are
    attached to {{question}} instead, so that follow-up questions still make
    sense to Claude and it can avoid repeating itself.
    """
    variables = base_variables(profile, question, context, history)
    prompts = [workflow["system_prompt"], *(s["prompt"] for s in workflow["steps"] if s.get("enabled", True))]
    used = {name for text in prompts for name in _PLACEHOLDER.findall(text)}
    extras = []
    if context.strip() and "context" not in used:
        extras.append(f"The conversation before this message:\n{context.strip()}")
    if history.strip() and "history" not in used:
        extras.append(f"Answers already given earlier in this interview (do not repeat them):\n{history.strip()}")
    if extras:
        variables["question"] = "\n\n".join([question, *extras])
    return variables


def preview(workflow: dict[str, Any], profile: dict[str, Any], question: str) -> dict[str, Any]:
    """Render every prompt without calling Claude; step outputs show as placeholders."""
    variables = base_variables(profile, question)
    steps = []
    for step in workflow["steps"]:
        if not step.get("enabled", True):
            continue
        steps.append({"name": step["name"], "prompt": render(step["prompt"], variables)})
        placeholder = f"[output of “{step['name']}”]"
        variables["previous"] = placeholder
        variables[f"steps.{step['key']}"] = placeholder
    return {"system_prompt": render(workflow["system_prompt"], base_variables(profile, question)), "steps": steps}


def prepare(profile: dict[str, Any], workflow: dict[str, Any]) -> bool:
    """Get Claude running for this profile's next question, so the answer does not wait for it to start.

    Returns False when there is nothing to prepare (the owner may not generate, or no steps).
    """
    owner = db.get_user(profile["user_id"])
    settings = db.get_settings()
    steps = [s for s in workflow["steps"] if s.get("enabled", True)]
    if owner is None or not steps or not can_generate(owner, settings):
        return False
    system_prompt = render(workflow["system_prompt"], prompt_variables(workflow, profile, ""))
    model, effort = resolve_model(steps[0], owner, settings)
    claude_runner.keep_ready(system_prompt=system_prompt, model=model, effort=effort)
    return True


class RunEvents:
    """In-memory event log for one run, replayable by late SSE subscribers."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.done = False
        self._changed = asyncio.Condition()
        # Progress of the step currently running, for clients that poll instead of streaming.
        self.step_index = -1
        self.step_total = 0
        self.step_name = ""
        self.partial = ""

    async def emit(self, event: dict[str, Any]) -> None:
        if event["type"] == "step_start":
            self.step_index, self.step_total, self.step_name = event["index"], event["total"], event["name"]
            self.partial = ""
        elif event["type"] == "delta":
            self.partial += event["text"]
        async with self._changed:
            self.events.append(event)
            if event["type"] in ("done", "error"):
                self.done = True
            self._changed.notify_all()

    async def stream(self):
        index = 0
        while True:
            async with self._changed:
                await self._changed.wait_for(lambda: index < len(self.events) or self.done)
                batch = self.events[index:]
                index = len(self.events)
                finished = self.done
            for event in batch:
                yield event
            if finished and index >= len(self.events):
                return


_live: dict[int, RunEvents] = {}
_tasks: set[asyncio.Task] = set()


def live_events(run_id: int) -> RunEvents | None:
    return _live.get(run_id)


def resolve_workflow(profile: dict[str, Any], workflow_id: int | None = None) -> dict[str, Any] | None:
    """The workflow that answers for this profile: the one asked for, else the
    profile's own, else its owner's default. Only the owner's workflows count."""
    owner = profile["user_id"]
    for candidate in (workflow_id, profile.get("workflow_id")):
        if candidate:
            workflow = db.get_workflow(candidate, owner)
            if workflow:
                return workflow
    return db.get_default_workflow(owner)


SUBSCRIPTION_ONLY_ADMIN = (
    "This server runs on its owner's Claude subscription, which only administrator accounts may use. "
    "Ask the administrator to add an Anthropic API key (Admin → Claude) so that other accounts can generate answers."
)


def can_generate(user: dict[str, Any], settings: dict[str, str] | None = None) -> bool:
    """A personal Claude subscription may serve its owner only; other accounts need the server on an API key."""
    settings = settings or db.get_settings()
    return settings["auth_mode"] == "api_key" or user["role"] == "admin"


def resolve_model(step: dict[str, Any], user: dict[str, Any], settings: dict[str, str]) -> tuple[str, str]:
    """Model and effort for one step: the step's choice, else the user's, else the server default.
    A model the admin has not allowed falls through to the next choice."""
    allowed = {m["id"] for m in db.allowed_models()}
    default = settings["default_model"]
    model = next((m for m in (step.get("model"), user.get("model")) if m and m in allowed), default)
    effort = step.get("effort") or user.get("effort") or settings["default_effort"]
    return model, effort


def start_run(
    profile: dict[str, Any],
    workflow: dict[str, Any],
    question: str,
    *,
    source: str = "ui",
    send_telegram: bool = True,
    reply_chat_id: str | None = None,
    context: str = "",
    session: str = "",
) -> dict[str, Any]:
    """Create the run record and execute it in the background. Returns the run row.

    `session` groups the runs of one interview; earlier answers in the same
    session are given to Claude as {{history}}.
    """
    run = db.create_run(profile, workflow, question, source, context, session)
    _live[run["id"]] = RunEvents()
    task = asyncio.create_task(
        _execute(run["id"], profile, workflow, question, send_telegram, reply_chat_id, context, session)
    )
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return run


async def _deliver(chat_id: str, template: str, variables: dict[str, str]) -> str:
    """Send one answer to Telegram. Returns '' on success or the error text."""
    try:
        await telegram.send_message(chat_id, render(template or "{{output}}", variables))
        return ""
    except telegram.TelegramError as exc:
        return str(exc)


async def _keep_typing(chat_id: str) -> None:
    while True:
        await telegram.send_typing(chat_id)
        await asyncio.sleep(4)


async def _execute(
    run_id: int,
    profile: dict[str, Any],
    workflow: dict[str, Any],
    question: str,
    send_telegram: bool,
    reply_chat_id: str | None,
    context: str = "",
    session: str = "",
) -> None:
    events = _live[run_id]
    started = time.monotonic()
    owner = db.get_user(profile["user_id"]) or {"id": profile["user_id"], "role": "user", "model": "", "effort": ""}
    settings = db.get_settings()
    variables = prompt_variables(workflow, profile, question, context,
                                 session_history(session, owner["id"], question))
    system_prompt = render(workflow["system_prompt"], variables)
    chat_id = reply_chat_id or profile["telegram_chat_id"].strip()
    steps = [s for s in workflow["steps"] if s.get("enabled", True)]
    results: list[dict[str, Any]] = []
    sent: list[str] = []
    send_errors: list[str] = []
    total_cost = 0.0
    wanted_without_chat = False
    typing =asyncio.create_task(_keep_typing(chat_id)) if reply_chat_id else None

    def telegram_status() -> str:
        if send_errors:
            return "failed: " + "; ".join(dict.fromkeys(send_errors))
        if sent:
            return "sent"
        if not send_telegram:
            return "skipped"
        return "no chat ID" if wanted_without_chat else ""

    try:
        if not can_generate(owner, settings):
            raise ClaudeError(SUBSCRIPTION_ONLY_ADMIN)
        if not steps:
            raise ClaudeError("This workflow has no enabled steps.")
        for index, step in enumerate(steps):
            record = {
                "key": step["key"], "name": step["name"], "status": "running", "output": "",
                "model": "", "duration_ms": 0, "cost_usd": 0.0, "telegram": "",
            }
            results.append(record)
            db.update_run(run_id, steps=results)
            await events.emit({"type": "step_start", "index": index, "name": step["name"], "total": len(steps)})

            async def on_delta(text: str, index: int = index) -> None:
                await events.emit({"type": "delta", "index": index, "text": text})

            model, effort = resolve_model(step, owner, settings)
            try:
                outcome = await run_claude(
                    system_prompt=system_prompt,
                    prompt=render(step["prompt"], variables),
                    model=model,
                    effort=effort,
                    on_delta=on_delta,
                    keep_warm=True,  # the next question in this interview is likely soon
                )
            except ClaudeError:
                record["status"] = "error"
                raise

            total_cost += outcome.cost_usd
            record.update(status="done", output=outcome.text, model=outcome.model,
                          duration_ms=outcome.duration_ms, cost_usd=outcome.cost_usd)
            variables["previous"] = outcome.text
            variables[f"steps.{step['key']}"] = outcome.text

            if send_telegram and step.get("send_to_telegram"):
                if chat_id:
                    error = await _deliver(chat_id, workflow["telegram_template"],
                                           {**variables, "question": question, "output": outcome.text,
                                            "step_name": step["name"]})
                    record["telegram"] = f"failed: {error}" if error else "sent"
                    (send_errors if error else sent).append(error or step["key"])
                else:
                    record["telegram"] = "skipped: no chat ID"
                    wanted_without_chat = True
            db.update_run(run_id, steps=results)
            await events.emit({"type": "step_done", "index": index, "step": record})

        final = results[-1]["output"]
        # A question that arrived from Telegram always gets a reply, even when
        # no step in the workflow is marked to send.
        if reply_chat_id and not sent and not send_errors:
            error = await _deliver(reply_chat_id, workflow["telegram_template"],
                                   {**variables, "question": question, "output": final,
                                    "step_name": results[-1]["name"]})
            (send_errors if error else sent).append(error or "final")

        db.update_run(
            run_id, status="done", steps=results, final_output=final, telegram_status=telegram_status(),
            duration_ms=int((time.monotonic() - started) * 1000), cost_usd=total_cost, finished_at=db.now(),
        )
        await events.emit({"type": "done", "run": db.get_run(run_id)})
    except Exception as exc:
        message = str(exc) if isinstance(exc, ClaudeError) else f"{type(exc).__name__}: {exc}"
        if not isinstance(exc, ClaudeError):
            log.exception("Run %s failed", run_id)
        if reply_chat_id:
            await _deliver(reply_chat_id, "{{output}}", {"output": f"⚠️ Could not generate an answer: {message}"})
        db.update_run(
            run_id, status="error", steps=results, error=message, telegram_status=telegram_status(),
            duration_ms=int((time.monotonic() - started) * 1000), cost_usd=total_cost, finished_at=db.now(),
        )
        await events.emit({"type": "error", "run": db.get_run(run_id)})
    finally:
        if typing:
            typing.cancel()
        # Keep the event log briefly so a client that connects late still gets the replay.
        asyncio.get_running_loop().call_later(120, _live.pop, run_id, None)


async def resend(run: dict[str, Any]) -> None:
    """Send a finished run's final answer to its profile's Telegram chat again."""
    profile = db.get_profile(run["profile_id"], run["user_id"]) if run["profile_id"] else None
    if not profile:
        raise telegram.TelegramError("The profile for this run no longer exists.")
    workflow = db.get_workflow(run["workflow_id"], run["user_id"]) if run["workflow_id"] else None
    template = workflow["telegram_template"] if workflow else "{{output}}"
    variables = {**base_variables(profile, run["question"]), "output": run["final_output"],
                 "step_name": run["steps"][-1]["name"] if run["steps"] else ""}
    await telegram.send_message(profile["telegram_chat_id"], render(template or "{{output}}", variables))
    db.update_run(run["id"], telegram_status="sent")
