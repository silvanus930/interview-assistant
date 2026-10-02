/* Ethos Copilot — content script (v1.9)
 * - Joins a panel onto the Ethos call window so the two read as one modal, centered on screen.
 * - Opens the call's transcript automatically ("View transcript").
 * - Reads the transcript (one block per message; right-aligned = you).
 * - "Ethos just asked" card: the latest Ethos reply, one click to copy + send / answer.
 * - Questions list, chat-style transcript, Telegram, Interview Assistant answers.
 * - Auto-answer sends everything Ethos said since the last request as one
 *   message (lead-in and question together), with the conversation so far.
 */
(() => {
  // One live instance per page (see v1.3 notes).
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (!document.dispatchEvent(new CustomEvent('ethos-tx-ping', { cancelable: true }))) return;
  document.getElementById('ethos-tx-host')?.remove();
  document.addEventListener('ethos-tx-ping', (e) => { if (alive()) e.preventDefault(); });

  // ---------- state ----------
  const newSessionObj = () => ({
    id: 'tx_' + Date.now(), url: location.href, title: document.title, startedAt: Date.now(),
    segments: [],   // {t, speaker, text}
    questions: []   // {id, t, text, context, speaker, sent, answer?}
  });
  let session = newSessionObj();
  const seenQ = new Set();
  let settings = {
    token: '', chatId: '', autoSend: false, ethosOnly: true, withContext: false, sendOnCopy: true,
    // set by signing in from the toolbar popup; appKey identifies the user to the server
    appUrl: 'http://127.0.0.1:8765', appKey: '', appUser: '', appEmail: '', appProfileId: '', appProfileName: '',
    autoAnswer: true, appTelegram: true, appContext: true,
    autoOpen: true, dock: true,         // v1.4: page integration
    center: true                        // v1.6: call window + panel centered as one group
  };
  let appProfiles = [];
  let paused = false, pinnedEl = null, currentEl = null, picking = false;
  let firstPass = true;          // questions already on screen at load are not auto-answered
  let view = 'questions';        // questions | transcript | settings
  let lastRaw = '';
  // integration state
  let mode = 'pill';             // docked | floating | pill
  let card = null;               // the Ethos call window
  let callActive = false, closedByUser = false, userHid = false, autoClicks = 0, lastAutoClick = 0, autoClicking = false;
  let pageStatus = '';

  // ---------- helpers ----------
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el.innerText || el.textContent);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const stamp = (t) => {
    const s = Math.max(0, Math.floor((t - session.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const normQ = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return 0; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };

  // ---------- locate the call window + transcript ----------
  const TOGGLE_RE = /^\s*(view|show|hide)\s+transcript\s*$/i;
  const END_RE = /^\s*end\s+call\s*$/i;
  const STATUS_RE = /^(listening|thinking|speaking|ethos is|connecting|reconnecting|muted|paused)/i;
  function findTextEl(re, scope = document.body) {
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (re.test(n.nodeValue) && !host.contains(n.parentElement)) return n.parentElement;
    }
    return null;
  }
  const findToggle = () => { const t = findTextEl(TOGGLE_RE); return t && (t.closest('button,[role=button],a') || t); };
  // The call window: first big, opaque ancestor of the transcript toggle / End call button.
  function findCard() {
    const anchor = findToggle() || findTextEl(END_RE);
    if (!anchor) return null;
    let fallback = null;
    for (let el = anchor.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 240) continue;
      const cs = getComputedStyle(el);
      if (alpha(cs.backgroundColor) > 0.6) return el;
      if (!fallback && parseFloat(cs.borderTopLeftRadius) >= 12) fallback = el;
    }
    return fallback;
  }
  // message list = lowest common ancestor of all <p> paragraphs inside the call window
  function findListIn(scope) {
    const ps = [...scope.querySelectorAll('p')].filter((p) => !host.contains(p) && !p.closest('button,textarea'));
    if (!ps.length) return null;
    let lca = ps[0].parentElement;
    for (const p of ps) while (lca && !lca.contains(p)) lca = lca.parentElement;
    return lca;
  }
  function findTranscriptEl() {
    if (pinnedEl && pinnedEl.isConnected) return pinnedEl;
    if (card) return findListIn(card);
    const tg = findToggle();          // no window detected: look near the toggle only
    let anc = tg;
    for (let i = 0; i < 4 && anc; i++) {
      anc = anc.parentElement;
      if (!anc || anc === document.body) break;
      const list = findListIn(anc);
      if (list) return list;
    }
    return null;
  }

  // ---------- auto-open the transcript ----------
  // Remember when you open/close it yourself, so we never fight you.
  document.addEventListener('click', (e) => {
    if (autoClicking || host.contains(e.target)) return;
    const t = e.target.closest?.('button,[role=button],a');
    if (t && TOGGLE_RE.test(textOf(t))) userHid = /hide/i.test(textOf(t));
  }, true);
  function autoOpenTranscript() {
    if (!settings.autoOpen || userHid || autoClicks >= 3 || Date.now() - lastAutoClick < 2500) return;
    const tg = findToggle();
    if (!tg || !/^(view|show)/i.test(textOf(tg))) return;
    autoClicking = true;
    try { tg.click(); } finally { autoClicking = false; }
    autoClicks++; lastAutoClick = Date.now();
  }

  // ---------- speaker ----------
  function speakerOf(block) {
    const cs = getComputedStyle(block);
    if (cs.justifyContent === 'flex-end' || cs.alignItems === 'flex-end' || cs.textAlign === 'right') return 'You';
    const inner = block.firstElementChild;
    if (inner) {
      const ic = getComputedStyle(inner);
      if (ic.alignSelf === 'flex-end' || ic.marginLeft === 'auto') return 'You';
    }
    return 'Ethos';
  }

  // ---------- questions ----------
  function extractQuestions(seg) {
    if (settings.ethosOnly && seg.speaker === 'You') return;
    const ABBR = /\b(e\.g|i\.e|etc|vs|approx|incl|Mr|Ms|Dr)\./gi;
    const safe = seg.text.replace(ABBR, (m) => m.replace(/\./g, '․'));
    const sentences = safe.match(/[^.!?…]+(?:[.!?…]+[)"'”’\]]*|$)/g) || [];
    for (let s of sentences) {
      s = clean(s).replace(/․/g, '.').replace(/^[—–\-,;:\s]+/, '');
      if (!/\?[)"'”’\]]*$/.test(s)) continue;
      const key = normQ(s);
      if (key.length < 6 || seenQ.has(key)) continue;
      seenQ.add(key);
      const q = { id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6), t: Date.now(),
                  text: s, context: seg.text, speaker: seg.speaker, sent: false, fresh: !firstPass };
      session.questions.push(q);
      if (!firstPass) {
        flash('New question');
        if (settings.autoSend && settings.token && settings.chatId) sendTelegram(q, true);
      }
    }
  }

  // Called whenever a transcript message appears or its text changes
  function segChanged(seg) {
    extractQuestions(seg);
    if (seg.speaker !== 'You') scheduleTurn();
  }

  // ---------- ingest ----------
  function ingestList(list) {
    const blocks = [...list.children].filter((k) => textOf(k).length);
    let dirty = false;
    blocks.forEach((b, i) => {
      const text = textOf(b);
      const speaker = speakerOf(b);
      const seg = session.segments[i];
      if (!seg) { session.segments[i] = { t: Date.now(), speaker, text }; dirty = true; }
      else if (seg.text !== text) { seg.text = text; seg.speaker = speaker; seg.t2 = Date.now(); dirty = true; }
      else return;
      segChanged(session.segments[i]);
    });
    if (dirty) changed();
  }
  function mergeScroll(a, b) {
    if (b.length < 15) return null;
    if (a.includes(b)) return a;
    for (let k = Math.min(a.length, b.length); k >= 15; k--) if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
    return null;
  }
  function ingestBox(el) {
    const text = textOf(el);
    if (!text || text === lastRaw) return;
    lastRaw = text;
    const cur = session.segments[session.segments.length - 1];
    if (cur && !cur.final) {
      if (text.startsWith(cur.text)) { cur.text = text; cur.t2 = Date.now(); segChanged(cur); return changed(); }
      if (cur.text.startsWith(text)) return;
      const m = mergeScroll(cur.text, text);
      if (m !== null) { cur.text = m; cur.t2 = Date.now(); segChanged(cur); return changed(); }
      cur.final = true;
    }
    const seg = { t: Date.now(), speaker: '', text, final: false };
    session.segments.push(seg);
    segChanged(seg);
    changed();
  }

  // ---------- Telegram ----------
  function tgText(q) {
    let msg = `❓ ${q.text}`;
    if (settings.withContext && q.context && q.context !== q.text) msg += `\n\n💬 ${q.context}`;
    return msg;
  }
  const tgReady = () => !!(settings.token && settings.chatId);
  async function tgSend(text) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'tg', token: settings.token, method: 'sendMessage',
        params: { chat_id: settings.chatId, text: text.slice(0, 4000) } });
      if (!r?.ok) flash('Telegram: ' + (r?.description || 'failed'), true);
      return !!r?.ok;
    } catch (e) { flash('Telegram: ' + e.message, true); return false; }
  }
  async function sendTelegram(q, silent) {
    const text = tgText(q);
    if (!tgReady()) { window.open('https://t.me/share/url?url=' + encodeURIComponent(text), '_blank'); return; }
    q.sending = true; render();
    const ok = await tgSend(text);
    q.sending = false;
    if (ok) { q.sent = true; flash(silent ? 'Auto-sent' : 'Sent to Telegram'); }
    changed();
  }
  async function copyAndSend(text, item) {
    await copyText(text, 'Copied');
    if (!settings.sendOnCopy) return;
    if (!tgReady()) { flash('Copied · set up Telegram in settings to also send'); return; }
    if (item) { item.sending = true; render(); }
    const ok = await tgSend(text);
    if (item) { item.sending = false; if (ok) item.sent = true; }
    if (ok) flash('Copied + sent to Telegram');
    changed();
  }
  function ethosTurnEndingAt(end) {
    const segs = session.segments;
    let start = end;
    while (start - 1 >= 0 && segs[start - 1] && segs[start - 1].speaker !== 'You') start--;
    return { start, end };
  }
  function lastEthosTurn() {
    const segs = session.segments;
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i] && segs[i].speaker !== 'You') return ethosTurnEndingAt(i);
    return null;
  }
  const turnText = ({ start, end }) =>
    session.segments.slice(start, end + 1).filter(Boolean).map((s) => s.text).join('\n\n');

  // ---------- Interview Assistant ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const appReady = () => !!(settings.appUrl && settings.appKey);
  async function appCall(method, path, body, cfg = settings) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'app', base: cfg.appUrl, key: cfg.appKey, method, path, body });
      return r || { ok: false, error: 'No response from the extension' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  // Conversation lines up to segment `end`, oldest first, plus any extra lines.
  // Sent with every request so the app can follow the thread of the call.
  const CONTEXT_SEGMENTS = 14;
  const lineOf = (speaker, text) => `${speaker === 'You' ? 'Me' : 'Interviewer'}: ${text}`;
  function contextUpTo(end, extra = []) {
    const segs = session.segments;
    const lines = [];
    for (let i = Math.max(0, end - CONTEXT_SEGMENTS + 1); i <= end; i++) {
      if (segs[i]) lines.push(lineOf(segs[i].speaker, segs[i].text));
    }
    return [...lines, ...extra].join('\n').slice(-7000);
  }
  // What a card sends to the app: the interviewer's whole message (lead-in and
  // question together), and the conversation before it.
  function requestFor(q) {
    if (q.req) return q.req;
    const segs = session.segments;
    let i = segs.length - 1;
    while (i >= 0 && !(segs[i] && segs[i].text.includes(q.text))) i--;
    if (i < 0) return { question: q.context || q.text, context: '' };
    return { question: segs[i].text, context: contextUpTo(i - 1) };
  }
  // Ask the server to start Claude before a question arrives. Starting it takes a
  // few seconds, which would otherwise be added to the first answer of a call;
  // the server lets an unused one expire, so this repeats while a call is on.
  const WARM_EVERY_MS = 4 * 60 * 1000;
  let lastWarm = 0;
  function warmApp(force) {
    if (!appReady() || (!force && Date.now() - lastWarm < WARM_EVERY_MS)) return;
    lastWarm = Date.now();
    appCall('POST', '/api/ext/warm', { profile_id: Number(settings.appProfileId) || null });
  }
  const answerText = (a) =>
    a.status === 'error' ? '⚠ ' + (a.error || 'Could not generate an answer')
      : a.text || (a.step ? a.step + '…' : 'Generating answer…');
  function paintAnswer(q) {
    const el = root.querySelector(`.ans[data-ans="${q.id}"]`);
    if (el) el.textContent = answerText(q.answer); else render();
  }
  async function askApp(q, silent) {
    if (!appReady()) { flash('Sign in first: click the extension icon in the toolbar', true); return; }
    q.fresh = false;
    const a = (q.answer = { status: 'running', text: '', step: '', runId: null });
    render();
    const req = requestFor(q);
    const r = await appCall('POST', '/api/ext/questions', {
      question: req.question.slice(0, 8000), context: settings.appContext ? req.context : '',
      session: session.id, // lets the app remember what was already answered in this call
      profile_id: Number(settings.appProfileId) || null, send_telegram: settings.appTelegram
    });
    if (a !== q.answer) return;
    if (!r.ok) {
      a.status = 'error'; a.error = r.error;
      flash('Assistant: ' + r.error, true);
      return changed();
    }
    a.runId = r.data.run_id;
    if (!silent) flash('Generating answer…');
    let misses = 0;
    while (a === q.answer && a.status === 'running') {
      await sleep(600);
      const p = await appCall('GET', `/api/ext/runs/${a.runId}`);
      if (!p.ok) { if (++misses > 8) { a.status = 'error'; a.error = p.error; } continue; }
      misses = 0;
      a.text = p.data.output || '';
      a.step = p.data.step || '';
      if (p.data.status !== 'running') {
        a.status = p.data.status; a.error = p.data.error; a.telegram = p.data.telegram_status;
      } else paintAnswer(q);
    }
    if (a === q.answer) { if (a.status === 'done') flash('Answer ready'); changed(); }
  }
  // ----- auto-answer: one request per thing Ethos says, not per sentence -----
  // Ethos often speaks in several transcript blocks (a lead-in, then the
  // question, sometimes a second question a few seconds later). Everything it
  // has said since the last request goes to the app as one message, once it
  // stops adding text.
  const asked = [];              // Ethos message texts already sent to the app
  const markAsked = (text) => {
    if (asked.includes(text)) return;
    asked.push(text);
    if (asked.length > 300) asked.shift();
  };
  // Split a message into what was already sent and what is new (blocks grow as Ethos talks)
  function splitAsked(text) {
    if (asked.includes(text)) return { done: text, fresh: '' };
    let best = '';
    for (const a of asked) if (a.length > best.length && text.startsWith(a)) best = a;
    return { done: best, fresh: clean(text.slice(best.length)) };
  }
  // A question mark, or a request phrased as an instruction ("Walk me through…")
  const ASK_RE = /\?|\b(tell me|walk me through|talk me through|describe|explain|could you|can you|would you)\b/i;
  let turnTimer = null;
  function scheduleTurn() {
    clearTimeout(turnTimer);
    if (firstPass || !settings.autoAnswer || !appReady()) return;
    const t = lastEthosTurn();
    const last = t && session.segments[t.end];
    // a finished question can go quickly; otherwise wait for Ethos to stop adding text
    turnTimer = setTimeout(answerPendingTurn, last && /\?[)"'”’\]]*$/.test(last.text) ? 700 : 1500);
  }
  function answerPendingTurn() {
    if (paused || !settings.autoAnswer || !appReady()) return;
    const t = lastEthosTurn();
    if (!t) return;
    const turn = session.segments.slice(t.start, t.end + 1).filter(Boolean);
    const fresh = [], alreadySent = [];
    for (const seg of turn) {
      const part = splitAsked(seg.text);
      if (part.done) alreadySent.push(lineOf('Ethos', part.done));
      if (part.fresh) fresh.push(part.fresh);
    }
    const message = fresh.join(' ');
    if (!message || !ASK_RE.test(message)) return; // nothing to answer yet; it stays pending
    turn.forEach((seg) => markAsked(seg.text));
    // The answer belongs to the newest question card taken from this message
    const cards = session.questions.filter((q) => !q.turn && message.includes(q.text));
    let target = cards[cards.length - 1];
    if (target && target.answer) return; // already answered by hand
    if (!target) {
      target = { id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6), t: Date.now(), text: message,
                 context: message, speaker: 'Ethos', sent: false, fresh: false, turn: true, turnKey: normQ(message) };
      session.questions.push(target);
    }
    cards.slice(0, -1).forEach((q) => { q.mergedInto = target.id; q.fresh = false; });
    target.context = message;
    target.req = { question: message, context: contextUpTo(t.start - 1, alreadySent) };
    askApp(target, true);
  }
  // The answered card that belongs to what Ethos just said; shown in the hero card.
  function heroCard(t) {
    const said = normQ(turnText(t));
    for (let i = session.questions.length - 1; i >= 0; i--) {
      const q = session.questions[i];
      if (q.answer && q.req && said.includes(normQ(q.req.question))) return q;
    }
    return null;
  }
  function turnQuestion(t, create) {
    const text = turnText(t);
    const key = normQ(text);
    let q = session.questions.find((x) => x.turnKey === key);
    if (!q && create) {
      q = { id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6), t: Date.now(), text, context: text,
            speaker: 'Ethos', sent: false, fresh: false, turn: true, turnKey: key };
      session.questions.push(q);
    }
    return q;
  }
  // Answer a whole Ethos reply (several paragraphs) as one question, on demand
  function answerTurn(t) {
    const q = turnQuestion(t, true);
    q.req = { question: q.text, context: contextUpTo(t.start - 1) };
    session.segments.slice(t.start, t.end + 1).filter(Boolean).forEach((seg) => markAsked(seg.text));
    askApp(q);
  }

  // ---------- persistence ----------
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!session.segments.length) return;
      try {
        const { txIndex = [] } = await chrome.storage.local.get('txIndex');
        if (!txIndex.includes(session.id)) txIndex.unshift(session.id);
        await chrome.storage.local.set({ [session.id]: session, txIndex: txIndex.slice(0, 50) });
      } catch (e) { /* extension reloaded */ }
    }, 600);
  }
  let renderPending = false, pointerDown = false;
  // don't swap buttons out from under a click in progress
  function changed() { if (pointerDown) renderPending = true; else render(); save(); }

  // ---------- export ----------
  function asText() {
    const head = `Ethos call transcript\nURL: ${session.url}\nStarted: ${new Date(session.startedAt).toLocaleString()}\n\n`;
    return head + session.segments.filter(Boolean)
      .map((s) => `[${stamp(s.t)}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`).join('\n\n') + '\n';
  }
  const questionsText = () => session.questions.filter((q) => !q.turn).map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  function download(content, ext, mime) {
    const name = `ethos-transcript-${new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function copyText(t, msg = 'Copied') {
    try { await navigator.clipboard.writeText(t); }
    catch {
      const ta = document.createElement('textarea'); ta.value = t;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    flash(msg);
  }

  // ---------- icons ----------
  const svg = (d, s = 14) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    send: svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
    spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
    sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    dock: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>'),
    float: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="10" width="7" height="6" rx="1"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')
  };

  // ---------- UI shell ----------
  const host = document.createElement('div');
  host.id = 'ethos-tx-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host{all:initial}
    *{box-sizing:border-box}
    .w{--bg:#1d2b2f;--panel:#1d2b2f;--raise:rgba(255,255,255,.045);--raise2:rgba(255,255,255,.08);--line:rgba(255,255,255,.08);
       --text:#eef5f6;--muted:rgba(238,245,246,.58);--faint:rgba(238,245,246,.38);
       --accent:#67e8f9;--accent-ink:#06282d;--you:#f6c768;--ok:#5eead4;--err:#fca5a5;--tg:#2aabee;--ai:#a7f3d0;
       --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
       font:13px/1.5 var(--font,Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif);color:var(--text)}
    button{font:inherit;color:inherit}
    /* panel */
    .p{position:relative;width:var(--pw,380px);height:100%;display:flex;flex-direction:column;background:var(--panel);
       border:1px solid var(--line);border-radius:var(--radius,24px);box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
    .w.floating .p{height:auto;max-height:78vh}
    .h{display:flex;align-items:center;gap:10px;padding:14px 14px 10px 16px;user-select:none}
    .w.floating .h{cursor:move}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
    .dot.live{background:var(--accent);box-shadow:0 0 0 0 rgba(103,232,249,.5);animation:pulse 2s infinite}
    .dot.paused{background:var(--you)}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(103,232,249,.45)}70%{box-shadow:0 0 0 7px rgba(103,232,249,0)}100%{box-shadow:0 0 0 0 rgba(103,232,249,0)}}
    .tt{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}
    .tt b{font-size:13.5px;font-weight:600;letter-spacing:.01em}
    .st{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ib{display:grid;place-items:center;width:30px;height:30px;border-radius:999px;border:0;background:transparent;color:var(--muted);cursor:pointer}
    .ib:hover,.ib.on{background:var(--raise2);color:var(--text)}
    .seg-c{display:flex;gap:4px;margin:0 14px 10px;padding:4px;border-radius:999px;background:var(--raise)}
    .tab{flex:1;border:0;background:transparent;color:var(--muted);padding:6px 10px;border-radius:999px;cursor:pointer;font-weight:600;font-size:12.5px}
    .tab.on{background:var(--raise2);color:var(--text)}
    .badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:700}
    .body{flex:1;min-height:120px;overflow:auto;padding:2px 14px 14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
    .foot{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px 14px;border-top:1px solid var(--line)}
    /* buttons */
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:999px;padding:8px 14px;cursor:pointer;
         background:var(--raise2);color:var(--text);font-weight:600;font-size:12.5px;white-space:nowrap;transition:background .15s,transform .05s}
    .btn:hover{background:rgba(255,255,255,.13)}
    .btn:active{transform:scale(.98)}
    .btn.pri{background:var(--accent);color:var(--accent-ink)}
    .btn.pri:hover{background:#8ef0fb}
    .btn.ai{background:rgba(167,243,208,.14);color:var(--ai)}
    .btn.ai:hover{background:rgba(167,243,208,.22)}
    .btn.done{background:rgba(94,234,212,.12);color:var(--ok)}
    .btn.sm{padding:5px 10px;font-size:12px}
    .btn.ghost{background:transparent;color:var(--muted);padding:6px 10px;font-weight:500}
    .btn.ghost:hover{background:var(--raise);color:var(--text)}
    .btn[disabled]{opacity:.45;cursor:default}
    .grow{flex:1}
    /* hero: latest Ethos reply */
    .hero{border-radius:18px;padding:14px;background:linear-gradient(180deg,rgba(103,232,249,.10),rgba(103,232,249,.03));border:1px solid rgba(103,232,249,.22);margin-bottom:14px}
    .eyebrow{display:flex;align-items:center;gap:8px;font:600 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
    .eyebrow .when{color:var(--faint);margin-left:auto}
    /* shows the question Ethos asked; click for the whole message (the call window has the full transcript) */
    .hero-t{margin:10px 0 12px;font-size:15px;line-height:1.55;overflow-wrap:anywhere;cursor:pointer;white-space:normal;
       display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
    .hero.has-ans .hero-t{margin:9px 0 0;font-size:12.5px;line-height:1.5;color:var(--muted);-webkit-line-clamp:3}
    .hero.open .hero-t{display:block;white-space:pre-wrap;overflow:visible}
    .hero .ans{margin:10px 0 12px;font-size:15.5px;line-height:1.62;color:var(--text)}
    .hero .ans.running{color:var(--muted)}
    .hero .ans.error{color:var(--err)}
    .btn.ic{flex:none !important;padding:8px 11px}
    /* wide panel: larger reading size */
    .w.wide .hero .ans{font-size:17px;line-height:1.6}
    .w.wide .hero-t{font-size:16px}
    .w.wide .hero.has-ans .hero-t{font-size:13.5px}
    .w.wide .q .qt{font-size:14.5px}
    .w.wide .ans{font-size:15px}
    .w.wide .bub{font-size:14px}
    .hero .acts{display:flex;gap:8px;flex-wrap:wrap}
    .hero .acts .btn{flex:1}
    .typing{display:inline-flex;gap:3px;margin-left:2px}
    .typing i{width:4px;height:4px;border-radius:50%;background:var(--accent);animation:bl 1.2s infinite}
    .typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
    @keyframes bl{0%,80%,100%{opacity:.25}40%{opacity:1}}
    /* question cards */
    .sh{display:flex;align-items:center;gap:8px;margin:4px 2px 8px;font:600 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
    .q{border-radius:14px;padding:11px 12px;margin-bottom:8px;background:var(--raise);border:1px solid transparent}
    .q.fresh{border-color:rgba(103,232,249,.35)}
    .q .qt{font-size:13.5px;cursor:pointer}
    .q .ctx{display:none;margin-top:8px;color:var(--muted);font-size:12px;border-left:2px solid var(--line);padding-left:8px}
    .q.open .ctx{display:block}
    .row{display:flex;align-items:center;gap:6px;margin-top:9px}
    .ts{font:11px var(--mono);color:var(--faint)}
    .tag{font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ai);background:rgba(167,243,208,.1);padding:2px 6px;border-radius:6px}
    .ans{margin-top:10px;padding:11px 12px;border-radius:12px;background:rgba(167,243,208,.07);border:1px solid rgba(167,243,208,.18);
         font-size:14px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
    .ans.running{color:var(--muted)}
    .ans.error{background:rgba(252,165,165,.08);border-color:rgba(252,165,165,.25);color:var(--err)}
    .note{font-size:11.5px;color:var(--muted);flex:1}
    /* transcript bubbles */
    .msg{display:flex;flex-direction:column;align-items:flex-start;margin:0 0 10px}
    .msg.you{align-items:flex-end}
    .who{font:600 10px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin:0 4px 5px}
    .msg.eth .who b{color:var(--accent);font-weight:600}
    .msg.you .who b{color:var(--you);font-weight:600}
    .bub{max-width:88%;padding:9px 12px;border-radius:16px 16px 16px 5px;background:var(--raise2);font-size:13px;line-height:1.5}
    .msg.you .bub{border-radius:16px 16px 5px 16px;background:rgba(246,199,104,.12)}
    .msg.last .bub{box-shadow:inset 0 0 0 1px rgba(103,232,249,.4)}
    .macts{display:none;gap:4px;margin-top:5px}
    .msg:hover .macts,.msg.last .macts{display:flex}
    /* empty */
    .empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;color:var(--muted);padding:34px 18px}
    .empty .ic{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:var(--raise2);color:var(--accent)}
    .empty b{color:var(--text);font-size:14px}
    /* settings */
    .sect{margin:18px 0 6px;font:600 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
    .sect:first-child{margin-top:4px}
    label.f{display:block;margin:10px 0 5px;color:var(--muted);font-size:12px}
    input[type=text],input[type=password],select{width:100%;background:rgba(0,0,0,.22);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:8px 11px;font:inherit;outline:none}
    input:focus,select:focus{border-color:rgba(103,232,249,.5)}
    select option{background:#1d2b2f}
    .chk{display:flex;gap:10px;align-items:center;margin:9px 0;cursor:pointer;font-size:12.5px}
    .chk input{accent-color:#67e8f9;width:15px;height:15px}
    .hint{color:var(--muted);font-size:11.5px;margin-top:7px;line-height:1.5}
    .inl{display:flex;gap:6px}
    /* toast */
    .toast{position:absolute;bottom:64px;left:50%;transform:translate(-50%,6px);background:var(--accent);color:var(--accent-ink);white-space:nowrap;
       padding:6px 12px;border-radius:999px;font-weight:600;font-size:12px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:90%;overflow:hidden;text-overflow:ellipsis;z-index:2}
    .toast.err{background:var(--err);color:#3a0b0b}
    .toast.on{opacity:1;transform:translate(-50%,0)}
    /* pill launcher */
    .launch{display:none;align-items:center;gap:8px;padding:9px 14px 9px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);
          color:var(--text);cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.3);font-weight:600;font-size:12.5px}
    .launch:hover{filter:brightness(1.15)}
    .launch .badge{margin-left:2px}
    /* joined: flush against the call window, so the two read as one modal */
    .w.joined .p{border-radius:0 var(--radius,24px) var(--radius,24px) 0;border-left:1px solid var(--line);box-shadow:none}
    /* one drop shadow around the call window and the panel together (an outer shadow never paints inside its own box) */
    .halo{display:none;position:absolute;top:0;pointer-events:none;border-radius:var(--radius,24px);box-shadow:0 24px 60px rgba(0,0,0,.35)}
    .w.joined .halo{display:block}
    .w.pill .p{display:none}
    .w.pill .launch{display:inline-flex}
  </style>
  <div class="w">
    <div class="halo"></div>
    <div class="p">
      <div class="h">
        <span class="dot"></span>
        <div class="tt"><b>Ethos Copilot</b><span class="st"></span></div>
        <button class="ib" data-a="dock" title="Dock beside the call / float"></button>
        <button class="ib" data-a="settings" title="Settings">${I.sliders}</button>
        <button class="ib" data-a="close" title="Minimize to a pill (Alt+Shift+T hides fully)">${I.minus}</button>
      </div>
      <div class="seg-c">
        <button class="tab" data-v="questions">Questions<span class="badge qn">0</span></button>
        <button class="tab" data-v="transcript">Transcript</button>
      </div>
      <div class="body"></div>
      <div class="foot"></div>
      <div class="toast"></div>
    </div>
    <button class="launch" data-a="open"><span class="dot"></span><span class="pl">Ethos Copilot</span><span class="badge qn2">0</span></button>
  </div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const W = $('.w'), halo = $('.halo'), panel = $('.p'), body = $('.body'), foot = $('.foot'), toast = $('.toast');
  let toastTimer;
  function flash(msg, err) {
    toast.textContent = msg; toast.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), err ? 3500 : 1400);
  }
  const setHTML = (el, html) => { if (el.__h !== html) { el.innerHTML = html; el.__h = html; } };
  const emptyState = (title, sub) =>
    `<div class="empty"><div class="ic">${svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>', 20)}</div><b>${title}</b><div>${sub}</div></div>`;
  const waitingSub = () => callActive
    ? (currentEl ? 'Questions from Ethos show up here as the call goes.' : 'Opening the transcript…')
    : 'Start a call with Ethos. The transcript opens automatically and this panel docks beside it.';

  // ---------- views ----------
  const openQ = new Set();
  const copyLabel = (it, base = 'Copy') =>
    it?.sending ? 'Sending…' : it?.sent ? `${I.check} Sent` : tgReady() && settings.sendOnCopy ? `${I.send} ${base} + send` : `${I.copy} ${base}`;
  function answerBlock(q) {
    if (!q?.answer) return '';
    return `<div class="ans ${q.answer.status}" data-ans="${q.id}">${esc(answerText(q.answer))}</div>
      ${q.answer.status === 'done' ? `<div class="row"><span class="note">${q.answer.telegram === 'sent' ? 'Sent to Telegram ✓' : q.answer.telegram ? 'Telegram: ' + esc(q.answer.telegram) : ''}</span>
        <button class="btn sm" data-a="acopy" data-id="${q.id}">${I.copy} Copy answer</button></div>` : ''}`;
  }
  let heroOpenKey = '';          // the Ethos message expanded by hand
  // What is worth showing at a glance from Ethos's message: its question(s), or
  // failing that the last thing it said.
  function focusText(text) {
    const flat = text.replace(/\s*\n+\s*/g, ' ');
    const ABBR = /\b(e\.g|i\.e|etc|vs|approx|incl|Mr|Ms|Dr)\./gi;
    const parts = (flat.replace(ABBR, (m) => m.replace(/\./g, '․')).match(/[^.!?…]+(?:[.!?…]+[)"'”’\]]*|$)/g) || [])
      .map((x) => clean(x).replace(/․/g, '.')).filter(Boolean);
    const asks = parts.filter((x) => /\?[)"'”’\]]*$/.test(x));
    if (asks.length) return asks.join(' ');
    return parts.length > 2 ? '… ' + parts.slice(-2).join(' ') : flat;
  }
  function heroHtml() {
    const t = lastEthosTurn();
    if (!t) return { html: '', hq: null, key: '' };
    const segs = session.segments;
    const lastSeg = segs[t.end];
    const streaming = callActive && t.end === segs.length - 1 && lastSeg && Date.now() - (lastSeg.t2 || lastSeg.t) < 2500;
    const hq = heroCard(t);
    const ans = hq?.answer;
    const text = turnText(t);
    const key = normQ(text);
    const open = heroOpenKey === key;
    const eyebrow = `<div class="eyebrow">${I.chat} Ethos ${streaming ? 'is speaking<span class="typing"><i></i><i></i><i></i></span>' : 'just asked'}<span class="when">${stamp(segs[t.start].t)}</span></div>`;
    const said = `<div class="hero-t" data-a="heroexpand" title="${open ? 'Show only the question' : 'Show everything Ethos said'}">${esc(open ? text : focusText(text))}</div>`;
    if (!ans) return { hq, key, html: `
      <div class="hero ${open ? 'open' : ''}">
        ${eyebrow}
        ${said}
        <div class="acts">
          <button class="btn pri ${lastSeg.sent ? 'done' : ''}" data-a="lastreply">${copyLabel(lastSeg)}</button>
          ${appReady() ? `<button class="btn ai" data-a="turnanswer">${I.spark} Answer</button>` : ''}
        </div>
      </div>` };
    const tgNote = ans.status !== 'done' || !ans.telegram ? '' : ans.telegram === 'sent' ? 'Sent to Telegram ✓' : 'Telegram: ' + esc(ans.telegram);
    return { hq, key, html: `
      <div class="hero has-ans ${open ? 'open' : ''}">
        ${eyebrow}
        ${said}
        <div class="ans ${ans.status}" data-ans="${hq.id}">${esc(answerText(ans))}</div>
        <div class="acts">
          <button class="btn pri" data-a="acopy" data-id="${hq.id}" ${ans.status === 'done' ? '' : 'disabled'}>${I.copy} Copy answer</button>
          <button class="btn ai" data-a="turnanswer" ${ans.status === 'running' ? 'disabled' : ''}>${I.spark} ${ans.status === 'running' ? 'Answering…' : 'Regenerate'}</button>
          <button class="btn ic ${lastSeg.sent ? 'done' : ''}" data-a="lastreply" title="Copy what Ethos said${tgReady() && settings.sendOnCopy ? ' and send it to Telegram' : ''}">${lastSeg.sending ? '…' : lastSeg.sent ? I.check : I.copy}</button>
        </div>
        ${tgNote ? `<div class="note" style="margin-top:8px">${tgNote}</div>` : ''}
      </div>` };
  }
  let lastHeroKey = '';
  function renderQuestions() {
    const { html: hero, hq, key: heroKey } = heroHtml();
    const qs = [...session.questions].reverse().filter((q) => q !== hq && (!q.turn || q.answer));
    const cards = qs.map((q) => `
      <div class="q ${q.fresh ? 'fresh' : ''} ${openQ.has(q.id) ? 'open' : ''}" data-id="${q.id}">
        <div class="qt" data-a="expand" title="Show the full message">${q.turn ? '<span class="tag">Whole reply</span> ' : ''}${esc(q.text)}</div>
        <div class="ctx">${esc(q.context)}</div>
        <div class="row">
          <span class="ts grow">${stamp(q.t)}</span>
          <button class="btn sm ${q.sent ? 'done' : ''}" data-a="${tgReady() ? 'qcopy' : 'qsend'}">${tgReady() ? copyLabel(q) : `${I.send} Telegram`}</button>
          ${tgReady() ? '' : `<button class="btn sm" data-a="qcopy">${I.copy}</button>`}
          ${appReady() ? `<button class="btn sm ai" data-a="qanswer" ${q.answer?.status === 'running' ? 'disabled' : ''}>${I.spark} ${!q.answer ? 'Answer' : q.answer.status === 'running' ? '…' : 'Again'}</button>` : ''}
        </div>
        ${q.mergedInto && !q.answer ? '<div class="row"><span class="note">↑ Answered together with the next question</span></div>' : ''}
        ${answerBlock(q)}
      </div>`).join('');
    setHTML(body, hero || cards
      ? hero + (cards ? `<div class="sh">All questions · ${qs.length}</div>${cards}` : '')
      : emptyState(callActive ? 'Listening for questions' : 'No call yet', waitingSub()));
    // Ethos said something new: bring its card (and the answer about to arrive) into view
    if (heroKey !== lastHeroKey) { lastHeroKey = heroKey; body.scrollTop = 0; }
    setHTML(foot, `
      <button class="btn ghost" data-a="qcopyall">${I.copy} Copy all questions</button>
      <span class="grow"></span>
      <button class="btn ghost" data-a="pause">${paused ? 'Resume' : 'Pause'}</button>
      <button class="btn ghost" data-a="pick" title="Click the transcript manually if auto-detect misses it">Pick</button>`);
  }
  function renderTranscript() {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    const segs = session.segments;
    const last = lastEthosTurn();
    const html = [];
    segs.forEach((s, i) => {
      if (!s) return;
      const you = s.speaker === 'You';
      const next = segs[i + 1];
      const endsTurn = !you && (!next || next.speaker === 'You');
      const turn = endsTurn ? ethosTurnEndingAt(i) : null;
      const inLast = last && i >= last.start && i <= last.end;
      const prev = segs[i - 1];
      const showWho = !prev || prev.speaker !== s.speaker;
      html.push(`<div class="msg ${you ? 'you' : 'eth'} ${inLast ? 'last' : ''}">
        ${showWho ? `<div class="who"><b>${you ? 'You' : s.speaker || 'Ethos'}</b> · ${stamp(s.t)}</div>` : ''}
        <div class="bub">${esc(s.text)}</div>
        ${!you ? `<div class="macts">
          <button class="btn sm ${s.sent ? 'done' : ''}" data-a="mcopy" data-i="${i}">${copyLabel(s)}</button>
          ${turn && turn.end > turn.start ? `<button class="btn sm" data-a="turncopy" data-i="${i}" title="All ${turn.end - turn.start + 1} paragraphs since your answer">Whole reply</button>` : ''}
        </div>` : ''}
      </div>`);
    });
    setHTML(body, html.length ? html.join('') : emptyState(callActive ? 'Waiting for speech' : 'No call yet', waitingSub()));
    if (atBottom) body.scrollTop = body.scrollHeight;
    setHTML(foot, `
      <button class="btn ghost" data-a="copy">${I.copy} Copy all</button>
      <button class="btn ghost" data-a="txt">.txt</button>
      <button class="btn ghost" data-a="json">.json</button>
      <span class="grow"></span>
      <button class="btn ghost" data-a="pause">${paused ? 'Resume' : 'Pause'}</button>
      <button class="btn ghost" data-a="clear">Clear</button>`);
  }
  function profileOptions(selected) {
    const known = appProfiles.some((p) => String(p.id) === String(selected));
    return `<option value="">Most recently edited profile</option>` +
      (selected && !known ? `<option value="${esc(selected)}" selected>${esc(settings.appProfileName || 'Profile #' + selected)}</option>` : '') +
      appProfiles.map((p) => `<option value="${p.id}" ${String(p.id) === String(selected) ? 'selected' : ''}>${esc(p.name)}${p.has_resume ? '' : ' (no résumé)'}</option>`).join('');
  }
  let appNotice = '';             // why this account cannot generate answers, if it cannot
  async function loadProfiles(silent) {
    const r = await appCall('GET', '/api/ext/ping');
    const note = root.getElementById('amsg');
    if (!r.ok) {
      if (note) { note.textContent = r.error; note.style.display = ''; }
      if (!silent) flash('Assistant: ' + r.error, true);
      return false;
    }
    appProfiles = r.data.profiles || [];
    appNotice = r.data.can_generate === false ? r.data.message : '';
    settings.appUser = r.data.user?.name || settings.appUser;
    const sel = root.getElementById('aprof');
    if (sel) sel.innerHTML = profileOptions(sel.value || settings.appProfileId);
    const who = root.getElementById('awho');
    if (who) who.textContent = settings.appUser;
    if (note) { note.textContent = appNotice; note.style.display = appNotice ? '' : 'none'; }
    if (!silent) flash(appProfiles.length ? `${appProfiles.length} profile${appProfiles.length === 1 ? '' : 's'} loaded` : 'Add a profile with your résumé in the app');
    return true;
  }
  function renderSettings() {
    body.__h = foot.__h = null;
    body.innerHTML = `
      <div class="sect">On the Ethos page</div>
      <label class="chk"><input type="checkbox" id="sopen" ${settings.autoOpen ? 'checked' : ''}> Open the transcript automatically</label>
      <label class="chk"><input type="checkbox" id="sdock" ${settings.dock ? 'checked' : ''}> Join this panel onto the call window (one modal)</label>
      <label class="chk"><input type="checkbox" id="scenter" ${settings.center ? 'checked' : ''}> Center the joined modal on the screen</label>
      <div class="sect">Interview Assistant</div>
      ${appReady()
        ? `<div class="hint">Signed in as <b id="awho">${esc(settings.appUser || settings.appEmail || 'your account')}</b> on ${esc(settings.appUrl)}. To switch account, click the extension icon in the browser toolbar.</div>`
        : `<div class="hint" style="color:var(--you)">Not signed in. Click the extension icon in the browser toolbar and sign in with your Interview Assistant email and password.</div>`}
      <div class="hint" id="amsg" style="color:var(--you);display:${appNotice ? '' : 'none'}">${esc(appNotice)}</div>
      <label class="f">Profile (résumé + Telegram chat used for answers)</label>
      <div class="inl"><select id="aprof" ${appReady() ? '' : 'disabled'}>${profileOptions(settings.appProfileId)}</select>
        <button class="btn sm" data-a="appconnect" ${appReady() ? '' : 'disabled'} title="Load your profiles again from the app">Reload</button></div>
      <label class="chk"><input type="checkbox" id="aauto" ${settings.autoAnswer ? 'checked' : ''}> Auto-answer when Ethos finishes speaking</label>
      <label class="chk"><input type="checkbox" id="atg" ${settings.appTelegram ? 'checked' : ''}> Send answers to Telegram (the profile's chat)</label>
      <label class="chk"><input type="checkbox" id="actx" ${settings.appContext ? 'checked' : ''}> Send the conversation so far as context</label>
      <div class="hint">Résumés, prompts and the answer style are managed in the Interview Assistant dashboard, under your own account.</div>
      <div class="sect">Telegram</div>
      <label class="f">Bot token</label>
      <input type="password" id="tok" placeholder="123456:ABC-DEF…" value="${esc(settings.token)}">
      <label class="f">Chat ID</label>
      <div class="inl"><input type="text" id="cid" placeholder="123456789 or @channel" value="${esc(settings.chatId)}">
        <button class="btn sm" data-a="findchat" title="Send any message to your bot first">Find</button></div>
      <div class="hint">Create a bot with <b>@BotFather</b> (<b>/newbot</b>) and paste its token. Message the bot, then <b>Find</b>. For a channel, add the bot as admin and use <b>@channelname</b>.</div>
      <label class="chk"><input type="checkbox" id="soc" ${settings.sendOnCopy ? 'checked' : ''}> Copy buttons also send to Telegram</label>
      <label class="chk"><input type="checkbox" id="auto" ${settings.autoSend ? 'checked' : ''}> Auto-send new questions</label>
      <label class="chk"><input type="checkbox" id="eonly" ${settings.ethosOnly ? 'checked' : ''}> Only Ethos's questions (ignore mine)</label>
      <label class="chk"><input type="checkbox" id="ctx" ${settings.withContext ? 'checked' : ''}> Include the full message as context</label>`;
    foot.innerHTML = `
      <button class="btn ghost" data-a="back">${I.back} Back</button>
      <span class="grow"></span>
      <button class="btn" data-a="testtg">Test Telegram</button>
      <button class="btn pri" data-a="savesettings">Save</button>`;
    if (appReady()) loadProfiles(true);
  }
  function render() {
    renderPending = false;
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.v === view));
    $('[data-a=settings]').classList.toggle('on', view === 'settings');
    $('.seg-c').style.display = view === 'settings' ? 'none' : '';
    const n = session.questions.filter((q) => !q.turn).length;
    $('.qn').textContent = n; $('.qn2').textContent = n;
    $('.qn2').style.display = n ? '' : 'none';
    const live = paused ? ' paused' : currentEl ? ' live' : '';
    root.querySelectorAll('.dot').forEach((d) => (d.className = 'dot' + live));
    $('.st').textContent = paused ? 'Paused' : !callActive ? 'No active call' : currentEl ? (pageStatus || 'Live · capturing transcript') : 'Opening transcript…';
    $('.pl').textContent = callActive ? 'Ethos Copilot · live' : 'Ethos Copilot';
    $('[data-a=dock]').innerHTML = mode === 'docked' ? I.float : I.dock;
    $('[data-a=dock]').title = mode === 'docked' ? 'Float the panel' : 'Dock beside the call';
    if (view === 'settings') return;
    if (view === 'questions') renderQuestions(); else renderTranscript();
  }

  // ---------- placement ----------
  const PW_MIN = 380, PW_MAX = 720, PW_FLOAT = 520, PW_WIDE = 600, GAP = 12, M = 8;
  let pw = PW_MIN;               // current panel width
  let dragPos = null; // floating position
  // While docked, the panel is joined onto the right edge of the page's call
  // window: same top and height, no gap, the touching corners squared off.
  // With centering on, the call window is also slid sideways (CSS `translate`,
  // which adds to whatever positioning the page uses) so the joined modal sits
  // in the middle of the screen. Everything done to the call window is undone
  // when the panel is not docked.
  const JOIN_MIN_H = 420;        // a shorter call window is not worth matching in height
  let touched = null, movedBy = 0, prevStyle = null;
  function styleCard(dx, join) {
    if (touched && touched !== card) restoreCard();
    if (!touched) {
      touched = card; movedBy = 0;
      prevStyle = { translate: card.style.translate, tr: card.style.borderTopRightRadius, br: card.style.borderBottomRightRadius };
    }
    if (Math.abs(dx - movedBy) >= 0.5) {
      movedBy = dx;
      card.style.translate = dx ? `${dx}px 0px` : prevStyle.translate;
    }
    card.style.borderTopRightRadius = join ? '0px' : prevStyle.tr;
    card.style.borderBottomRightRadius = join ? '0px' : prevStyle.br;
  }
  function restoreCard() {
    if (touched) {
      touched.style.translate = prevStyle.translate;
      touched.style.borderTopRightRadius = prevStyle.tr;
      touched.style.borderBottomRightRadius = prevStyle.br;
    }
    touched = null; movedBy = 0; prevStyle = null;
  }
  function themeFromCard() {
    if (!card) return;
    const cs = getComputedStyle(card);
    if (alpha(cs.backgroundColor) > 0.6) W.style.setProperty('--panel', cs.backgroundColor);
    const r = parseFloat(cs.borderTopLeftRadius);
    if (r >= 8) W.style.setProperty('--radius', Math.min(r, 28) + 'px');
    if (cs.fontFamily) W.style.setProperty('--font', cs.fontFamily);
  }
  function place() {
    W.className = 'w ' + mode;
    if (mode !== 'docked' || !card) restoreCard();
    if (mode === 'pill') {
      host.style.left = 'auto'; host.style.top = 'auto'; host.style.right = '20px'; host.style.bottom = '20px';
      panel.style.height = '';
      return;
    }
    host.style.right = 'auto'; host.style.bottom = 'auto';
    const vw = innerWidth, vh = innerHeight;
    if (mode === 'docked' && card) {
      const r = card.getBoundingClientRect();
      const cl = r.left - (touched === card ? movedBy : 0);   // where the page itself puts the call window
      const cr = cl + r.width;
      const canJoin = r.height >= JOIN_MIN_H;
      const gap = canJoin ? 0 : GAP;
      const roomBoth = vw - 2 * M - r.width - gap;            // panel width available if the pair is centered
      const roomRight = vw - M - (cr + gap), roomLeft = cl - GAP - M;
      let left, joined = false, overlay = false;
      if (settings.center && roomBoth >= PW_MIN) {
        pw = Math.min(PW_MAX, roomBoth);
        styleCard(Math.round((vw - (r.width + gap + pw)) / 2 - cl), canJoin);
        left = cl + movedBy + r.width + gap;
        joined = canJoin;
      } else if (roomRight >= PW_MIN) {
        pw = Math.min(PW_MAX, roomRight);
        styleCard(0, canJoin);
        left = cr + gap;
        joined = canJoin;
      } else {
        restoreCard();
        if (roomLeft >= PW_MIN) { pw = Math.min(PW_MAX, roomLeft); left = cl - GAP - pw; }
        else { pw = PW_MIN; left = vw - pw - M; overlay = true; }   // no room: sit over the page edge
      }
      let top, h;
      if (joined) { top = r.top; h = r.height; }
      else if (overlay) { top = M; h = vh - 2 * M; }
      else {
        top = Math.max(M, r.top);
        // at least as tall as the call window, and tall enough to show a whole answer
        h = Math.min(Math.max(r.height, Math.min(640, vh - top - M)), vh - top - M);
      }
      W.style.setProperty('--pw', pw + 'px');
      W.classList.toggle('wide', pw >= PW_WIDE);
      W.classList.toggle('joined', joined);
      if (joined) Object.assign(halo.style, { left: -r.width + 'px', width: r.width + pw + 'px', height: h + 'px' });
      host.style.left = left + 'px'; host.style.top = top + 'px';
      panel.style.height = h + 'px';
      return;
    }
    // floating
    W.className = 'w floating';
    pw = Math.min(PW_FLOAT, vw - 2 * M);
    W.style.setProperty('--pw', pw + 'px');
    const pos = dragPos || { left: vw - pw - 16, top: 16 };
    host.style.left = Math.min(Math.max(M, pos.left), vw - pw - M) + 'px';
    host.style.top = Math.min(Math.max(M, pos.top), vh - 120) + 'px';
    panel.style.height = '';
  }
  function setMode(m) { mode = m; place(); render(); }
  addEventListener('resize', place);
  addEventListener('scroll', place, true);

  function readSettingsForm() {
    const prof = root.getElementById('aprof');
    return {
      autoOpen: root.getElementById('sopen').checked,
      dock: root.getElementById('sdock').checked,
      center: root.getElementById('scenter').checked,
      appProfileId: prof.value,
      appProfileName: prof.value ? prof.options[prof.selectedIndex].textContent : '',
      autoAnswer: root.getElementById('aauto').checked,
      appTelegram: root.getElementById('atg').checked,
      appContext: root.getElementById('actx').checked,
      token: root.getElementById('tok').value.trim(),
      chatId: root.getElementById('cid').value.trim(),
      autoSend: root.getElementById('auto').checked,
      sendOnCopy: root.getElementById('soc').checked,
      ethosOnly: root.getElementById('eonly').checked,
      withContext: root.getElementById('ctx').checked
    };
  }

  // ---------- events ----------
  // While a call is open the Ethos page locks scrolling, traps keyboard focus
  // and listens for clicks outside its call window. The panel lives outside
  // that window, so its events are kept to itself, and it scrolls itself.
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup', 'keypress', 'focusin', 'focusout', 'touchmove']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  host.addEventListener('wheel', (e) => {
    e.stopPropagation();
    const dy = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    // innermost scrollable element under the pointer that can still move in this direction
    const box = e.composedPath().find((n) => n instanceof Element && root.contains(n)
      && n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)
      && (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1));
    e.preventDefault();          // never scroll the page behind the panel
    if (box) box.scrollTop += dy;
  }, { passive: false });
  root.addEventListener('pointerdown', () => { pointerDown = true; });
  addEventListener('pointerup', () => { pointerDown = false; if (renderPending) setTimeout(render, 0); }, true);
  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tab');
    if (tab) { view = tab.dataset.v; return render(); }
    const btn = e.target.closest('[data-a]');
    if (!btn || btn.disabled) return;
    const a = btn.dataset.a;
    const card_ = btn.closest('.q');
    const q = card_ ? session.questions.find((x) => x.id === card_.dataset.id)
      : btn.dataset.id ? session.questions.find((x) => x.id === btn.dataset.id) : null;
    switch (a) {
      case 'expand': openQ.has(q.id) ? openQ.delete(q.id) : openQ.add(q.id); q.fresh = false; render(); break;
      case 'qcopy': q.fresh = false; copyAndSend(q.text, q); break;
      case 'qsend': q.fresh = false; sendTelegram(q); break;
      case 'qanswer': askApp(q); break;
      case 'heroexpand': {
        const t = lastEthosTurn();
        const key = t ? normQ(turnText(t)) : '';
        heroOpenKey = heroOpenKey === key ? '' : key;
        render();
        break;
      }
      case 'acopy': if (q?.answer?.text) copyText(q.answer.text, 'Answer copied'); break;
      case 'turnanswer': {
        const t = lastEthosTurn();
        if (!t) break;
        const shown = heroCard(t);      // regenerate the answer on screen, or answer the whole reply
        if (shown) askApp(shown); else answerTurn(t);
        break;
      }
      case 'appconnect': await loadProfiles(false); break;
      case 'mcopy': { const s = session.segments[+btn.dataset.i]; if (s) copyAndSend(s.text, s); break; }
      case 'turncopy': { const t = ethosTurnEndingAt(+btn.dataset.i); copyAndSend(turnText(t), session.segments[t.end]); break; }
      case 'lastreply': { const t = lastEthosTurn(); if (t) copyAndSend(turnText(t), session.segments[t.end]); break; }
      case 'qcopyall': copyText(questionsText(), 'Questions copied'); break;
      case 'copy': copyText(asText()); break;
      case 'txt': download(asText(), 'txt', 'text/plain'); break;
      case 'json': download(JSON.stringify(session, null, 2), 'json', 'application/json'); break;
      case 'pause': paused = !paused; render(); break;
      case 'clear':
        if (confirm('Clear captured transcript and questions?')) {
          session.segments = []; session.questions = []; seenQ.clear(); lastRaw = ''; changed();
        } break;
      case 'pick': startPick(); break;
      case 'close': closedByUser = callActive; setMode('pill'); break;
      case 'open': closedByUser = false; setMode(callActive && settings.dock && card ? 'docked' : 'floating'); break;
      case 'dock':
        settings.dock = mode !== 'docked';
        chrome.storage.local.set({ settings }).catch(() => {});
        setMode(settings.dock && card ? 'docked' : 'floating');
        if (settings.dock && !card) flash('Docks automatically when a call is open');
        break;
      case 'settings': view = view === 'settings' ? 'questions' : 'settings'; render(); if (view === 'settings') renderSettings(); break;
      case 'back': view = 'questions'; render(); break;
      case 'savesettings':
        settings = { ...settings, ...readSettingsForm() };
        await chrome.storage.local.set({ settings });
        flash('Saved'); view = 'questions';
        if (callActive) warmApp(true);   // the chosen profile may have changed
        if (mode !== 'pill') setMode(settings.dock && card ? 'docked' : 'floating'); else render();
        break;
      case 'findchat': {
        const token = root.getElementById('tok').value.trim();
        if (!token) return flash('Paste the bot token first', true);
        const r = await chrome.runtime.sendMessage({ type: 'tg', token, method: 'getUpdates', params: {} });
        if (!r?.ok) return flash('Telegram: ' + (r?.description || 'failed'), true);
        const upd = [...r.result].reverse().find((u) => (u.message || u.channel_post || u.my_chat_member));
        const chat = upd && (upd.message || upd.channel_post || upd.my_chat_member).chat;
        if (!chat) return flash('Send a message to your bot first, then retry', true);
        root.getElementById('cid').value = chat.id;
        flash('Found: ' + (chat.title || chat.first_name || chat.id));
        break;
      }
      case 'testtg': {
        const s = readSettingsForm();
        if (!s.token || !s.chatId) return flash('Token and chat ID needed', true);
        const r = await chrome.runtime.sendMessage({ type: 'tg', token: s.token, method: 'sendMessage',
          params: { chat_id: s.chatId, text: '✅ Ethos Copilot is connected.' } });
        flash(r?.ok ? 'Test sent' : 'Telegram: ' + (r?.description || 'failed'), !r?.ok);
        break;
      }
    }
  });

  // drag the header: floats the panel
  (() => {
    const h = $('.h'); let sx, sy, ox, oy, drag = false;
    h.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = true; const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; e.preventDefault();
    });
    addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      if (mode === 'docked') { mode = 'floating'; render(); }
      dragPos = { left: ox + e.clientX - sx, top: oy + e.clientY - sy };
      place();
    });
    addEventListener('mouseup', () => (drag = false));
  })();

  // manual picker
  function startPick() {
    if (picking) return;
    picking = true; flash('Click the transcript on the page (Esc to cancel)');
    const hl = document.createElement('div');
    hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #67e8f9;background:rgba(103,232,249,.12);border-radius:8px';
    document.documentElement.appendChild(hl);
    const move = (e) => {
      if (host.contains(e.target)) return;
      const r = e.target.getBoundingClientRect();
      Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const click = (e) => {
      if (host.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      let el = e.target, list = null;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        if ([...p.children].filter((k) => k.querySelector('p')).length >= 2) { list = p; break; }
      }
      pinnedEl = list || el; currentEl = pinnedEl; lastRaw = '';
      stop(); flash('Transcript set'); tick();
    };
    const key = (e) => { if (e.key === 'Escape') stop(); };
    function stop() {
      picking = false; hl.remove();
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // ---------- watch loop ----------
  const isList = (el) => [...el.children].some((k) => k.querySelector('p'));
  function onCallStart(initial) {
    // a new call on the same page gets its own saved session
    if (!initial && session.segments.length) {
      session = newSessionObj(); seenQ.clear(); lastRaw = ''; openQ.clear(); asked.length = 0;
    }
    if (!initial) firstPass = false;  // answer the very first question of a new call too
    userHid = false; autoClicks = 0;
    warmApp(true);
    if (!closedByUser) setMode(settings.dock ? 'docked' : 'floating');
  }
  function onCallEnd() {
    pinnedEl = null; currentEl = null; closedByUser = false;
    if (mode === 'docked') setMode('pill');
    if (session.questions.length) flash('Call ended · transcript saved');
  }
  let started = false;
  function tick() {
    if (!alive()) return shutdown();
    const c = findCard();
    if (c !== card) { card = c; themeFromCard(); }
    const active = !!card;
    if (active !== callActive) {
      callActive = active;
      if (active) onCallStart(!started); else onCallEnd();
    }
    started = true;
    if (callActive) {
      warmApp(false);
      autoOpenTranscript();
      const st = findTextEl(STATUS_RE, card);
      pageStatus = st && textOf(st).length < 40 ? textOf(st) : '';
    }
    const el = findTranscriptEl();
    if (el !== currentEl) {
      if (currentEl && el && !pinnedEl) session.segments = [];
      currentEl = el;
    }
    if (el && !paused) {
      if (isList(el)) ingestList(el); else ingestBox(el);
      if (firstPass) {
        firstPass = false;
        session.segments.forEach((seg) => seg && seg.speaker !== 'You' && markAsked(seg.text));
      }
    }
    place();
    if (!pointerDown) render(); else renderPending = true;
  }
  let pending = false;
  const observer = new MutationObserver((muts) => {
    if (pending || muts.every((m) => host.contains(m.target))) return;
    pending = true;
    setTimeout(() => { pending = false; tick(); }, 200);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const timer = setInterval(tick, 1000);
  function shutdown() { observer.disconnect(); clearInterval(timer); restoreCard(); host.remove(); }

  addEventListener('beforeunload', () => { try { chrome.storage.local.set({ [session.id]: session }); } catch {} });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'toggle') host.style.display = host.style.display === 'none' ? '' : 'none';
    if (msg.type === 'show') { host.style.display = ''; if (mode === 'pill') setMode(callActive && settings.dock && card ? 'docked' : 'floating'); }
    if (msg.type === 'status') reply({ lines: session.segments.filter(Boolean).length, questions: session.questions.length, detected: !!currentEl, paused, id: session.id });
    if (msg.type === 'text') reply({ text: asText() });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    const before = settings.appKey + '|' + settings.appUrl;
    settings = { ...settings, ...changes.settings.newValue };
    if (before !== settings.appKey + '|' + settings.appUrl) {   // signed in, out, or switched account
      appProfiles = []; appNotice = '';
      if (callActive) warmApp(true);
      if (view === 'settings') renderSettings(); else render();
    }
  });

  chrome.storage.local.get('settings').then((r) => {
    if (r.settings) settings = { ...settings, ...r.settings };
    tick();
  }).catch(() => tick());
})();
