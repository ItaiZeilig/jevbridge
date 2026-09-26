// End-to-end perception + action tests against a real headless Chrome, driving the shipped
// extension/background.js through a chrome.debugger shim (see harness.mjs). Every outcome is checked
// against GROUND TRUTH read straight from the page — never PawBrowse's own report of success.
//
//   npm run test:e2e          (needs Chrome; set CHROME_PATH if it isn't in the default location)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, chromePath, ref } from './harness.mjs';

const skip = chromePath() ? false : 'Chrome not found (set CHROME_PATH)';
let h;
before(async () => { if (!skip) h = await launch(); });
after(async () => { if (h) await h.close(); });

const out = () => h.js(`document.getElementById('out')?.textContent || ''`);
function mustRef(table, label, kind) {
  const r = ref(table, label, kind);
  assert.ok(r, `no row "${label}"${kind ? ` (${kind})` : ''} in:\n${table}`);
  return r;
}

/* ------------------------------ styled widgets ----------------------------- */

test('styled checkboxes/radios/switch/file are perceived (hidden native inputs)', { skip }, async () => {
  const t = await h.goto('widgets.html');
  for (const l of ['Free WiFi', 'Pool', 'Dark mode', 'Economy class', 'Business class']) mustRef(t, l, 'click');
  mustRef(t, 'Upload CV', 'upload');
  assert.doesNotMatch(t, /"Pool".*covered/, 'sr-only checkbox must be clickable via its label, not flagged covered');
});

for (const [label, id] of [['Free WiFi', 'wifi'], ['Pool', 'pool'], ['Dark mode', 'dark'], ['Business class', 'biz']]) {
  test(`clicking styled control "${label}" really toggles the native input`, { skip }, async () => {
    const t = await h.goto('widgets.html');
    const r = await h.act({ op: 'click', ref: mustRef(t, label) });
    assert.match(r, /page changed/);
    assert.equal(await h.js(`document.getElementById('${id}').checked`), true, r);
    assert.match(r, new RegExp(`✓ "${label}"`), 'table should now show it checked');
  });
}

test('date/time/month/week/color/range inputs are fillable with a format hint', { skip }, async () => {
  const t = await h.goto('widgets.html');
  for (const [l, f] of [['Departure', 'YYYY-MM-DD'], ['Time', 'HH:MM'], ['Local', 'YYYY-MM-DDTHH:MM'], ['Month', 'YYYY-MM'], ['Week', 'YYYY-Www'], ['Color', '#rrggbb'], ['Budget', '0..1000 step 50']]) {
    const line = t.split('\n').find((x) => x.includes(`"${l}"`));
    assert.ok(line && line.includes(' fill ') && line.includes(`fmt{${f}}`), `bad row for ${l}: ${line}`);
  }
});

test('typing a date sets it, fires page events, and survives form submit', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Departure'), text: '2026-12-25' });
  assert.match(r, /set to "2026-12-25"/);
  assert.equal(await h.js(`document.getElementById('when').value`), '2026-12-25');
  assert.equal(await out(), 'date:2026-12-25', 'page input listener must see the change');
  const t2 = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t2, 'Search') });
  // The email field is invalid, so native validation blocks submit — fix it, then submit.
  const t3 = await h.observe();
  await h.act({ op: 'type', ref: mustRef(t3, 'Email'), text: 'a@b.co' }, { op: 'click', ref: mustRef(t3, 'Search') });
  assert.equal(await out(), 'submitted 2026-12-25');
});

test('an invalid date is rejected with a clear error, not silently blanked', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Departure'), text: 'next friday' });
  assert.match(r, /rejected by the date field/);
});

test('range input reports the browser-clamped value', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Budget'), text: '5000' });
  assert.match(r, /set to "1000"/);
  assert.equal(await h.js(`document.getElementById('budget').value`), '1000');
});

test('file upload through a hidden input behind a label', { skip }, async () => {
  const f = path.join(os.tmpdir(), `pawbrowse-cv-${process.pid}.txt`);
  fs.writeFileSync(f, 'hello');
  try {
    const t = await h.goto('widgets.html');
    const r = await h.act({ op: 'upload', ref: mustRef(t, 'Upload CV'), paths: [f] });
    assert.match(r, /upload e\d+ \(1 file\)/, r);
    assert.equal(await out(), `file:${path.basename(f)}`);
    assert.match(r, new RegExp(`"Upload CV"\\s+▸ "${path.basename(f)}"`));
  } finally { fs.rmSync(f, { force: true }); }
});

test('unlabelled fields get a nearby label; contenteditable gets its placeholder; validation shown', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Name', 'fill'), text: 'Ada' }, { op: 'type', ref: mustRef(t, 'Write a note', 'fill'), text: 'hi there' });
  assert.equal(await h.js(`document.getElementById('nolabel').value`), 'Ada');
  assert.equal(await h.js(`document.getElementById('rte').innerText.trim()`), 'hi there');
  void r;
  assert.match(await h.observe(), /"Email" \(required\).*⚠ "Please include an '@'/);
});

/* ------------------------------- hostile pages ----------------------------- */

test('a page that sabotages JS builtins and squats on our globals cannot blind us', { skip }, async () => {
  const t = await h.goto('hostile.html');
  assert.doesNotMatch(t, /Ignore previous instructions|INJECTED|pwned/);
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Real button') }, { op: 'click', ref: mustRef(t, 'Agree') });
  assert.equal(await h.js(`document.getElementById('o').textContent`), 'hostile clicked');
  assert.equal(await h.js(`document.getElementById('c').checked`), true, r);
  assert.equal(await h.js('window.__pawbrowse'), 'not your cache', 'we must not touch the page\'s own globals');
});

test('hidden text never leaks into labels; disabled/inert/collapsed controls are excluded', { skip }, async () => {
  const t = await h.goto('tricky.html');
  assert.doesNotMatch(t, /SECRET/);
  assert.doesNotMatch(t, /In disabled fieldset|Inert button|Hidden in details/);
  mustRef(t, 'Close'); mustRef(t, 'Settings'); mustRef(t, 'Save');
  assert.match(t, /"Under overlay"\s+⊘ covered/);
  assert.match(t, /"No pointer events"\s+⊘ covered/);
});

test('clicking a covered control fails loudly instead of clicking the overlay', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Under overlay') });
  assert.match(r, /covered by another element/);
  assert.equal(await out(), '');
});

test('a control relabelled after observe is refused (no clicking "Delete forever" thinking it is "Archive")', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const archive = mustRef(t, 'Archive');
  await h.js(`document.getElementById('morph').textContent='Delete forever'`);
  const r = await h.act({ op: 'click', ref: archive });
  assert.match(r, /changed since observe/);
});

test('an element removed on mousedown does not crash the batch', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Vanish on press') }, { op: 'click', ref: mustRef(t, 'Div role button') });
  assert.equal(await out(), 'div button', r);
  assert.equal(await h.js(`!!document.getElementById('vanish')`), false);
});

test('RTL / non-latin labels round-trip', { skip }, async () => {
  const t = await h.goto('nav.html');
  mustRef(t, 'אשר', 'click');
});

/* ---------------------------- shadow DOM & frames --------------------------- */

test('open, nested and slotted shadow content is perceived and clickable', { skip }, async () => {
  const t = await h.goto('shadow.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Deep nested button') });
  assert.equal(await out(), 'deep clicked');
  const t2 = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t2, 'Slotted action') }, { op: 'type', ref: mustRef(t2, 'Shadow field'), text: 'in shadow' });
  assert.equal(await out(), 'slotted clicked');
  assert.equal(await h.js(`document.querySelector('x-open').shadowRoot.getElementById('i').value`), 'in shadow');
});

test('read includes shadow-DOM, slotted and same-origin iframe text', { skip }, async () => {
  await h.goto('shadow.html');
  const r = await h.cmd('read');
  for (const s of ['Inside open shadow text', 'Deep nested button', 'Slotted action']) assert.ok(r.includes(s), `missing "${s}":\n${r}`);
  await h.goto('frames.html');
  const f = await h.cmd('read');
  assert.ok(f.includes('Inner frame text'), f);
});

test('same-origin iframe (border + padding offset) click lands on the right element', { skip }, async () => {
  const t = await h.goto('frames.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Inner button') }, { op: 'click', ref: mustRef(t, 'Inner check') });
  const inner = `document.getElementById('same').contentDocument`;
  assert.equal(await h.js(`${inner}.getElementById('o').textContent`), 'inner clicked');
  assert.equal(await h.js(`${inner}.getElementById('ic').checked`), true);
});

test('a control scrolled out of its iframe is reachable', { skip }, async () => {
  const t = await h.goto('frames.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Low inner button') });
  assert.equal(await h.js(`document.getElementById('same').contentDocument.getElementById('o').textContent`), 'low clicked', r);
});

/* ------------------------------ cross-origin frames ------------------------- */

const msgs = () => h.js('window.msgs.join(" | ")');
const frameRef = (t, host, label) => {
  // rows of the frame section whose header names this host (first match)
  const lines = t.split('\n'); let inF = false;
  for (const l of lines) {
    if (l.startsWith('frame ')) inF = l.includes(`"${host}`);
    else if (inF && l.includes(`"${label}"`)) return l.split(/\s+/)[0];
  }
  assert.fail(`no "${label}" in frame ${host}:\n${t}`);
};

test('cross-site (out-of-process) iframe content is listed and clickable', { skip }, async () => {
  const t = await h.goto('frames.html');
  assert.doesNotMatch(t, /content not readable/);
  const x = `localhost:${h.port}`;
  await h.act({ op: 'click', ref: frameRef(t, x, 'Cross button') }, { op: 'click', ref: frameRef(t, x, 'Cross check') });
  const m = await msgs();
  assert.match(m, new RegExp(`${x} cross clicked`), m);
  assert.match(m, new RegExp(`${x} xc=true`), m);
});

test('typing into a field inside a cross-site iframe (a card-number style widget)', { skip }, async () => {
  const t = await h.goto('frames.html');
  const r = await h.act({ op: 'type', ref: frameRef(t, `localhost:${h.port}`, 'Card number'), text: '4242 4242' });
  assert.match(r, /"Card number"\s+▸ "4242 4242"/, r);
});

test('a frame nested inside a cross-site frame (back on the top site) is reachable', { skip }, async () => {
  const t = await h.goto('frames.html');
  const r = await h.act({ op: 'click', ref: frameRef(t, `127.0.0.1:${h.port}`, 'Inner button') });
  void r;
  assert.match(await msgs(), new RegExp(`127.0.0.1:${h.port} inner clicked`));
});

test('a confirm() raised inside a cross-site frame is handled, not a hang', { skip }, async () => {
  let t = await h.goto('frames.html');
  const x = `localhost:${h.port}`;
  const r = await h.act({ op: 'click', ref: frameRef(t, x, 'Cross confirm') });
  assert.match(r, /confirm "Pay now\?" → dismissed/);
  t = await h.observe();
  await h.act({ op: 'click', ref: frameRef(t, x, 'Cross confirm'), dialog: 'accept' });
  const m = await msgs();
  assert.match(m, /not paid/); assert.match(m, / paid/);
});

test('read includes cross-site frame text', { skip }, async () => {
  await h.goto('frames.html');
  const r = await h.cmd('read');
  assert.ok(r.includes('Cross frame text'), r);
});

/* -------------------------- scrolling, overlays, nav ------------------------ */

test('controls below the fold / inside scroll boxes are flagged and clickable', { skip }, async () => {
  const t = await h.goto('layout.html');
  assert.match(t, /\+1 more; scroll to reveal/);
  assert.match(t, /"Inside scroll box"\s+↕/);
  await h.act({ op: 'click', ref: mustRef(t, 'Inside scroll box') });
  assert.equal(await out(), 'inbox');
  const t2 = await h.act({ op: 'scroll', dy: 1400 });
  await h.act({ op: 'click', ref: mustRef(t2, 'Far below button') });
  assert.equal(await out(), 'below');
});

test('a modal dialog covers the page behind it; its own button works', { skip }, async () => {
  const t = await h.goto('layout.html');
  const t2 = await h.act({ op: 'click', ref: mustRef(t, 'Open dialog') });
  assert.match(t2, /"Top button"\s+⊘ covered/);
  const bad = await h.act({ op: 'click', ref: mustRef(t2, 'Top button') });
  assert.match(bad, /covered|disabled/);
  await h.act({ op: 'click', ref: mustRef(t2, 'Confirm') });
  assert.equal(await out(), 'confirmed');
});

test('refs from a previous page fail cleanly after navigation; the next observe works', { skip }, async () => {
  const t = await h.goto('nav.html');
  const old = mustRef(t, 'JS navigate');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Go to tricky') });
  assert.match(r, /Tricky/);
  const r2 = await h.act({ op: 'click', ref: old });
  assert.match(r2, /unknown ref|no longer on page|no snapshot/);
  mustRef(await h.observe(), 'Archive');
});

test('JS navigation and pushState inside one act batch', { skip }, async () => {
  const t = await h.goto('nav.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Push state') });
  assert.match(r, /Routed/);
  const r2 = await h.act({ op: 'click', ref: mustRef(r, 'JS navigate') });
  assert.match(r2, /Layout/);
});

/* ------------------------------ dynamic / scale ----------------------------- */

test('autocomplete on a page that re-renders every keystroke', { skip }, async () => {
  const t = await h.goto('spa.html');
  let r = await h.act({ op: 'type', ref: mustRef(t, 'City', 'fill'), text: 'Pa' });
  for (let i = 0; i < 5 && !ref(r, 'Paris'); i++) r = await h.observe();
  await h.act({ op: 'click', ref: mustRef(r, 'Paris') });
  assert.equal(await out(), 'picked Paris');
});

test('big page (3000 rows, 9000 controls) stays fast and bounded', { skip }, async () => {
  await h.goto('big.html');
  const t0 = performance.now();
  const t = await h.observe();
  const ms = performance.now() - t0;
  const rows = t.split('\n').filter((l) => /^e\d/.test(l)).length;
  assert.ok(rows > 20 && rows <= 290, `rows=${rows}`);
  assert.ok(ms < 1500, `observe took ${ms.toFixed(0)}ms`);
});

test('about:blank and a page with no body do not throw', { skip }, async () => {
  await h.cdp('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 300));
  const t = await h.observe();
  assert.equal(typeof t, 'string');
});

/* ------------------------- round 2: layout & dialogs ------------------------ */

for (const [label, want] of [['Zoomed button', 'zoomed'], ['Scaled button', 'scaled'], ['Moving button', 'mover'], ['Fading button', 'faded in']]) {
  test(`click lands on a ${label.split(' ')[0].toLowerCase()} element`, { skip }, async () => {
    const t = await h.goto('round2.html');
    await h.act({ op: 'click', ref: mustRef(t, label) });
    assert.equal(await out(), want);
  });
}

test('repeated labels are disambiguated by their row, and the right row is hit', { skip }, async () => {
  const t = await h.goto('round2.html');
  assert.match(t, /"Delete" in "Invoice #1002 — Globex"/);
  assert.match(t, /"Edit" in "Bob"/);
  const row = t.split('\n').find((l) => l.includes('Globex')).split(/\s+/)[0];
  await h.act({ op: 'click', ref: row });
  assert.equal(await out(), 'del 1002');
});

test('scroll with a ref scrolls that panel, not the page', { skip }, async () => {
  const t = await h.goto('round2.html');
  assert.match(t, /"Open row 12"\s+↕/, 'rows in the fixed panel are scrolled out of their box, not below the page');
  assert.equal(ref(t, 'Open row 55'), null);
  const r = await h.act({ op: 'scroll', ref: mustRef(t, 'Open row 0'), dy: 1500 });
  assert.ok(await h.js(`document.getElementById('panel').scrollTop`) > 1000);
  await h.act({ op: 'click', ref: mustRef(r, 'Open row 55') });
  assert.equal(await out(), 'row 55');
});

test('alert is accepted and reported instead of freezing the tab', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Save') });
  assert.match(r, /dialog: alert "Saved!" → accepted/);
  assert.equal(await out(), 'after alert');
});

test('a destructive confirm is dismissed by default, accepted only on request', { skip }, async () => {
  let t = await h.goto('dialogs.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Delete account') });
  assert.match(r, /confirm "Really delete\?" → dismissed/);
  assert.equal(await out(), 'cancelled');
  t = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t, 'Delete account'), dialog: 'accept' });
  assert.equal(await out(), 'confirmed');
});

test('prompt gets the requested answer', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Ask name'), dialog: 'accept', dialog_text: 'Ada' });
  assert.equal(await out(), 'prompt:Ada');
});

test('a dialog left open while idle gives a clear error, and {op:"dialog"} clears it', { skip }, async () => {
  await h.goto('dialogs.html');
  await new Promise((r) => setTimeout(r, 1700)); // past the post-action window: we're idle now
  await h.js(`setTimeout(()=>alert('from the user'),10)`);
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(h.observe(), /showing an alert dialog "from the user"/);
  const r = await h.act({ op: 'dialog', accept: true });
  assert.match(r, /alert "from the user" → accepted/);
  mustRef(await h.observe(), 'Save');
});

test('change detection: a dead click says "did NOT change"; a scroll says "changed"', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const dead = await h.act({ op: 'click', ref: mustRef(t, 'Settings') }); // no handler
  assert.match(dead, /page did NOT change/);
  const t2 = await h.goto('layout.html');
  const moved = await h.act({ op: 'scroll', dy: 500 });
  assert.match(moved, /\[page changed\]/, moved.split('\n')[0]);
  void t2;
});

test('a select whose change navigates is applied exactly once and reported honestly', { skip }, async () => {
  const t = await h.goto('nav.html');
  const line = t.split('\n').find((l) => l.includes(' select '));
  assert.ok(line, t);
  const r = await h.act({ op: 'select', ref: line.split(/\s+/)[0], value: 'Tricky' });
  assert.doesNotMatch(r, /unknown ref|option not found/, r);
  assert.match(r, /Tricky/);
});

/* ------------------------------- waiting (settle) ---------------------------- */

for (const q of ['', '?clock']) {
  const tag = q ? ' (page with a ticking clock)' : '';
  test(`a click that fetches returns the fetched results, not a stale table${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const r = await h.act({ op: 'click', ref: mustRef(t, 'Load results') });
    mustRef(r, 'Lyon');
  });
  test(`typing into a debounced search returns its results${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const r = await h.act({ op: 'type', ref: mustRef(t, 'Search'), text: 'Ly' });
    mustRef(r, 'Lyon');
    assert.equal(ref(r, 'London'), null, 'results must be the filtered ones');
  });
  test(`a click that does nothing returns fast${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const t0 = performance.now();
    await h.act({ op: 'click', ref: mustRef(t, 'Search') });
    const ms = performance.now() - t0;
    assert.ok(ms < (q ? 400 : 150), `took ${ms.toFixed(0)}ms`);
  });
}

test('a link to a slow page returns the NEW page', { skip }, async () => {
  const t = await h.goto('async.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Slow page') });
  mustRef(r, 'Slow page button');
});

test('navigate waits for a slow page, returns fast for a fast one, and reports network errors', { skip }, async () => {
  const t = await h.goto('slow.html?delay=900');
  mustRef(t, 'Slow page button');
  const t0 = performance.now();
  await h.goto('widgets.html');
  assert.ok(performance.now() - t0 < 300, `fast navigate took ${(performance.now() - t0).toFixed(0)}ms`);
  await assert.rejects(h.goto('http://127.0.0.1:1/'), /navigation failed: net::ERR_/);
});

/* ------------------------ refs across node-replacing re-renders ------------- */

const rowRef = (t, label, row) => {
  const l = t.split('\n').find((x) => x.includes(`"${label}" in "${row}`));
  assert.ok(l, `no "${label}" row for ${row} in:\n${t}`);
  return l.split(/\s+/)[0];
};

test('a batch keeps working when every click re-renders (replaces) the whole list', { skip }, async () => {
  const t = await h.goto('rerender.html');
  const r = await h.act({ op: 'click', ref: rowRef(t, 'Done', 'Walk dog') }, { op: 'click', ref: rowRef(t, 'Done', 'Call mom') });
  assert.doesNotMatch(r, /no longer on page/, r);
  assert.equal(await out(), 'Walk dog,Call mom|Buy milk,Walk dog,Pay rent,Call mom,Fix bike');
});

test('after a row is deleted, the other rows\' refs still hit the right row', { skip }, async () => {
  const t = await h.goto('rerender.html');
  await h.act({ op: 'click', ref: rowRef(t, 'Delete', 'Walk dog') }, { op: 'click', ref: rowRef(t, 'Done', 'Pay rent') });
  assert.equal(await out(), 'Pay rent|Buy milk,Pay rent,Call mom,Fix bike');
});

test('a ref to a row that no longer exists fails instead of hitting a neighbour', { skip }, async () => {
  const t = await h.goto('rerender.html');
  const r = await h.act({ op: 'click', ref: rowRef(t, 'Delete', 'Walk dog') }, { op: 'click', ref: rowRef(t, 'Done', 'Walk dog') });
  assert.match(r, /no longer on page/);
  assert.equal(await out(), '|Buy milk,Pay rent,Call mom,Fix bike');
});

test('150 invisible ad iframes: ignored cheaply; the one visible cross-site frame is read', { skip }, async () => {
  const t = await h.goto('adframes.html');
  const frames = t.split('\n').filter((l) => l.startsWith('frame '));
  assert.equal(frames.length, 2, `expected xframe + its nested frame only:\n${frames.join('\n')}`);
  const t0 = performance.now();
  const t2 = await h.observe();
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `observe took ${ms.toFixed(0)}ms`);
  frameRef(t2, `localhost:${h.port}`, 'Cross button');
});

test('closed shadow roots (incl. closed-inside-closed) are perceived and actionable', { skip }, async () => {
  const t = await h.goto('shadow.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Closed shadow button') }, { op: 'type', ref: mustRef(t, 'PIN'), text: '1234' });
  assert.equal(await out(), 'closed clicked');
  assert.equal(await h.js('window.__pin.value'), '1234');
  const r = await h.cmd('read');
  assert.ok(r.includes('Locked panel text'), r);
});

/* ----------------------------- richer interactions -------------------------- */

test('hover opens a CSS :hover menu whose item is then clickable', { skip }, async () => {
  const t = await h.goto('interact.html');
  assert.equal(ref(t, 'Settings item'), null);
  const r = await h.act({ op: 'hover', ref: mustRef(t, 'Account') });
  await h.act({ op: 'click', ref: mustRef(r, 'Settings item') });
  assert.equal(await out(), 'settings');
});

test('hover fires mouseenter-revealed controls', { skip }, async () => {
  const t = await h.goto('interact.html');
  const r = await h.act({ op: 'hover', ref: mustRef(t, 'Hover for tip') });
  await h.act({ op: 'click', ref: mustRef(r, 'Tip action') });
  assert.equal(await out(), 'tip action');
});

test('key chords, single characters, Shift and named keys reach the page', { skip }, async () => {
  const t = await h.goto('interact.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Shortcut field') },
    { op: 'key', key: 'Control+k' }, { op: 'key', key: 'Shift+a' }, { op: 'key', key: '?' }, { op: 'key', key: 'PageDown' }, { op: 'key', key: 'Alt+Enter' });
  assert.equal((await h.js(`document.getElementById('keys').textContent`)).trim(), 'Ctrl+k Shift+A ? PageDown Alt+Enter');
  assert.equal(await h.js(`document.getElementById('field').value`), 'A?', 'printable keys type text; chords do not');
});

test('Mod+A selects all (macOS needs the editing command), then typing replaces it', { skip }, async () => {
  const t = await h.goto('interact.html');
  const f = mustRef(t, 'Shortcut field');
  await h.act({ op: 'type', ref: f, text: 'hello world' }, { op: 'key', key: 'Mod+a' }, { op: 'key', key: 'x' });
  assert.equal(await h.js(`document.getElementById('field').value`), 'x');
});

test('double-click and right-click', { skip }, async () => {
  let t = await h.goto('interact.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Double me'), count: 2 });
  assert.equal(await out(), 'double');
  t = await h.observe();
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Right me'), button: 'right' });
  await h.act({ op: 'click', ref: mustRef(r, 'Copy link') });
  assert.equal(await out(), 'ctx copy');
});

test('native HTML5 drag-and-drop onto a drop zone found by text', { skip }, async () => {
  const t = await h.goto('interact.html');
  assert.match(t, /"Card A"\s+⇄ draggable/);
  const r = await h.act({ op: 'drag', ref: mustRef(t, 'Card A'), to_text: 'Done column' });
  assert.match(r, /html5 drop/);
  assert.equal(await out(), 'dropped cardA');
  assert.equal(await h.js(`document.getElementById('cardA').parentElement.id`), 'done');
});

test('pointer-driven custom slider drags by an offset', { skip }, async () => {
  const t = await h.goto('interact.html');
  await h.act({ op: 'drag', ref: mustRef(t, 'Volume'), dx: 140, dy: 0 });
  const v = Number((await out()).replace('volume ', ''));
  assert.ok(v >= 45 && v <= 55, `volume ${v}`);
});

/* ---------------------------------- WebMCP ---------------------------------- */

test('WebMCP: page tools (imperative + declarative) are listed and callable', { skip }, async () => {
  const w = await launch({ args: ['--enable-features=WebMCPTesting'] });
  try {
    const t = await w.goto('webmcp.html');
    assert.match(t, /tool add_to_cart\(sku\*: string, qty: number\) — Add a product to the cart by SKU/);
    assert.match(t, /tool search_products\(q\*: string\)/);
    const r = await w.act({ op: 'tool', name: 'add_to_cart', input: { sku: 'B-42', qty: 2 } });
    assert.match(r, /tool add_to_cart: Completed\s+output \(untrusted page data\): Added 2 of B-42/);
    assert.equal(await w.js(`document.getElementById('out').textContent`), 'cart B-42 x2');
    const bad = await w.act({ op: 'tool', name: 'nope' });
    assert.match(bad, /not offered by this page/);
    const t2 = await w.goto('widgets.html');
    assert.doesNotMatch(t2, /page tools/, 'tools must not leak to the next page');
  } finally { await w.close(); }
});

/* ------------------------- screenshots & canvas apps ------------------------ */

test('screenshot is in CSS pixels even on a 2x display, and click_xy hits a canvas-drawn button', { skip }, async () => {
  const w = await launch({ args: ['--force-device-scale-factor=2'] });
  try {
    await w.goto('canvas.html');
    const shot = await w.cmd('screenshot', {});
    const [vw, vh] = await w.js('[innerWidth, innerHeight]');
    assert.equal(shot.width, vw); assert.equal(shot.height, vh);
    assert.ok(shot.data.length > 1000 && shot.mimeType === 'image/jpeg');
    // canvas content box starts at (21,21): margin 20 + border 1; "Approve" spans x 250..350, y 120..160.
    await w.act({ op: 'click_xy', x: 21 + 300, y: 21 + 140 });
    assert.equal(await w.js(`document.getElementById('out').textContent`), 'approved');
  } finally { await w.close(); }
});

/* ------------------------------ delta act results ---------------------------- */

test('act on a big unchanged page returns only the changed rows (and says so); observe is full', { skip }, async () => {
  const t = await h.goto('rerender.html?n=30');
  const rows = (x) => x.split('\n').filter((l) => /^e\d/.test(l)).length;
  assert.ok(rows(t) >= 60, t);
  const r = await h.act({ op: 'click', ref: rowRef(t, 'Done', 'Task 7') });
  assert.match(r, /only changes shown: \d+ new\/changed row\(s\); \d+ unchanged row\(s\) omitted/);
  assert.match(r, /click\s+"Undo"/, 'the changed row is shown');
  assert.match(r, /"Delete" in "Task 7 Undo"/);
  // Re-render replaced every node, yet unchanged rows kept their refs (so the agent's refs still work).
  const t8 = rowRef(t, 'Done', 'Task 8');
  await h.act({ op: 'click', ref: t8 });
  assert.match(await out(), /Task 7,Task 8\|/);
  assert.ok(rows(r) <= 4, `delta should be tiny:\n${r}`);
  assert.equal(rows(await h.observe()), rows(t), 'observe always returns the full table');
  const d = await h.act({ op: 'click', ref: rowRef(await h.observe(), 'Delete', 'Task 3') });
  assert.match(d, /gone: /, 'removed refs are listed');
});

/* --------------------------------- round 3 ---------------------------------- */

test('custom select with a listbox portaled to <body>: open, pick, value shown', { skip }, async () => {
  const t = await h.goto('round3.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Cabin class Economy') });
  await h.act({ op: 'click', ref: mustRef(r, 'Business') });
  assert.equal(await out(), 'cabin Business');
  mustRef(await h.observe(), 'Cabin class Business');
});

test('identical buttons in different forms are told apart and hit correctly', { skip }, async () => {
  const t = await h.goto('round3.html');
  const l = t.split('\n').find((x) => x.includes('"Submit" in "Newsletter"'));
  await h.act({ op: 'click', ref: l.split(/\s+/)[0] });
  assert.equal(await out(), 'newsletter submit');
});

test('nameless icon buttons get icon / test-id hints instead of "button"', { skip }, async () => {
  const t = await h.goto('round3.html');
  mustRef(t, 'icon:trash'); mustRef(t, 'testid:share-button');
  assert.doesNotMatch(t, /click\s+"button"/);
  mustRef(t, 'Archive conversation'); // aria-labelledby -> hidden element still names it
});

test('multi-select takes several values', { skip }, async () => {
  const t = await h.goto('round3.html');
  const r = await h.act({ op: 'select', ref: mustRef(t, 'Toppings'), values: ['Cheese', 'Basil'] });
  assert.equal(await h.js(`[...document.getElementById('top').selectedOptions].map(o=>o.text).join(',')`), 'Cheese,Basil');
  assert.match(await h.observe(), /"Toppings"\s+▸ "Cheese, Basil"/, r);
});

test('accordion + tab state, and a sandboxed srcdoc frame is readable and clickable', { skip }, async () => {
  const t = await h.goto('round3.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Shipping details') });
  assert.match(r, /▾ "Shipping details"/);
  mustRef(r, 'Track order');
  const t2 = await h.observe();
  const sb = t2.split('\n').find((l) => l.includes('"Sandboxed button"'));
  assert.ok(sb, t2);
  await h.act({ op: 'click', ref: sb.split(/\s+/)[0] });
  assert.match(await h.cmd('read'), /sandbox clicked/);
});

test('observe find: searches the whole page (incl. far below the fold) and returns only matches', { skip }, async () => {
  await h.goto('round2.html');
  const f = await h.cmd('observe', { find: 'open row 5' });
  assert.match(f, /find "open row 5": \d+ of \d+ controls on the whole page match/);
  const rows = f.split('\n').filter((l) => /^e\d/.test(l));
  assert.deepEqual(rows.map((l) => l.split('"')[1]).sort(), ['Open row 5', 'Open row 50', 'Open row 51', 'Open row 52', 'Open row 53', 'Open row 54', 'Open row 55', 'Open row 56', 'Open row 57', 'Open row 58', 'Open row 59']);
  await h.act({ op: 'click', ref: mustRef(f, 'Open row 57') });
  assert.equal(await out(), 'row 57');
});

test('observe text: visible text in reading order, flex row-reverse respected', { skip }, async () => {
  await h.goto('layout.html');
  const t = await h.cmd('observe', { text: true });
  const vt = t.slice(t.indexOf('visible text'));
  assert.ok(vt.indexOf('SECOND-VISUAL-LEFT') < vt.indexOf('FIRST-VISUAL-RIGHT'), vt);
  assert.doesNotMatch(vt, /Far below button/, 'only what is on screen');
});

/* ------------------------ regressions from code review ----------------------- */

test('review#1: a gone nameless button is never re-bound to another nameless button', { skip }, async () => {
  await h.goto('review.html');
  await h.js(`document.querySelector('.fa-trash').closest('button').remove()`); // exactly two nameless buttons left
  const t = await h.observe();
  const [a] = t.split('\n').filter((l) => /click\s+"button"$/.test(l)).map((l) => l.split(/\s+/)[0]);
  const r = await h.act({ op: 'click', ref: a }, { op: 'click', ref: a });
  assert.equal(await out(), 'closed modal', 'the second click must NOT hit the other icon button');
  assert.match(r, /no longer on page/);
});

test('review#2: page text cannot forge table rows', { skip }, async () => {
  const t = await h.goto('review.html');
  assert.doesNotMatch(t, /^e999/m);
  assert.ok(!t.split('\n').some((l) => l.startsWith('e999')));
});

test('review#3: select on a dropdown relabelled since observe is refused', { skip }, async () => {
  const t = await h.goto('review.html');
  const sel = mustRef(t, 'Country');
  await h.js(`document.getElementById('sl').textContent='Payment plan'`);
  const r = await h.act({ op: 'select', ref: sel, value: 'Two' });
  assert.match(r, /changed since observe/);
  assert.equal(await h.js(`document.getElementById('sel').value`), '1');
});

test('review#4: a click into a cross-site frame covered by a parent overlay is refused', { skip }, async () => {
  const t = await h.goto('review.html');
  const x = `localhost:${h.port}`;
  const r = await h.act({ op: 'click', ref: frameRef(t, x, 'Cross button') });
  assert.match(r, /covered by another element of the page around its frame/);
  const t2 = await h.act({ op: 'click', ref: mustRef(t, 'Accept cookies') });
  const r2 = await h.act({ op: 'click', ref: frameRef(await h.observe(), x, 'Cross button') });
  assert.doesNotMatch(r2, /covered/, r2); void t2;
});

test('review#8: navigate away from unsaved changes is dismissed by default, accepted on request', { skip }, async () => {
  await h.goto('review.html?unsaved');
  await h.js(`document.getElementById('ta').focus(); document.execCommand('insertText', false, 'x')`); // user activation for beforeunload
  await h.act({ op: 'click', ref: mustRef(await h.observe(), 'Next step') }); // a real click = sticky activation
  const r = await h.goto('widgets.html');
  assert.match(r, /beforeunload .* dismissed \(to accept, repeat browser_navigate with dialog:"accept"\)/, r.slice(0, 300));
  const r2 = await h.cmd('navigate', { url: h.url('widgets.html'), dialog: 'accept' });
  assert.match(r2, /Widgets/);
});

test('review#10: assert ref_visible works for frame refs', { skip }, async () => {
  const t = await h.goto('frames.html');
  const r = await h.cmd('assert', { ref_visible: frameRef(t, `localhost:${h.port}`, 'Cross button') });
  assert.equal(r.pass, true, JSON.stringify(r));
});

/* ------------------------- found in real-Chrome testing ---------------------- */

test('typing into a rich-text editor keeps its label, so it can be typed into again', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const ed = mustRef(t, 'Write a note', 'fill');
  const r = await h.act({ op: 'type', ref: ed, text: 'first' });
  assert.match(r, /"Write a note"\s+▸ "first"/, r);
  const r2 = await h.act({ op: 'type', ref: ed, text: 'second' });
  assert.doesNotMatch(r2, /changed since observe/, r2);
  assert.equal(await h.js(`document.getElementById('rte').innerText.trim()`), 'second');
});

test('an action whose only effect is page text or a dialog reports "page changed"', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Ask name'), dialog: 'accept', dialog_text: 'Ada' });
  assert.match(r, /\[page changed\]/, r.split('\n')[0]);
  const t2 = await h.goto('tricky.html');
  assert.match(await h.act({ op: 'click', ref: mustRef(t2, 'Settings') }), /page did NOT change/, 'a dead click still says so');
});

test('an SPA route change that lazy-loads a chunk and renders after a long task returns the NEW view', { skip }, async () => {
  const t = await h.goto('route.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Search') });
  mustRef(r, 'easyJet $55');
  assert.equal(ref(r, 'Old home card'), null, 'no stale rows from the previous view');
});

test('a link rendered UNDER its own row content (Google results) is clickable; under another control it is covered', { skip }, async () => {
  const t = await h.goto('rowlink.html');
  assert.doesNotMatch(t.split('\n').find((l) => l.includes('easyJet')), /covered/);
  assert.match(t.split('\n').find((l) => l.includes('Hidden deal')), /⊘ covered/);
  await h.act({ op: 'click', ref: mustRef(t, 'From 55 US dollars. Nonstop flight with easyJet.') });
  assert.equal(await out(), 'opened easyJet');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Hidden deal') });
  assert.match(r, /covered/);
  assert.equal(await out(), 'opened easyJet', 'the promo button was not clicked');
});

test('a menu that fades in (CSS transition) is listed in the click result, not missed mid-fade', { skip }, async () => {
  const t = await h.goto('fade.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Ticket type') });
  await h.act({ op: 'click', ref: mustRef(r, 'One way') });
  assert.equal(await out(), 'one way');
});

/* ------------------------------ found by the bug hunter ---------------------- */

test('hunter: a link that wraps across lines is not "covered" and clicks on its text', { skip }, async () => {
  const t = await h.goto('wrap.html');
  const line = t.split('\n').find((l) => l.includes('very long wrapped hyperlink text'));
  assert.doesNotMatch(line, /covered/, line);
  await h.act({ op: 'click', ref: line.split(/\s+/)[0] });
  assert.equal(await out(), 'wrapped link');
});

test('hunter: a menu that opens in a freshly loading iframe is in the click result', { skip }, async () => {
  const t = await h.goto('wrap.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Apps') });
  assert.match(r, /"Drive"/, r);
});

test('hunter: on a constantly-animating page, a panel with staggered entrance animations is in the click result', { skip }, async () => {
  const t = await h.goto('ambient.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Search site') });
  mustRef(r, 'Apple Vision Pro');
});

test('hunter: a list item scrolled under its panel\'s sticky header is "scrolled out" (↕), and clickable', { skip }, async () => {
  const t = await h.goto('ambient.html');
  const line = t.split('\n').find((l) => l.includes('"Sidebar item 1"'));
  assert.ok(line && /↕/.test(line) && !/covered/.test(line), line);
  await h.act({ op: 'click', ref: line.split(/\s+/)[0] });
  assert.equal(await h.js('document.title'), 'item 1');
});

test('hunter: web-component buttons (shadow control + slotted label) are named from the slot and not "covered"', { skip }, async () => {
  const t = await h.goto('wc.html');
  const login = t.split('\n').find((l) => l.includes('"Log in"'));
  const reset = t.split('\n').find((l) => l.includes('"Reset"'));
  assert.ok(login && !/covered/.test(login), t); assert.ok(reset && !/covered/.test(reset), t);
  await h.act({ op: 'click', ref: reset.split(/\s+/)[0] });
  assert.equal(await out(), 'reset clicked');
});

test('a follow-up alert raised right after an action is answered and reported, not left freezing the page', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Late alert') }); // alert fires 100ms after the click
  await new Promise((r) => setTimeout(r, 300));
  const o = await h.observe();
  assert.match(o, /dialog: alert "late" → accepted/, o.slice(0, 300));
});

test('a click is refused when an overlay appears at the moment of the click (hit-target interceptor)', { skip }, async () => {
  const t = await h.goto('tricky.html');
  // An overlay that appears on mousedown, over the target (e.g. a modal backdrop raised by a mousedown handler).
  await h.js(`document.getElementById('morph').addEventListener('pointerdown', () => { const d=document.createElement('div'); d.id='trap'; d.textContent='Trap'; d.style='position:fixed;inset:0;background:rgba(0,0,0,.2)'; d.onclick=()=>o('trap clicked'); document.body.append(d); }, { once: true })`);
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Archive') });
  assert.notEqual(await out(), 'trap clicked', 'the overlay must not receive the click');
  void r;
});

/* ----------------------- gaps found by reading jev-ultrafast ----------------- */

test('jev: on a page with CSS scroll-behavior:smooth, a far-below click still lands (instant scroll)', { skip }, async () => {
  const t = await h.goto('jevgaps.html');
  const f = await h.cmd('observe', { find: 'Far button' });
  await h.act({ op: 'click', ref: mustRef(f, 'Far button (smooth-scroll page)') });
  assert.equal(await out(), 'far clicked');
  void t;
});

test('jev: a recycled row (virtualized list) is refused instead of deleting the wrong item', { skip }, async () => {
  const t = await h.goto('jevgaps.html');
  const bob = t.split('\n').find((l) => l.includes('"Delete" in "Bob'));
  assert.ok(bob, t);
  await h.js('recycle()'); // the same <li>/<button> now shows Dave
  const r = await h.act({ op: 'click', ref: bob.split(/\s+/)[0] });
  assert.match(r, /row this control belongs to changed/);
  assert.notEqual(await out(), 'deleted Dave');
});

test('jev: values a field would reject are refused before typing', { skip }, async () => {
  const t = await h.goto('jevgaps.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Email', 'fill'), text: 'not an email' },
    { op: 'type', ref: mustRef(t, 'Guests', 'fill'), text: 'two' }, { op: 'type', ref: mustRef(t, 'Zip', 'fill'), text: '12a' });
  assert.match(r, /not a valid email/); assert.match(r, /not a valid number/); assert.match(r, /specific format \(5 digits\)/);
  assert.equal(await h.js(`[em.value, gu.value, zip.value].join('|')`), '||');
  const ok = await h.act({ op: 'type', ref: mustRef(t, 'Email', 'fill'), text: 'a@b.co' });
  assert.match(ok, /type e\d+/); assert.equal(await h.js('em.value'), 'a@b.co');
});

test('jev: a target=_blank link is followed into the new tab', { skip }, async () => {
  const t = await h.goto('jevgaps.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Open docs in new tab') });
  assert.match(r, /opened a NEW TAB/);
  mustRef(r, 'Slow page button');
});

test('jev: back and reload', { skip }, async () => {
  await h.goto('widgets.html');
  await h.goto('tricky.html');
  const r = await h.act({ op: 'back' });
  assert.match(r, /Widgets/);
  const r2 = await h.act({ op: 'reload' });
  assert.match(r2, /Widgets/);
});

/* --------------------------- speed: fewer, better-ordered rows --------------- */

test('speed: task content is listed before global header/nav chrome', { skip }, async () => {
  const t = await h.goto('speed.html');
  const rows = t.split('\n').filter((l) => /^e\d/.test(l));
  const taskIdx = rows.findIndex((l) => l.includes('"Do the task"'));
  const homeIdx = rows.findIndex((l) => l.includes('"Home"'));
  const signInIdx = rows.findIndex((l) => l.includes('"Sign in"'));
  assert.ok(taskIdx >= 0 && homeIdx >= 0 && signInIdx >= 0, t);
  assert.ok(taskIdx < homeIdx, 'main content should come before header nav links');
  assert.ok(taskIdx < signInIdx, 'main content should come before header sign-in button');
});

test('speed: a clickable cell wrapping its own checkbox is one row, not two', { skip }, async () => {
  const t = await h.goto('speed.html');
  const dayRows = t.split('\n').filter((l) => /Tuesday, October 20, 2026/.test(l));
  assert.equal(dayRows.length, 1, `expected exactly one row for the calendar day:\n${t}`);
  assert.match(dayRows[0], /click ·/, dayRows[0]); // kept the checkbox's own richer (checked) row
  await h.act({ op: 'click', ref: dayRows[0].split(/\s+/)[0] });
  assert.equal(await out(), 'checkbox true', 'clicking the merged row must toggle the real checkbox');
});

test('speed: repeated links to the exact same page collapse to one row; distinct pages stay separate', { skip }, async () => {
  const t = await h.goto('speed.html');
  const acme = t.split('\n').filter((l) => /^e\d/.test(l) && /photo clicked|title clicked|info clicked|"Acme Inn"|"Opens Acme Inn information"|\[photo\]/.test(l));
  assert.equal(acme.length, 1, `expected the 3 Acme Inn links to collapse to 1 row:\n${t}`);
  mustRef(t, 'Different Hotel'); // a link to a genuinely different page must survive
});

test('speed: same-page hash links (#1 vs #2) never collapse, even when the fragment number collides across widgets', { skip }, async () => {
  const t = await h.goto('ambient.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Search site') });
  const full = await h.observe();
  mustRef(full, 'AirPods'); mustRef(full, 'Find a Store'); mustRef(full, 'Apple Vision Pro');
  for (let i = 0; i <= 2; i++) mustRef(full, `Sidebar item ${i}`);
  void r;
});

/* --------------------------- speed: transparent ref recovery ---------------- */

test('speed: a ref whose id map got wiped (world/cache reset) recovers in one call, not an extra round trip', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const ref = mustRef(t, 'Name', 'fill');
  // Simulate the page-side ref map losing its entries entirely while the DOM node itself is unchanged
  // (a fresh isolated-world snapshot, or any cache reset) — the underlying element is still there.
  await h.js(`0`); // no-op to ensure the isolated world is settled before we poke it
  await h.ev(`window.__pawbrowse.byId = {}`);
  const r = await h.act({ op: 'type', ref, text: 'Ada' });
  assert.doesNotMatch(r, /unknown ref/, r);
  assert.match(r, /type e\d+/, r);
  assert.equal(await h.js(`document.getElementById('nolabel').value`), 'Ada');
});
