const $ = (id) => document.getElementById(id);
let tabId = null;

const stamp = (s, t) => {
  const x = Math.max(0, Math.floor((t - s.startedAt) / 1000));
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const toText = (s) =>
  `Ethos call transcript\nURL: ${s.url}\nStarted: ${new Date(s.startedAt).toLocaleString()}\n\n` +
  s.segments.map((g) => `[${stamp(s, g.t)}] ${g.text}`).join('\n\n') + '\n';

function download(s) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toText(s)], { type: 'text/plain' }));
  a.download = `ethos-transcript-${new Date(s.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click();
}

// The panel script answers 'status' when it is running in the tab.
async function panelStatus() {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'status' }); } catch { return null; }
}
// Start the panel in a page that was already open when the extension was loaded
// (Chrome only adds it automatically to pages loaded afterwards).
async function startPanel() {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch { return false; }
}
const isCallPage = (url) => {
  try { return /(^|\.)askethos\.com$/.test(new URL(url).hostname); } catch { return false; }
};

function showStatus(r) {
  $('copy').disabled = !r;
  $('show').textContent = r ? 'Show panel' : 'Start on this page';
  $('status').textContent = !r
    ? 'The panel is not running on this page. Open your Ethos call page, or start it here.'
    : r.detected
      ? `${r.paused ? 'Paused' : 'Live'} · ${r.lines} line${r.lines === 1 ? '' : 's'} captured`
      : `Transcript box not found yet · ${r.lines} lines. Open the transcript on the page.`;
}

// ---------- Interview Assistant account ----------
// The panel on the call page reads these settings; it picks up changes at once.
const DEFAULT_SERVER = 'http://127.0.0.1:8765';
const loadSettings = async () => (await chrome.storage.local.get('settings')).settings || {};
const saveSettings = async (changes) => chrome.storage.local.set({ settings: { ...(await loadSettings()), ...changes } });
const server = (base, key, method, path, body) =>
  chrome.runtime.sendMessage({ type: 'app', base, key, method, path, body }).catch((e) => ({ ok: false, error: e.message }));

async function renderAccount() {
  const s = await loadSettings();
  const signedIn = Boolean(s.appKey);
  $('signin').hidden = signedIn;
  $('account').hidden = !signedIn;
  $('notice').hidden = true;
  if (!signedIn) {
    $('server').value = s.appUrl || DEFAULT_SERVER;
    $('email').value = s.appEmail || '';
    return;
  }
  $('who').textContent = s.appUser || s.appEmail || 'Signed in';
  $('where').textContent = s.appUrl || DEFAULT_SERVER;
  // Confirm the sign-in still works (the account may have been disabled or its key replaced).
  const r = await server(s.appUrl || DEFAULT_SERVER, s.appKey, 'GET', '/api/ext/ping');
  if (r.ok) {
    $('who').textContent = r.data.user.name;
    if (r.data.user.name !== s.appUser) await saveSettings({ appUser: r.data.user.name, appEmail: r.data.user.email });
    if (r.data.can_generate === false) { $('notice').textContent = r.data.message; $('notice').hidden = false; }
    else if (!r.data.profiles.length) { $('notice').textContent = 'Add a profile with your résumé in the Interview Assistant dashboard.'; $('notice').hidden = false; }
  } else {
    $('notice').textContent = r.status === 401 ? 'Your sign-in is no longer valid. Sign out and sign in again.' : r.error;
    $('notice').hidden = false;
  }
}

$('signin').onsubmit = async (event) => {
  event.preventDefault();
  const base = $('server').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
  $('login').disabled = true;
  $('loginerr').hidden = true;
  const r = await server(base, '', 'POST', '/api/ext/login', { email: $('email').value.trim(), password: $('password').value });
  $('login').disabled = false;
  if (!r.ok) {
    $('loginerr').textContent = r.error;
    $('loginerr').hidden = false;
    return;
  }
  $('password').value = '';
  // A different account has different profiles: forget the previous choice.
  await saveSettings({ appUrl: base, appKey: r.data.key, appUser: r.data.name, appEmail: r.data.email, appProfileId: '', appProfileName: '' });
  renderAccount();
};
$('logout').onclick = async () => {
  await saveSettings({ appKey: '', appUser: '', appProfileId: '', appProfileName: '' });
  renderAccount();
};

async function init() {
  renderAccount();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  let r = await panelStatus();
  if (!r && isCallPage(tab?.url) && (await startPanel())) r = await panelStatus();
  showStatus(r);
  renderList();
}

async function renderList() {
  const { txIndex = [] } = await chrome.storage.local.get('txIndex');
  const data = txIndex.length ? await chrome.storage.local.get(txIndex) : {};
  const ul = $('list');
  ul.innerHTML = '';
  const items = txIndex.map((id) => data[id]).filter(Boolean);
  if (!items.length) { ul.innerHTML = '<li class="muted">Nothing saved yet.</li>'; return; }
  for (const s of items) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="meta"><div>${new Date(s.startedAt).toLocaleString()} · ${s.segments.length} lines</div>
      <div class="muted"></div></div>`;
    li.querySelector('.muted').textContent = s.segments[0]?.text || '';
    const dl = document.createElement('button'); dl.textContent = '⬇'; dl.title = 'Download .txt';
    dl.onclick = () => download(s);
    const cp = document.createElement('button'); cp.textContent = '⧉'; cp.title = 'Copy';
    cp.onclick = () => navigator.clipboard.writeText(toText(s));
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Delete';
    del.onclick = async () => {
      const { txIndex = [] } = await chrome.storage.local.get('txIndex');
      await chrome.storage.local.remove(s.id);
      await chrome.storage.local.set({ txIndex: txIndex.filter((x) => x !== s.id) });
      renderList();
    };
    li.append(dl, cp, del);
    ul.appendChild(li);
  }
}

$('show').onclick = async () => {
  if (!(await panelStatus())) {
    if (!(await startPanel())) {
      $('status').textContent = 'The panel cannot run on this page (browser pages and the Web Store are off limits).';
      return;
    }
  }
  chrome.tabs.sendMessage(tabId, { type: 'show' }).catch(() => {});
  showStatus(await panelStatus());
};
$('copy').onclick = async () => {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'text' });
  await navigator.clipboard.writeText(r.text);
  $('copy').textContent = 'Copied';
};

init();
