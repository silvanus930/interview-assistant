"""Runs one prompt through Claude via the Claude Agent SDK.

The SDK drives the locally installed Claude Code CLI, so in "subscription"
mode it uses whatever account `claude` is logged in with (e.g. a Max plan).
In "api_key" mode the key from Settings is passed to the CLI instead.
"""

import asyncio
import os
import tempfile
from dataclasses import dataclass
from typing import Awaitable, Callable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKError,
    CLINotFoundError,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    query,
)

from . import db
from .config import CLAUDE_CWD, CLAUDE_TIMEOUT_SECONDS, MAX_CONCURRENT_CLAUDE_CALLS

DeltaCallback = Callable[[str], Awaitable[None]]

_semaphore = asyncio.Semaphore(MAX_CONCURRENT_CLAUDE_CALLS)

# The SDK otherwise spawns `claude --version` before every call (~1s each).
os.environ.setdefault("CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK", "1")


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


def _build_env(settings: dict[str, str]) -> dict[str, str]:
    if settings["auth_mode"] == "api_key":
        key = settings["anthropic_api_key"].strip()
        if not key:
            raise ClaudeError("API key mode is selected but no Anthropic API key is saved in Settings.")
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


async def run_claude(
    *,
    system_prompt: str,
    prompt: str,
    model: str = "",
    effort: str = "",
    on_delta: DeltaCallback | None = None,
) -> ClaudeResult:
    settings = db.get_settings()
    model = model or settings["default_model"]
    effort = effort or settings["default_effort"]
    env = _build_env(settings)

    # The system prompt carries the whole résumé; pass it as a file so it is
    # never limited by the Windows command-line length.
    fd, system_path = tempfile.mkstemp(prefix="system-", suffix=".txt", dir=CLAUDE_CWD)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(system_prompt)

    options = ClaudeAgentOptions(
        system_prompt={"type": "file", "path": system_path},
        model=model,
        effort=_effort_for(model, effort),
        # Haiku has no effort setting and, left to think, takes ~15s before the
        # first word; it is picked for speed, so turn its thinking off.
        thinking={"type": "disabled"} if _is_haiku(model) else None,
        tools=[],  # pure text generation: no file, shell or web access
        setting_sources=[],  # ignore user/project Claude Code settings and CLAUDE.md
        max_turns=1,
        include_partial_messages=on_delta is not None,
        cwd=CLAUDE_CWD,
        env=env,
        extra_args={"no-session-persistence": None},
    )

    result = ClaudeResult(text="", model=model)
    chunks: list[str] = []
    failure = ""

    async def consume() -> None:
        nonlocal failure
        async for message in query(prompt=prompt, options=options):
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

    try:
        async with _semaphore:
            await asyncio.wait_for(consume(), timeout=CLAUDE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise ClaudeError(f"Claude did not answer within {CLAUDE_TIMEOUT_SECONDS} seconds.") from exc
    except CLINotFoundError as exc:
        raise ClaudeError(
            "Claude Code is not installed or not on PATH. Install it and run `claude` once to log in."
        ) from exc
    except ClaudeSDKError as exc:
        # A failed run reports its reason in the result message before the CLI
        # exits non-zero; that reason is more useful than the exit code.
        raise ClaudeError(failure or str(exc)) from exc
    finally:
        try:
            os.unlink(system_path)
        except OSError:
            pass

    if failure:
        raise ClaudeError(failure)
    result.text = "\n\n".join(chunks).strip()
    if not result.text:
        raise ClaudeError("Claude returned an empty answer.")
    return result
