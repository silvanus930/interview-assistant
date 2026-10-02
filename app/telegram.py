"""Telegram Bot API client and the long-polling listener for incoming questions."""

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

import httpx

from . import db
from .config import TELEGRAM_API_BASE as API_BASE

log = logging.getLogger("telegram")

MESSAGE_LIMIT = 4096
POLL_SECONDS = 25


class TelegramError(Exception):
    pass


def _token() -> str:
    token = db.get_settings()["telegram_bot_token"].strip()
    if not token:
        raise TelegramError("No Telegram bot token saved. Add one in Settings.")
    return token


async def call(method: str, payload: dict[str, Any] | None = None, *, token: str | None = None,
               timeout: float = 20) -> Any:
    token = token or _token()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{API_BASE}/bot{token}/{method}", json=payload or {})
    except httpx.HTTPError as exc:
        # httpx puts the full URL in its message; never echo the bot token.
        raise TelegramError(f"Could not reach Telegram ({type(exc).__name__}).") from None
    try:
        body = response.json()
    except ValueError:
        raise TelegramError(f"Telegram returned HTTP {response.status_code}.") from None
    if not body.get("ok"):
        raise TelegramError(body.get("description") or f"Telegram returned HTTP {response.status_code}.")
    return body["result"]


def split_message(text: str, limit: int = MESSAGE_LIMIT) -> list[str]:
    """Split on paragraph, then line, then word boundaries to fit Telegram's limit."""
    chunks: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        cut = max(rest.rfind("\n\n", 0, limit), rest.rfind("\n", 0, limit))
        if cut < limit // 2:
            cut = rest.rfind(" ", 0, limit)
        if cut < limit // 2:
            cut = limit
        chunks.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        chunks.append(rest)
    return chunks


async def send_message(chat_id: str, text: str) -> None:
    chat_id = str(chat_id).strip()
    if not chat_id:
        raise TelegramError("This profile has no Telegram chat ID.")
    # Sent as plain text: model output is not valid Telegram markup.
    for chunk in split_message(text):
        await call("sendMessage", {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True})


async def send_typing(chat_id: str) -> None:
    try:
        await call("sendChatAction", {"chat_id": chat_id, "action": "typing"}, timeout=10)
    except TelegramError:
        pass


QuestionHandler = Callable[[dict[str, Any], str, str], Awaitable[None]]


class TelegramListener:
    """Long-polls getUpdates and hands each text message from a known chat to `on_question`."""

    def __init__(self, on_question: QuestionHandler) -> None:
        self._on_question = on_question
        self._task: asyncio.Task | None = None
        self._handlers: set[asyncio.Task] = set()
        self.state = "stopped"  # stopped | running | error
        self.error = ""
        self.bot: dict[str, Any] | None = None
        # Chats that messaged the bot since startup, for the "detect chat ID" helper.
        self.recent_chats: dict[str, dict[str, Any]] = {}

    def status(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "error": self.error,
            "bot_username": (self.bot or {}).get("username", ""),
            "bot_name": (self.bot or {}).get("first_name", ""),
        }

    async def restart(self) -> None:
        await self.stop()
        settings = db.get_settings()
        if not settings["telegram_bot_token"].strip() or settings["telegram_listener_enabled"] != "1":
            return
        self._task = asyncio.create_task(self._run(settings["telegram_bot_token"].strip()))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self.state, self.error, self.bot = "stopped", "", None

    async def _run(self, token: str) -> None:
        backoff = 2
        offset = int(db.get_settings().get("telegram_update_offset") or 0)
        while True:
            try:
                if self.bot is None:
                    self.bot = await call("getMe", token=token)
                    self.state, self.error = "running", ""
                updates = await call(
                    "getUpdates",
                    {"offset": offset, "timeout": POLL_SECONDS, "allowed_updates": ["message"]},
                    token=token,
                    timeout=POLL_SECONDS + 15,
                )
                self.state, self.error, backoff = "running", "", 2
                for update in updates:
                    offset = max(offset, update["update_id"] + 1)
                    self._dispatch(update)
                if updates:
                    db.set_settings({"telegram_update_offset": str(offset)})
            except asyncio.CancelledError:
                raise
            except TelegramError as exc:
                self.state, self.error = "error", str(exc)
                log.warning("Telegram listener: %s", exc)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
            except Exception as exc:  # keep the listener alive through anything unexpected
                self.state, self.error = "error", f"{type(exc).__name__}: {exc}"
                log.exception("Telegram listener crashed; retrying")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    def _dispatch(self, update: dict[str, Any]) -> None:
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        text = (message.get("text") or "").strip()
        if not chat or not text:
            return
        chat_id = str(chat["id"])
        title = chat.get("title") or " ".join(
            part for part in (chat.get("first_name"), chat.get("last_name")) if part
        ) or chat.get("username") or chat_id
        self.recent_chats[chat_id] = {
            "chat_id": chat_id,
            "title": title,
            "username": chat.get("username") or "",
            "type": chat.get("type") or "",
            "last_text": text[:120],
            "seen_at": time.time(),
        }
        task = asyncio.create_task(self._handle(chat_id, title, text))
        self._handlers.add(task)
        task.add_done_callback(self._handlers.discard)

    async def _handle(self, chat_id: str, title: str, text: str) -> None:
        try:
            profile = db.find_profile_by_chat(chat_id)
            command = text.split()[0].split("@")[0].lower() if text.startswith("/") else ""
            if command in ("/start", "/id", "/help") or not profile:
                lines = [f"Your chat ID is {chat_id}."]
                if profile:
                    lines.append(
                        f"This chat is linked to the profile “{profile['name']}”. "
                        "Send any interview question and I will reply with a spoken-style answer."
                    )
                else:
                    lines.append(
                        "It is not linked to a profile yet. Open the Interview Assistant, "
                        "edit a profile and paste this chat ID into its Telegram field."
                    )
                await send_message(chat_id, "\n\n".join(lines))
                return
            if command:
                await send_message(chat_id, "Unknown command. Send an interview question as a normal message.")
                return
            await self._on_question(profile, text, chat_id)
        except Exception:
            log.exception("Failed to handle Telegram message from chat %s (%s)", chat_id, title)
