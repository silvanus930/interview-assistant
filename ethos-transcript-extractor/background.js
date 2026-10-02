const CALL_PAGES = ['https://*.askethos.com/*'];

// Put the panel into a tab. content.js ignores a second copy of itself.
async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false; // a page the extension may not touch (chrome://, the Web Store, …)
  }
}

// Chrome only adds content scripts to pages loaded after the extension. Attach
// to call pages that are already open, so installing or reloading the extension
// during a call does not need a page reload (which would drop the call).
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: CALL_PAGES });
  for (const tab of tabs) if (tab.id) injectInto(tab.id);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    injectInto(tab.id); // not running in this tab yet: start it (the panel opens visible)
  }
});

// Telegram Bot API proxy (avoids page CSP / CORS issues in the content script)
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'tg') return;
  fetch(`https://api.telegram.org/bot${msg.token}/${msg.method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg.params || {})
  })
    .then((r) => r.json())
    .then(reply)
    .catch((e) => reply({ ok: false, description: e.message }));
  return true; // async reply
});

// Interview Assistant proxy: the local app that turns questions into answers.
// Replies { ok: true, data } or { ok: false, error }.
const SERVER_URL = /^https?:\/\/[^\s/?#]+$/i;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'app') return;
  const base = String(msg.base || '').trim().replace(/\/+$/, '');
  if (!SERVER_URL.test(base)) {
    reply({ ok: false, error: 'The server address must look like http://127.0.0.1:8765 or https://assistant.example.com' });
    return;
  }
  fetch(base + msg.path, {
    method: msg.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Extension-Key': msg.key || '' },
    body: msg.body ? JSON.stringify(msg.body) : undefined
  })
    .then(async (r) => {
      const data = await r.json().catch(() => null);
      if (r.ok) return reply({ ok: true, data });
      const detail = data && data.detail;
      reply({ ok: false, status: r.status, error: typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${r.status}` });
    })
    .catch(() => reply({ ok: false, error: 'Interview Assistant is not running or cannot be reached at ' + base }));
  return true; // async reply
});
