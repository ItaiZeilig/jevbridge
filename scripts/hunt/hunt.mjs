// Bug hunter: point the shipped PawBrowse engine at real sites and let ORACLES — checks that need
// no knowledge of the page — flag anything suspicious. Hand-written fixtures only test what we
// already imagined; this is how the Google Flights surprises should have been caught.
//
//   node scripts/hunt/hunt.mjs [out-dir] [url ...]        (headless Chrome; never your browser)
//
// Oracles:
//   recall   Chrome's own accessibility tree lists a visible, named, interactive control that our
//            element table does not have (a perception miss).
//   covered  we flag a row "⊘ covered", but Chrome's hit-test finds plain content of the same card
//            there — not a dialog, fixed/sticky layer, or another control (likely false positive).
//   stale    after a safe action (open a menu/tab/accordion), the table 2s later differs from what
//            the action returned by far more than the page's own background churn (settled too early).
//   refused  a safe action on a row we listed failed (covered / not visible / changed…).
// Safe actions only: expanding collapsed menus/accordions/comboboxes and selecting tabs. Nothing is
// submitted, typed or bought.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../../test/e2e/harness.mjs';

const DEFAULT_SITES = [
  // widget-heavy component libraries: menus, selects, comboboxes, dialogs, tabs, date pickers
  'https://ui.shadcn.com/docs/components/select',
  'https://ui.shadcn.com/docs/components/combobox',
  'https://ui.shadcn.com/docs/components/dropdown-menu',
  'https://ui.shadcn.com/docs/components/tabs',
  'https://ui.shadcn.com/docs/components/accordion',
  'https://www.radix-ui.com/primitives/docs/components/navigation-menu',
  'https://mui.com/material-ui/react-select/',
  'https://mui.com/material-ui/react-autocomplete/',
  'https://headlessui.com/react/listbox',
  'https://headlessui.com/react/menu',
  'https://react-spectrum.adobe.com/react-aria/Select.html',
  'https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/examples/menu-button-links/',
  'https://www.w3.org/WAI/ARIA/apg/patterns/tabs/examples/tabs-automatic/',
  // big real sites
  'https://www.google.com/travel/flights?hl=en&gl=US&curr=USD',
  'https://github.com/microsoft/vscode',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://news.ycombinator.com/',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select',
  'https://stackoverflow.com/questions',
  'https://www.npmjs.com/package/react',
  'https://www.bbc.com/news',
  'https://www.apple.com/iphone/',
  'https://vercel.com/',
  'https://stripe.com/docs/payments/quickstart',
  'https://www.gov.uk/',
];

const outDir = path.resolve(process.argv[2] || `hunt-${Date.now()}`);
const sites = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_SITES;
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} timed out`); })]);

const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'treeitem']);
const rowsOf = (t) => String(t).split('\n').filter((l) => /^(f\d+\.)?e\d/.test(l));
const bodyOf = (l) => l.replace(/^(f\d+\.)?e\d+(_\d+)?\s+/, '').replace(/\s+/g, ' ').replace(/\s+(↑ above view|↓ below view|↕ scrolled out of its box)$/, '');
const diffRows = (a, b) => { const A = new Set(rowsOf(a).map(bodyOf)); return rowsOf(b).map(bodyOf).filter((x) => !A.has(x)); };

// recall: visible, named, interactive AX nodes (main frame) that no table row accounts for.
async function recallOracle(h) {
  const { nodes } = await h.cdp('Accessibility.getFullAXTree', {});
  const cands = nodes.filter((n) => !n.ignored && n.backendDOMNodeId && INTERACTIVE.has(n.role && n.role.value) && n.name && String(n.name.value || '').trim()).slice(0, 400);
  // Tag candidates in the page (test-only attribute), then check them from PawBrowse's own world.
  let k = 0;
  for (const n of cands) {
    try {
      const { object } = await h.cdp('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
      await h.cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(){ this.setAttribute('data-paw-ax','${k}'); }` });
      n._k = k++;
    } catch {}
  }
  const res = await h.ev(`(function(){
    var c=window.__pawbrowse, listed=new Set();
    Object.keys(c.byId||{}).forEach(function(id){ var e=c.nodes.get(c.byId[id]); if(e){ listed.add(e); var s=c.surface&&c.surface(e); if(s) listed.add(s); } });
    var miss=[];
    document.querySelectorAll('[data-paw-ax]').forEach(function(el){
      var k=el.getAttribute('data-paw-ax'); el.removeAttribute('data-paw-ax');
      var r=el.getBoundingClientRect(); if(r.width<4||r.height<4) return;
      var cx=r.x+r.width/2, cy=r.y+r.height/2; if(cx<0||cy<0||cx>=innerWidth||cy>=innerHeight) return;
      if(!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return;
      // clipped away by an overflow:hidden/auto ancestor (truncated text, collapsed panel): not visible
      for(var o=el.parentElement; o && o!==document.body; o=o.parentElement){ var ocs=getComputedStyle(o); if(ocs.overflowX!=='visible'||ocs.overflowY!=='visible'){ var q=o.getBoundingClientRect(); if(cx<q.left||cx>q.right||cy<q.top||cy>q.bottom) return; } }
      if(el.closest('[aria-hidden="true"],[inert]')||el.matches(':disabled')||el.closest('[aria-disabled="true"]')) return;
      // accounted for if it, an ancestor (3 levels) or a descendant is a listed element
      for(var a=el,g=0; a&&g<4; a=a.parentElement,g++) if(listed.has(a)) return;
      var hit=false; listed.forEach(function(x){ if(!hit && el.contains(x)) hit=true; }); if(hit) return;
      // Not present by node identity -- but if this is a link and a NEARBY listed element resolves
      // to the exact same href, the product intentionally merged them (two labels, one destination,
      // e.g. HN's "7 hours ago" / "197 comments"): that is a deliberate simplification, not a miss.
      if(el.tagName==='A' && el.getAttribute('href')){
        // Compare CENTER points, matching how the product itself measures "close enough to merge" —
        // a wide title link's own left edge can be 300+px from a short trailing fragment's edge even
        // though their centers (what the product actually compares) are well within its threshold.
        var sameHref=false, er=el.getBoundingClientRect(), ecx=er.x+er.width/2, ecy=er.y+er.height/2;
        listed.forEach(function(x){
          if(sameHref || x.tagName!=='A' || x.href!==el.href) return;
          var xr=x.getBoundingClientRect(), xcx=xr.x+xr.width/2, xcy=xr.y+xr.height/2;
          if(Math.abs(xcx-ecx)<=260 && Math.abs(xcy-ecy)<=260) sameHref=true;
        });
        if(sameHref) return;
      }
      miss.push({k:+k, tag:el.tagName, html:el.outerHTML.slice(0,160)});
    });
    return miss;
  })()`);
  return res.map((m) => { const n = cands.find((c) => c._k === m.k); return { role: n && n.role.value, name: n && String(n.name.value).slice(0, 80), tag: m.tag, html: m.html }; });
}

// covered: rows we call covered where Chrome's hit-test shows same-card plain content.
async function coveredOracle(h, snap) {
  const out = [];
  for (const a of snap.actions.filter((x) => x.covered).slice(0, 15)) {
    try {
      const { backendNodeId } = await h.cdp('DOM.getNodeForLocation', { x: a.x, y: a.y, includeUserAgentShadowDOM: false });
      const { object } = await h.cdp('DOM.resolveNode', { backendNodeId });
      const r = await h.cdp('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){
        var el=this.nodeType===1?this:this.parentElement, layer=null;
        for(var p=el; p && p!==document.body; p=p.parentElement){ var cs=getComputedStyle(p);
          if(p.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')||cs.position==='fixed'||cs.position==='sticky'){ layer=p.tagName+'.'+String(p.className).slice(0,30); break; } }
        var ctl=el.closest('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option]');
        return {top:el.tagName+'.'+String(el.className).slice(0,30), text:(el.innerText||'').trim().slice(0,40), layer:layer, control:ctl?ctl.tagName+' '+(ctl.getAttribute('aria-label')||ctl.innerText||'').trim().slice(0,30):null};
      }` });
      const v = r.result.value;
      if (!v.layer && !v.control) out.push({ row: `${a.id} "${a.label.slice(0, 60)}"`, under: v });
    } catch {}
  }
  return out;
}

async function stalenessOracle(h, url, snap) {
  const findings = [];
  // Safe targets: collapsed expandables and unselected tabs, in view, not covered.
  const cands = snap.actions.filter((a) => !a.off && !a.covered && a.kind === 'click' && (a.expanded === false || (a.role === 'tab' && a.selected === false))).slice(0, 3);
  for (const a of cands) {
    try {
      const b0 = await h.observe(); await sleep(1500); const b1 = await h.observe();
      const churn = diffRows(b0, b1).length; // the page's own background change rate
      // Re-resolve THIS trial's target from a fresh snapshot before acting: an earlier trial in this
      // same loop may have re-rendered the page (without a full navigation) and shifted ref numbers,
      // which would make a.id a stale ref from a since-superseded observation — a hunter-loop replay
      // artifact, not a product bug. Only fall back to the original id when no fresh match exists.
      const freshNow = await h.snap();
      const rematch = freshNow.actions.find((x) => x.label === a.label && x.role === a.role);
      if (!rematch) continue; // an earlier trial's action legitimately removed this control from the page: nothing to test
      const useId = rematch.id;
      if (process.env.HUNT_DEBUG) console.log('DBG before act', useId, await h.ev(`JSON.stringify([!!(window.__pawbrowse.byId||{})[${JSON.stringify(useId)}], Object.keys(window.__pawbrowse.byId||{}).slice(0,5), location.href])`));
      const res = await within(h.act({ op: 'click', ref: useId }), 30000, 'act');
      const line = res.split('\n')[1] || '';
      if (/: (element|unknown|not visible|field)|covered|changed since|off-screen/.test(line)) findings.push({ oracle: 'refused', row: `${useId} "${a.label.slice(0, 60)}"`, detail: line.trim() });
      const now = await h.observe(); await sleep(2000); const late = await h.observe();
      const appeared = diffRows(now, late);
      if (appeared.length > Math.max(5, churn * 2 + 3)) findings.push({ oracle: 'stale', row: `${useId} "${a.label.slice(0, 60)}"`, detail: `${appeared.length} rows appeared within 2s after act returned (background churn ${churn})`, sample: appeared.slice(0, 5) });
      await h.act({ op: 'key', key: 'Escape' }).catch(() => {});
      if ((await h.js('location.href')) !== url) {
        // A reset reload is a NEW document: old refs are rightly refused, so re-find the rest by label.
        await h.goto(url); await sleep(500); await h.observe();
        const fresh = await h.snap();
        for (const c of cands) { const m = fresh.actions.find((x) => x.label === c.label && x.role === c.role); if (m) c.id = m.id; }
      }
    } catch (e) { findings.push({ oracle: 'error', row: a.id, detail: String(e.message || e).slice(0, 160) }); }
  }
  return findings;
}

const report = [];
const h = await launch();
try {
  for (let url of sites) {
    const entry = { url, findings: [] };
    const t0 = Date.now();
    try {
      await within(h.goto(url), 45000, 'navigate');
      await sleep(2200); // async-loaded widgets (commit lists, embedded tools) need real time to settle
      url = await h.js('location.href'); // where the site actually settled (redirects)
      await h.observe();
      const snap = await h.snap();
      entry.controls = snap.actions.length;
      for (const m of await within(recallOracle(h), 30000, 'recall')) entry.findings.push({ oracle: 'recall', row: `${m.role} "${m.name}"`, detail: m.html });
      for (const c of await within(coveredOracle(h, snap), 30000, 'covered')) entry.findings.push({ oracle: 'covered', row: c.row, detail: `under: ${c.under.top} "${c.under.text}"` });
      entry.findings.push(...await within(stalenessOracle(h, url, snap), 120000, 'staleness'));
    } catch (e) { entry.findings.push({ oracle: 'error', detail: String(e.message || e).slice(0, 200) }); }
    entry.ms = Date.now() - t0;
    report.push(entry);
    const n = (o) => entry.findings.filter((f) => f.oracle === o).length;
    console.log(`${url.replace(/^https:\/\/(www\.)?/, '').slice(0, 60).padEnd(60)} controls=${String(entry.controls ?? '-').padStart(3)} recall=${n('recall')} covered=${n('covered')} stale=${n('stale')} refused=${n('refused')} error=${n('error')}`);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  }
} finally { await h.close(); }

// Summary (markdown, also for the GitHub job summary) and exit code: any oracle finding fails the
// run so it gets noticed; sites that couldn't be reached (network, bot walls) are listed, not failed.
// Verified true positives (each with a reason) don't fail the run; anything new does.
const known = JSON.parse(fs.readFileSync(new URL('./known.json', import.meta.url), 'utf8'));
const isKnown = (url, f) => known.some((k) => url.includes(k.site) && f.oracle === k.oracle && String(f.row || '').includes(k.row));
const real = report.flatMap((e) => e.findings.filter((f) => f.oracle !== 'error' && !isKnown(e.url, f)).map((f) => ({ url: e.url, ...f })));
const baselined = report.reduce((n, e) => n + e.findings.filter((f) => isKnown(e.url, f)).length, 0);
const unreachable = report.filter((e) => e.findings.some((f) => f.oracle === 'error'));
const md = [`## PawBrowse bug hunt — ${report.length} sites, ${real.length} new finding(s)${baselined ? ` (${baselined} known, see scripts/hunt/known.json)` : ''}`, ''];
if (real.length) {
  md.push('| site | oracle | row | detail |', '|---|---|---|---|');
  for (const f of real) md.push(`| ${f.url.replace(/^https:\/\//, '').slice(0, 50)} | ${f.oracle} | ${String(f.row || '').replace(/\|/g, '/').slice(0, 60)} | ${String(f.detail || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 120)} |`);
} else md.push('No findings: every oracle is quiet on every reachable site.');
if (unreachable.length) md.push('', `Unreachable or errored (not counted): ${unreachable.map((e) => e.url).join(', ')}`);
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n') + '\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
console.log(`\n${real.length} finding(s); report: ${path.join(outDir, 'report.json')}`);
process.exitCode = real.length ? 1 : 0;
