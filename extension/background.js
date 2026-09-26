// PawBrowse background service worker.
// Connects to the local pawbrowse broker over WebSocket and drives the user's real tabs via
// chrome.debugger (CDP) — no remote debug port, no relaunch needed.
//
// MULTI-SESSION: the broker multiplexes many editor/Claude sessions over this one connection.
// Every command carries a `session` id; each session gets its OWN tab group (🐾 PawBrowse,
// with its own color) and drives only its own tab, so sessions run concurrently without
// fighting over one tab. Commands are serialized PER SESSION (not globally), so different
// sessions' tabs are driven in parallel.
//
// The element-table perception and action-execution techniques (accessible-name
// resolution, checkVisibility filtering, viewport-center hit-testing, stable node
// identity, robust fill) are adapted from browser-use/jev-ultrafast (MIT License).

const DEFAULT_PORT = 10577;
const IS_MAC = (navigator.userAgent || '').indexOf('Macintosh') >= 0;
let ws = null;
let reconnectTimer = null;

// Per-session state. Each session drives its own tab(s) inside its own tab group.
const attachedTabs = new Set();
const peekOnly = new Set();               // tabs attached ONLY for dev frame capture (peek)           // tabIds we currently hold a debugger on
const sessions = new Map();               // sessionId -> { activeTabId, createdTabs:Set, groupId, num, color }
const tabOwner = new Map();               // tabId -> sessionId (so sessions don't steal each other's tabs)
const chains = new Map();
const refSeed = new Map();                // tabId -> next unused ref number (see SNAPSHOT: refs never repeat within a tab)                 // sessionId -> Promise (serialize commands within a session)
let sessionCounter = 0;
let colorCursor = 0;
// PawBrowse's own group identity — deliberately NOT Claude-in-Chrome's blue "Claude" group.
// Distinct emoji (🐾) + a rotating non-blue palette so concurrent sessions are visually distinct.
const GROUP_COLORS = ['orange', 'cyan', 'purple', 'pink', 'green', 'yellow', 'red', 'grey'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------- persistence across service-worker restarts (avoid orphan tabs/groups) --------- *
 * MV3 kills the service worker under memory pressure, wiping the maps above. Without this, a
 * restart would abandon each session's tab + "🐾 PawBrowse" group (and endSession would no-op),
 * leaking one tab/group per session. We mirror the minimal session→tab/group map to
 * chrome.storage.session (cleared when the browser closes) and rehydrate on startup. All of it is
 * best-effort: if storage is unavailable, behaviour degrades to in-memory only.                */
let persistTimer = null;
function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const ser = {};
      for (const [k, v] of sessions) ser[k] = { activeTabId: v.activeTabId, createdTabs: [...v.createdTabs], groupId: v.groupId, num: v.num, color: v.color };
      await chrome.storage.session.set({ pawbrowse_state: { sessions: ser, tabOwner: [...tabOwner], sessionCounter, colorCursor, refSeed: [...refSeed] } });
    } catch {}
  }, 250);
  persistTimer.unref?.();
}
const rehydrated = (async () => {
  try {
    const { pawbrowse_state: st } = await chrome.storage.session.get('pawbrowse_state');
    if (!st) return;
    for (const [k, v] of Object.entries(st.sessions || {})) {
      if (!sessions.has(k)) sessions.set(k, { activeTabId: v.activeTabId, createdTabs: new Set(v.createdTabs || []), groupId: v.groupId, num: v.num, color: v.color });
    }
    for (const [t, sess] of (st.tabOwner || [])) if (!tabOwner.has(t)) tabOwner.set(t, sess);
    if (typeof st.sessionCounter === 'number') sessionCounter = Math.max(sessionCounter, st.sessionCounter);
    if (typeof st.colorCursor === 'number') colorCursor = Math.max(colorCursor, st.colorCursor);
    for (const [t, n] of (st.refSeed || [])) refSeed.set(t, Math.max(refSeed.get(t) || 1, n));
  } catch {}
})();

function sessionState(session) {
  const key = session || '_default';
  let s = sessions.get(key);
  if (!s) {
    s = { activeTabId: null, createdTabs: new Set(), groupId: null, num: ++sessionCounter, color: GROUP_COLORS[colorCursor++ % GROUP_COLORS.length] };
    sessions.set(key, s);
    persistState();
  }
  return s;
}

// Put a tab into this session's tab group, creating the group (with PawBrowse's own name +
// color + 🐾) on first use. Best-effort: grouping can fail across windows — never fatal.
async function ensureGroup(s, tabId) {
  try {
    if (s.groupId != null) {
      try { await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] }); return; }
      catch { s.groupId = null; } // stale group (e.g. all its tabs closed) — recreate below
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    s.groupId = groupId; persistState();
    const title = s.num > 1 ? `🐾 PawBrowse ${s.num}` : '🐾 PawBrowse';
    await chrome.tabGroups.update(groupId, { title, color: s.color });
  } catch {}
}

async function getPort() {
  try { const { port } = await chrome.storage.local.get('port'); return port || DEFAULT_PORT; }
  catch { return DEFAULT_PORT; }
}

/* ------------------------- WebSocket to the bridge ------------------------- */

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = await getPort();
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', ext: chrome.runtime.id }));
    setBadge('on');
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.cmd) return;
    const sock = ws;
    const session = msg.session || '_default';
    // Serialize commands PER SESSION (overlapping calls in one session queue instead of racing
    // that session's tab); different sessions run concurrently on their own tabs. Each command is
    // bounded by a 25s timeout AND a cancellation token so a stalled multi-step command (act/
    // navigate) stops issuing further CDP ops instead of leaking work into the next one.
    const token = { cancelled: false };
    const prev = chains.get(session) || Promise.resolve();
    let settled = null;
    const run = prev.then(async () => {
      let timer;
      try {
        const work = handleCommand(msg.cmd, msg.args || {}, token, session);
        // The next command in this session must not start while this one is still touching the tab,
        // even after we've replied with a timeout (bounded, so a wedged page can't block forever).
        settled = Promise.race([work.catch(() => {}), sleep(15000)]);
        const result = await Promise.race([
          work,
          new Promise((_, rej) => { timer = setTimeout(() => { token.cancelled = true; rej(new Error(`command timed out in extension after 25s${msg.cmd === 'act' || msg.cmd === 'navigate' ? ' — it may already have acted: observe before retrying' : ''}`)); }, 25000); }),
        ]);
        clearTimeout(timer);
        sock.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (e) {
        clearTimeout(timer);
        try { sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) })); } catch {}
      }
    });
    chains.set(session, run.catch(() => {}).then(() => settled));
  };
  ws.onclose = () => { setBadge('off'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function setBadge(state) {
  try {
    chrome.action.setBadgeText({ text: state === 'on' ? '●' : '' });
    chrome.action.setBadgeBackgroundColor({ color: state === 'on' ? '#16a34a' : '#999999' });
  } catch {}
}

/* ------------------------------- CDP helpers ------------------------------ */

// A CDP target is a tabId (the tab's top frame) or { tabId, sessionId?, frameId? }: sessionId
// addresses an out-of-process (cross-site) iframe attached via Target.setAutoAttach (flat sessions,
// Chrome 125+); frameId pins evaluation to a cross-origin frame living in that session's process.
const tabOf = (t) => (typeof t === 'object' ? t.tabId : t);
function sendCdp(target, method, params = {}) {
  const dbg = typeof target === 'object' ? (target.sessionId ? { tabId: target.tabId, sessionId: target.sessionId } : { tabId: target.tabId }) : { tabId: target };
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(dbg, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

// All of PawBrowse's page-side code runs in its own ISOLATED WORLD (like an extension content
// script / Playwright's utility world): it shares the DOM with the page but not its JS globals, so a
// page that monkey-patches Array.prototype / JSON / Element.prototype, or that squats on our cache
// name, can't blind or steer the snapshot. One world per tab's main frame; a navigation destroys it
// and the next call transparently recreates it.
const worlds = new Map(); // tabId -> Map(frameKey -> executionContextId)
const frameKey = (t) => (typeof t === 'object' ? `${t.sessionId || ''}|${t.frameId || ''}` : '|');

async function worldFor(target) {
  const tabId = tabOf(target), key = frameKey(target);
  let m = worlds.get(tabId);
  if (!m) { m = new Map(); worlds.set(tabId, m); }
  const cached = m.get(key);
  if (cached != null) return cached;
  let frameId = typeof target === 'object' ? target.frameId : null;
  if (!frameId) ({ frameTree: { frame: { id: frameId } } } = await sendCdp(target, 'Page.getFrameTree'));
  const { executionContextId } = await sendCdp(target, 'Page.createIsolatedWorld', { frameId, worldName: 'pawbrowse' });
  m.set(key, executionContextId);
  return executionContextId;
}

async function evaluate(target, expression, opts) {
  let r;
  for (let attempt = 0; ; attempt++) {
    const contextId = await worldFor(target);
    try {
      r = await sendCdp(target, 'Runtime.evaluate', { expression, contextId, returnByValue: !(opts && opts.handle), awaitPromise: true });
      break;
    } catch (e) {
      // The world died with its previous document (navigation/reload) BEFORE this call: make a fresh
      // one and retry once. NOT when the context was destroyed DURING the call ("Execution context
      // was destroyed") — the expression may have already acted (e.g. a select that navigated) and
      // re-running it on the new page would act twice.
      worlds.get(tabOf(target))?.delete(frameKey(target));
      if (attempt >= 1 || !/Cannot find context/i.test(e.message)) throw e;
    }
  }
  if (r && r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluation error');
  }
  return opts && opts.handle ? r.result : r.result.value;
}

// Attach to a SPECIFIC tab and keep it attached (many tabs can be attached at once, one per
// concurrent session). We never detach another tab here — that would break a sibling session.
async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  // "Already attached" can mean OUR own attachment survived a service-worker restart (fine) OR a
  // FOREIGN debugger owns the tab — DevTools or another extension (not fine: we can't drive it).
  const already = await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/already attached/i.test(err.message)) { resolve(true); return; }
        reject(new Error(err.message)); return;
      }
      resolve(false);
    });
  });
  attachedTabs.add(tabId);
  if (already) {
    // Probe: if we truly hold the session this succeeds; if a foreign debugger owns it, it throws.
    try { await sendCdp(tabId, 'Runtime.evaluate', { expression: '1', returnByValue: true }); }
    catch { attachedTabs.delete(tabId); throw new Error('another debugger is attached to this tab (close DevTools or another extension) so PawBrowse cannot drive it'); }
  }
  await sendCdp(tabId, 'Runtime.enable', {}).catch(() => {});
  await sendCdp(tabId, 'Page.enable', {}).catch(() => {});
  await sendCdp(tabId, 'DOM.enable', {}).catch(() => {});
  // Lifecycle events (cheap: a handful per load) tell us when a new document is ready. The Network
  // domain is NOT left on: on ad-heavy pages (hundreds of requests) it slows the whole browser, so
  // it's switched on only around actions (netOn/netOff), where "did this click start a fetch?" matters.
  await sendCdp(tabId, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
  try { const { frameTree } = await sendCdp(tabId, 'Page.getFrameTree'); tabWatch(tabId).mainFrame = frameTree.frame.id; } catch {}
  // WebMCP (sites exposing their own agent tools; Chrome 146+ behind a flag / origin trial).
  await sendCdp(tabId, 'WebMCP.enable', {}).catch(() => {});
  // Cross-site iframes run in other renderer processes: attach to each as a flat child session.
  await sendCdp(tabId, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
  // Make the tab behave as focused even when it's a background tab, so focus/blur, rendering,
  // and focus-dependent menus/dropdowns work while driving (the same approach Playwright uses for
  // backgrounded pages). A hidden tab still throttles requestAnimationFrame, so our waits use
  // setTimeout/setInterval, not rAF.
  await sendCdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

function detach(tabId) {
  return new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; attachedTabs.delete(tabId); forgetTab(tabId, false); resolve(); }));
}

// Everything we remember about a tab's CDP state. On detach (user cancelled the debugging bar,
// renderer crash) child sessions are gone without detachedFromTarget events: drop them so a
// re-attach rebuilds cleanly. On tab close, also drop what outlives an attachment.
function forgetTab(tabId, closed) {
  worlds.delete(tabId); childSessions.delete(tabId); webTools.delete(tabId); shotScale.delete(tabId);
  if (!closed) return;
  watches.delete(tabId); frameIdx.delete(tabId); lastTable.delete(tabId); lastFull.delete(tabId);
  openDialogs.delete(tabId); acting.delete(tabId); dialogLog.delete(tabId); refSeed.delete(tabId);
  for (const k of [...refSeed.keys()]) if (String(k).startsWith(`${tabId}#`)) refSeed.delete(k);
}
chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) { attachedTabs.delete(source.tabId); forgetTab(source.tabId, false); } });

// JavaScript dialogs (alert/confirm/prompt/beforeunload) block the page's main thread, so every CDP
// call into the tab would hang until someone clicks the dialog. While PawBrowse is ACTING on a tab
// it answers them itself: alerts are accepted, confirm/prompt/beforeunload are DISMISSED unless the
// op opted in with dialog:"accept" (a destructive confirm is never auto-approved). What was shown is
// reported back. Dialogs that appear while we're idle belong to the user and are left alone; if one
// is still open when a command arrives we say so instead of hanging.
const acting = new Map();      // tabId -> { accept?: boolean, text?: string } while an act/navigate runs
const dialogLog = new Map();   // tabId -> [lines] reported in the next result
const openDialogs = new Map(); // tabId -> { type, message } left open (appeared while idle)

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === 'Page.javascriptDialogClosed') { openDialogs.delete(tabId); return; }
  if (method !== 'Page.javascriptDialogOpening') return;
  const pol = acting.get(tabId);
  // Dialogs from any frame (incl. out-of-process iframes) are raised on — and answered via — the
  // root session (Chromium routes them through the main frame's Page domain).
  const where = tabId;
  if (!pol) { openDialogs.set(tabId, { type: params.type, message: params.message, where }); return; }
  const accept = pol.accept != null ? pol.accept : params.type === 'alert';
  const promptText = pol.text != null ? String(pol.text) : (params.defaultPrompt || '');
  sendCdp(where, 'Page.handleJavaScriptDialog', { accept, promptText }).catch(() => {});
  const lines = dialogLog.get(tabId) || [];
  lines.push(`${params.type} "${String(params.message || '').replace(/\s+/g, ' ').slice(0, 200)}" → ${accept ? 'accepted' : 'dismissed'}${params.type === 'prompt' && accept ? ` with "${promptText}"` : ''}${!accept && params.type !== 'alert' ? ` (to accept, repeat ${pol.nav ? 'browser_navigate' : 'the op'} with dialog:"accept")` : ''}`);
  dialogLog.set(tabId, lines);
});

// Run fn with this tab's dialogs auto-answered (see above).
async function whileActing(tabId, fn, policy) {
  const mine = { ...(policy || {}) };
  acting.set(tabId, mine);
  try { return await fn(); } finally {
    // A dialog that pops up just AFTER the action (a follow-up alert once a confirm is answered) is
    // still its consequence: keep answering with the default policy for a short while and report it
    // with the next result, instead of leaving the page frozen for the next call.
    if (acting.get(tabId) === mine) {
      const linger = { linger: true };
      acting.set(tabId, linger);
      setTimeout(() => { if (acting.get(tabId) === linger) acting.delete(tabId); }, 1500);
    }
  }
}

function takeDialogLog(tabId) {
  const l = dialogLog.get(tabId); dialogLog.delete(tabId);
  return l && l.length ? l.map((x) => `  dialog: ${x}`).join('\n') + '\n' : '';
}

// Refuse to talk to a tab frozen by a dialog the user hasn't answered (it would hang). The
// act op {op:"dialog"} answers it.
function assertNoOpenDialog(tabId) {
  const d = openDialogs.get(tabId);
  if (d) throw new Error(`the page is showing ${d.type === 'alert' ? 'an' : 'a'} ${d.type} dialog "${String(d.message || '').slice(0, 120)}" and is frozen until it's answered: run browser_act with [{op:"dialog",accept:true|false}] (or answer it in the browser)`);
}

// If a driven tab is closed (by the user or by us), forget it everywhere so a session doesn't
// keep pointing at a dead tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  forgetTab(tabId, true);
  openedBy.delete(tabId);
  const owner = tabOwner.get(tabId);
  tabOwner.delete(tabId);
  if (owner != null) {
    const s = sessions.get(owner);
    if (s) { s.createdTabs.delete(tabId); if (s.activeTabId === tabId) s.activeTabId = null; }
  }
  persistState();
});

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

// Browser-internal pages and the Web Store forbid CDP/debugger driving. Applied to BOTH the
// active tab and an explicitly-passed tabId so neither path can attach to a restricted page.
function restrictedPage(url) {
  url = url || '';
  return /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)
    || /^https?:\/\/chromewebstore\.google\.com/i.test(url)
    || /^https?:\/\/chrome\.google\.com\/webstore/i.test(url);
}

// Resolve which tab THIS session should drive, keeping sessions isolated:
//   - explicit tabId  -> use it (validated), adopt into the session's group.
//   - session already has a live tab -> reuse it.
//   - mode 'inspect' (observe/read/act/assert), first tab -> adopt the current active page if it's
//     free (not owned by another session); this preserves "read what I have open" for one session.
//   - otherwise (incl. mode 'navigate' first tab) -> create a NEW tab in the session's group, so we
//     never clobber the user's current page and concurrent sessions never share a tab.
async function resolveTabId(session, args, mode) {
  const s = sessionState(session);
  if (args.tabId != null) {
    let t;
    try { t = await chrome.tabs.get(args.tabId); }
    catch { throw new Error(`tab ${args.tabId} not found (list tabs with browser_tabs)`); }
    if (restrictedPage(t.url)) throw new Error(`that tab (${t.url}) is a browser page that cannot be driven; use a normal web page`);
    s.activeTabId = t.id; tabOwner.set(t.id, session); persistState();
    await ensureGroup(s, t.id);
    return t.id;
  }
  if (s.activeTabId != null) {
    try { const t = await chrome.tabs.get(s.activeTabId); if (t) return s.activeTabId; }
    catch { s.activeTabId = null; }
  }
  if (mode === 'inspect') {
    const t = await activeTab();
    // Read-and-claim must stay synchronous (no await between the owner read and the set below), so
    // two concurrent sessions can't both adopt the same tab: whichever runs first claims it, and the
    // other sees the claim and falls through to create its own tab.
    const owner = t ? tabOwner.get(t.id) : undefined;
    if (t && !restrictedPage(t.url) && (owner == null || owner === session)) {
      s.activeTabId = t.id; tabOwner.set(t.id, session); persistState();
      await ensureGroup(s, t.id);
      return t.id;
    }
  }
  const nt = await chrome.tabs.create({ url: 'about:blank', active: false });
  s.activeTabId = nt.id; s.createdTabs.add(nt.id); tabOwner.set(nt.id, session); persistState();
  await ensureGroup(s, nt.id);
  return nt.id;
}

// End a session (its controller disconnected): close only the tabs WE created for it, ungroup any
// tab we merely adopted (the user's own), and drop the group. Never closes the user's tabs.
async function endSession(session) {
  const s = sessions.get(session || '_default');
  if (!s) return { ended: true };
  for (const tid of s.createdTabs) {
    try { if (attachedTabs.has(tid)) await detach(tid); } catch {}
    try { await chrome.tabs.remove(tid); } catch {}
    attachedTabs.delete(tid); tabOwner.delete(tid);
  }
  if (s.activeTabId != null && !s.createdTabs.has(s.activeTabId)) {
    const tid = s.activeTabId;
    try { if (attachedTabs.has(tid)) await detach(tid); } catch {}
    try { await chrome.tabs.ungroup([tid]); } catch {}
    tabOwner.delete(tid);
  }
  sessions.delete(session || '_default');
  chains.delete(session || '_default');
  persistState();
  return { ended: true };
}

/* ------------------------------ Perception -------------------------------- *
 * Accessible-name resolution, native checkVisibility, viewport-center filtering,
 * stable WeakMap identity, select-options-as-actions, and in-viewport page text.
 * (Techniques credited in the file header.) Each snapshot re-numbers
 * displayed ids (e1..) but backs them with stable node ids (cache.byId) so an
 * action re-resolves the exact element it was chosen from.
 * -------------------------------------------------------------------------- */

// DOM activity tracker, kept apart from the ref cache (window.__pawbrowse) so creating it can't
// reset ref numbering. Installed by the first snapshot or wait in each document; shadow roots are
// added as the snapshot discovers them. Keeps recent mutation times so a wait can tell "this page
// is always animating" (don't wait for quiet that never comes) from "the action changed things".
const MO_INSTALL = `var M=window.__pawmo; if(!M){ M=window.__pawmo={last:performance.now(),times:[],roots:new WeakSet()};
  M.mo=new MutationObserver(function(){ var t=performance.now(); M.last=t; M.times.push(t); if(M.times.length>64) M.times.shift(); });
  M.watch=function(r){ if(!M.roots.has(r)){ M.roots.add(r); try{ M.mo.observe(r,{subtree:true,childList:true,attributes:true,characterData:true}); }catch(_){} } };
  M.watch(document);
  // A busy main thread (parsing/running JS, rendering) is not "quiet" even when the DOM is still:
  // SPA routes often mutate nothing for a few hundred ms and then render everything at once.
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ var end=e.startTime+e.duration; if(end>M.last) M.last=end; }); }).observe({type:'longtask', buffered:false}); }catch(_){}
  }`;
const SNAPSHOT = `(function(seed, opts){
  opts=opts||{};
  try{
  if(!document.body) return null;
  // A NEW document continues numbering from where the tab's previous document stopped (seed), so a
  // ref held over from the last page can never silently name a different element on this one.
  var cache = window.__pawbrowse || (window.__pawbrowse = {ids:new WeakMap(), nodes:new Map(), next:Math.max(1,seed|0), byId:{}});
  var fresh=new Set(); // node ids first allocated during this snapshot
  function identity(e){
    var id=cache.ids.get(e), holder=id!=null && cache.nodes.get(id);
    // A new id if unseen — or if its old id now belongs to a different live element (a node that
    // was detached, had its ref handed to a replacement, then came back).
    if(id==null || (holder && holder!==e && holder.isConnected)){ id=cache.next++; cache.ids.set(e, id); fresh.add(id); }
    cache.nodes.set(id,e); return id;
  }
  cache.nodes.forEach(function(e,id){ if(!e.isConnected) cache.nodes.delete(id); });
  ${MO_INSTALL}
  // CLOSED shadow roots are invisible to page JS; the extension hands them to us via CDP
  // (probeClosedRoots) keyed by host. sroot() = a host's shadow root, open or closed.
  if(!cache.closed){ cache.closed=new WeakMap(); cache.probed=new WeakSet(); }
  function sroot(n){ return n.shadowRoot || cache.closed.get(n) || null; }
  cache.sroot=sroot;
  var pendingHosts=[];
  function safe(e){ return ['password','hidden'].indexOf(e.type)<0; }
  // display:contents boxes (every <slot>, many design-system wrappers) have no box of their own, so
  // checkVisibility() says false even though their children render: judge those by their parent.
  function shown(e){ for(var g=0; e && g<32; g++){ if(e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return true; var v=e.ownerDocument.defaultView; if(!v || v.getComputedStyle(e).display!=='contents') return false; e=e.parentElement || (e.parentNode && e.parentNode.host); } return false; }
  function visible(e){ return !!e && !e.closest('[aria-hidden="true"],[inert]') && shown(e); }
  function sized(e){ var r=e.getBoundingClientRect(); return r.width>0 && r.height>0; }
  function clean(s,n){ return String(s||'').replace(/\\s+/g,' ').trim().slice(0,n||120); }
  function name(e,seen){
    seen=seen||new Set();
    if(!e||seen.has(e)||e.nodeType!==1) return '';
    seen.add(e);
    var tag=e.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='TEMPLATE') return '';
    if(tag.toLowerCase()==='svg'){ var st=e.querySelector('title'); return e.getAttribute('aria-label')||(st?st.textContent:''); }
    var rt=(e.getRootNode&&e.getRootNode())||document; var gid=function(id){try{return (rt.getElementById&&rt.getElementById(id))||e.ownerDocument.getElementById(id);}catch(_){return null;}};
    // (A control that lists ITSELF in aria-labelledby contributes its own content, per accname.)
    var ref=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(function(id){ var t=gid(id); return t===e ? clean(e.textContent,80) : name(t,seen); }).filter(Boolean).join(' ');
    if(ref) return ref;
    if(e.getAttribute('aria-label')) return e.getAttribute('aria-label');
    var labs=[].slice.call(e.labels||[]).map(function(l){return name(l,seen);}).filter(Boolean).join(' ');
    if(labs) return labs;
    if(['button','submit','reset'].indexOf(e.type)>=0 && e.value) return e.value;
    if(e.getAttribute('alt')) return e.getAttribute('alt');
    // Visible descendants only: display:none / hidden children (tooltips, menus) must not leak in.
    // A rich-text editor's text is its VALUE, never its name (else typing into it renames it and
    // its ref is refused on the next action).
    // A <slot> shows the nodes ASSIGNED to it (a web component's light-DOM label), not its children.
    var kids = tag==='SLOT' ? ((e.assignedNodes && e.assignedNodes({flatten:true}).length) ? e.assignedNodes({flatten:true}) : e.childNodes) : e.childNodes;
    var txt = (tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||e.isContentEditable) ? '' : [].map.call(kids,function(n){ return n.nodeType===3 ? n.textContent : (n.nodeType===1 && visible(n) ? name(n,seen) : ''); }).join(' ').trim();
    if(txt) return txt;
    return e.getAttribute('title')||e.getAttribute('placeholder')||e.getAttribute('aria-placeholder')||'';
  }
  // A form field with no programmatic label: use a nearby <label> sibling (the common unassociated
  // "<label>Name</label><div><input></div>" markup), then placeholder-ish hints, then its name attr.
  function fieldLabel(e){
    var n=name(e); if(n) return n;
    if(!e.isContentEditable && !e.matches('input,textarea,select')) return '';
    for(var s=e.parentElement,d=0; s && d<3; s=s.parentElement,d++){
      if(['BODY','HTML','FORM'].indexOf(s.tagName)>=0) break;
      for(var k=0;k<s.children.length;k++){ var c=s.children[k]; if(c.tagName==='LABEL' && !c.contains(e) && !c.control){ var t=name(c); if(t) return t; } }
    }
    return e.getAttribute('data-placeholder')||e.getAttribute('name')||(e.isContentEditable?'Rich text editor':'');
  }
  // Last resort for a nameless control (icon-font buttons): a test id, a meaningful id/name, or an
  // icon class (fa-trash, bi-share, icon-close, material-icons text...) — shown as "icon:trash".
  function hint(e){
    var t=e.getAttribute('data-testid')||e.getAttribute('data-test')||e.getAttribute('data-qa')||e.getAttribute('data-cy')||e.getAttribute('data-action');
    if(t) return 'testid:'+clean(t,40);
    var els=[e].concat([].slice.call(e.querySelectorAll('i,span,svg,use,img')).slice(0,6));
    for(var k=0;k<els.length;k++){
      var cls=(els[k].getAttribute('class')||'')+' '+(els[k].getAttribute('href')||els[k].getAttribute('xlink:href')||'');
      var re=/(?:^|[\\s#])(?:fa|bi|mdi|icon|glyphicon|lucide|ti|ri|octicon|ico)[-_]([a-z][a-z0-9-]{1,30})/ig, m;
      while((m=re.exec(cls))){ if(!/^(solid|regular|light|thin|duotone|sharp|brands|lg|sm|xs|xl|fw|[0-9]+x|spin|pulse|icon|button|btn|wrapper|container|inner)$/i.test(m[1])) return 'icon:'+m[1].toLowerCase(); }
    }
    var id=e.id||e.getAttribute('name')||'';
    if(id && /[a-z]{3}/i.test(id) && !/\\d{3}|[0-9a-f]{8}|^(ember|react|radix|mui|headlessui|:r)/i.test(id)) return 'id:'+clean(id,40);
    return '';
  }
  var roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio','menuitemcheckbox','option','gridcell','combobox','textbox','searchbox','spinbutton','slider','treeitem'];
  // Semantic controls + custom clickables: any contenteditable, an inline onclick, or a
  // keyboard-focusable [tabindex] (framework buttons — React-Native-Web Pressables, design-system
  // divs — often expose only these). cursor:pointer clickables are added separately in collect().
  var selector='a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[onclick],[onmousedown],[onmouseup],[onpointerdown],[onpointerup],[ondblclick],[tabindex]:not([tabindex="-1"]),[draggable="true"],'+roles.map(function(r){return '[role="'+r+'"]';}).join(',');
  // Inputs whose value is SET (not typed): typing into these is unreliable, so type() routes them
  // through a value setter. The hint tells the agent the expected format.
  var SETTABLE={date:'YYYY-MM-DD',time:'HH:MM','datetime-local':'YYYY-MM-DDTHH:MM',month:'YYYY-MM',week:'YYYY-Www',color:'#rrggbb',range:''};
  function role(e){
    var explicit=e.getAttribute('role');
    if(roles.indexOf(explicit)>=0) return explicit;
    if(e.tagName==='BUTTON'||e.tagName==='SUMMARY') return 'button';
    if(e.tagName==='A') return 'link';
    if(e.tagName==='SELECT') return 'combobox';
    if(e.tagName==='TEXTAREA'||e.isContentEditable) return 'textbox';
    if(e.tagName==='INPUT'){
      if(['checkbox','radio'].indexOf(e.type)>=0) return e.type;
      if(['button','submit','reset','image','file'].indexOf(e.type)>=0) return 'button';
      if(e.type==='search') return 'searchbox';
      if(e.type==='number') return 'spinbutton';
      if(e.type==='range') return 'slider';
      if(['text','email','url','tel'].indexOf(e.type)>=0 || SETTABLE.hasOwnProperty(e.type)) return 'textbox';
    }
    return null;
  }
  // Hit-test a frame-local point in the element's own root, descending into nested open shadow
  // roots, so a covered control (overlay, modal backdrop, pointer-events:none) is flagged.
  // Is f (what is actually under the pointer) just the target's own visible content? Common
  // pattern (Google results, cards): the accessible element sits UNDER a sibling that renders the
  // row. Clicking there is what a person does. Not so for an empty overlay, a modal/fixed layer, a
  // different control, or an ancestor of the target.
  cache.sameWidget=function(t, f){
    try{
      if(!f || f===t || f.contains(t)) return false;
      var p=t.parentElement, d=0; while(p && d<2 && !p.contains(f)){ p=p.parentElement; d++; }
      if(!p || !p.contains(f) || p.tagName==='BODY' || p.tagName==='HTML') return false;
      for(var a=f; a && a!==p; a=a.parentElement){
        var cs=a.ownerDocument.defaultView.getComputedStyle(a);
        if(cs.position==='fixed' || cs.position==='sticky') return false;
        if(a.matches('a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=option],[role=tab]')) return false;
      }
      // A layer that CONTAINS other controls (a promo with its own button) is a different widget.
      if(f.querySelector('a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=option],[role=tab]')) return false;
      return !!((f.innerText||'').trim() || f.querySelector('img,svg') || /^(IMG|SVG)$/i.test(f.tagName));
    }catch(_){ return false; }
  };
  // Where to point at an element: the centre of its box — except for an inline element that WRAPS
  // (a link across two lines), whose box centre falls between the lines, on the surrounding text.
  // Then use the centre of its first visible line box.
  cache.pt=function(el){
    var r=el.getBoundingClientRect(), rs=el.getClientRects(), v=el.ownerDocument.defaultView;
    if(rs.length>1){ for(var i=0;i<rs.length;i++){ var q=rs[i]; if(q.width>=2 && q.height>=2 && q.bottom>0 && q.top<v.innerHeight) return {x:q.x+q.width/2, y:q.y+q.height/2, r:r}; } }
    return {x:r.x+r.width/2, y:r.y+r.height/2, r:r};
  };
  // Pointing at a web component's SLOTTED text (its light-DOM label) makes the shadow root's
  // elementFromPoint answer with the host: that's the control's own content, not a cover.
  function slotted(t, f){ var rt=t.getRootNode(); return !!(rt && rt.host && f===rt.host && t.querySelector && t.querySelector('slot')); }
  cache.slotted=slotted;
  // Does a pointer event landing on f count as hitting t? (t itself or inside it, its label's control,
  // its slotted content, or its own row content.) Used before AND during the click.
  cache.accepts=function(t, f){ return !!f && (t===f || (f.nodeType===1 && t.contains(f)) || (t.control && t.control===f) || slotted(t, f) || cache.sameWidget(t, f)); };
  cache.hits=function(t, lx, ly){
    try{
      if(lx==null){ var hp=cache.pt(t); lx=hp.x; ly=hp.y; }
      var root=t.getRootNode(); if(!root.elementFromPoint) root=t.ownerDocument;
      var f=root.elementFromPoint(lx,ly), g=0;
      while(f && sroot(f) && g++<16){ var inner=sroot(f).elementFromPoint(lx,ly); if(!inner||inner===f) break; f=inner; }
      return !!f && (t===f || t.contains(f) || (t.control && t.control===f) || slotted(t, f) || cache.sameWidget(t, f));
    }catch(_){ return true; }
  };
  var hits=cache.hits;
  // The element to click for a control. Styled checkboxes/radios/file pickers usually hide the
  // native input (opacity:0, 0x0, display:none, sr-only) and show a <label> or a card instead:
  // the visible label is the interaction surface; an opacity-0 input stretched over a visible
  // card is clicked directly. Returns null when the control has no usable surface.
  cache.surface=function(e){
    if(!e||!e.isConnected) return null;
    var hidable=e.tagName==='INPUT' && ['checkbox','radio','file'].indexOf(e.type)>=0;
    if(visible(e) && sized(e)){
      // A sr-only (1px, clipped) native input is "visible" but not clickable: use its label.
      if(!hidable || cache.hits(e)) return e;
    }
    if(!hidable) return null;
    if(e.closest('[aria-hidden="true"],[inert]')) return null;
    var labs=[].slice.call(e.labels||[]);
    for(var i=0;i<labs.length;i++) if(visible(labs[i]) && sized(labs[i])) return labs[i];
    if(visible(e) && sized(e)) return e; // no label to fall back to: report it as-is (covered)
    if(sized(e) && e.checkVisibility({checkOpacity:false,checkVisibilityCSS:true}) && visible(e.parentElement)){
      try{ if(e.ownerDocument.defaultView.getComputedStyle(e).pointerEvents!=='none') return e; }catch(_){}
    }
    return null;
  };
  // Identity-focused semantic guard: role + accessible name. Catches a target silently becoming a
  // different control (relabel), while tolerating value/checked/expanded churn.
  cache.guard=function(el){ if(!el) return ''; try{ return [role(el),clean(fieldLabel(el)||hint(el),200)].join(String.fromCharCode(1)); }catch(_){ return ''; } };
  var unnamed=function(g){ return !g || g.charAt(g.length-1)===String.fromCharCode(1); }; // role only, no label: never rebind on it
  // Walk the top document, OPEN shadow roots, and SAME-ORIGIN iframes. dx/dy translate each
  // element's frame-local rect into top-level viewport coordinates (shadow roots share their
  // frame's coords; iframes add their content-box offset). Cross-origin frames can't be read from
  // here; they're reported so the agent knows content exists that it can't see.
  var frames=[], remoteEls=[], textRoots=[];
  function collect(){
    var out=[], seen=new Set(), scanned=0;
    function add(el, dx, dy, clk){ if(seen.has(el)) return; seen.add(el); out.push({el:el, dx:dx, dy:dy, clk:clk}); }
    function walk(root, dx, dy, depth){
      if(depth>12) return;
      textRoots.push({root:root, dx:dx, dy:dy});
      var els; try{ els=root.querySelectorAll(selector); }catch(_){ els=[]; }
      for(var a=0;a<els.length;a++) add(els[a], dx, dy, false);
      var all; try{ all=root.querySelectorAll('*'); }catch(_){ all=[]; }
      for(var b=0;b<all.length;b++){
        var n=all[b];
        // Custom/framework clickables (e.g. React-Native-Web Pressable/Touchable, many design
        // systems) render as role-less <div>s but get cursor:pointer. Include the ROOT of each
        // pointer region (its parent is NOT pointer) so we capture the pressable itself, not its
        // inherited-cursor text children. Bounded scan so huge DOMs stay fast.
        // <a> without href but with inline JS handlers (onmouseenter/onmousedown/...): JS-driven links.
        if(!seen.has(n) && n.tagName==='A' && !n.hasAttribute('href')){ for(var ai=0;ai<n.attributes.length;ai++){ if(/^on(mouse|pointer|touch|click|dblclick|key)/.test(n.attributes[ai].name)){ add(n, dx, dy, true); break; } } }
        if(!seen.has(n) && scanned<8000){
          scanned++;
          try{
            var view=(n.ownerDocument&&n.ownerDocument.defaultView)||window;
            if(view.getComputedStyle(n).cursor==='pointer'){
              var pe=n.parentElement;
              if(!pe || view.getComputedStyle(pe).cursor!=='pointer') add(n, dx, dy, true);
            }
          }catch(_){}
        }
        var sr=sroot(n);
        if(sr){ M.watch(sr); walk(sr, dx, dy, depth+1); }
        else if(n.localName.indexOf('-')>0 && !cache.probed.has(n) && pendingHosts.length<40 && sized(n)) pendingHosts.push(n); // custom element: may hide a closed root
        if(n.tagName==='IFRAME' || n.tagName==='FRAME'){
          var idoc=null; try{ idoc=n.contentDocument; }catch(_){}
          if(idoc && idoc.body){
            var ir=n.getBoundingClientRect();
            walk(idoc, dx+ir.left+n.clientLeft+(parseFloat(n.ownerDocument.defaultView.getComputedStyle(n).paddingLeft)||0),
              dy+ir.top+n.clientTop+(parseFloat(n.ownerDocument.defaultView.getComputedStyle(n).paddingTop)||0), depth+1);
          } else if(visible(n) && (function(){ var fr=n.getBoundingClientRect(); return fr.width>=10 && fr.height>=10; })()){ // 1x1 ad/tracking frames don't count
            var src=''; try{ src=new URL(n.src, location.href).host; }catch(_){ src=n.getAttribute('src')||''; }
            frames.push(clean(n.getAttribute('title')||n.getAttribute('aria-label')||n.name||src||'frame',60));
            remoteEls.push(n);
          }
        }
      }
    }
    walk(document, 0, 0, 0);
    return out;
  }
  // Not hittable, but only because a sticky/fixed bar (not a modal) or something OUTSIDE its own
  // scroll box sits on top of it — e.g. a sidebar list scrolled under the sidebar's filter header.
  // Acting scrolls it into the open, so it's "scrolled out", not "covered".
  function reachable(t, lx, ly){
    try{
      var root=t.getRootNode(); if(!root.elementFromPoint) root=t.ownerDocument;
      var f=root.elementFromPoint(lx,ly); if(!f || f.contains(t)) return false;
      var view=t.ownerDocument.defaultView;
      for(var a=f; a && a.nodeType===1; a=a.parentElement){
        if(a.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) return false;
        var cs=view.getComputedStyle(a);
        if(cs.position==='fixed' || cs.position==='sticky'){ var q=a.getBoundingClientRect(); return q.width*q.height < 0.4*view.innerWidth*view.innerHeight; }
      }
      var sc=t.parentElement; while(sc && !(sc.scrollHeight>sc.clientHeight+2 && /(auto|scroll)/.test(view.getComputedStyle(sc).overflowY))) sc=sc.parentElement;
      return !!sc && sc!==t.ownerDocument.body && sc!==t.ownerDocument.documentElement && !sc.contains(f);
    }catch(_){ return false; }
  }
  var scrollerCache=new Map(); // element -> does it clip its overflow? (one style read per ancestor per snapshot)
  function clipper(a, view){ var v=scrollerCache.get(a); if(v===undefined){ var cs=view.getComputedStyle(a); v=!(cs.overflowX==='visible' && cs.overflowY==='visible'); scrollerCache.set(a,v); } return v; }
  function clipped(t){
    try{
      var r=t.getBoundingClientRect(), cx=r.x+r.width/2, cy=r.y+r.height/2, view=t.ownerDocument.defaultView;
      for(var a=t.parentElement, g=0; a && g<40; a=a.parentElement, g++){
        if(!clipper(a, view)) continue;
        var ar=a.getBoundingClientRect();
        // How far outside the box it is (0 = inside), so the nearest hidden rows are kept first.
        if(cx<ar.left||cx>ar.right||cy<ar.top||cy>ar.bottom) return 1+Math.max(ar.left-cx,cx-ar.right,ar.top-cy,cy-ar.bottom,0);
      }
    }catch(_){}
    return 0;
  }
  var inView=[], offView=[], farOff=0, nodes=collect(), VH=innerHeight, VW=innerWidth;
  for(var i=0;i<nodes.length;i++){
    var e=nodes[i].el, ox=nodes[i].dx, oy=nodes[i].dy, clk=nodes[i].clk;
    try{
    if(!safe(e)||e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) continue;
    // Cheap early exit for controls screens away (huge pages have thousands): count, don't process.
    var r0=e.getBoundingClientRect();
    if(!opts.all && r0.width>0 && r0.height>0){ var y0=r0.y+r0.height/2+oy; if(y0<-VH||y0>=2*VH){ if(visible(e)) farOff++; continue; } }
    var surf=cache.surface(e); if(!surf) continue;
    var rname=role(e);
    if(!rname){
      // Role-less custom clickable (cursor:pointer, inline onclick, or focusable [tabindex]).
      // Only accept it if it has a real label and isn't just a wrapper around an actual control
      // (or a <label> standing in for one), so we don't flood the table with layout containers.
      var ti=e.getAttribute('tabindex');
      if(clk || e.hasAttribute('onclick') || e.hasAttribute('onmousedown') || e.hasAttribute('onmouseup') || e.hasAttribute('onpointerdown') || e.hasAttribute('onpointerup') || e.hasAttribute('ondblclick') || (ti!==null && ti!=='-1') || e.getAttribute('draggable')==='true'){
        if(e.tagName==='LABEL' && e.control) continue;
        if(!(name(e)||'').trim() || e.querySelector(selector)) continue;
        rname='button';
      }
    }
    if(!rname) continue;
    var sp=cache.pt(surf), r=sp.r, lx=sp.x, ly=sp.y, x=lx+ox, y=ly+oy;
    if(x<0||x>=VW) continue;
    if(rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    var base={node:identity(e), role:rname, label:clean(fieldLabel(e)||hint(e)||rname), x:Math.round(x), y:Math.round(y), w:Math.round(r.width), h:Math.round(r.height)};
    var achecked=e.getAttribute('aria-checked');
    if(['checkbox','radio'].indexOf(e.type)>=0) base.checked=!!e.checked;
    else if(achecked!=null) base.checked=(achecked==='true');
    var aexp=e.getAttribute('aria-expanded'); if(aexp!=null) base.expanded=(aexp==='true');
    var asel=e.getAttribute('aria-selected'); if(asel!=null) base.selected=(asel==='true');
    if(e.required || e.getAttribute('aria-required')==='true') base.required=true;
    if(e.getAttribute('draggable')==='true') base.draggable=true;
    // Only surface validation errors on fields the user (or agent) has put a value in, or that the
    // page itself flags, so an untouched required form isn't a wall of warnings.
    if(e.getAttribute('aria-invalid')==='true') base.invalid='invalid';
    else if(e.validity && !e.validity.valid && e.value) base.invalid=clean(e.validationMessage,80)||'invalid';
    var clip=clipped(surf);
    if(clip){
      base.off='scroll'; base.dist=clip; // inside an overflow box, scrolled out of it: acting scrolls it into view
    } else if(y<0||y>=VH){
      // Off-screen (scrolled away): keep the nearest ones so the agent knows they exist; acting on
      // them scrolls them into view first.
      if(!opts.all && (y<-VH/2||y>=1.5*VH)){ farOff++; continue; }
      base.off=y<0?'up':'down'; base.dist=y<0?-y:y-VH;
    } else if((function(){ var fv=surf.ownerDocument.defaultView; return fv!==window && (lx<0||ly<0||lx>=fv.innerWidth||ly>=fv.innerHeight); })()){
      base.off='scroll'; // scrolled out of its (same-origin) iframe's viewport
    } else if(!hits(surf, lx, ly) && reachable(surf, lx, ly)){
      base.off='scroll'; base.dist=1; // hidden under a sticky bar / a panel header: right here, scrolling brings it out
    } else if(!hits(surf, lx, ly)){
      // Not hittable: either scrolled out of an overflow container (reachable — acting scrolls it
      // in) or genuinely covered by an overlay/modal (needs dismissing first).
      base.covered=true;
    }
    var list=base.off?offView:inView;
    if(e.tagName==='SELECT'){
      base.kind='select';
      if(e.multiple) base.fmt='multiple: select values:[...]';
      base.value=clean([].map.call(e.selectedOptions,function(o){return o.label;}).join(', '),80);
      base.options=[].filter.call(e.options,function(o){return !o.disabled && !(o.closest&&o.closest('optgroup[disabled]'));}).map(function(o){return clean(o.label,60);}).slice(0,40);
      list.push(base);
    } else if(e.tagName==='INPUT' && e.type==='file'){
      base.kind='upload';
      if(e.files && e.files.length) base.value=clean([].map.call(e.files,function(f){return f.name;}).join(', '),80);
      if(e.accept) base.fmt=clean(e.accept,60);
      list.push(base);
    } else {
      var settable=e.tagName==='INPUT' && SETTABLE.hasOwnProperty(e.type);
      var editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' && (['textbox','searchbox','spinbutton'].indexOf(rname)>=0 || (rname==='slider' && e.tagName==='INPUT') || (rname==='combobox' && ['INPUT','TEXTAREA'].indexOf(e.tagName)>=0));
      var value = (['checkbox','radio'].indexOf(e.type)>=0) ? '' : (('value' in e && e.tagName!=='BUTTON' && e.tagName!=='LI') ? String(e.value) : ((e.isContentEditable||rname==='combobox') ? e.innerText.trim() : ''));
      if(e.tagName==='INPUT' && ['button','submit','reset','image'].indexOf(e.type)>=0) value=''; // its value IS its label
      if(value) base.value=clean(value,80); // single line: page text must never forge extra table rows
      if(settable){ base.fmt=e.type==='range' ? (e.min||'0')+'..'+(e.max||'100')+(e.step&&e.step!=='any'?' step '+e.step:'') : SETTABLE[e.type]; }
      base.kind=editable?'fill':'click';
      list.push(base);
      // For an editable combobox, also offer a plain click to open its popup (not just type).
      if(editable && rname==='combobox'){ list.push({node:base.node, role:rname, label:'Open '+base.label, x:base.x, y:base.y, kind:'click', expanded:base.expanded, off:base.off, covered:base.covered}); }
    }
    }catch(_){ continue; }
  }
  var omitted=Math.max(0, inView.length-250); inView.splice(250);
  // Keep the 25 off-screen controls NEAREST the visible area (not the first 25 in DOM order, which
  // for a scrolled list are the rows furthest behind), then restore page order.
  var OFFCAP=opts.all?400:25;
  var offMore=Math.max(0, offView.length-OFFCAP)+farOff;
  if(offView.length>OFFCAP){ offView.forEach(function(a,k){ a.ord=k; }); offView.sort(function(a,b){ return a.dist-b.dist; }); offView.splice(OFFCAP); offView.sort(function(a,b){ return a.ord-b.ord; }); }
  var actions=inView.concat(offView);
  // The nearest ancestor text that isn't just the label itself: which row/item a control is in.
  cache.ctxOf=function(el, lab){ return ctxOf(el, lab); };
  function ctxOf(el, lab){
    for(var p=el&&el.parentElement, g=0; p && g<6 && p.tagName!=='BODY'; p=p.parentElement, g++){
      var tx=clean(p.innerText,400); if(!tx || tx===lab) continue;
      var rest=clean(tx.split(lab).join(' '),40); if(rest) return rest;
    }
    return '';
  }
  // Identical labels ("Delete" per row, "Edit" per user) are ambiguous to the agent: tag each with
  // the nearest ancestor text that tells them apart (e.g. the list row it lives in).
  try{
    var byLabel={};
    for(var u=0;u<actions.length;u++){ var key=actions[u].kind+'|'+actions[u].label; (byLabel[key]=byLabel[key]||[]).push(actions[u]); }
    Object.keys(byLabel).forEach(function(key){
      var grp=byLabel[key]; if(grp.length<2) return;
      grp.forEach(function(a){ var cx=ctxOf(cache.nodes.get(a.node), a.label); if(cx) a.ctx=cx; });
    });
  }catch(_){}
  var focus=null;
  try{ var fe=document.activeElement; while(fe && fe.shadowRoot && fe.shadowRoot.activeElement) fe=fe.shadowRoot.activeElement;
    for(var q=0; fe && fe.tagName==='IFRAME' && q<8; q++){ var fd=null; try{ fd=fe.contentDocument; }catch(_){} fe=fd?fd.activeElement:null; }
    if(fe && fe.tagName!=='BODY' && fe.tagName!=='HTML' && cache.ids.has(fe)) focus=cache.ids.get(fe);
  }catch(_){}
  // Displayed id derives from the STABLE node id (not position), so a reused number can never
  // remap to a different element across observations; duplicates (e.g. combobox Open) get a suffix.
  // Guarded so a getter/DOM quirk while building ids can't blank the whole table.
  // Resolved to CDP frame ids by the extension (cross-origin frames): biggest first, so a real
  // embedded app/checkout wins over banner slots when there are many.
  cache.pendingHosts=pendingHosts;
  cache.remoteEls=remoteEls.map(function(el){ var r=el.getBoundingClientRect(); return {el:el, a:r.width*r.height}; }).sort(function(p,q){ return q.a-p.a; }).slice(0,12).map(function(p){ return p.el; });
  // Keep refs stable across re-renders that REPLACE nodes: a brand-new element whose identity
  // (role + label + row context) uniquely matches an element that vanished since the last snapshot
  // takes over its node id, so "e12" keeps meaning "Done in Task 7" and the agent's refs survive.
  try{
    var gone={}, gcount={}, ncount={}, k2;
    Object.keys(cache.byId||{}).forEach(function(id){
      var nid=cache.byId[id]; if(cache.nodes.has(nid)) return; // still on the page
      var fp=cache.fps&&cache.fps[id]; if(!fp||!cache.guards[id]||unnamed(cache.guards[id])) return;
      k2=cache.guards[id]+'\u0002'+(fp.ctx||''); gone[k2]=nid; gcount[k2]=(gcount[k2]||0)+1;
    });
    var keyOf=function(a){ return cache.guard(cache.nodes.get(a.node))+'\u0002'+(a.ctx||''); };
    actions.forEach(function(a){ if(fresh.has(a.node)){ k2=keyOf(a); ncount[k2]=(ncount[k2]||0)+1; } });
    actions.forEach(function(a){
      if(!fresh.has(a.node)) return;
      k2=keyOf(a);
      if(gcount[k2]!==1 || ncount[k2]!==1) return; // ambiguous: never guess
      var el=cache.nodes.get(a.node), old=gone[k2];
      cache.nodes.delete(a.node); cache.ids.set(el, old); cache.nodes.set(old, el);
      actions.forEach(function(b){ if(b.node===a.node && b!==a) b.node=old; });
      a.node=old; delete gcount[k2];
    });
  }catch(_){}
  var focusId=null;
  try{
    cache.byId={}; cache.guards={}; cache.fps={}; var used={};
    for(var j=0;j<actions.length;j++){ var bid='e'+actions[j].node, id=bid, kk=2; while(used[id]){ id=bid+'_'+kk; kk++; } used[id]=1; actions[j].id=id; cache.byId[id]=actions[j].node; cache.guards[id]=cache.guard(cache.nodes.get(actions[j].node)); cache.fps[id]={label:actions[j].label, ctx:actions[j].ctx||''}; if(focus!=null && actions[j].node===focus && !focusId) focusId=id; }
  }catch(_){}
  // Resolve a ref to its live element. Frameworks that re-render by REPLACING nodes (innerHTML
  // templates, keyed lists) orphan every ref; re-find the replacement by the same identity the guard
  // uses (role + label) plus its row context — only when exactly ONE element matches, never a guess.
  cache.get=function(id){
    var node=cache.byId[id]; if(node==null) return null;
    var e=cache.nodes.get(node); if(e && e.isConnected) return e;
    var fp=cache.fps && cache.fps[id], want=cache.guards && cache.guards[id]; if(!fp || !want || unnamed(want)) return null;
    var cands=collect(), hit=null, n=0;
    for(var k=0;k<cands.length && n<2;k++){
      var el=cands[k].el;
      try{
        if(!el.isConnected || cache.guard(el)!==want || !cache.surface(el)) continue;
        if(fp.ctx && ctxOf(el, fp.label)!==fp.ctx) continue;
        hit=el; n++;
      }catch(_){}
    }
    if(n!==1) return null;
    cache.byId[id]=identity(hit);
    return hit;
  };
  // Optional: the visible text in reading order (top-to-bottom, left-to-right), for prices, headings
  // and results the controls table doesn't carry.
  var vtext='';
  if(opts.text){ try{
    var frags=[], seenT=0;
    textRoots.forEach(function(tr){
      var doc=tr.root.ownerDocument||tr.root, w=doc.createTreeWalker(tr.root.body||tr.root, NodeFilter.SHOW_TEXT), rg=doc.createRange(), nd;
      while((nd=w.nextNode()) && seenT<20000){ seenT++;
        var v=nd.textContent.replace(/\\s+/g,' ').trim(), p=nd.parentElement;
        if(!v||!p||p.closest('script,style,noscript,template')||!visible(p)) continue;
        rg.selectNodeContents(nd); var q=rg.getBoundingClientRect(), ty=q.y+tr.dy, tx=q.x+tr.dx;
        if(q.width<=0||q.height<=0||ty+q.height<0||ty>=VH||tx>=VW||tx+q.width<0) continue;
        frags.push({t:v, x:tx, y:ty});
      }
    });
    frags.sort(function(a,b){ return Math.round(a.y/6)-Math.round(b.y/6) || a.x-b.x; });
    var lines=[], cur=null, lastY=-1e9;
    frags.forEach(function(f){ if(Math.abs(f.y-lastY)>6){ if(cur) lines.push(cur); cur=f.t; lastY=f.y; } else cur+=' '+f.t; });
    if(cur) lines.push(cur);
    vtext=lines.join('\\n').slice(0,4000);
  }catch(_){} }
  return {url:location.href, title:document.title, vh:innerHeight, text:vtext, scrollY:Math.round(scrollY), scrollH:Math.round(document.documentElement.scrollHeight), omitted:omitted, offMore:offMore, frames:frames.slice(0,10), focus:focusId, next:cache.next, probe:pendingHosts.length, actions:actions};
  }catch(_){ return {url:location.href, title:(document&&document.title)||'', scrollY:0, scrollH:0, omitted:0, actions:[]}; }
})`;

function formatRow(a) {
  let flag = ' ';
  if (typeof a.expanded === 'boolean') flag = a.expanded ? '▾' : '▸'; // open / closed
  else if (typeof a.checked === 'boolean') flag = a.checked ? '✓' : '·';
  else if (a.selected === true) flag = '◉';
  let line = `${a.id.padEnd(4)} ${a.kind.padEnd(6)}${flag} "${a.label}"`;
  if (a.ctx) line += ` in "${a.ctx}"`;
  if (a.required) line += ' (required)';
  if (a.value) line += `  ▸ "${a.value}"`;
  if (a.fmt) line += `  fmt{${a.fmt}}`;
  if (a.kind === 'select' && a.options && a.options.length) line += `  opts{${a.options.join(' | ')}}`;
  if (a.invalid) line += `  ⚠ "${a.invalid}"`;
  if (a.off === 'up') line += '  ↑ above view';
  else if (a.off === 'down') line += '  ↓ below view';
  else if (a.off === 'scroll') line += '  ↕ scrolled out of its box';
  if (a.draggable) line += '  ⇄ draggable';
  if (a.covered) line += '  ⊘ covered';
  return line;
}

function formatTable(snap) {
  if (!snap) return '(page not ready)';
  const lines = [];
  const fsnaps = snap.frameSnaps || [];
  const count = snap.actions.length + fsnaps.reduce((n, f) => n + Math.min(60, f.snap.actions.length), 0);
  lines.push(`${snap.title || '(untitled)'}  —  ${snap.url}`);
  const more = (snap.omitted || 0) + (snap.offMore || 0);
  lines.push(`scroll ${snap.scrollY}/${snap.scrollH}  ·  ${count} controls${more ? ` (+${more} more; scroll to reveal)` : ''}${snap.focus ? `  ·  focus ${snap.focus}` : ''}`);
  if (snap.frames && snap.frames.length > fsnaps.length) lines.push(`cross-origin frames (content not readable): ${snap.frames.map((f) => `"${f}"`).join(', ')}`);
  for (const a of snap.actions) lines.push(formatRow(a));
  for (const { f, off, snap: fs } of fsnaps) {
    let host = f.url;
    try { host = new URL(f.url).host || f.url; } catch {}
    lines.push(`frame f${f.idx} "${String(host).slice(0, 60)}" (cross-origin):`);
    for (const a of fs.actions.slice(0, 60)) {
      const ty = off.y + a.y;
      if (!a.off && (ty < 0 || ty >= (snap.vh || 1e9))) a.off = ty < 0 ? 'up' : 'down';
      lines.push(formatRow({ ...a, id: `f${f.idx}.${a.id}` }));
    }
  }
  return lines.join('\n');
}

// A page signature to detect whether an action actually changed the page. Includes per-input
// value/checked/selectedIndex so fills, toggles, and selects register as changes (password
// values excluded).
const SIG = `JSON.stringify([location.href, document.title, document.body ? document.body.textContent.length : 0, [].map.call(document.querySelectorAll('input,textarea,select'),function(e){return e.type==='password'?'':(String(e.value)+'~'+(e.checked?1:0)+'~'+(e.selectedIndex==null?'':e.selectedIndex));}).join('|'), document.querySelectorAll('a,button,input,select,textarea,summary,[role]').length])`;

// Retry through transient "document is navigating" states so a snapshot taken
// during a transition settles instead of failing.
// Readable page text. innerText stops at shadow roots and iframes, so it misses web-component
// content and same-origin frames. Mark every composed ancestor of a shadow host / iframe; unmarked
// subtrees use the (fast, layout-aware) innerText, marked ones are walked through their composed
// children (shadow root, slots' assigned nodes, iframe document).
const READ_TEXT = `(function(max){
  var main=document.querySelector('main')||document.body; if(!main) return {title:document.title,url:location.href,text:''};
  var mark=new Set(), C=window.__pawbrowse&&window.__pawbrowse.closed;
  function sr(n){ return n.shadowRoot || (C&&C.get(n)) || null; }
  function scan(root,d){ if(d>12) return; var all; try{ all=root.querySelectorAll('*'); }catch(_){ return; }
    for(var i=0;i<all.length;i++){ var n=all[i], special=false;
      if(sr(n)){ special=true; scan(sr(n),d+1); }
      if(n.tagName==='SLOT') special=true;
      if(n.tagName==='IFRAME'||n.tagName==='FRAME'){ var doc=null; try{ doc=n.contentDocument; }catch(_){} if(doc&&doc.body){ special=true; scan(doc,d+1); } }
      if(special){ for(var p=n; p && !mark.has(p); ){ mark.add(p); p=p.parentNode; if(p && p.nodeType===11) p=p.host; } }
    } }
  scan(document,0);
  var out=[], len=0;
  function vis(e){ try{ if(e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return true; return getComputedStyle(e).display==='contents'; }catch(_){ return true; } }
  function put(t){ if(t && len<max){ out.push(t); len+=t.length; } }
  function kids(n){
    if(sr(n)) return sr(n).childNodes;
    if(n.tagName==='SLOT'){ var a=n.assignedNodes({flatten:true}); return a.length?a:n.childNodes; }
    return n.childNodes;
  }
  function walk(n,d){
    if(len>=max||d>60) return;
    if(n.nodeType===3){ var v=n.textContent.replace(/\\s+/g,' ').trim(); if(v && n.parentElement && vis(n.parentElement)) put(v); return; }
    if(n.nodeType!==1 && n.nodeType!==11) return;
    if(n.nodeType===1){
      if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName) || !vis(n)) return;
      if(n.tagName==='IFRAME'||n.tagName==='FRAME'){ var doc=null; try{ doc=n.contentDocument; }catch(_){} if(doc&&doc.body){ put('\\n'); walk(doc.body,d+1); put('\\n'); } return; }
      if(!mark.has(n)){ put(n.innerText); if(getComputedStyle(n).display!=='inline') put('\\n'); return; }
    }
    var k=kids(n); for(var i=0;i<k.length;i++) walk(k[i],d+1);
    if(n.nodeType===1 && getComputedStyle(n).display!=='inline') put('\\n');
  }
  walk(main,0);
  var text=out.join(' ').replace(/[ \\t]*\\n[ \\t]*/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,max);
  return {title:document.title,url:location.href,text:text};
})`;

/* ------------------------------ Cross-origin frames ------------------------- *
 * The page-side snapshot can't reach into cross-origin iframes (payment fields, embedded logins,
 * widgets). CDP can: cross-SITE frames are separate targets we auto-attach to as flat child
 * sessions; cross-origin but same-site frames share their parent's process and get their own
 * isolated world via frameId. Each readable frame gets a stable index per tab (f1, f2...), its
 * refs are shown as f1.e3, and clicks are translated by the frame's on-screen offset.           */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] };
const childSessions = new Map(); // tabId -> Map(sessionId -> { targetId, parent: sessionId|null })
const frameIdx = new Map();      // tabId -> { next, byKey: Map(key -> idx), byIdx: Map(idx -> frame) }
function kidsOf(tabId) { let m = childSessions.get(tabId); if (!m) { m = new Map(); childSessions.set(tabId, m); } return m; }

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === 'Target.attachedToTarget') {
    const info = params.targetInfo || {};
    if (info.type !== 'iframe' || /^chrome-extension:/i.test(info.url || '')) return; // other extensions' frames aren't ours to drive
    // Ad-heavy pages spawn hundreds of (mostly invisible) frames: just record them; a session is
    // only set up (ensureSession) when one of its frames is actually visible and read.
    kidsOf(tabId).set(params.sessionId, { targetId: info.targetId, parent: source.sessionId || null, ready: null });
  } else if (method === 'Target.detachedFromTarget') {
    kidsOf(tabId).delete(params.sessionId);
    const m = worlds.get(tabId);
    if (m) for (const k of [...m.keys()]) if (k.startsWith(`${params.sessionId}|`)) m.delete(k);
  }
});

async function ensureSession(tabId, sessionId) {
  const k = kidsOf(tabId).get(sessionId);
  if (!k) return;
  if (!k.ready) {
    const t = { tabId, sessionId };
    k.ready = Promise.all([['Page.enable', {}], ['DOM.enable', {}], ['Target.setAutoAttach', AUTO_ATTACH]].map(([m, p]) => sendCdp(t, m, p).catch(() => {})));
  }
  await k.ready;
}

// CDP frame ids of the visible cross-origin iframes a snapshot found in `target`'s document.
async function remoteFrameIds(target) {
  const ctx = await worldFor(target);
  const r = await sendCdp(target, 'Runtime.evaluate', { expression: 'window.__pawbrowse && window.__pawbrowse.remoteEls', contextId: ctx, objectGroup: 'pawframes' });
  const ids = [];
  try {
    if (!r.result || !r.result.objectId) return ids;
    const { result } = await sendCdp(target, 'Runtime.getProperties', { objectId: r.result.objectId, ownProperties: true });
    for (const p of result) {
      if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue;
      try { const { node } = await sendCdp(target, 'DOM.describeNode', { objectId: p.value.objectId }); if (node.frameId) ids.push(node.frameId); } catch {}
    }
  } finally { sendCdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'pawframes' }).catch(() => {}); }
  return ids;
}

// Read the cross-origin frames under a snapshot, depth-first: only visible ones, never invisible
// subtrees. Cross-SITE frames are their own attached session; cross-origin same-site frames live
// in the parent's process and are addressed by frameId.
async function readFrames(tabId, parentTarget, parentSnap, out, depth = 0) {
  if (!parentSnap || !parentSnap.frames || !parentSnap.frames.length || depth > 4 || out.length >= 12) return out;
  let ids = [];
  try { ids = await remoteFrameIds(parentTarget); } catch {}
  let fi = frameIdx.get(tabId);
  if (!fi) { fi = { next: 1, byKey: new Map(), byIdx: new Map() }; frameIdx.set(tabId, fi); }
  for (const fid of ids) {
    if (out.length >= 12) break;
    const sid = [...kidsOf(tabId)].reverse().find(([, k]) => k.targetId === fid)?.[0]; // newest wins after a re-attach
    const parentSession = typeof parentTarget === 'object' ? parentTarget.sessionId : undefined;
    const f = sid
      ? { target: { tabId, sessionId: sid }, root: true, key: `s:${fid}` }
      : { target: { tabId, sessionId: parentSession, frameId: fid }, root: false, key: `f:${fid}` };
    try {
      if (sid) await ensureSession(tabId, sid);
      const off = await frameOffset(tabId, f);
      if (off.w < 10 || off.h < 10) continue; // tracking pixels / collapsed frames
      const fs = await snapshot(f.target, 1);
      if (!fs || !fs.actions) continue;
      if (!fi.byKey.has(f.key)) fi.byKey.set(f.key, fi.next++);
      f.idx = fi.byKey.get(f.key); f.url = fs.url;
      fi.byIdx.set(f.idx, f);
      out.push({ f, off, snap: fs });
      await readFrames(tabId, f.target, fs, out, depth + 1);
    } catch {}
  }
  return out;
}

// Top-level viewport offset (and size) of a frame's content box: its owner <iframe>'s content quad
// in the parent's local root, plus that parent session's own offset, up to the top.
async function frameOffset(tabId, f) {
  let x = 0, y = 0, w = 0, h = 0, first = true, topOwner = null;
  let sess = f.target.sessionId || null, isRoot = !!f.root;
  let fid = isRoot ? kidsOf(tabId).get(sess)?.targetId : f.target.frameId;
  for (let g = 0; g < 10 && fid; g++) {
    // A session's root frame is owned by an <iframe> in the PARENT session; an in-process frame's
    // owner is in its own session, whose box coords are relative to that session's root.
    const owner = isRoot ? (kidsOf(tabId).get(sess)?.parent ?? null) : sess;
    const t = owner ? { tabId, sessionId: owner } : tabId;
    const { backendNodeId } = await sendCdp(t, 'DOM.getFrameOwner', { frameId: fid });
    const { model } = await sendCdp(t, 'DOM.getBoxModel', { backendNodeId });
    const q = model.content;
    x += q[0]; y += q[1];
    if (first) { w = q[2] - q[0]; h = q[5] - q[1]; first = false; }
    if (!owner) { topOwner = backendNodeId; break; } // reached the top session: coordinates are now top-level
    sess = owner; isRoot = true; fid = kidsOf(tabId).get(owner)?.targetId;
  }
  return { x, y, w, h, topOwner };
}

// Split "f2.e7" into its frame and the frame-local ref.
function routeRef(tabId, ref) {
  const m = /^f(\d+)\.(.+)$/.exec(String(ref || ''));
  if (!m) return { target: tabId, ref, frame: null };
  const f = frameIdx.get(tabId)?.byIdx.get(Number(m[1]));
  if (!f) return { target: null, ref: m[2], frame: null };
  return { target: f.target, ref: m[2], frame: f };
}

// Hand CLOSED shadow roots of the custom elements a snapshot flagged to our isolated world:
// DOM.describeNode(pierce) exposes them to CDP even though page JS can't reach them. Each host is
// probed once per document. Returns how many roots were found.
async function probeClosedRoots(target) {
  const ctx = await worldFor(target);
  let found = 0;
  try {
    const r = await sendCdp(target, 'Runtime.evaluate', { expression: 'window.__pawbrowse && window.__pawbrowse.pendingHosts', contextId: ctx, objectGroup: 'pawshadow' });
    if (!r.result || !r.result.objectId) return 0;
    const { result } = await sendCdp(target, 'Runtime.getProperties', { objectId: r.result.objectId, ownProperties: true });
    for (const p of result) {
      if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue;
      try {
        const { node } = await sendCdp(target, 'DOM.describeNode', { objectId: p.value.objectId, depth: 0, pierce: true });
        const root = (node.shadowRoots || []).find((x) => x.shadowRootType === 'closed');
        if (!root) continue;
        const { object } = await sendCdp(target, 'DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId: ctx, objectGroup: 'pawshadow' });
        await sendCdp(target, 'Runtime.callFunctionOn', { objectId: p.value.objectId, functionDeclaration: 'function(r){ window.__pawbrowse.closed.set(this, r); }', arguments: [{ objectId: object.objectId }] });
        found++;
      } catch {}
    }
    await sendCdp(target, 'Runtime.evaluate', { expression: 'window.__pawbrowse.pendingHosts.forEach(function(h){ window.__pawbrowse.probed.add(h); })', contextId: ctx });
  } finally { sendCdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'pawshadow' }).catch(() => {}); }
  return found;
}

async function snapshot(target, tries = 8, opts) {
  const O = JSON.stringify(opts || {});
  const sk = typeof target === 'object' ? `${target.tabId}#${frameKey(target)}` : target;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      let snap = await evaluate(target, `${SNAPSHOT}(${refSeed.get(sk) || 1}, ${O})`);
      // Closed shadow roots found: re-snapshot with them (nested closed hosts: a few rounds).
      for (let k = 0; k < 3 && snap && snap.probe; k++) {
        if (!(await probeClosedRoots(target).catch(() => 0))) break;
        snap = await evaluate(target, `${SNAPSHOT}(${refSeed.get(sk) || 1}, ${O})`);
      }
      if (snap) { if (snap.next > (refSeed.get(sk) || 1)) { refSeed.set(sk, snap.next); persistState(); } return snap; }
    } catch (e) { last = e; }
    if (i < tries - 1) await sleep(120);
  }
  if (last) throw last;
  return null;
}

// The last table each tab reported, so act() can tell the agent whether ANYTHING it can see changed
// (scrolling a panel, opening a popover...) rather than only form values / URL / control count.
const lastTable = new Map(); // tabId -> table text (without the header lines that hold ref numbers)

// Ref numbers and the focus marker are dropped: clicking a button that does nothing still focuses
// it, and that alone must not count as "the page changed".
function tableBody(t) { return String(t).split('\n').map((l) => l.replace(/^(f\d+\.)?e\d+(_\d+)?\s+/, '').replace(/ {2}· {2}focus e\S+$/, '')).join('\n'); }

// What the agent last saw, per tab (full table text), so act() can answer with just the rows that
// changed. Same document + mostly-unchanged table => delta; otherwise the full table.
const lastFull = new Map();
const ROW_ID = /^((?:f\d+\.)?e\d+(?:_\d+)?)\s/;
function deltaTable(prev, cur) {
  if (!prev) return null;
  const P = prev.split('\n'), C = cur.split('\n');
  if (P[0] !== C[0]) return null; // title/url changed: a different page, send it whole
  const prevRows = new Map();
  for (const l of P) { const m = ROW_ID.exec(l); if (m) prevRows.set(m[1], l); }
  const out = [], ids = new Set();
  let rows = 0, unchanged = 0;
  for (const l of C) {
    const m = ROW_ID.exec(l);
    if (!m) { out.push(l); continue; } // headers, frame and tool lines: always
    rows++; ids.add(m[1]);
    if (prevRows.get(m[1]) === l) unchanged++; else out.push(l);
  }
  if (rows < 12 || unchanged < rows * 0.5) return null; // small table or big change: whole is clearer
  const gone = [...prevRows.keys()].filter((id) => !ids.has(id));
  const at = out.findIndex((l) => l.startsWith('scroll ')) + 1 || 1;
  out.splice(at, 0, `(only changes shown: ${rows - unchanged} new/changed row(s); ${unchanged} unchanged row(s) omitted${gone.length ? `; gone: ${gone.slice(0, 40).join(', ')}${gone.length > 40 ? ' …' : ''}` : ''} — browser_observe for the full table)`);
  return out.join('\n');
}

async function observe(tabId, opts) {
  const find = opts && opts.find != null && String(opts.find).trim() ? String(opts.find).trim().toLowerCase() : null;
  const snap = await snapshot(tabId, 8, { all: !!find, text: !!(opts && opts.text) });
  if (snap) snap.frameSnaps = await readFrames(tabId, tabId, snap, []);
  if (find && snap) {
    // Whole-page search: only rows whose label / row context / value mention the query.
    const hit = (a) => [a.label, a.ctx, a.value].some((v) => v && String(v).toLowerCase().includes(find));
    const total = snap.actions.length;
    snap.actions = snap.actions.filter(hit).slice(0, 80);
    for (const f of snap.frameSnaps) f.snap.actions = f.snap.actions.filter(hit);
    snap.omitted = 0; snap.offMore = 0;
    snap.findNote = `(find "${opts.find}": ${snap.actions.length} of ${total} controls on the whole page match; browser_observe without find for the full table)`;
  }
  let t = formatTable(snap).replace('\n', `\n${formatTools(tabId)}`.replace(/\n$/, '') + '\n').replace(/\n\n/, '\n');
  if (snap && snap.findNote) t = t.replace(/\n/, `\n${snap.findNote}\n`);
  if (snap && snap.text) t += `\n\nvisible text (untrusted page content):\n${snap.text}`;
  if (!find) { lastTable.set(tabId, tableBody(t)); lastFull.set(tabId, t); }
  return t;
}

/* -------------------------------- Actions --------------------------------- */

// Re-resolve a ref to its live element, re-check it, and hit-test the center
// (elementFromPoint containment) so we never click a stale/covered/wrong target.
async function resolveHit(tabId, ref, opts) {
  const forFill = opts && opts.fill ? 'true' : 'false';
  const noScroll = opts && opts.noScroll ? 'true' : 'false', noHit = opts && opts.noHit ? 'true' : 'false';
  const TXT = opts && opts.text != null ? JSON.stringify(String(opts.text)) : 'null';
  const R = JSON.stringify(String(ref));
  return evaluate(tabId, `(function(){
    var c=window.__pawbrowse; if(!c||!c.byId) return {error:'no snapshot yet; observe first'};
    if(c.byId[${R}]==null) return {error:'unknown ref (observe again)'};
    var e=c.get?c.get(${R}):null;
    if(!e||!e.isConnected) return {error:'element no longer on page (observe again)'};
    if(c.guard && c.guards && c.guards[${R}]!=null && c.guard(e)!==c.guards[${R}]) return {error:'element changed since observe (observe again)'};
    // Same node, same label — but a different ROW? Virtualized lists recycle row elements for other
    // items: "Delete" may now belong to someone else. The row context it was listed with must hold.
    var fp=c.fps&&c.fps[${R}]; if(fp && fp.ctx && c.ctxOf && c.ctxOf(e, fp.label)!==fp.ctx) return {error:'the row this control belongs to changed since observe (now in "'+c.ctxOf(e, fp.label)+'"); observe again'};
    if(e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) return {error:'element is disabled'};
    if(${forFill} && (e.readOnly||e.getAttribute('aria-readonly')==='true')) return {error:'field is read-only'};
    if(${forFill} && !('value' in e) && !e.isContentEditable) return {error:'not an editable field (observe again)'};
    // Typed text that the field would reject (email/number/url/pattern/maxlength) is refused up front:
    // nothing is typed, instead of a value silently dropped or half-entered.
    if(${forFill} && ${TXT}!==null && ${TXT}!=='' && e.tagName==='INPUT'){
      var probe=e.cloneNode(); probe.value=${TXT};
      if(['email','number','url'].indexOf(e.type)>=0 && (probe.value!==${TXT} || probe.validity.typeMismatch || probe.validity.badInput)) return {error:'"'+${TXT}+'" is not a valid '+e.type+' for this field (nothing typed)'};
      if(e.hasAttribute('pattern') && probe.validity.patternMismatch) return {error:'the field requires a specific format ('+(e.title||e.getAttribute('pattern'))+'); "'+${TXT}+'" does not match (nothing typed)'};
    }
    // Value-set inputs (date/time/range/color...) take the setter path, not click+type.
    if(${forFill} && e.tagName==='INPUT' && ['date','time','datetime-local','month','week','color','range'].indexOf(e.type)>=0) return {set:true};
    // Click the control's visible SURFACE: a styled checkbox's <label>, or the element itself.
    var s=c.surface?c.surface(e):e;
    if(!s) return {error:'element not visible'};
    // Hit-test in the surface's OWN root (document / shadow root / iframe doc) with frame-local
    // coords, descending through nested open/closed shadow roots.
    var sroot=function(n){ return n.shadowRoot || (c.closed && c.closed.get(n)) || null; };
    var at=function(){
      var r=s.getBoundingClientRect(); if(!r.width||!r.height) return {error:'element has no size'};
      var fw=s.ownerDocument.defaultView;
      var sp=c.pt?c.pt(s):{x:r.x+r.width/2, y:r.y+r.height/2}, lx=sp.x, ly=sp.y;
      // ...plus the offset chain of any ancestor iframes, giving the TOP-LEVEL click point for CDP.
      var dx=0, dy=0, w=fw, g=0;
      while(w && w.frameElement && g++<12){
        var fe=w.frameElement, fr=fe.getBoundingClientRect(), fcs=fe.ownerDocument.defaultView.getComputedStyle(fe);
        dx+=fr.left+fe.clientLeft+(parseFloat(fcs.paddingLeft)||0);
        dy+=fr.top+fe.clientTop+(parseFloat(fcs.paddingTop)||0);
        w=fe.ownerDocument.defaultView;
      }
      var inView=ly>=0 && lx>=0 && ly<fw.innerHeight && lx<fw.innerWidth && (r.height>fw.innerHeight || (r.top>=0 && r.bottom<=fw.innerHeight));
      var x=Math.round(lx+dx), y=Math.round(ly+dy);
      var root=s.getRootNode(); if(!root||!root.elementFromPoint) root=s.ownerDocument;
      var f=root.elementFromPoint(lx,ly), k=0;
      while(f && sroot(f) && k++<16){ var inner=sroot(f).elementFromPoint(lx,ly); if(!inner||inner===f) break; f=inner; }
      var hit=!!f && (s===f || s.contains(f) || (s.control && s.control===f) || (c.slotted && c.slotted(s, f)) || (c.sameWidget && c.sameWidget(s, f)));
      return {x:x, y:y, inView:inView && x>=0 && y>=0 && x<innerWidth && y<innerHeight, hit:hit};
    };
    // Don't move the page when the target is already on screen and hittable: needless scrolling
    // closes popups/date pickers and jolts the page. Otherwise bring it to the centre and re-check.
    var p=at(); if(p.error) return p;
    if(!(p.inView && p.hit) && !${noScroll}){ s.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); p=at(); if(p.error) return p; }
    if(!p.inView && !${noHit}) return {error:'element off-screen after scroll'};
    if(${noHit}) return {x:p.x, y:p.y};
    if(!p.hit) return {error:'element is covered by another element (dismiss the overlay/dialog first)'};
    return {x:p.x, y:p.y};
  })()`);
}

// Set the value of a date/time/month/week/color/range input the way a user's picker would: via the
// native value setter (so framework value-trackers see a real change), then input + change events.
// The browser sanitizes invalid values to '' (or clamps ranges), so we read back and report that.
async function setValue(tabId, ref, text) {
  const R = JSON.stringify(String(ref));
  const V = JSON.stringify(String(text ?? ''));
  return evaluate(tabId, `(function(){
    var c=window.__pawbrowse; var e=c&&c.get&&c.get(${R});
    if(!e||!e.isConnected) return {error:'element no longer on page (observe again)'};
    var val=${V};
    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    try{ e.focus({preventScroll:true}); }catch(_){}
    setter.call(e,val);
    e.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    if(val!=='' && e.value==='') return {error:'value "'+val+'" rejected by the '+e.type+' field (use the fmt{} format shown)'};
    return {value:e.value};
  })()`);
}

// Attach local files to an <input type=file> (DOM.setFileInputFiles). Chrome only allows this for
// an extension that the user has granted "Allow access to file URLs" in chrome://extensions.
async function uploadFiles(tabId, ref, paths) {
  const R = JSON.stringify(String(ref));
  const h = await evaluate(tabId, `(function(){
    var c=window.__pawbrowse; var e=c&&c.get&&c.get(${R});
    if(e && c.guards && c.guards[${R}]!=null && c.guard(e)!==c.guards[${R}]) return null; // relabelled / reused input
    return (e&&e.isConnected&&e.tagName==='INPUT'&&e.type==='file'&&!e.disabled)?e:null;
  })()`, { handle: true });
  if (!h || !h.objectId) return { error: 'not a file-upload field, or it changed since observe (observe again)' };
  try {
    await sendCdp(tabId, 'DOM.setFileInputFiles', { files: paths, objectId: h.objectId }); // tabId: the frame target
  } catch (e) {
    return { error: /not allowed/i.test(e.message)
      ? 'Chrome blocked the upload: enable "Allow access to file URLs" for PawBrowse in chrome://extensions'
      : e.message };
  } finally {
    sendCdp(tabId, 'Runtime.releaseObject', { objectId: h.objectId }).catch(() => {}); // (frame target, see above)
  }
  return { ok: true };
}

// Click the most specific visible element matching text, for custom widgets/menus
// (dropdowns, flair pickers) whose options aren't standard controls in the table.
async function centerOfText(tabId, text) {
  return evaluate(tabId, `(function(){
    var target=${JSON.stringify(String(text))}.trim().toLowerCase();
    if(!target) return null;
    var nodes=document.querySelectorAll('a,button,li,span,div,p,label,td,th,[role=button],[role=option],[role=menuitem],[role=tab],[role=radio]');
    var exact=[], partial=[];
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];
      if((el.textContent||'').toLowerCase().indexOf(target)<0) continue; // cheap pre-filter, no reflow
      var r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) continue;
      if(!el.checkVisibility||!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      var txt=(el.innerText||el.textContent||'').trim();
      if(!txt) continue;
      var low=txt.toLowerCase(), area=r.width*r.height;
      if(low===target) exact.push({el:el,area:area});
      else if(low.indexOf(target)>=0) partial.push({el:el,area:area});
    }
    var pool=exact.length?exact:partial;
    if(!pool.length) return null;
    pool.sort(function(a,b){return a.area-b.area;});
    var chosen=pool[0].el;
    chosen.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    var rr=chosen.getBoundingClientRect();
    var cx=Math.round(rr.left+rr.width/2), cy=Math.round(rr.top+rr.height/2);
    if(cx<0||cy<0||cx>=innerWidth||cy>=innerHeight) return null;
    if(!chosen.contains(document.elementFromPoint(cx,cy))) return null;
    return {x:cx, y:cy};
  })()`);
}

async function clickAt(tabId, x, y, opts) {
  const button = (opts && opts.button) || 'left', count = Math.max(1, Math.min(3, Number(opts && opts.count) || 1));
  // `buttons` must say which button is held (CDP defaults it to 0; pointer-event widgets ignore a
  // pointerdown with no button). A double/triple click is press/release pairs with rising clickCount.
  // Pipelined, like Playwright: move, press and release reach the renderer together. Awaiting each
  // one leaves a gap in which a mousedown-triggered re-render (a blur committing a date, a ripple)
  // swaps the element, and Chromium then sends the click to a common ancestor — or nowhere.
  const held = { left: 1, right: 2, middle: 4 }[button];
  const sends = [sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })];
  for (let n = 1; n <= count; n++) {
    sends.push(sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: held, clickCount: n }));
    sends.push(sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n }));
  }
  await Promise.all(sends);
}

/* ------------------------------ Waiting (settle) ---------------------------- *
 * Wait for what the page is ACTUALLY doing instead of a fixed delay: a navigation in progress (until
 * the new document's DOMContentLoaded), fetch/XHR requests started by the action, then a short
 * DOM-quiet window (MutationObserver). Each phase is capped, so long-polling, analytics beacons or a
 * ticking clock can't stall us, and a click that does nothing returns in a few tens of ms.        */
const watches = new Map(); // tabId -> { mainFrame, inflight: Map(reqId -> startedAt), navStart, navDone }
function tabWatch(tabId) {
  let w = watches.get(tabId);
  if (!w) { w = { mainFrame: null, inflight: new Map(), frameLoads: new Map(), navStart: 0, navDone: 0, committed: true, navReq: null }; watches.set(tabId, w); }
  return w;
}
// Script too: SPA route changes lazy-load code chunks and render only after they run.
const TRACKED = new Set(['Fetch', 'XHR', 'Document', 'Script']);
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const w = watches.get(source.tabId);
  if (!w) return;
  // A request can finish on a different session than it started on (an iframe's document request
  // is announced by the parent, completed by the child): accept completions from any session.
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    w.inflight.delete(params.requestId);
    if (method === 'Network.loadingFailed' && params.requestId === w.navReq && !w.committed) w.navDone = Date.now(); // blocked/aborted navigation
    return;
  }
  // Same for frames: an out-of-process iframe starts loading in the parent, stops in its own session.
  if (method === 'Page.frameStoppedLoading' || method === 'Page.frameDetached') { w.frameLoads.delete(params.frameId); if (source.sessionId) return; }
  if (source.sessionId) return; // everything else: the top-level target only
  const now = Date.now();
  const begin = (loaderId) => { w.navStart = now; w.navDone = 0; w.committed = false; w.navReq = loaderId || null; w.netIdle = 0; };
  switch (method) {
    case 'Network.requestWillBeSent':
      // Documents: only the main frame's (subframe documents finish on other sessions / may never).
      if (TRACKED.has(params.type) && (params.type !== 'Document' || params.frameId === w.mainFrame)) {
        w.inflight.set(params.requestId, now);
        if (params.type === 'Script') w.lastScript = now; // a code chunk: the page is mid-transition
      }
      if (params.type === 'Document' && params.frameId === w.mainFrame && params.requestId === params.loaderId && w.navReq !== params.requestId) {
        if (w.navDone >= w.navStart) begin(params.requestId); else w.navReq = params.requestId;
      }
      break;
    case 'Network.responseReceived':
      // A 204/205 navigation never replaces the document: it's over as soon as the response lands.
      if (params.requestId === w.navReq && (params.response.status === 204 || params.response.status === 205)) w.navDone = now;
      break;
    case 'Page.frameRequestedNavigation': case 'Page.frameStartedNavigating':
      if (params.frameId === w.mainFrame && params.navigationType !== 'sameDocument') begin(params.loaderId);
      break;
    case 'Page.frameNavigated':
      if (!params.frame.parentId) { w.mainFrame = params.frame.id; w.committed = true; if (params.frame.loaderId) w.navReq = params.frame.loaderId; }
      break;
    // The OLD document can still fire load/stop events after a navigation starts: only events that
    // follow the new document's commit (frameNavigated) mean "arrived".
    case 'Page.domContentEventFired': case 'Page.loadEventFired':
      if (w.committed) w.navDone = now;
      break;
    case 'Page.frameStoppedLoading':
      if (params.frameId === w.mainFrame && w.committed) w.navDone = now;
      else w.frameLoads.delete(params.frameId);
      break;
    case 'Page.frameStartedLoading':
      // An iframe (menu, widget, embed) that starts loading because of an action: its content is
      // part of the result, so waits follow it (capped like requests).
      if (params.frameId !== w.mainFrame) w.frameLoads.set(params.frameId, now);
      break;
    case 'Page.lifecycleEvent':
      // Tied to the NEW document's loader, so the old page's late events can't end a wait.
      if (params.frameId === w.mainFrame && params.loaderId && params.loaderId === w.navReq) {
        if (params.name === 'DOMContentLoaded' || params.name === 'load') { w.committed = true; w.navDone = now; }
        if (params.name === 'networkAlmostIdle' || params.name === 'networkIdle') w.netIdle = now;
      }
      break;
    case 'Page.navigatedWithinDocument':
      if (params.frameId === w.mainFrame) w.routeAt = now; // SPA route change (pushState)
      w.navDone = now;
      break;
    case 'Page.downloadWillBegin':
      w.navDone = now;
      break;
  }
});

// -> [ms since last DOM change, was the DOM already busy in the 600ms before `since` (epoch ms)?]
const quietExpr = (since) => `(function(){ ${MO_INSTALL}
  var now=performance.now(), s=${Number(since) || 0}-Date.now()+now, b={};
  M.times.forEach(function(t){ if(t<s && t>=s-600) b[Math.floor((s-t)/100)]=1; });
  // Finite CSS transitions/animations still running (a menu fading in, a panel sliding open):
  // until they finish, their contents may still be invisible. Infinite ones (spinners) don't count.
  // Those the ACTION started (startTime after it) are counted separately: they matter even on a page
  // that animates constantly in the background (a panel's staggered entrance on a carousel page).
  var anim=0, animNew=0;
  try{ document.getAnimations().forEach(function(a){ if(a.playState==='running' && a.effect){ var ct=a.effect.getComputedTiming(); if(isFinite(ct.endTime) && ct.endTime<=2000){ anim++; if(a.startTime!=null && a.startTime>=s-30) animNew++; } } }); }catch(_){}
  return [anim ? 0 : now-M.last, Object.keys(b).length>=4, animNew];
})()`;

// Network tracking only while an action is being watched (see attach()).
async function netOn(tabId) {
  const w = tabWatch(tabId);
  if (w.net) return;
  w.net = true;
  await sendCdp(tabId, 'Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => { w.net = false; });
}
async function netOff(tabId) {
  const w = tabWatch(tabId);
  if (!w.net) return;
  w.net = false; w.inflight.clear();
  await sendCdp(tabId, 'Network.disable').catch(() => {});
}

async function settle(tabId, capMs, since, opts) {
  const start = since || Date.now();
  const w = tabWatch(tabId);
  const deadline = start + (capMs || 3000);
  // After typing, search boxes commonly DEBOUNCE (wait ~150-300ms of no typing, then fetch): there's
  // no signal to follow during that gap, so give a typed field a grace window for a request or a
  // re-render to begin before calling it idle.
  const grace = start + ((opts && opts.grace) || 0);
  // Let the action's handlers run first (event loop turn + a frame).
  await sleep(25);
  let idleSince = 0;
  // Which requests are the action's (vs. background beacons/polling that never stop): those that
  // start within 500ms of the action — or of the new page's DOMContentLoaded — plus requests that
  // start right after one of those finishes (a fetch chain). Anything else is ignored.
  const rel = new Set();
  let windowEnd = start + 500, sawNav = false;
  for (;;) {
    const now = Date.now();
    const navigating = w.navStart >= start - 50 && w.navDone < w.navStart;
    // A navigation gets a longer allowance: the next page must actually arrive.
    if (now > (navigating ? Math.max(deadline, start + 10000) : deadline)) break;
    if (navigating) {
      // Once the new document has committed, stop network tracking: its (possibly hundreds of)
      // subresource requests would only slow the browser down. Lifecycle events take over.
      if (w.committed && w.net) await netOff(tabId);
      sawNav = true; await sleep(30); continue;
    }
    if (sawNav) {
      sawNav = false; windowEnd = Math.max(windowEnd, w.navDone + 500);
      if (!w.net) {
        // New page: let its initial data requests settle (Chrome's networkAlmostIdle), capped.
        // Ends early once the document is fully loaded and the DOM has been quiet for 300ms.
        const until = Math.min(deadline, w.navDone + 800);
        while (!(w.netIdle >= w.navStart) && Date.now() < until) {
          try {
            const [q, , rs] = await evaluate(tabId, `(function(){ var r=${quietExpr(start)}; return [r[0], r[1], document.readyState]; })()`);
            if (rs === 'complete' && q >= 300) break;
          } catch {}
          await sleep(40);
        }
      }
    }
    let busy = false;
    for (const [id, t] of w.inflight) {
      if (now - t > 15000) { w.inflight.delete(id); continue; } // leaked / long-poll: forget it
      if (!rel.has(id) && t >= start - 50 && t <= windowEnd) rel.add(id);
    }
    for (const id of rel) {
      if (!w.inflight.has(id)) { rel.delete(id); windowEnd = Math.max(windowEnd, now + 150); continue; } // finished: allow a follow-up
      if (now - w.inflight.get(id) < 8000) busy = true;
    }
    for (const [fid, t] of w.frameLoads) {
      if (now - t > 8000) { w.frameLoads.delete(fid); continue; }
      if (t >= start - 50 && now - t < 2500) busy = true; // an embed/menu frame; ads shouldn't hold us long
    }
    if (busy) { idleSince = 0; await sleep(30); continue; }
    if (now < grace) { await sleep(30); continue; } // debounce window: a request may still be coming
    if (!idleSince) idleSince = now;
    // A route change or a freshly loaded code chunk means a new view is being built: it often goes
    // quiet for a beat (JS executing, timers) before rendering, so ask for a longer quiet period.
    const transition = (w.routeAt || 0) >= start - 50 || (w.lastScript || 0) >= start - 50;
    const needQuiet = transition ? 250 : 60, quietCap = transition ? 1500 : 600;
    let quiet = 1e9, ambient = false, animNew = 0;
    const tq = Date.now();
    try { [quiet, ambient, animNew] = await evaluate(tabId, quietExpr(start)); } catch { await sleep(30); continue; } // document swapping
    // If even this tiny probe waited >50ms to run, the page's main thread was busy (JS/render):
    // not quiet, whatever the observers have reported so far.
    if (Date.now() - tq > 50) quiet = 0;
    // DOM still changing: wait for 60ms of quiet, capped at 600ms after the network went idle, or
    // 120ms on a page that was already constantly mutating (clocks, tickers, carousels) before us.
    if (animNew && now - idleSince < 1500) { await sleep(40); continue; } // the action's own animations
    if (quiet < needQuiet && now - idleSince < (ambient ? 120 : quietCap)) { await sleep(Math.max(10, Math.min(60, needQuiet - quiet))); continue; }
    break;
  }
}

// After typing into a combobox, wait for its autocomplete options to actually render
// (up to ms) before the next observation, instead of paying a fixed delay.
async function waitForOptions(tabId, ref, ms) {
  const R = JSON.stringify(String(ref));
  const cap = Number(ms) || 250;
  try {
    // Poll with setInterval + a hard setTimeout cap (NOT requestAnimationFrame): rAF is paused in
    // background tabs, which is the normal case when driving, so an rAF-only wait would hang.
    await evaluate(tabId, `new Promise(function(res){
      var done=false; function fin(){ if(done) return; done=true; try{clearInterval(iv);}catch(_){} res(1); }
      setTimeout(fin, ${cap});
      var c=window.__pawbrowse; var e=(c&&c.get)?c.get(${R}):null;
      if(!e || (e.getAttribute('role')||'').toLowerCase()!=='combobox'){ return fin(); }
      var ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
      var iv=setInterval(function(){
        try{
          var roots=ids.length?ids.map(function(id){return document.getElementById(id);}).filter(Boolean):[document];
          var opts=roots.reduce(function(a,r){return a.concat([].slice.call(r.querySelectorAll('[role=option]')));},[]);
          var vis=opts.some(function(o){var b=o.getBoundingClientRect();return b.width&&b.height&&o.checkVisibility&&o.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});});
          if(vis) fin();
        }catch(_){ fin(); }
      }, 40);
    })`);
  } catch { await sleep(cap); }
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

// "Shift+Tab", "Mod+A" (Cmd on macOS, Ctrl elsewhere), "Control+Enter", "F5", "a", "?" ...
const MODS = { Alt: 1, Option: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8, Mod: IS_MAC ? 4 : 2 };
// macOS editing shortcuts aren't bound to Cmd+key for synthetic events: they need the command name.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };
function keyDef(name) {
  if (KEYMAP[name]) return { ...KEYMAP[name] };
  if (name.length === 1) {
    const up = name.toUpperCase();
    const alnum = /[a-z0-9]/i.test(name);
    return { key: name, code: /[a-z]/i.test(name) ? `Key${up}` : /[0-9]/.test(name) ? `Digit${name}` : '', windowsVirtualKeyCode: alnum ? up.charCodeAt(0) : name.charCodeAt(0), text: name };
  }
  const f = /^F(\d{1,2})$/.exec(name);
  if (f) return { key: name, code: name, windowsVirtualKeyCode: 111 + Number(f[1]) };
  return null;
}
async function pressKey(tabId, combo) {
  const parts = String(combo).split(/\+(?!$)/); // "Control++" -> ["Control", "+"]
  let mods = 0;
  for (const m of parts.slice(0, -1)) { if (!(m in MODS)) return `unknown modifier "${m}"`; mods |= MODS[m]; }
  const def = keyDef(parts[parts.length - 1]);
  if (!def) return `key "${combo}" not supported`;
  if ((mods & 8) && def.text && def.text.length === 1) { def.key = def.text = def.text.toUpperCase(); }
  if (mods & 6) delete def.text; // Ctrl/Cmd chords are shortcuts, not text
  const commands = IS_MAC && (mods & 4) && MAC_COMMANDS[String(def.key).toLowerCase()] ? [(mods & 8) && def.key.toLowerCase() === 'z' ? 'redo' : MAC_COMMANDS[def.key.toLowerCase()]] : undefined;
  await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...def, modifiers: mods, commands });
  await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def, text: undefined, modifiers: mods });
  return null;
}

/* ------------------------- Tabs opened by an action -------------------------- *
 * target=_blank links and window.open() open a NEW tab: the agent would otherwise keep looking at
 * the old one and see "page did NOT change". A tab opened by the tab we're acting on is adopted
 * into the session (and its group) and becomes the one we drive.                                */
const openedBy = new Map(); // opener tabId -> newest tab it opened during an action
chrome.tabs.onCreated.addListener((t) => { if (t.openerTabId != null && acting.has(t.openerTabId)) openedBy.set(t.openerTabId, t.id); });

async function followNewTab(session, tabId) {
  const nt = openedBy.get(tabId);
  openedBy.delete(tabId);
  if (nt == null) return null;
  const s = sessionState(session);
  s.activeTabId = nt; s.createdTabs.add(nt); tabOwner.set(nt, session); persistState();
  await ensureGroup(s, nt);
  // Let it get past about:blank and load, then read it like any navigation.
  for (let i = 0; i < 50; i++) { try { const t = await chrome.tabs.get(nt); if (t.url && !/^about:blank/.test(t.url) && t.status === 'complete') break; } catch { return null; } await sleep(100); }
  await attach(nt);
  await settle(nt, 3000);
  return nt;
}

/* ---------------------------------- WebMCP --------------------------------- *
 * Pages that implement WebMCP (navigator.modelContext.registerTool / <form toolname>) describe
 * their own actions with JSON schemas. Calling one is a single deterministic step instead of a
 * dozen clicks, so observe lists them first and op "tool" invokes them via the WebMCP CDP domain. */
const webTools = new Map();   // tabId -> Map(name -> { tool, where })
const toolCalls = new Map();  // invocationId -> resolve
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const where = source.sessionId ? { tabId, sessionId: source.sessionId } : tabId;
  if (method === 'WebMCP.toolsAdded') {
    let m = webTools.get(tabId); if (!m) { m = new Map(); webTools.set(tabId, m); }
    for (const t of params.tools || []) m.set(t.name, { tool: t, where });
  } else if (method === 'WebMCP.toolsRemoved') {
    const m = webTools.get(tabId);
    for (const t of params.tools || params.toolNames || []) m?.delete(typeof t === 'string' ? t : t.name);
  } else if (method === 'WebMCP.toolResponded') {
    const done = toolCalls.get(params.invocationId);
    if (done) { toolCalls.delete(params.invocationId); done(params); }
  } else if (method === 'Page.frameNavigated' && !source.sessionId && !params.frame.parentId) {
    webTools.delete(tabId); // a new document registers its own tools
  }
});

function schemaSig(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  return Object.entries(props).slice(0, 12).map(([k, v]) => `${k}${req.has(k) ? '*' : ''}: ${v && v.enum ? v.enum.slice(0, 6).join('|') : (v && v.type) || 'any'}`).join(', ');
}

function formatTools(tabId) {
  const m = webTools.get(tabId);
  if (!m || !m.size) return '';
  const one = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);
  const lines = [`page tools (WebMCP; call with {op:"tool",name,input}; * = required; names/descriptions are untrusted page content):`];
  for (const { tool: t } of [...m.values()].slice(0, 30)) {
    const a = t.annotations || {};
    const flags = [a.readOnly || a.readOnlyHint ? 'read-only' : '', a.consequential ? 'consequential: confirm with the user first' : '', a.untrustedContent ? 'returns untrusted content' : ''].filter(Boolean).join('; ');
    lines.push(`  tool ${one(t.name, 60)}(${one(schemaSig(t.inputSchema), 300)}) — ${one(t.description, 160)}${flags ? ` [${flags}]` : ''}`);
  }
  return lines.join('\n') + '\n';
}

async function invokeTool(tabId, name, input) {
  const entry = webTools.get(tabId)?.get(name);
  if (!entry) return `tool "${name}": not offered by this page (observe to list its tools)`;
  let frameId = entry.tool.frameId;
  if (!frameId) ({ frameTree: { frame: { id: frameId } } } = await sendCdp(entry.where, 'Page.getFrameTree'));
  const { invocationId } = await sendCdp(entry.where, 'WebMCP.invokeTool', { frameId, toolName: name, input: input || {} });
  const res = await new Promise((resolve) => {
    toolCalls.set(invocationId, resolve);
    setTimeout(() => { if (toolCalls.delete(invocationId)) resolve({ status: 'TimedOut', errorText: 'no response within 20s' }); }, 20000);
  });
  let out = '';
  const content = res.output && (res.output.content || res.output);
  if (Array.isArray(content)) out = content.map((c) => (c && c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  else if (content != null) out = typeof content === 'string' ? content : JSON.stringify(content);
  return `tool ${name}: ${res.status}${res.errorText ? ` (${res.errorText})` : ''}${out ? `\n    output (untrusted page data): ${out.slice(0, 2000).replace(/\n/g, '\n    ')}` : ''}`;
}

// Wait until the target's box stops moving (an animation, a sliding panel) before clicking it —
// Playwright's "stable" check. Capped: a forever-spinning element is clicked anyway.
async function waitStable(target, ref) {
  const R = JSON.stringify(String(ref));
  try {
    await evaluate(target, `new Promise(function(res){
      var c=window.__pawbrowse, e=c&&c.get&&c.get(${R}), s=e&&(c.surface?c.surface(e):e); if(!s) return res(0);
      var key=function(){ var r=s.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map(Math.round).join(','); };
      // Moving = its box changed, or a finite animation is still running on it or an ancestor (an
      // orbit/slide can pause at its turning points, which looks "stable" for a frame or two).
      var animating=function(){ try{ for(var a=s,g=0;a&&g<8;a=a.parentElement,g++){ var an=a.getAnimations?a.getAnimations():[]; for(var i=0;i<an.length;i++){ var ct=an[i].effect&&an[i].effect.getComputedTiming(); if(an[i].playState==='running' && ct && isFinite(ct.endTime)) return true; } } }catch(_){} return false; };
      // Fast path: nothing animating and the box unchanged over one frame -> go. Once it has been seen
      // moving, require two quiet frames in a row.
      // Nothing animating on it or its ancestors: click now (no frame wait). JS-driven motion is
      // still caught by the click-time hit check.
      if(!animating()) return res(1);
      var last=key(), same=0, moved=true, t0=performance.now();
      (function tick(){ setTimeout(function(){ var k=key(), an=animating(); if(k===last && !an){ if(++same>=(moved?2:1)) return res(1); } else { same=0; last=k; moved=true; } if(performance.now()-t0>6000) return res(0); tick(); }, 16); })();
    })`);
  } catch {}
}

// Click-time hit check (Playwright's hit-target interceptor): the FIRST trusted pointer/mouse event
// of the click must land on the intended element (or what counts as it). If it would land on
// something else — an overlay that appeared, a re-render — the whole gesture is stopped before the
// wrong element sees it, and the op reports what intercepted it.
async function armClick(target, ref) {
  const R = JSON.stringify(String(ref));
  return evaluate(target, `(function(){
    var c=window.__pawbrowse, e=c&&c.get&&c.get(${R}), s=e&&(c.surface?c.surface(e):e); if(!s||!c.accepts) return false;
    if(c.__arm) c.__arm.off();
    var st={ok:null, by:null}, types=['pointerdown','mousedown','pointerup','mouseup','click','auxclick','dblclick','contextmenu'];
    var hosted=function(f){ for(var r=s.getRootNode(); r && r.host; r=r.host.getRootNode()){ if(r.host===f) return true; } return false; };
    // The page REPLACED the target during the gesture (re-render on hover/mousedown): the new element
    // with the same identity (role + label) is the same control to a user.
    var want=c.guard?c.guard(e):'', replaced=function(f){ if(s.isConnected&&e.isConnected) return false; for(var a=f,g=0;a&&g<6;a=a.parentElement,g++){ if(want && c.guard(a)===want) return true; } return false; };
    var h=function(ev){
      if(!ev.isTrusted) return;
      if(st.ok===null){ var f=(ev.composedPath&&ev.composedPath()[0])||ev.target; if(f && f.nodeType!==1) f=f.parentElement;
        st.ok = c.accepts(s,f) || hosted(f) || (e!==s && c.accepts(e,f)) || replaced(f);
        if(!st.ok) st.by = f ? (f.tagName.toLowerCase()+(f.id?'#'+f.id:'')+' "'+String(f.innerText||f.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,40)+'"') : 'nothing'; }
      if(st.ok===false){ ev.preventDefault(); ev.stopImmediatePropagation(); }
    };
    types.forEach(function(t){ window.addEventListener(t, h, true); });
    c.__arm={st:st, off:function(){ types.forEach(function(t){ window.removeEventListener(t, h, true); }); c.__arm=null; }};
    return true;
  })()`).catch(() => false);
}
async function disarmClick(target) {
  return evaluate(target, `(function(){ var c=window.__pawbrowse, a=c&&c.__arm; if(!a) return null; var st=a.st; a.off(); return st; })()`).catch(() => null);
}

const dragIntercepts = new Map(); // tabId -> drag data captured by Input.dragIntercepted
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Input.dragIntercepted' && source.tabId != null) dragIntercepts.set(source.tabId, params.data);
});

async function drag(tabId, from, to) {
  const mouse = (type, p, extra) => sendCdp(tabId, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra });
  dragIntercepts.delete(tabId);
  await sendCdp(tabId, 'Input.setInterceptDrags', { enabled: true }).catch(() => {});
  try {
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from, { clickCount: 1, buttons: 1 });
    // Move in steps: libraries only start a drag after a few pixels and track intermediate moves.
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const p = { x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) };
      await mouse('mouseMoved', p, { buttons: 1 });
      const data = dragIntercepts.get(tabId);
      if (data) {
        // Native HTML5 drag started: deliver it to the drop target and finish there.
        for (const type of ['dragEnter', 'dragOver', 'drop']) await sendCdp(tabId, 'Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
        await mouse('mouseReleased', to, { clickCount: 1 });
        return ' (html5 drop)';
      }
      await sleep(16);
    }
    await mouse('mouseReleased', to, { clickCount: 1 });
    return '';
  } finally {
    dragIntercepts.delete(tabId);
    sendCdp(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

async function runOp(tabId, op) {
  const pol = acting.get(tabId);
  if (pol) { pol.accept = op.dialog === 'accept' ? true : op.dialog === 'dismiss' ? false : undefined; pol.text = op.dialog_text; }
  // Route the ref to its frame: T is where page-side code runs, R the frame-local ref; top() turns
  // frame-local coordinates into top-level ones for input (which the browser routes to the frame).
  const rt = op.ref != null ? routeRef(tabId, op.ref) : { target: tabId, ref: op.ref, frame: null };
  if (op.ref != null && !rt.target) return `${op.ref}: unknown frame (observe again)`;
  const T = rt.target, REF = rt.ref;
  const top = async (x, y) => {
    if (!rt.frame) return { x, y };
    const off = await frameOffset(tabId, rt.frame);
    const p = { x: Math.round(x + off.x), y: Math.round(y + off.y) };
    // The frame's own hit-test can't see the PARENT page: make sure the point really lands in this
    // frame and not on a cookie banner / modal of the page around it.
    try {
      const hit = await sendCdp(tabId, 'DOM.getNodeForLocation', { x: p.x, y: p.y, includeUserAgentShadowDOM: false });
      const main = tabWatch(tabId).mainFrame;
      if (off.topOwner != null && hit.backendNodeId !== off.topOwner && (!hit.frameId || hit.frameId === main)) p.covered = true;
    } catch {}
    return p;
  };
  switch (op.op) {
    case 'dialog': {
      const d = openDialogs.get(tabId);
      if (!d) return 'dialog: no dialog is open';
      await sendCdp(d.where || tabId, 'Page.handleJavaScriptDialog', { accept: !!op.accept, promptText: op.text != null ? String(op.text) : '' });
      openDialogs.delete(tabId);
      return `dialog: ${d.type} "${String(d.message || '').slice(0, 120)}" → ${op.accept ? 'accepted' : 'dismissed'}`;
    }
    case 'click': {
      await waitStable(T, REF);
      const r = await resolveHit(T, REF);
      if (r.error) return `${op.ref}: ${r.error}`;
      const p = await top(r.x, r.y);
      if (p.covered) return `${op.ref}: element is covered by another element of the page around its frame (dismiss the overlay first)`;
      const button = ['right', 'middle'].includes(op.button) ? op.button : 'left';
      const armed = await armClick(T, REF);
      await clickAt(tabId, p.x, p.y, { button, count: op.count });
      const verdict = armed ? await disarmClick(T) : null;
      if (verdict && verdict.ok === false) return `${op.ref}: click intercepted by ${verdict.by} at the moment of the click — NOT delivered (dismiss what covers it, then retry)`;
      return `${op.count > 1 ? `${op.count}x ` : ''}${button !== 'left' ? `${button}-` : ''}click ${op.ref}`;
    }
    case 'hover': {
      const r = await resolveHit(T, REF);
      if (r.error) return `${op.ref}: ${r.error}`;
      const p = await top(r.x, r.y);
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      return `hover ${op.ref}`;
    }
    case 'drag': {
      // Drag ref onto to:"eN" (or by dx/dy pixels). Pointer-driven widgets (sliders, sortable
      // lists) get a real press-move-release; native HTML5 drag-and-drop is intercepted by CDP and
      // replayed as dragEnter/dragOver/drop on the target.
      const a = await resolveHit(T, REF);
      if (a.error) return `${op.ref}: ${a.error}`;
      const from = await top(a.x, a.y);
      let to;
      if (op.to_text) {
        const c = await centerOfText(tabId, op.to_text);
        if (!c) return `drag: drop target "${op.to_text}" not found`;
        to = c;
      } else if (op.to) {
        const rt2 = routeRef(tabId, op.to);
        if (!rt2.target) return `${op.to}: unknown frame (observe again)`;
        const b = await resolveHit(rt2.target, rt2.ref, { noScroll: true, noHit: true });
        if (b.error) return `${op.to}: ${b.error}`;
        to = rt2.frame ? await (async () => { const off = await frameOffset(tabId, rt2.frame); return { x: Math.round(b.x + off.x), y: Math.round(b.y + off.y) }; })() : { x: b.x, y: b.y };
      } else to = { x: from.x + Number(op.dx || 0), y: from.y + Number(op.dy || 0) };
      return drag(tabId, from, to).then((how) => `drag ${op.ref} → ${op.to || (op.to_text ? `"${op.to_text}"` : `${op.dx || 0},${op.dy || 0}`)}${how}`);
    }
    case 'click_text': {
      const c = await centerOfText(tabId, op.text);
      if (!c) return `click_text "${op.text}": not found`;
      await clickAt(tabId, c.x, c.y);
      return `click_text "${op.text}"`;
    }
    case 'type': {
      const r = await resolveHit(T, REF, { fill: true, text: op.text ?? '' });
      if (r.error) return `${op.ref}: ${r.error}`;
      if (r.set) {
        const sv = await setValue(T, REF, op.text);
        return sv.error ? `${op.ref}: ${sv.error}` : `type ${op.ref} (set to "${sv.value}")`;
      }
      const p = await top(r.x, r.y);
      if (p.covered) return `${op.ref}: element is covered by another element of the page around its frame (dismiss the overlay first)`;
      await clickAt(tabId, p.x, p.y); // focus the field with a trusted click
      // Select-all then insert — robust for React/controlled inputs.
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2, commands: ['selectAll'] });
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2 });
      const txt = String(op.text ?? '');
      if (txt === '') {
        // insertText('') is a no-op in many inputs; Backspace deletes the selected contents.
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...KEYMAP.Backspace });
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...KEYMAP.Backspace });
      } else {
        await sendCdp(tabId, 'Input.insertText', { text: txt });
      }
      await waitForOptions(T, REF, 250); // let autocomplete suggestions render
      return `type ${op.ref}`;
    }
    case 'select': {
      const R = JSON.stringify(String(REF));
      const VS = JSON.stringify([].concat(op.values ?? op.value ?? '').map(String));
      try {
        const res = await evaluate(T, `(function(){
          var c=window.__pawbrowse; var e=(c&&c.get)?c.get(${R}):null;
          if(!e||!e.isConnected) return 'unknown ref (observe again)';
          if(c.guards && c.guards[${R}]!=null && c.guard(e)!==c.guards[${R}]) return 'element changed since observe (observe again)';
          if(e.tagName!=='SELECT') return 'not a dropdown';
          if(e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) return 'dropdown is disabled';
          if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return 'dropdown not visible';
          var vals=${VS}, m=0, ok=function(o){ return !o.disabled && !(o.closest&&o.closest('optgroup[disabled]')); };
          var hit=function(o){ return vals.some(function(v){ return o.value===v||o.label===v||o.text===v; }); };
          if(e.multiple){ for(var i=0;i<e.options.length;i++){ var o=e.options[i]; var want=ok(o)&&hit(o); if(want) m++; o.selected=want; } }
          else for(var j=0;j<e.options.length;j++){ if(ok(e.options[j]) && hit(e.options[j])){ e.selectedIndex=j; m=1; break; } }
          if(m<vals.length) return m ? 'some options not found' : 'option not found';
          e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
          return 'ok';
        })()`);
        return res === 'ok' ? `select ${op.ref}` : `${op.ref}: ${res}`;
      } catch {
        // The change handler may have navigated and destroyed the context — do not blindly retry.
        return `select ${op.ref}: may have applied and navigated the page; observe again before retrying`;
      }
    }
    case 'upload': {
      const paths = [].concat(op.paths ?? op.path ?? []).map(String).filter(Boolean);
      if (!paths.length) return `${op.ref}: upload needs paths:["/absolute/file"]`;
      const u = await uploadFiles(T, REF, paths);
      return u.error ? `${op.ref}: ${u.error}` : `upload ${op.ref} (${paths.length} file${paths.length > 1 ? 's' : ''})`;
    }
    case 'back': case 'forward': {
      const { currentIndex, entries } = await sendCdp(tabId, 'Page.getNavigationHistory');
      const to = entries[currentIndex + (op.op === 'back' ? -1 : 1)];
      if (!to) return `${op.op}: no ${op.op === 'back' ? 'previous' : 'next'} page in this tab's history`;
      const w = tabWatch(tabId); w.navStart = Date.now(); w.navDone = 0; w.committed = false; w.navReq = null;
      await sendCdp(tabId, 'Page.navigateToHistoryEntry', { entryId: to.id });
      return `${op.op} → ${String(to.url).slice(0, 100)}`;
    }
    case 'reload': {
      const w = tabWatch(tabId); w.navStart = Date.now(); w.navDone = 0; w.committed = false; w.navReq = null;
      await sendCdp(tabId, 'Page.reload', {});
      return 'reload';
    }
    case 'click_xy': {
      // Coordinates from the last browser_screenshot image (converted to CSS px).
      const k = shotScale.get(tabId) || 1;
      const x = Math.round(Number(op.x) * k), y = Math.round(Number(op.y) * k);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'click_xy needs numeric x and y';
      const button = ['right', 'middle'].includes(op.button) ? op.button : 'left';
      await clickAt(tabId, x, y, { button, count: op.count });
      return `click_xy ${op.x},${op.y}`;
    }
    case 'tool': {
      return invokeTool(tabId, String(op.name || ''), op.input);
    }
    case 'key': {
      const err = await pressKey(tabId, op.key);
      return err || `key ${op.key}`;
    }
    case 'scroll': {
      const dy = Number(op.dy ?? 600);
      // Real wheel event so overflow containers, virtualized lists, and infinite scroll fire. With a
      // ref, the wheel goes to THAT element (a side panel, a dropdown list, a chat pane) instead of
      // the middle of the page, so the right box scrolls.
      let cx = 400, cy = 400;
      try {
        const R = JSON.stringify(String(REF || ''));
        const c = await evaluate(T, `(function(){
          var c=window.__pawbrowse, e=${R}&&c&&c.get&&c.get(${R});
          if(e&&e.isConnected){ var s=c.surface?c.surface(e):e; if(s){ var r=s.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, w=s.ownerDocument.defaultView;
            while(w&&w.frameElement){ var fr=w.frameElement.getBoundingClientRect(); x+=fr.left+w.frameElement.clientLeft; y+=fr.top+w.frameElement.clientTop; w=w.frameElement.ownerDocument.defaultView; }
            if(x>=0&&y>=0&&x<innerWidth&&y<innerHeight) return [Math.round(x),Math.round(y)]; } }
          return [Math.round(innerWidth/2),Math.round(innerHeight/2)];
        })()`);
        if (Array.isArray(c)) ({ x: cx, y: cy } = await top(c[0], c[1]));
      } catch {}
      // Scroll offsets of the page and every scroll container under the point, as one signature.
      const probe = rt.frame ? null : `(function(){ var s=[scrollX,scrollY], e=document.elementFromPoint(${cx},${cy}); for(var g=0;e&&g<60;g++){ if(e.scrollHeight>e.clientHeight||e.scrollWidth>e.clientWidth) s.push(e.scrollTop,e.scrollLeft); e=e.parentElement||(e.getRootNode&&e.getRootNode().host); } return s.join(','); })()`;
      const before = probe ? await evaluate(tabId, probe).catch(() => null) : null;
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dy });
      // Wheel scrolling is often ANIMATED (smooth scrolling, e.g. on Linux): wait until the offsets
      // stop moving, so the table we return shows where the page actually ended up.
      if (probe) {
        let last = before, stable = 0;
        for (const end = Date.now() + 1500; Date.now() < end;) {
          await sleep(30);
          const now = await evaluate(tabId, probe).catch(() => null);
          if (now !== last) { last = now; stable = 0; continue; }
          if (++stable >= 3 && (now !== before || Date.now() > end - 1200)) break; // settled (or nothing scrolls here)
        }
      }
      return `scroll ${dy}`;
    }
    case 'wait': {
      await sleep(Math.min(Number(op.ms ?? 300), 10000));
      return `wait ${op.ms ?? 300}`;
    }
    default:
      return `unknown op "${op.op}"`;
  }
}

/* -------------------------------- Screenshots ------------------------------ *
 * For what the element table can't express — canvas apps (Docs/Sheets/Figma/maps), charts, visual
 * state. The image is in CSS pixels (so it maps 1:1 to click_xy on any display density), capped at
 * 1568px on the long side, and, where OffscreenCanvas exists, labelled with the table's refs.     */
const shotScale = new Map(); // tabId -> CSS px per image px of the last screenshot

async function screenshot(tabId, opts) {
  const [dpr, vw, vh] = await evaluate(tabId, '[devicePixelRatio, innerWidth, innerHeight]');
  const { cssVisualViewport: vv } = await sendCdp(tabId, 'Page.getLayoutMetrics');
  const fit = Math.min(1, 1568 / Math.max(vw, vh));
  const shot = await sendCdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 70,
    clip: { x: vv.pageX, y: vv.pageY, width: vw, height: vh, scale: fit / dpr },
  });
  shotScale.set(tabId, 1 / fit);
  let data = shot.data, marked = 0;
  if (opts && opts.marks !== false && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
    try {
      const snap = await snapshot(tabId, 1);
      const frames = snap ? await readFrames(tabId, tabId, snap, []) : [];
      // Label at each control's top-left corner (not its centre, which would hide its text).
      const rows = (snap ? snap.actions.filter((a) => !a.off) : []).map((a) => ({ id: a.id, x: a.x - (a.w || 0) / 2, y: a.y - (a.h || 0) / 2 }));
      for (const { f, off, snap: fs } of frames) for (const a of fs.actions) if (!a.off) rows.push({ id: `f${f.idx}.${a.id}`, x: a.x - (a.w || 0) / 2 + off.x, y: a.y - (a.h || 0) / 2 + off.y });
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext('2d');
      g.drawImage(bmp, 0, 0);
      g.font = 'bold 11px sans-serif'; g.textBaseline = 'top';
      for (const r of rows) {
        const w = g.measureText(r.id).width + 4, x = Math.max(0, r.x * fit - 2), y = Math.max(0, r.y * fit - 9);
        g.fillStyle = 'rgba(220,38,38,.85)'; g.fillRect(x, y, w, 13);
        g.fillStyle = '#fff'; g.fillText(r.id, x + 2, y + 1);
        marked++;
      }
      const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      const buf = new Uint8Array(await out.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      data = btoa(bin);
    } catch { /* unlabelled screenshot is still useful */ }
  }
  const w = Math.round(vw * fit), h = Math.round(vh * fit);
  return { data, mimeType: 'image/jpeg', width: w, height: h, note: `screenshot ${w}x${h} of the visible viewport${marked ? `, ${marked} controls labelled with their refs` : ''}. For things not in the element table (canvas apps, maps, charts), act with {op:"click_xy",x,y} using THIS image's pixel coordinates.` };
}

/* ------------------------------ Command router ---------------------------- */

async function handleCommand(cmd, args, token, session) {
  await rehydrated; // ensure persisted session→tab/group state is loaded before we resolve tabs
  const aborted = () => token && token.cancelled;
  switch (cmd) {
    case '__session_end':
      return endSession(session);
    case 'doctor': {
      const t = await activeTab();
      const s = sessions.get(session || '_default');
      return {
        ext_version: chrome.runtime.getManifest().version,
        extension_id: chrome.runtime.id,
        session,
        session_tab_id: s ? s.activeTabId : null,
        session_group_id: s ? s.groupId : null,
        attached_tab_ids: [...attachedTabs],
        active_sessions: sessions.size,
        active_tab: t ? { id: t.id, url: t.url, title: t.title } : null,
      };
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case 'navigate': {
      const tabId = await resolveTabId(session, args, 'navigate');
      let url = String(args.url || '').trim();
      if (!url) throw new Error('navigate needs a url');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url; // bare domain -> https
      if (!/^https?:\/\//i.test(url)) throw new Error(`navigate only supports http(s) URLs (refusing "${url.split(':')[0]}:")`);
      await attach(tabId);
      // beforeunload ("Leave site? Changes may not be saved") is dismissed unless dialog:"accept".
      return whileActing(tabId, async () => {
      const t0 = Date.now();
      const w = tabWatch(tabId);
      w.navStart = t0; w.navDone = 0; w.committed = false; w.navReq = null; // the old document must not count as "arrived"
      const nav = await sendCdp(tabId, 'Page.navigate', { url });
      if (nav && nav.loaderId && !w.committed) w.navReq = nav.loaderId;
      worlds.delete(tabId); // the old document's world is going away with it
      if (nav && nav.errorText) {
        // Cancelled by a "leave site?" prompt we dismissed: not a failure — say so, show where we are.
        const dl0 = takeDialogLog(tabId);
        if (dl0 && /beforeunload/.test(dl0)) return `${dl0}(navigation cancelled: the page asked to keep unsaved changes)\n\n${await observe(tabId)}`;
        throw new Error(`navigation failed: ${nav.errorText}`);
      }
      if (nav && !nav.loaderId) w.navDone = Date.now(); // same-document (fragment) navigation
      await settle(tabId, 5000, t0);
      const dl = takeDialogLog(tabId);
      return (dl ? dl + '\n' : '') + await observe(tabId);
      }, { nav: true, accept: args.dialog === 'accept' ? true : undefined });
    }
    case 'observe': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      assertNoOpenDialog(tabId);
      const t = await observe(tabId, args);
      const dl = takeDialogLog(tabId);
      return dl ? `${dl}\n${t}` : t;
    }
    case 'read': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      assertNoOpenDialog(tabId);
      const max = Math.min(Number(args.max_chars) || 12000, 50000);
      const r = await evaluate(tabId, `${READ_TEXT}(${max})`);
      let text = r.text;
      // Cross-origin frames the page-side reader can't enter (embedded docs, widgets, checkouts).
      try {
        for (const { f } of await readFrames(tabId, tabId, await snapshot(tabId, 1), [])) {
          if (text.length >= max) break;
          try {
            const fr = await evaluate(f.target, `${READ_TEXT}(${max})`);
            if (fr && fr.text) text += `\n\n[frame f${f.idx}: ${fr.url}]\n${fr.text}`;
          } catch {}
        }
      } catch {}
      return `${r.title}  —  ${r.url}\n\n${text.slice(0, max)}`;
    }
    case 'act': {
      const ops = args.ops || [];
      if (ops.length > 50) throw new Error('too many ops in one call (max 50); split into smaller batches');
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      return whileActing(tabId, async () => {
        const logLines = [];
        // Answer a dialog left open from before FIRST: until then the page can't run anything.
        let i = 0;
        for (; i < ops.length && ops[i].op === 'dialog'; i++) logLines.push('  ' + await runOp(tabId, ops[i]));
        assertNoOpenDialog(tabId);
        const before = await evaluate(tabId, SIG).catch(() => null);
        await netOn(tabId);
        try {
        for (; i < ops.length; i++) {
          const op = ops[i];
          if (aborted()) { logLines.push('  (aborted: command timed out; remaining ops not run)'); break; }
          const t0 = Date.now();
          try { logLines.push('  ' + await runOp(tabId, op)); }
          catch (e) { logLines.push(`  ${op.op} ${op.ref || ''}: ERROR ${e.message}`); }
          if (op.op !== 'wait') await settle(tabId, i === ops.length - 1 ? 4000 : 2500, t0, { grace: op.op === 'type' ? 400 : 0 });
        }
        } finally { await netOff(tabId); }
        const after = await evaluate(tabId, SIG).catch(() => null);
        const seen = lastTable.get(tabId), seenFull = lastFull.get(tabId);
        // The ops already executed; a failed post-action read (page navigating) must NOT make
        // the caller think they failed and retry them.
        let table;
        try { table = await observe(tabId); } catch { table = null; }
        const nt = await followNewTab(session, tabId).catch(() => null);
        if (nt != null) {
          const t2 = await observe(nt).catch(() => '(new tab not readable yet: observe next)');
          return `ran ${ops.length} op(s) [page changed]:\n${logLines.join('\n')}\n${takeDialogLog(tabId)}  → the page opened a NEW TAB (tab ${nt}); now driving it (the previous tab ${tabId} is left open)\n\n${t2}`;
        }
        const changed = before == null || after == null || before !== after || table == null || seen == null || tableBody(table) !== seen || dialogLog.has(tabId);
        const note = changed ? 'page changed' : 'page did NOT change (if you expected an effect, the action may not have worked — try a different target)';
        if (table == null) {
          return `ran ${ops.length} op(s) [${note}]:\n${logLines.join('\n')}\n${takeDialogLog(tabId)}\n(ops executed; the page is navigating and could not be read yet — call browser_observe next. Do NOT re-run these ops.)`;
        }
        return `ran ${ops.length} op(s) [${note}]:\n${logLines.join('\n')}\n${takeDialogLog(tabId)}\n${(changed && deltaTable(seenFull, table)) || table}`;
      });
    }
    case 'peek': {
      // Dev-only frame capture for recordings: screenshot ANY tab by id without adopting it into a
      // session, grouping it, or enabling domains on it (so another tool driving that tab — e.g. for
      // a side-by-side benchmark — is not disturbed). Attaches the debugger only if needed.
      const tabId = Number(args.tabId);
      let t; try { t = await chrome.tabs.get(tabId); } catch { throw new Error(`tab ${args.tabId} not found`); }
      if (restrictedPage(t.url)) throw new Error('that tab is a browser page that cannot be captured');
      if (!attachedTabs.has(tabId)) {
        await new Promise((res, rej) => chrome.debugger.attach({ tabId }, '1.3', () => { const e = chrome.runtime.lastError; if (e && !/already attached/i.test(e.message)) rej(new Error(e.message)); else res(); }));
        peekOnly.add(tabId);
      }
      const q = Math.max(20, Math.min(90, Number(args.quality) || 60));
      const shot = await sendCdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: q });
      return { data: shot.data, t: Date.now(), url: t.url };
    }
    case 'peek_end': {
      for (const id of [...peekOnly]) { peekOnly.delete(id); if (!attachedTabs.has(id)) await new Promise((r) => chrome.debugger.detach({ tabId: id }, () => { void chrome.runtime.lastError; r(); })); }
      return { ok: true };
    }
    case 'screenshot': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      assertNoOpenDialog(tabId);
      return screenshot(tabId, args);
    }
    case 'assert': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      assertNoOpenDialog(tabId);
      if (args.contains != null) {
        const ok = await evaluate(tabId, `!!(document.body && document.body.innerText && document.body.innerText.indexOf(${JSON.stringify(args.contains)})>=0)`);
        return { pass: !!ok, kind: 'contains', value: args.contains };
      }
      if (args.url_includes != null) {
        const u = await evaluate(tabId, 'location.href');
        return { pass: String(u).indexOf(args.url_includes) >= 0, kind: 'url_includes', url: u };
      }
      if (args.ref_visible != null) {
        const rt = routeRef(tabId, args.ref_visible);
        const r = rt.target ? await resolveHit(rt.target, rt.ref, { noScroll: true }) : { error: 'unknown frame (observe again)' };
        return { pass: !r.error, kind: 'ref_visible', ref: args.ref_visible, note: r.error };
      }
      return { pass: false, error: 'provide one of: contains, url_includes, ref_visible' };
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

/* --------------------------------- Wiring --------------------------------- */

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('pawbrowse-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pawbrowse-keepalive') connect(); });
// Let the options page read live connection status without opening a competing socket
// (which the bridge's single-connection guard would reject).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') { sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) }); return true; }
  if (msg && msg.type === 'reconnect') {
    // The options page changed the port: drop the current socket and reconnect on the new one.
    try { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } } catch {}
    try { if (ws) ws.close(); } catch {}
    ws = null;
    connect();
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
connect();
