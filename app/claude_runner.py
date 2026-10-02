"""Runs one prompt through Claude via the Claude Agent SDK.

The SDK drives the locally installed Claude Code CLI, so in "subscription"
mode it uses whatever account `claude` is logged in with (e.g. a Max plan).
In "api_key" mode the key from the admin settings is passed to the CLI instead.

Starting the CLI takes several seconds, most of the wait for a short answer.
So a process is kept ready ("warm") for the prompt that is likely to come next:
the same system prompt and model as the answer just given, or the ones a
client asked to prepare. A warm process answers one question and is replaced.
"""

import asyncio
import hashlib
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    CLINotFoundError,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
)

from . import db
from .config import CLAUDE_CWD, CLAUDE_TIMEOUT_SECONDS, MAX_CONCURRENT_CLAUDE_CALLS

log = logging.getLogger("claude")

DeltaCallback = Callable[[str], Awaitable[None]]

_semaphore = asyncio.Semaphore(MAX_CONCURRENT_CLAUDE_CALLS)

# The SDK otherwise spawns `claude --version` before every call (~1s each).
os.environ.setdefault("CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK", "1")

STARTUP_TIMEOUT_SECONDS = 60
WARM_MAX_PROCESSES = 8      # idle processes kept ready across all users
WARM_MAX_AGE_SECONDS = 900  # an idle process older than this is replaced, not used
WARM_REFRESH_SECONDS = 420  # a "keep ready" request replaces one older than this


class ClaudeError(Exception):
    pass


@dataclass
class ClaudeResult:
    text: str
    model: str = ""
    duration_ms: int = 0
    cost_usd: float = 0.0
    cli_version: str = ""
    auth_source: str = ""
    warm: bool = False  # answered by a process that was already running


def _build_env(settings: dict[str, str]) -> dict[str, str]:
    if settings["auth_mode"] == "api_key":
        key = settings["anthropic_api_key"].strip()
        if not key:
            raise ClaudeError("API key mode is selected but no Anthropic API key is saved (Admin → Claude & Telegram).")
        return {"ANTHROPIC_API_KEY": key}
    # Subscription mode: an API key inherited from the environment would take
    # precedence over the Claude Code login, so drop it from this process.
    os.environ.pop("ANTHROPIC_API_KEY", None)
    return {}


def _is_haiku(model: str) -> bool:
    return "haiku" in model.lower()


def _effort_for(model: str, effort: str) -> str | None:
    # Haiku does not accept an effort level.
    if not effort or _is_haiku(model):
        return None
    return effort


def _key(system_prompt: str, model: str, effort: str, env: dict[str, str]) -> str:
    """Identifies a process configuration: a warm process is only reused for exactly this."""
    parts = [model, effort or "", env.get("ANTHROPIC_API_KEY", ""), system_prompt]
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


class _Process:
    """One Claude Code process. It starts, waits for a single prompt, answers it, and exits.

    Everything touching the SDK client happens inside this object's own task:
    the client must be connected, used and closed from the same task.
    """

    def __init__(self, key: str, system_prompt: str, model: str, effort: str, env: dict[str, str]) -> None:
        self.key = key
        self.started = time.monotonic()
        self.ready = asyncio.Event()
        self.failure: BaseException | None = None
        self._closing = False
        self._job: asyncio.Future[tuple[str, asyncio.Queue[Any]]] = asyncio.get_running_loop().create_future()
        self._task = asyncio.create_task(self._run(system_prompt, model, effort, env))

    @property
    def age(self) -> float:
        return time.monotonic() - self.started

    def submit(self, prompt: str) -> "asyncio.Queue[Any]":
        """Hand over the prompt. Messages arrive on the queue; None marks the end, an exception a failure."""
        out: asyncio.Queue[Any] = asyncio.Queue()
        self._job.set_result((prompt, out))
        return out

    def discard(self) -> None:
        """Stop the process unless it is already shutting itself down."""
        if not self._closing and not self._task.done():
            self._task.cancel()

    async def _run(self, system_prompt: str, model: str, effort: str, env: dict[str, str]) -> None:
        # The system prompt carries the whole résumé; pass it as a file so it is
        # never limited by the Windows command-line length.
        fd, system_path = tempfile.mkstemp(prefix="system-", suffix=".txt", dir=CLAUDE_CWD)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(system_prompt)
        client = ClaudeSDKClient(ClaudeAgentOptions(
            system_prompt={"type": "file", "path": system_path},
            model=model,
            effort=_effort_for(model, effort),
            # Haiku has no effort setting and, left to think, takes ~15s before the
            # first word; it is picked for speed, so turn its thinking off.
            thinking={"type": "disabled"} if _is_haiku(model) else None,
            tools=[],  # pure text generation: no file, shell or web access
            setting_sources=[],  # ignore user/project Claude Code settings and CLAUDE.md
            max_turns=1,
            include_partial_messages=True,
            cwd=CLAUDE_CWD,
            env=env,
            extra_args={"no-session-persistence": None},
        ))
        out: asyncio.Queue[Any] | None = None
        try:
            try:
                await client.connect()
            except BaseException as exc:
                self.failure = exc
                raise
            finally:
                self.ready.set()
            prompt, out = await self._job  # idle here until a question arrives (or it is discarded)
            await client.query(prompt)
            async for message in client.receive_response():
                await out.put(message)
            await out.put(None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if out is not None:
                await out.put(exc)
        finally:
            self._closing = True  # from here on it cleans up by itself; cancelling again would cut that short
            try:
                await client.disconnect()
            except Exception:
                pass
            try:
                os.unlink(system_path)
            except OSError:
                pass


_warm: dict[str, _Process] = {}
_starting: set[str] = set()


def _take_warm(key: str) -> _Process | None:
    process = _warm.pop(key, None)
    if process is None:
        return None
    if process.failure is not None or process.age > WARM_MAX_AGE_SECONDS:
        process.discard()
        return None
    return process


def _trim() -> None:
    for key, process in list(_warm.items()):
        if process.age > WARM_MAX_AGE_SECONDS or process.failure is not None:
            _warm.pop(key).discard()
    while len(_warm) > WARM_MAX_PROCESSES:
        oldest = min(_warm, key=lambda k: _warm[k].started)
        _warm.pop(oldest).discard()


async def _prewarm(key: str, system_prompt: str, model: str, effort: str, env: dict[str, str]) -> None:
    _starting.add(key)
    try:
        process = _Process(key, system_prompt, model, effort, env)
        await asyncio.wait_for(process.ready.wait(), STARTUP_TIMEOUT_SECONDS)
        if process.failure is not None:
            log.warning("Could not start a ready Claude process: %s", process.failure)
            return
        previous = _warm.pop(key, None)
        if previous is not None:
            previous.discard()
        _warm[key] = process
        _trim()
    except Exception as exc:  # being ready early is an optimisation; never let it break anything
        log.warning("Could not start a ready Claude process: %s", exc)
    finally:
        _starting.discard(key)


def keep_ready(*, system_prompt: str, model: str = "", effort: str = "") -> None:
    """Start a process for this prompt and model in the background, unless a fresh one is waiting."""
    try:
        settings = db.get_settings()
        model = model or settings["default_model"]
        effort = effort or settings["default_effort"]
        env = _build_env(settings)
    except ClaudeError:
        return
    key = _key(system_prompt, model, effort, env)
    existing = _warm.get(key)
    if key in _starting or (existing is not None and existing.failure is None and existing.age < WARM_REFRESH_SECONDS):
        return
    task = asyncio.create_task(_prewarm(key, system_prompt, model, effort, env))
    _background.add(task)
    task.add_done_callback(_background.discard)


_background: set[asyncio.Task] = set()


async def shutdown() -> None:
    """Stop every idle process (server shutdown)."""
    for process in list(_warm.values()):
        process.discard()
    _warm.clear()


async def _answer(process: _Process, prompt: str, result: ClaudeResult, on_delta: DeltaCallback | None) -> str:
    """Send the prompt to a started process and collect the reply. Returns the failure text, '' if none."""
    out = process.submit(prompt)
    chunks: list[str] = []
    failure = ""
    while True:
        message = await out.get()
        if message is None:
            break
        if isinstance(message, Exception):
            raise message
        if isinstance(message, SystemMessage):
            if message.subtype == "init":
                result.model = message.data.get("model") or result.model
                result.cli_version = message.data.get("claude_code_version") or ""
                result.auth_source = message.data.get("apiKeySource") or ""
        elif isinstance(message, StreamEvent):
            event = message.event
            if on_delta and event.get("type") == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    await on_delta(delta["text"])
        elif isinstance(message, AssistantMessage):
            text = "".join(b.text for b in message.content if isinstance(b, TextBlock))
            if message.error:
                failure = text or message.error
            elif text:
                chunks.append(text)
        elif isinstance(message, ResultMessage):
            result.duration_ms = message.duration_ms
            result.cost_usd = message.total_cost_usd or 0.0
            if message.is_error:
                failure = failure or message.result or "; ".join(message.errors or []) or message.subtype
            elif not chunks and message.result:
                chunks.append(message.result)
    result.text = "\n\n".join(chunks).strip()
    return failure


async def run_claude(
    *,
    system_prompt: str,
    prompt: str,
    model: str = "",
    effort: str = "",
    on_delta: DeltaCallback | None = None,
    keep_warm: bool = False,
) -> ClaudeResult:
    """Answer one prompt. With keep_warm, a process is started afterwards for the next question."""
    settings = db.get_settings()
    model = model or settings["default_model"]
    effort = effort or settings["default_effort"]
    env = _build_env(settings)
    key = _key(system_prompt, model, effort, env)

    started = time.monotonic()
    result = ClaudeResult(text="", model=model)
    process = _take_warm(key)
    result.warm = process is not None
    failure = ""
    try:
        async with _semaphore:
            for attempt in (1, 2):
                if process is None:
                    process = _Process(key, system_prompt, model, effort, env)
                await asyncio.wait_for(process.ready.wait(), STARTUP_TIMEOUT_SECONDS)
                if process.failure is not None:
                    raise process.failure
                streamed = False

                async def relay(text: str) -> None:
                    nonlocal streamed
                    streamed = True
                    if on_delta:
                        await on_delta(text)

                try:
                    failure = await asyncio.wait_for(_answer(process, prompt, result, relay), CLAUDE_TIMEOUT_SECONDS)
                    break
                except asyncio.TimeoutError:
                    raise
                except Exception:
                    # A process that sat idle may have died. If it failed before
                    # producing anything, try once more with a fresh one.
                    if result.warm and attempt == 1 and not streamed:
                        process.discard()
                        process, result.warm = None, False
                        continue
                    raise
    except asyncio.TimeoutError as exc:
        raise ClaudeError(f"Claude did not answer within {CLAUDE_TIMEOUT_SECONDS} seconds.") from exc
    except CLINotFoundError as exc:
        raise ClaudeError(
            "Claude Code is not installed or not on PATH on the server. Install it and run `claude` once to log in."
        ) from exc
    except ClaudeError:
        raise
    except Exception as exc:
        raise ClaudeError(failure or str(exc)) from exc
    finally:
        if process is not None:
            process.discard()

    if failure:
        raise ClaudeError(failure)
    if not result.text:
        raise ClaudeError("Claude returned an empty answer.")
    # The CLI reports its own time; what matters to the caller is the whole wait.
    result.duration_ms = int((time.monotonic() - started) * 1000)
    if keep_warm:
        keep_ready(system_prompt=system_prompt, model=model, effort=effort)
    return result
