# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.3] - 2026-09-27

### Changed — fewer, richer rows per observation (fewer round trips)
- **Duplicate rows collapsed.** An outer clickable cell wrapping its own checkbox/radio/link (a
  calendar day, a selectable list row) is now one row, not two — same label, ancestor relationship,
  and close position (tolerant of border/padding) keep the richer or innermost element.
- **Repeated links to the same destination merge** within a card or row (a hotel card's photo,
  title, and "Opens X info" overlay). Only links that are visually close AND point at the identical
  URL merge — a page's own navbar shortcut and a hero button that happen to share a destination stay
  separate. When merged labels differ, they're **combined**, never silently dropped, so no
  information is lost (e.g. Hacker News's "7 hours ago" and "197 comments" both survive).
- **Off-screen row cap trimmed from 25 to 12** by default; `find:"..."` still searches the whole page.
- **Site chrome demoted, not hidden.** Links inside `nav`/`role="navigation"` sink to the end of the
  visible rows so task content comes first — a bare `<header>` no longer counts, since real sites
  also use it for hero sections with genuine call-to-action buttons.

### Fixed
- A ref the page-side cache no longer recognises (a reset, or a transient re-render race right after
  a prior action) now gets up to two free, transparent retries via a fresh snapshot before being
  reported as gone — zero cost when the ref resolves fine, and it never hides a genuinely removed
  element.

### Testing
- Re-ran the real-site hunter after every change and fixed what it found, converging from 71 new
  findings down to 0 across 25 sites (3 stable runs). Along the way this also fixed several bugs in
  the hunter itself (async-widget timing, an oracle unaware of intentional merges, a staleness test
  that reused stale refs across its own trial loop).
- 7 new e2e tests (each verified to fail on the pre-fix code), 103 e2e + 28 unit + 17 UI Testing
  Playground checks green, all run twice for stability. The fast path is unchanged (a dead click is
  still ~34ms).

## [0.6.2] - 2026-09-26

### Fixed — clicks and results on real sites
Found by recording a live Google Flights demo, a new real-site bug hunter, UI Testing Playground,
and by reading Playwright's and jev-ultrafast's source.
- **Stale results after in-page navigations.** A click that switched views without reloading
  (Google Flights' Search) returned the previous view's controls. Waits now follow lazy-loaded
  scripts, main-thread long tasks and route transitions.
- **Google result rows were unclickable.** They were flagged as covered by their own visible
  content.
- **Menus that fade in, panels with entrance animations** (including on pages that animate
  constantly) and **menus inside freshly loading iframes** were missing from the result.
- **Links that wrap across lines** were reported as covered and clicked between the lines.
- **Web-component buttons** (Lit, MDN, Shoelace…) were nameless and reported as covered; their
  label is slotted in from outside.
- **Clicks could miss or hit the wrong element.** Mouse input is now sent pipelined like
  Playwright's, which fixes Google's date-picker "Done". Moving targets are awaited. A click-time
  check stops a click that would land on anything else. Scrolls are instant even on
  `scroll-behavior: smooth` sites. Clicks no longer scroll a target that is already visible.
- **Recycled list rows** (virtualized lists) are refused instead of acting on the wrong item.
- **Dialogs:** answers go through the root session; a follow-up dialog raised right after an action
  is answered and reported instead of freezing the tab.
- Controls hidden under a sticky header are marked `↕` (reachable), not `⊘ covered`.

### Added
- New tabs opened by an action (`target=_blank`, `window.open`) are followed.
- `back`, `forward` and `reload` ops.
- JS-only links (`<a>` with inline handlers) are recognised as controls.
- Values a field would reject (email/number/url/pattern) are refused before typing.

### Security
- Uploads only accept files under the working directory, temp, Downloads or Desktop (override
  with `PAWBROWSE_UPLOAD_ROOTS`). Hidden files (`~/.ssh`, `.env`…) are always refused.

### Testing
- `scripts/hunt/hunt.mjs` is a real-site bug hunter with checks that need no knowledge of the
  page: recall against Chrome's accessibility tree, false "covered", stale results, refused
  actions.
- `scripts/hunt/playground.mjs` runs 17 live checks on UI Testing Playground.
- Both run nightly (`.github/workflows/hunt.yml`).
- README demo: a real 1× Google Flights run (`scripts/demo/`).
- 98 e2e and 28 unit tests.

## [0.6.1] - 2026-09-26

### Fixed
Found by driving 0.6.0 through the real extension in Chrome:
- **A rich-text editor (contenteditable) took its own text as its label.** After typing into
  one, its label changed and the next action on the same ref was refused. An editor's text is now
  only its value.
- **"page did NOT change" was reported when an action's only effect was page text or a dialog**
  (e.g. a result message, or an answered prompt), which nudges an agent into retries. Change
  detection now covers page text and dialogs.

## [0.6.0] - 2026-09-25

### Added — perception v2 (sees and drives far more real-world HTML)
Ported and extended the unmerged `planner-state-final` snapshot work from browser-use/jev-ultrafast.
- **Styled checkboxes, radios, switches and file pickers** whose native input is hidden (opacity 0,
  0×0, `display:none`, sr-only) are now listed and clicked through their visible label/card.
- **Date, time, datetime-local, month, week, color and range inputs** are fillable: `type` sets the
  value the way a picker does (native setter + input/change) and rows show the expected `fmt{…}`.
  Invalid values are rejected with a clear error; clamped ranges report the real value.
- **File upload**: `{op:"upload", ref, paths:[…]}` (needs "Allow access to file URLs" for the
  extension).
- **Off-screen controls** within about a viewport are listed with `↑`/`↓`/`↕` (acting scrolls them in),
  and the ones nearest the visible area are kept. Covered controls are flagged `⊘ covered`.
  Further-away ones are counted.
- **Repeated labels are disambiguated** with their row (`"Delete" in "Invoice #1002 — Globex"`).
- Unlabelled fields use a nearby `<label>`; contenteditable editors use their placeholder; required
  and invalid fields are marked. Focus is reported, and so are cross-origin frames the table can't
  see into.
- `read` now includes open shadow-DOM, slotted and same-origin iframe text.
- `{op:"scroll", ref}` scrolls the panel that contains that control, not the page.

### Added — reach every kind of page
- **Cross-origin iframes.** Embedded checkouts, logins and widgets are read and driven: cross-site
  frames are attached as child sessions (`chrome.debugger` `sessionId`, Chrome 125+), and
  cross-origin same-site and sandboxed frames get their own isolated world. Refs look like
  `f2.e5`, clicks are offset by the frame's position, dialogs raised inside frames are answered,
  and `read` includes frame text. Invisible ad and tracking frames are skipped without cost.
- **Closed shadow roots**, including a closed root nested inside another, via CDP
  (`DOM.describeNode` with pierce).
- **WebMCP.** Tools a page registers (`navigator.modelContext.registerTool` or
  `<form toolname>`) are listed at the top of the table with typed signatures, and
  `{op:"tool"}` calls one. Output is marked as untrusted.
- **`browser_screenshot`** returns a JPEG in CSS pixels with the table's refs drawn on it.
  `{op:"click_xy"}` then clicks by image coordinates, for canvas apps (Docs/Sheets, Figma,
  maps) and anything else the table can't express.
- **More ways to act:** `hover`; `drag` (pointer widgets, and native HTML5 drag-and-drop via
  `Input.setInterceptDrags`), with the target given by ref, text or offset; any key or chord
  (`Shift+Tab`, `Mod+A`, F-keys, single characters); double-click and right-click;
  `select values:[…]` for `<select multiple>`. Draggable elements are marked `⇄`.
- **`observe find:"…"`** searches every control on the page and returns only the matches.
  **`text:true`** adds the visible text in reading order.
- Nameless icon buttons are labelled `icon:trash` or `testid:share-button` instead of `"button"`.

### Changed — faster and cheaper
- **Waits follow what the page is actually doing:** navigation (commit-aware), fetch/XHR started
  by the action (including chained requests), then a short DOM-quiet window, all with caps. The
  table after a click that fetches is no longer stale; a debounced search returns its results;
  `navigate` to a fast page drops from ~380ms to ~100ms; a click that does nothing returns in
  ~30ms. Analytics beacons, polling and constantly-animating pages no longer hold a wait until
  its cap.
- **The Network domain is only on while an action is being watched.** Left on during an ad-heavy
  page load, it slowed the whole browser: a navigation after w3schools took 17–30s. Page loads now
  wait on lifecycle events tied to the new document's loader (DOMContentLoaded, then
  `networkAlmostIdle`), and the wait ends early once the page is complete and quiet. w3schools
  now loads in ~2s, versus ~22s on the previous release.
- **Delta results.** When `act` leaves the page mostly unchanged, it returns only the new or
  changed rows plus the refs that are gone, e.g. 2 rows instead of 60. `observe` always returns
  the full table.
- **Refs survive re-renders that replace nodes**, both within a batch and across observations.
  A new element takes over a vanished element's ref only when role, label and row context match
  one element exactly.

### Fixed
- **Pages could blind PawBrowse.** All page-side code now runs in a CDP isolated world, so a site
  that patches `Array.prototype`/`JSON`/`Element.prototype` or defines `window.__pawbrowse` no longer
  yields an empty table.
- **`alert()`/`confirm()`/`prompt()` froze the tab.** Dialogs raised by an action are now answered
  and reported: alerts are accepted; confirm, prompt and beforeunload are dismissed unless the op
  passes `dialog:"accept"`. A dialog left open by the user produces a clear error, and
  `{op:"dialog"}` answers it.
- **A stale ref could click a different element after navigation.** Ref numbers no longer restart
  on a new document, so an old ref fails with "unknown ref".
- `display:none` text no longer leaks into labels. `display:contents` wrappers and `<slot>`s no
  longer hide their content.
- Scrolls, popovers and other visible changes no longer report "page did NOT change".
- A submit button's value is no longer echoed as its current value.

### Tests
- New real-browser e2e suite (`npm run test:e2e`, also in CI): it loads the shipped `background.js`
  against headless Chrome through a `chrome.debugger` shim and checks adversarial scenarios
  against ground truth read from the page (now 75 scenarios). The previous code passes 14 of them
  and hangs on the dialog cases.
- Opt-in suite driving the real unpacked extension in Chrome for Testing through the real MCP
  server (`CFT_PATH=… npm run test:e2e`).

## [0.5.1] - 2026-09-23

### Fixed
- **Custom/framework buttons are no longer invisible to the element table.** Apps built with
  React-Native-Web (and many design systems) render buttons as role-less `<div>`s that only carry
  `cursor: pointer` and/or `tabindex="0"` — so a submit/confirm button could be on screen yet
  absent from the observed controls. Perception now also enumerates these interactive elements:
  any `[contenteditable]`, an inline `onclick`, a keyboard-focusable `[tabindex]`, and elements
  whose computed `cursor` is `pointer` (captured at the root of each pointer region so we get the
  pressable, not its inherited-cursor text children). Guarded against noise: a candidate must have
  an accessible name and must not merely wrap another real control; the pointer scan is bounded so
  large pages stay fast. Also broadened the ARIA-role set (adds `slider`, `treeitem`,
  `menuitemcheckbox`) and fixed `contenteditable` matching (`""`/`plaintext-only`, not just
  `"true"`). Found via a real driver app whose "אשר" (confirm) and "manual entry" buttons were
  role-less `<div tabindex="0">` pressables; verified live that they now surface as clickable refs.

## [0.5.0] - 2026-09-22

### Added — multiple concurrent sessions (broker + per-session tab groups)

You can now run **as many editor/agent sessions as you want at the same time**, with zero
configuration and no "port already in use." This replaces the old single-owner bridge (where a
second Claude/Cursor/VS Code session was locked out until the first one closed).

- **Shared broker process.** The first session spawns a small broker that owns the bridge port
  (`127.0.0.1:10577`) and the single Chrome-extension connection. Every other session connects to
  the broker over a local IPC socket (unix socket / Windows named pipe) instead of binding the port
  itself, so sessions never contend for it. The broker multiplexes all sessions over the one
  extension connection, routing each session's commands independently.
- **A tab group per session.** Each session drives its **own tab group** — named `🐾 PawBrowse`
  (numbered for the 2nd+), each with its own color — and only its own tab, so concurrent sessions
  can't fight over a tab. The group name/color is deliberately distinct from Claude-in-Chrome's, so
  the two never interfere.
- **Automatic cleanup ("kill zombies").** Closing a session tells the broker to close the tabs that
  session created and ungroup any it borrowed; the broker reaps itself once the last session ends.
  A crashed/dead broker is detected and re-spawned on the next command — no stale process holding
  the port, nothing to kill by hand.
- The MCP server (`mcp/server.mjs`) is now a thin per-session controller; the broker lives in
  `mcp/broker.mjs`. The extension now attaches per-tab (many tabs at once) and serializes commands
  **per session** so different sessions run in parallel.

### Security
- The controller IPC socket is created owner-only (`0600`) on unix.

### Tests
- Suite updated for the new architecture (23 cases, still zero-dependency): multi-session routing
  and isolation (two sessions share one broker, each routed to its own session id), session-id
  tagging, `__session_end` cleanup on disconnect, plus all prior MCP-protocol and raw-WS hardening
  cases carried over to the broker.

## [0.4.0] - 2026-09-22

### Added
- **Shadow DOM traversal.** The element table now enumerates controls inside **open shadow roots**
  (web components), and they're clickable/typable by ref — sites built on custom elements
  (YouTube-style, many enterprise apps) are no longer invisible. Accessible-name resolution and
  hit-testing are shadow-aware (name resolves `aria-labelledby` within the element's root;
  occlusion is checked with the element's own `getRootNode().elementFromPoint`).
- **Same-origin iframe traversal.** Controls inside same-origin iframes are enumerated, with their
  rects translated into top-level viewport coordinates (accumulated across nested frames) so clicks
  and typing land correctly. Cross-origin iframes remain inaccessible (browser-enforced).

Verified live: shadow-DOM input + button and a same-origin iframe button were perceived, typed into,
and clicked on a controlled test page; light-DOM perception unchanged (no regression).

## [0.3.4] - 2026-09-22

Release-readiness hardening from a three-part production review (extension, MCP server, packaging).

### Fixed
- **Timed-out commands can no longer leak and race the next one.** A large `act` batch that hit
  the 25s bound used to keep running after the queue advanced, issuing CDP against the tab
  concurrently with the following command (and risking double execution on agent retry). Commands
  now carry a cancellation token; `act`/`navigate` stop issuing further ops once it fires.
- **In-flight tool calls no longer hang for the full timeout when the extension disconnects.** The
  MCP server now rejects all pending requests immediately when the extension socket closes or is
  replaced, instead of waiting out `CMD_TIMEOUT_MS`.
- **Port-in-use no longer kills the MCP server.** If another PawBrowse instance already owns the
  bridge port, the stdio server stays up and reports a clear reason via `browser_status` /tool
  errors, rather than the client showing "server failed / all tools unavailable".
- **An explicitly-passed `tabId` is now validated** against restricted pages (`chrome://`,
  `devtools://`, the Chrome Web Store, …), same as the active-tab path; `navigate` only accepts
  http(s) URLs (bare domains are prefixed with `https://`), refusing `javascript:`/`chrome:` targets.
- **A throw in the page-text walker or id-building no longer blanks the element table** — those
  steps are wrapped so the already-computed controls are still returned.
- **Options "Save & reconnect" now actually reconnects** on a port change (previously it kept the
  old socket until it happened to drop).
- **Clearing a field works** (`type` with empty text now sends Backspace after select-all instead
  of a no-op `insertText('')`).
- WebSocket bridge hardening: reject malformed/oversized control frames, cap reassembled
  fragmented messages, validate `PAWBROWSE_PORT`/`PAWBROWSE_TIMEOUT_MS` (bad values fall back to
  defaults), return `-32602` for a malformed `tools/call`, and add last-resort
  `uncaughtException`/`unhandledRejection` guards so a stray throw can't drop the bridge.

### Tests
- Replaced the single round-trip script with a **21-case adversarial suite** (`node --test`, still
  zero-dependency): MCP protocol (initialize/tools/list/annotations/ping/`-32601`/`-32602`/unknown
  tool/notifications), no-extension errors, round-trip + error propagation + out-of-order id
  correlation, and regressions for every fix above (disconnect fast-fail, last-wins takeover,
  port-in-use stays alive, bad env vars) — plus raw-socket attacks (web-origin rejection, oversized
  frame, malformed control frame, non-JSON garbage) and stdin-close shutdown.

### Known limitations (documented, not yet supported)
- Controls inside **shadow DOM** and **same-origin iframes** are not yet enumerated; the bridge
  trusts any **local process** on `127.0.0.1` (no shared token yet). See the README.

## [0.3.3] - 2026-09-22

Follow-ups from live testing + grounding the approach in the CDP/MV3 docs (rather than guessing).

### Added
- `Emulation.setFocusEmulationEnabled` on attach, so a background tab keeps focus/blur,
  rendering, and focus-dependent menus/dropdowns behaving while driving (the same approach
  Playwright uses). Note: a hidden tab still throttles `requestAnimationFrame`, so all waits
  use `setTimeout`/`setInterval`, never rAF.

### Fixed
- **A single hung command can no longer wedge the whole extension**: each queued command is
  bounded (25s) so the serialized queue always advances, even if the underlying work stalls.
- **Extension reload always reconnects**: the bridge now accepts the newest connection and
  drops the previous one (last-wins), instead of rejecting a second connection while an old
  socket lingers (which could lock the reloaded extension out). Only the current socket is
  trusted for replies; the origin check still blocks web pages.

## [0.3.2] - 2026-09-22

### Fixed
- **Actions no longer hang when driving a background tab** (the normal case). The
  combobox-suggestion wait used `requestAnimationFrame`, which Chrome pauses in background
  tabs, and had no `setTimeout` fallback — so `browser_act` could hang until the 30s command
  timeout. It now polls with `setInterval` + a hard `setTimeout` cap, which fire in background
  tabs. Found by live testing.

## [0.3.1] - 2026-09-22

Hardening from a second multi-agent review (bug-hunt on the v0.3.0 code itself).

### Fixed
- **Perception never blanks a whole page**: the in-page snapshot now wraps each element and the
  outer pass in try/catch, so one quirky element (throwing getter, overridden DOM method) can no
  longer abort the entire observation.
- **Stable element refs**: displayed ids derive from the stable node identity (`e<node>`), so a
  reused number can never silently retarget a different control across observations.
- **Semantic guard narrowed to role + accessible name**, removing false "element changed"
  positives on benign value/state churn and same-element multi-op batches (still catches relabels).
- **Options page status** no longer opens a competing socket (which the single-connection guard
  rejected, inverting the readout); it now asks the background worker for live status.
- `type` rejects a de-editable contenteditable; checkbox/radio no longer show a cosmetic `"on"`;
  `click_text` pre-filters by text to avoid layout thrash on large pages.

### Changed
- Commands are **serialized** in the extension so overlapping tool calls can't race the shared
  debugger session.
- Bridge `LIVE_MS` lowered 30s→15s (faster reconnect after an unclean disconnect); keepalive
  alarm set to 0.5 min (avoids Chrome's sub-30s clamp warning).

## [0.3.0] - 2026-09-22

Renamed **JevBridge → PawBrowse**, plus a second, deeper multi-agent audit that closes the
remaining correctness, robustness, and hardening gaps.

### Added
- **Semantic freshness guard**: an element's meaning (role/name/value/checked/selected/expanded)
  is fingerprinted at observe time and re-checked before acting, so a silently relabeled or
  changed target is rejected with "observe again" instead of mis-clicked.
- **`aria-expanded` / `aria-selected`** surfaced in the table (▾/▸ open/closed, ◉ selected) so
  the agent can tell an open menu / active tab from a closed one.
- **Combobox "Open" companion action** and a **targeted autocomplete wait** (polls for visible
  `[role=option]` after typing, instead of a fixed delay).

### Changed
- **Change-detection now includes per-input value/checked/selectedIndex**, fixing false
  "page did NOT change" after a successful fill/toggle/select (password values excluded).
- **Scroll uses a real wheel event** so overflow containers, virtualized lists, and infinite
  scroll fire.
- SELECT: raised option cap (15→40) and excludes `optgroup[disabled]`.

### Fixed
- **No more double-execution**: if the post-action observation fails (page navigating), ops are
  reported as executed with "call observe next," instead of throwing so the caller retries them.
- **`type` re-checks read-only at action time**; `select` runs the full live guard and returns a
  navigation-safe message if its change handler destroyed the context.
- **`click_text` now hit-tests** (elementFromPoint containment) so it can't hit a covered element.

### Security
- The bridge **rejects a second WebSocket while a live extension is attached** and **only trusts
  the current socket's replies**, closing the local takeover/forgery vector (a stale socket still
  ages out so a normal reload reconnects). Inbound frames are **size-capped** (8 MB) and
  `browser_act` caps ops per call (50).

### Docs
- Operational guidance baked into tool descriptions (WAIT discipline, "a matching result doesn't
  prove a filter applied," "a matching link isn't success — click through and assert," don't
  re-type an already-correct field).

## [0.2.0] - 2026-09-22

Perception + reliability overhaul, adapting techniques from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT).

### Added
- Proper **accessible-name resolution** (aria-labelledby → aria-label → `<label>` → alt →
  text → title) for far better element labels.
- Native **`checkVisibility`** filtering plus `aria-hidden`/`inert` exclusion.
- **Viewport-center filtering** — only currently-visible, hit-testable controls are listed.
- **Hit-testing before every click** (`elementFromPoint` containment) and **geometry
  re-resolved at action time**, so moving or covered targets never mis-click.
- Robust **fill** via select-all + `insertText` (works with React/controlled inputs).
- **Page-changed signal** on `browser_act` results (a "no change" hint when an action had
  no effect), and **observe retry** through page transitions.
- `select` matches by value/label/text and only among enabled options.
- Operational guidance + an untrusted-page-data warning baked into the tool descriptions.

### Security
- `password`, `file`, and `hidden` inputs are excluded and their values are never exposed.
- The local bridge now **rejects WebSocket connections from web-page origins** (only
  `chrome-extension://` or origin-less local tooling may connect), so a malicious page can't
  open `ws://127.0.0.1` and impersonate the extension.

## [0.1.2] - 2026-09-21

### Added
- `click_text` op for `browser_act`: clicks the most specific visible element matching a
  string, for custom widgets/menus (dropdowns, flair pickers) that aren't standard controls
  and so can't be referenced from the element table.

## [0.1.1] - 2026-09-21

### Added
- `browser_read` tool: returns a tab's readable text (prose/articles), for pages where the
  element table isn't enough.

### Changed
- Removed the `<all_urls>` host permission — `chrome.debugger` does not require it for regular
  tabs, which avoids the Chrome Web Store "broad host permissions" review delay.

### Fixed
- MCP server exits when the client closes the stdio pipe and fails loudly on a busy port, so
  it can no longer linger as a zombie holding the bridge port.

## [0.1.0] - 2026-09-20

### Added
- Zero-dependency MCP server (`mcp/server.mjs`) exposing a localhost WebSocket bridge and
  six tools: `browser_status`, `browser_tabs`, `browser_navigate`, `browser_observe`,
  `browser_act`, `browser_assert`.
- Chrome MV3 extension that drives the user's real, logged-in tabs via `chrome.debugger`
  (CDP) — no remote-debug port and no browser relaunch required.
- **Element-table** perception: pages are read as numbered, stable-ref controls
  instead of screenshots.
- Options page to configure the bridge port and check connection status.
- End-to-end round-trip test (`npm test`) and CI.

[Unreleased]: https://github.com/ItaiZeilig/pawbrowse/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.5.1
[0.5.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.5.0
[0.4.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.4.0
[0.3.4]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.4
[0.3.3]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.3
[0.3.2]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.2
[0.3.1]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.1
[0.3.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.0
[0.2.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.2.0
[0.1.2]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.2
[0.1.1]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.1
[0.1.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.0
