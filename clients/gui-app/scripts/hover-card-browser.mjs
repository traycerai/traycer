// ---------------------------------------------------------------------------
// HOVER CARDS, IN A REAL BROWSER (G8)
//
// Real headless Chrome over CDP, a real mouse (`Input.dispatchMouseEvent`) and
// a real keyboard, against the REAL surfaces:
//   - the side strip's rows (`side-tab-strip.html`, the real `SideTabStrip`);
//   - agent rows, the owner card and its label fallback in one list
//     (`hover-card-agents.html`, the real `AgentHoverTooltip`; the real
//     Agents tree needs a live host, so no fixture mounts it);
//   - the left-panel rail (`layout-editor-canvas.html`, the real
//     `EpicLeftPanelRail`).
//
// Hover timing is a question about pointer events, focus modality, portals and
// frames, none of which jsdom has, which is why this is a browser check.
// A `MutationObserver` in the page timestamps every card mount, state change
// and unmount, and every row the pointer enters, so each claim below is a
// measured interval rather than a screenshot. "Two cards" means two PAINTED in
// one frame (a card fading out counts), sampled every frame with motion on:
//
//   S1  first open about 500ms after the pointer rests on a row; leave closes it.
//   S3  row to row with a card open: the next card within HANDOFF_MAX_MS of
//       entering the next row, never two cards painted.
//   S4  a sweep at 90ms a row: the card follows, one at a time.
//   S5  click during the open delay, then leave: no card, ever.
//   S6  click a row whose card is open, stay: it closes and stays closed.
//   S7  right-click during the delay: nothing under the menu, and nothing after
//       Escape closes it with the pointer away.
//   S8  the pointer travels into the card: it stays; out: it closes.
//   S11 a menu is open on one row: resting on a sibling row opens no card.
//   S9  a wheel scroll with a card open closes it at once.
//   S10 programmatic (non-keyboard) focus opens nothing; Tab opens the focused
//       row's card promptly; Escape closes it.
//   M1  reduced motion: the card is fully opaque on its first frame; with
//       motion, it fades in.
//   A1  agent rows: open, row to row, leave.
//   A4  agent row: click during the delay, then leave: no card.
//   A6  card row -> label row -> label row -> card row share one clock.
//   L1  an actionable card inside a real modal dialog: the pointer reaches
//       its link, the first Escape closes the card, the second the dialog.
//   K1  Tab past an open card: its enabled controls (one arriving late) are
//       no tab stops.
//   R1/R2 the rail: the neighbour's label replaces the first at once.
//
// Every scenario runs once, in the light theme (emulated
// `prefers-color-scheme`; every fixture boots on the "system" theme): hover
// timing, focus and paint counts do not depend on the theme.
//
// Set HOVER_CARD_EVIDENCE_DIR to keep the JSON timeline and screenshots, and
// HOVER_CARD_ONLY to a comma list of scenario ids (S1,S3,A6,...) to iterate.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { connectCdp } from "./cdp-client.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STRIP_FIXTURE = "/src/__tests__/browser/side-tab-strip.html?edge=left";
const AGENTS_FIXTURE = "/src/__tests__/browser/hover-card-agents.html";
const CANVAS_FIXTURE =
  "/src/__tests__/browser/layout-editor-canvas.html?tabs=left&collapsed=0&wco=none&dock=right&surface=epic&sidebar=left&account=1&warm=1";
const EVIDENCE_DIR = process.env.HOVER_CARD_EVIDENCE_DIR ?? null;
const ONLY = (process.env.HOVER_CARD_ONLY ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

/** The first open waits for intent (500ms in the app); this is the window it must land in. */
const FIRST_OPEN_MIN_MS = 350;
const FIRST_OPEN_MAX_MS = 800;
/** A sibling's card while one is open, or just closed: the instant phase (1ms in the app). */
const HANDOFF_MAX_MS = 60;
/** Leave to unmount: the 150ms close delay plus the 100ms exit, plus frames. */
const LEAVE_CLOSE_MAX_MS = 450;
/** Scroll, press and Escape close at once. */
const IMMEDIATE_CLOSE_MAX_MS = 100;
/** Tab onto a row: focus opens without the hover delay. */
const FOCUS_OPEN_MAX_MS = 250;

// --- page-side probes -------------------------------------------------------

const CARD_SELECTOR =
  '[data-slot="hover-card-content"],[data-slot="tooltip-content"]';
const ROW_SELECTOR =
  '[data-side-tab],[data-testid^="epic-sidebar-item-"],[data-testid="epic-sidebar-rail"] button[aria-label]';

/**
 * A timeline in the page: every card that mounts, changes `data-state` or
 * unmounts, and every row the pointer enters. A card is "open" from its mount
 * (or a state other than `closed`) until `closed` or its unmount.
 * `maxPainted` is the most cards ever PAINTED in one frame: mounted with a
 * computed opacity above 0, so a card fading out after it closed still counts.
 */
const INSTALL_TIMELINE = `(() => {
  if (window.__hc !== undefined) {
    window.__hc.events.length = 0;
    window.__hc.maxPainted = 0;
    return "reset";
  }
  const hc = { events: [], open: new Map(), maxPainted: 0, ids: new WeakMap(), next: 0, row: null };
  window.__hc = hc;
  const now = () => Math.round(performance.now());
  const idOf = (n) => { let id = hc.ids.get(n); if (id === undefined) { id = ++hc.next; hc.ids.set(n, id); } return id; };
  const text = (n) => (n.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 48);
  const isOpen = (n) => n.isConnected && (n.dataset.state ?? "open") !== "closed";
  const sync = (n, kind) => {
    const id = idOf(n);
    const wasOpen = hc.open.has(id);
    const nowOpen = kind !== "unmount" && isOpen(n);
    const style = kind === "mount" ? getComputedStyle(n) : null;
    hc.events.push({ t: now(), kind, id, text: text(n), state: n.dataset.state ?? null,
      opacity: style === null ? null : style.opacity });
    if (kind === "mount") requestAnimationFrame(() => {
      hc.events.push({ t: now(), kind: "frame", id, text: text(n), opacity: n.isConnected ? getComputedStyle(n).opacity : null });
    });
    if (nowOpen && !wasOpen) { hc.open.set(id, text(n)); hc.events.push({ t: now(), kind: "open", id, text: text(n) }); }
    if (!nowOpen && wasOpen) { hc.open.delete(id); hc.events.push({ t: now(), kind: "close", id, text: text(n) }); }
  };
  const cardsIn = (n) => {
    if (n.nodeType !== 1) return [];
    const out = n.matches(${JSON.stringify(CARD_SELECTOR)}) ? [n] : [];
    return [...out, ...n.querySelectorAll(${JSON.stringify(CARD_SELECTOR)})];
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") {
        if (r.target.matches(${JSON.stringify(CARD_SELECTOR)})) sync(r.target, "state");
        continue;
      }
      for (const n of r.addedNodes) for (const c of cardsIn(n)) sync(c, "mount");
      for (const n of r.removedNodes) for (const c of cardsIn(n)) sync(c, "unmount");
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  // Sampled once a frame, just before it paints: what is actually on screen.
  const paintedNow = () => [...document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)})]
    .filter((n) => Number(getComputedStyle(n).opacity) > 0).length;
  const sample = () => {
    hc.maxPainted = Math.max(hc.maxPainted, paintedNow());
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  const rowKey = (row) => row.matches("[data-side-tab]")
    ? (row.querySelector('[data-testid^="tab-close-"]')?.dataset.testid ?? null)
    : (row.dataset.testid ?? row.getAttribute("aria-label"));
  document.addEventListener("pointermove", (e) => {
    const row = e.target instanceof Element ? e.target.closest(${JSON.stringify(ROW_SELECTOR)}) : null;
    const key = row === null ? null : rowKey(row);
    if (key === hc.row) return;
    hc.row = key;
    hc.events.push({ t: now(), kind: "enter", row: key });
  }, true);
  for (const type of ["pointerdown", "contextmenu", "keydown", "wheel", "scroll"]) {
    document.addEventListener(type, (e) => {
      if (type === "scroll" && hc.events.at(-1)?.kind === "scroll") return;
      const target = type === "scroll" && e.target instanceof Element
        ? { target: (e.target.getAttribute("data-slot") ?? e.target.getAttribute("data-testid") ?? e.target.tagName), top: e.target.scrollTop }
        : {};
      hc.events.push({ t: now(), kind: type, key: e.key ?? null, ...target });
    }, true);
  }
  return "installed";
})()`;

/** The cards open right now, by text. */
const OPEN_CARDS = `[...window.__hc.open.values()]`;

// --- cdp helpers ------------------------------------------------------------

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "evaluation failed",
    );
  }
  return response.result.value;
}

async function waitFor(client, expression, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Vite `--force` can answer a first import with a 504 while optimizing; one renewed navigation settles it. */
async function open(client, url, ready, label) {
  // `Page.navigate` returns before the old document is gone, and a reload of
  // the same fixture would satisfy `ready` from it: stamp it so only the new
  // document can.
  await evaluate(client, "window.__hcOutgoing = true");
  const fresh = `window.__hcOutgoing !== true && (${ready})`;
  await client.send("Page.navigate", { url });
  try {
    await waitFor(client, fresh, label);
  } catch (error) {
    console.error(`retrying navigation once: ${error.message}`);
    await client.send("Page.navigate", { url });
    try {
      await waitFor(client, fresh, label);
    } catch (retryError) {
      // A fixture that never boots has usually thrown: say what.
      const errors = await evaluate(
        client,
        "JSON.stringify([...(window.__sideTabStripErrors ?? []), ...(window.__hoverCardAgentsErrors ?? []), ...(window.__layoutCanvasErrors ?? [])]).slice(0, 4000)",
      );
      throw new Error(
        `${retryError.message}; page errors: ${errors}; console: ${consoleErrors.join("\n").slice(0, 4000)}`,
      );
    }
  }
}

async function frames(client) {
  await evaluate(
    client,
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
}

async function settle(client, ms) {
  await frames(client);
  await delay(ms);
  await frames(client);
}

const mouse = (client, type, x, y, extra) =>
  client.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse",
    ...extra,
  });
const moveTo = (client, point) =>
  mouse(client, "mouseMoved", point.x, point.y, {});

async function glide(client, from, to, steps, msPerStep) {
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(client, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
    if (msPerStep > 0) await delay(msPerStep);
  }
}

async function click(client, point, button) {
  const buttons = button === "right" ? 2 : 1;
  await mouse(client, "mousePressed", point.x, point.y, {
    button,
    buttons,
    clickCount: 1,
  });
  await mouse(client, "mouseReleased", point.x, point.y, {
    button,
    buttons: 0,
    clickCount: 1,
  });
}

async function key(client, name, code, vk) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code,
      windowsVirtualKeyCode: vk,
    });
  }
}

async function rectOf(client, selector) {
  return await evaluate(
    client,
    `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (n === null) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`,
  );
}

/** A row's centre once it has stopped moving (a resize can scroll the strip after it). */
async function stripRow(client, id) {
  const measure = () =>
    evaluate(
      client,
      `(() => { const row = document.querySelector('[data-testid="tab-close-epic-fixture-${id}"]')?.closest("[data-side-tab]"); if (!row) return null; const r = row.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  let point = await measure();
  for (let i = 0; i < 20 && point !== null; i += 1) {
    await settle(client, 50);
    const next = await measure();
    if (next !== null && next.x === point.x && next.y === point.y) break;
    point = next;
  }
  if (point === null) throw new Error(`no strip row "${id}"`);
  return point;
}

/**
 * Vite optimizes a dependency the first time a page imports it and reloads
 * the page when that changes the bundle, so every fixture boots once before
 * any scenario and the run starts after Vite has been quiet for 3s. From then
 * on any reload or hot update voids the run (see the end).
 */
async function warmUp(client, origin) {
  for (const [url, ready] of [
    [STRIP_FIXTURE, "window.__sideTabStripProbe?.ready === true"],
    [AGENTS_FIXTURE, "window.__hoverCardAgentsProbe?.ready === true"],
    [
      CANVAS_FIXTURE,
      "window.__layoutCanvasProbe?.ready === true && document.querySelector('[data-testid=\"epic-sidebar-rail\"]') !== null",
    ],
  ]) {
    await open(client, origin + url, ready, "warm-up fixture");
  }
  let seen = -1;
  while (seen !== viteReloads.length) {
    seen = viteReloads.length;
    await delay(3000);
  }
  viteReloads.length = 0;
}

async function takeEvents(client) {
  return await evaluate(
    client,
    "(() => { const e = window.__hc.events.splice(0); const m = window.__hc.maxPainted; window.__hc.maxPainted = 0; return { events: e, maxPainted: m }; })()",
  );
}

const openCards = (client) => evaluate(client, OPEN_CARDS);

async function shot(client, name) {
  if (EVIDENCE_DIR === null) return;
  const capture = await client.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    path.join(EVIDENCE_DIR, `${name}.png`),
    Buffer.from(capture.data, "base64"),
  );
}

/** `setEmulatedMedia` replaces every emulated feature at once, so both live here. */
const media = { theme: "light", reduce: false };

async function applyMedia(client) {
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: media.theme },
      { name: "prefers-reduced-motion", value: media.reduce ? "reduce" : "" },
    ],
  });
}

async function setTheme(client, theme) {
  media.theme = theme;
  await applyMedia(client);
  await waitFor(
    client,
    `document.documentElement.classList.contains("dark") === ${theme === "dark"}`,
    `the ${theme} theme`,
  );
}

async function setReducedMotion(client, reduce) {
  media.reduce = reduce;
  await applyMedia(client);
}

// --- timeline readers -------------------------------------------------------

/** When the pointer last entered the row keyed `row`, before `before`. */
function lastEnter(events, row, before) {
  const hit = events.filter(
    (e) => e.kind === "enter" && e.row === row && e.t <= before,
  );
  return hit.length === 0 ? null : hit.at(-1).t;
}

/** The first `open` whose text contains `text`, at or after `after`. */
function firstOpen(events, text, after) {
  return (
    events.find(
      (e) => e.kind === "open" && e.t >= after && e.text.includes(text),
    ) ?? null
  );
}

/** Enter-to-open latency for the card containing `text` on the row keyed `row`, or null when it never opened. */
function openLatency(events, row, text) {
  const opened = events.find((e) => e.kind === "open" && e.text.includes(text));
  if (opened === undefined) return null;
  const entered = lastEnter(events, row, opened.t);
  return entered === null ? null : opened.t - entered;
}

// --- scenarios --------------------------------------------------------------

const results = [];

function want(id) {
  return ONLY.length === 0 || ONLY.includes(id);
}

/** One scenario's verdict: every `checks` entry is `[claim, ok, measured]`. */
function record(theme, id, title, checks, detail) {
  const failed = checks.filter(([, ok]) => !ok);
  results.push({ theme, id, title, pass: failed.length === 0, checks, detail });
  const mark = failed.length === 0 ? "PASS" : "FAIL";
  console.log(`\n[${theme}] ${id} ${mark} - ${title}`);
  for (const [claim, ok, measured] of checks) {
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${claim}: ${JSON.stringify(measured)}`,
    );
  }
}

async function runScenario(theme, id, run) {
  if (!want(id)) return;
  try {
    await run();
  } catch (error) {
    record(
      theme,
      id,
      "crashed",
      [["ran", false, String(error.stack ?? error)]],
      null,
    );
  }
}

const STRIP_IDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const stripKey = (id) => `tab-close-epic-fixture-${id}`;
const stripTitle = (id) => id[0].toUpperCase() + id.slice(1);

async function stripScenarios(client, origin, theme) {
  await open(
    client,
    origin + STRIP_FIXTURE,
    "window.__sideTabStripProbe?.ready === true",
    "the strip fixture",
  );
  await setTheme(client, theme);
  await settle(client, 600);
  await evaluate(client, INSTALL_TIMELINE);
  const content = await rectOf(client, "[data-fixture-content]");
  const far = { x: content.x, y: content.y };
  const rows = {};
  for (const id of STRIP_IDS) rows[id] = await stripRow(client, id);
  const away = async () => {
    await moveTo(client, far);
    await click(client, far, "left");
    await settle(client, 500);
    await takeEvents(client);
  };
  await away();

  await runScenario(theme, "S1", async () => {
    await moveTo(client, rows.alpha);
    await settle(client, 900);
    const openAfterRest = await openCards(client);
    await shot(client, `${theme}-s1-open`);
    await moveTo(client, far);
    await settle(client, LEAVE_CLOSE_MAX_MS);
    const mountedAfterLeave = await evaluate(
      client,
      `document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)}).length`,
    );
    const { events } = await takeEvents(client);
    const latency = openLatency(events, stripKey("alpha"), "Alpha");
    record(
      theme,
      "S1",
      "first open, then leave",
      [
        [
          "one card, Alpha's, after resting",
          openAfterRest.length === 1 && openAfterRest[0].includes("Alpha"),
          openAfterRest,
        ],
        [
          `opens ${FIRST_OPEN_MIN_MS}-${FIRST_OPEN_MAX_MS}ms after entering`,
          latency !== null &&
            latency >= FIRST_OPEN_MIN_MS &&
            latency <= FIRST_OPEN_MAX_MS,
          latency,
        ],
        [
          `gone ${LEAVE_CLOSE_MAX_MS}ms after leaving`,
          mountedAfterLeave === 0,
          mountedAfterLeave,
        ],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S3", async () => {
    await moveTo(client, rows.alpha);
    await settle(client, 900);
    await takeEvents(client);
    await glide(client, rows.alpha, rows.beta, 4, 8);
    await settle(client, 250);
    const onBeta = await openCards(client);
    await shot(client, `${theme}-s3-handoff-beta`);
    // Rest on each row, so a slow open still lands in the timeline and the
    // report carries its real latency rather than "never".
    await settle(client, 700);
    await glide(client, rows.beta, rows.gamma, 4, 8);
    await settle(client, 250);
    const onGamma = await openCards(client);
    await settle(client, 700);
    const { events, maxPainted } = await takeEvents(client);
    const beta = openLatency(events, stripKey("beta"), "Beta");
    const gamma = openLatency(events, stripKey("gamma"), "Gamma");
    record(
      theme,
      "S3",
      "row to row with a card open",
      [
        [
          `Beta's card within ${HANDOFF_MAX_MS}ms of entering Beta`,
          beta !== null && beta <= HANDOFF_MAX_MS,
          beta,
        ],
        [
          `Gamma's card within ${HANDOFF_MAX_MS}ms of entering Gamma`,
          gamma !== null && gamma <= HANDOFF_MAX_MS,
          gamma,
        ],
        [
          "only Beta's card open 250ms after arriving",
          onBeta.length === 1 && onBeta[0].includes("Beta"),
          onBeta,
        ],
        [
          "only Gamma's card open 250ms after arriving",
          onGamma.length === 1 && onGamma[0].includes("Gamma"),
          onGamma,
        ],
        ["never two cards painted at once", maxPainted <= 1, maxPainted],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S4", async () => {
    await moveTo(client, rows.alpha);
    await settle(client, 900);
    await takeEvents(client);
    for (const id of STRIP_IDS.slice(1)) {
      await moveTo(client, rows[id]);
      await delay(90);
    }
    await settle(client, 150);
    const atRest = await openCards(client);
    await settle(client, 800);
    const { events, maxPainted } = await takeEvents(client);
    const followed = STRIP_IDS.slice(1).filter(
      (id) => openLatency(events, stripKey(id), stripTitle(id)) !== null,
    );
    record(
      theme,
      "S4",
      "sweep at 90ms a row, rest on Zeta",
      [
        [
          "Zeta's card, alone, 150ms after arriving",
          atRest.length === 1 && atRest[0].includes("Zeta"),
          atRest,
        ],
        [
          "the card followed every row passed",
          followed.length === STRIP_IDS.length - 1,
          followed,
        ],
        ["never two cards painted at once", maxPainted <= 1, maxPainted],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S5", async () => {
    await moveTo(client, rows.delta);
    await delay(120);
    await click(client, rows.delta, "left");
    await delay(120);
    await moveTo(client, far);
    await settle(client, 1200);
    const after = await openCards(client);
    await shot(client, `${theme}-s5-click-then-leave`);
    const { events } = await takeEvents(client);
    const opened = events.filter((e) => e.kind === "open").map((e) => e.text);
    record(
      theme,
      "S5",
      "click during the delay, leave, wait 1.2s",
      [
        ["no card open", after.length === 0, after],
        ["no card ever opened", opened.length === 0, opened],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S6", async () => {
    await moveTo(client, rows.gamma);
    await settle(client, 900);
    const before = await openCards(client);
    await takeEvents(client);
    await click(client, rows.gamma, "left");
    await settle(client, 900);
    const after = await openCards(client);
    const { events } = await takeEvents(client);
    const press = events.find((e) => e.kind === "pointerdown");
    const closed = events.find((e) => e.kind === "close");
    const reopened = events.filter((e) => e.kind === "open").map((e) => e.text);
    const closeMs =
      press === undefined || closed === undefined ? null : closed.t - press.t;
    record(
      theme,
      "S6",
      "click the row with its card open, stay 900ms",
      [
        ["a card was open before the click", before.length === 1, before],
        [
          `the press closes it within ${IMMEDIATE_CLOSE_MAX_MS}ms`,
          closeMs !== null && closeMs <= IMMEDIATE_CLOSE_MAX_MS,
          closeMs,
        ],
        [
          "it does not re-open (no blink)",
          reopened.length === 0 && after.length === 0,
          { reopened, after },
        ],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S7", async () => {
    await moveTo(client, rows.beta);
    await delay(100);
    await click(client, rows.beta, "right");
    await settle(client, 700);
    const menu = await rectOf(client, '[role="menu"]');
    const duringMenu = await openCards(client);
    await shot(client, `${theme}-s7-context-menu`);
    await moveTo(client, far);
    await settle(client, 200);
    await key(client, "Escape", "Escape", 27);
    await settle(client, 900);
    const menuAfter = await rectOf(client, '[role="menu"]');
    const afterEscape = await openCards(client);
    await shot(client, `${theme}-s7-after-escape`);
    const { events } = await takeEvents(client);
    const opened = events.filter((e) => e.kind === "open").map((e) => e.text);
    record(
      theme,
      "S7",
      "right-click during the delay, pointer away, Escape",
      [
        ["the context menu opened", menu !== null, menu !== null],
        ["no card while the menu is open", duringMenu.length === 0, duringMenu],
        ["Escape closed the menu", menuAfter === null, menuAfter !== null],
        ["no card after Escape", afterEscape.length === 0, afterEscape],
        ["no card ever opened", opened.length === 0, opened],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S11", async () => {
    // The strip's menu is non-modal (Edit Title needs it), so the body keeps
    // its pointer events: a sibling row under the pointer must still not open
    // a card while any menu is up.
    await moveTo(client, rows.beta);
    await delay(100);
    await click(client, rows.beta, "right");
    await settle(client, 300);
    const menu = await rectOf(client, '[role="menu"]');
    await takeEvents(client);
    await glide(client, rows.beta, rows.alpha, 4, 8);
    await settle(client, 900);
    const duringMenu = await openCards(client);
    await shot(client, `${theme}-s11-sibling-under-menu`);
    await key(client, "Escape", "Escape", 27);
    await settle(client, 300);
    const { events } = await takeEvents(client);
    const opened = events.filter((e) => e.kind === "open").map((e) => e.text);
    record(
      theme,
      "S11",
      "menu open on Beta, pointer rests on Alpha",
      [
        ["the context menu opened", menu !== null, menu !== null],
        [
          "no sibling card while the menu is open",
          duringMenu.length === 0,
          duringMenu,
        ],
        ["no card ever opened", opened.length === 0, opened],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S8", async () => {
    await moveTo(client, rows.alpha);
    await settle(client, 900);
    const card = await rectOf(client, CARD_SELECTOR);
    if (card === null) {
      record(
        theme,
        "S8",
        "into the card, then out",
        [["a card opened", false, null]],
        null,
      );
      return;
    }
    await takeEvents(client);
    await glide(client, rows.alpha, card, 6, 12);
    await settle(client, 500);
    const inside = await openCards(client);
    await moveTo(client, { x: far.x, y: far.y + 300 });
    await settle(client, LEAVE_CLOSE_MAX_MS);
    const out = await openCards(client);
    const { events } = await takeEvents(client);
    record(
      theme,
      "S8",
      "into the card, then out",
      [
        [
          "stays open with the pointer inside it",
          inside.length === 1 && inside[0].includes("Alpha"),
          inside,
        ],
        ["closes after leaving it", out.length === 0, out],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "S9", async () => {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 330,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle(client, 400);
    // The short window scrolls the strip to keep its active row in view, which
    // can tuck Alpha under the sticky header: start from the top, where Alpha
    // is in view and a wheel has room to scroll.
    await evaluate(
      client,
      `document.querySelector('[data-testid="header-tab-strip-scroll"]').scrollTop = 0`,
    );
    const alpha = await stripRow(client, "alpha");
    const alphaUnderPointer = await evaluate(
      client,
      `document.elementFromPoint(${String(alpha.x)}, ${String(alpha.y)})?.closest("[data-side-tab]")?.querySelector('[data-testid="tab-close-epic-fixture-alpha"]') != null`,
    );
    await moveTo(client, alpha);
    await settle(client, 900);
    const before = await openCards(client);
    await takeEvents(client);
    await mouse(client, "mouseWheel", alpha.x, alpha.y, {
      deltaX: 0,
      deltaY: 120,
    });
    await settle(client, 700);
    const after = await openCards(client);
    const moved = (await stripRow(client, "alpha")).y !== alpha.y;
    await shot(client, `${theme}-s9-scrolled`);
    const { events } = await takeEvents(client);
    const wheel = events.find((e) => e.kind === "wheel");
    const closed = events.find(
      (e) => e.kind === "close" && e.text.includes("Alpha"),
    );
    const closeMs =
      wheel === undefined || closed === undefined ? null : closed.t - wheel.t;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1500,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    record(
      theme,
      "S9",
      "wheel with a card open",
      [
        [
          "Alpha's row is what the pointer rests on",
          alphaUnderPointer === true,
          alphaUnderPointer,
        ],
        [
          "Alpha's card open before the wheel",
          before.length === 1 && before[0].includes("Alpha"),
          before,
        ],
        ["the list scrolled", moved, moved],
        [
          `the wheel closes Alpha's card within ${IMMEDIATE_CLOSE_MAX_MS}ms`,
          closeMs !== null && closeMs <= IMMEDIATE_CLOSE_MAX_MS,
          closeMs,
        ],
        [
          "no stale Alpha card afterwards",
          after.every((text) => !text.includes("Alpha")),
          after,
        ],
      ],
      events,
    );
  });
  await settle(client, 300);
  await away();

  await runScenario(theme, "S10", async () => {
    // A mouse press focuses the row: that focus is not :focus-visible, so it
    // must open nothing once the pointer has gone.
    await moveTo(client, rows.alpha);
    await click(client, rows.alpha, "left");
    await moveTo(client, far);
    await settle(client, 900);
    const afterMouseFocus = await openCards(client);
    const mouseFocused = await evaluate(
      client,
      `document.activeElement?.closest("[data-side-tab]")?.querySelector('[data-testid^="tab-close-"]')?.dataset.testid ?? null`,
    );
    await takeEvents(client);
    await key(client, "Tab", "Tab", 9);
    await settle(client, FOCUS_OPEN_MAX_MS);
    const afterTab = await openCards(client);
    const focused = await evaluate(
      client,
      "document.activeElement?.closest('[data-side-tab]')?.querySelector('[data-testid^=\"tab-close-\"]')?.dataset.testid ?? document.activeElement?.tagName ?? null",
    );
    await key(client, "Escape", "Escape", 27);
    await settle(client, 300);
    const afterEscape = await openCards(client);
    await key(client, "Tab", "Tab", 9);
    await settle(client, FOCUS_OPEN_MAX_MS);
    const afterTabAgain = await openCards(client);
    const focusedAgain = await evaluate(
      client,
      "document.activeElement?.closest('[data-side-tab]')?.querySelector('[data-testid^=\"tab-close-\"]')?.dataset.testid ?? document.activeElement?.outerHTML.slice(0, 160) ?? null",
    );
    await shot(client, `${theme}-s10-keyboard`);
    const { events } = await takeEvents(client);
    // The card is the FOCUSED row's, not merely a card.
    const cardOf = (testid) => {
      const id = testid?.startsWith("tab-close-epic-fixture-")
        ? testid.slice("tab-close-epic-fixture-".length)
        : null;
      return id === null ? null : stripTitle(id);
    };
    const tabTitle = cardOf(focused);
    const tabAgainTitle = cardOf(focusedAgain);
    record(
      theme,
      "S10",
      "keyboard: mouse focus, Tab, Escape, Tab",
      [
        [
          "the press focused the row",
          mouseFocused === stripKey("alpha"),
          mouseFocused,
        ],
        [
          "a mouse focus opens nothing",
          afterMouseFocus.length === 0,
          afterMouseFocus,
        ],
        [
          `Tab opens the focused row's card within ${FOCUS_OPEN_MAX_MS}ms`,
          afterTab.length === 1 &&
            tabTitle !== null &&
            afterTab[0].includes(tabTitle),
          { afterTab, focused },
        ],
        ["Escape closes it", afterEscape.length === 0, afterEscape],
        [
          `Tab again opens the next focused row's card within ${FOCUS_OPEN_MAX_MS}ms`,
          afterTabAgain.length === 1 &&
            tabAgainTitle !== null &&
            afterTabAgain[0].includes(tabAgainTitle),
          { afterTabAgain, focusedAgain },
        ],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "M1", async () => {
    const fadeFrame = async (reduce) => {
      // The app reads the preference when a component mounts, so the page
      // boots under it rather than having it flipped underneath.
      await setReducedMotion(client, reduce);
      await open(
        client,
        origin + STRIP_FIXTURE,
        "window.__sideTabStripProbe?.ready === true",
        "the strip fixture",
      );
      await settle(client, 600);
      await evaluate(client, INSTALL_TIMELINE);
      const epsilon = await stripRow(client, "epsilon");
      await away();
      await moveTo(client, epsilon);
      await settle(client, 900);
      await moveTo(client, far);
      await settle(client, LEAVE_CLOSE_MAX_MS);
      const { events } = await takeEvents(client);
      const mount = events.find((e) => e.kind === "mount");
      const frame = events.find(
        (e) => e.kind === "frame" && mount !== undefined && e.id === mount.id,
      );
      const leave = events.findLast(
        (e) => e.kind === "enter" && e.row === null,
      );
      const gone = events.find(
        (e) => e.kind === "unmount" && leave !== undefined && e.t >= leave.t,
      );
      return {
        mountOpacity: mount?.opacity ?? null,
        firstFrameOpacity: frame?.opacity ?? null,
        leaveToUnmount:
          leave === undefined || gone === undefined ? null : gone.t - leave.t,
      };
    };
    const motion = await fadeFrame(false);
    const reduced = await fadeFrame(true);
    await setReducedMotion(client, false);
    record(
      theme,
      "M1",
      "reduced motion",
      [
        [
          "with motion, the card fades in (below full opacity on its first frame)",
          motion.firstFrameOpacity !== null &&
            Number(motion.firstFrameOpacity) < 1,
          motion,
        ],
        [
          "reduced, the card is opaque by its first frame",
          reduced.firstFrameOpacity === "1",
          reduced,
        ],
        [
          "reduced, leave unmounts without an exit animation (<= 250ms)",
          reduced.leaveToUnmount !== null && reduced.leaveToUnmount <= 250,
          reduced.leaveToUnmount,
        ],
      ],
      null,
    );
  });
  await setReducedMotion(client, false);

  const errors = await evaluate(client, "window.__sideTabStripErrors ?? []");
  if (errors.length > 0)
    record(
      theme,
      "strip-errors",
      "strip fixture errors",
      [["no page errors", false, errors]],
      null,
    );
}

const AGENT_TITLES = [
  "Plan the migration",
  "Write the tests",
  "Rebuild the index",
  "Review the diff",
  "Ship the release",
  "Sweep the worktrees",
];

async function agentScenarios(client, origin, theme) {
  await open(
    client,
    origin + AGENTS_FIXTURE,
    "window.__hoverCardAgentsProbe?.ready === true",
    "the agent rows fixture",
  );
  await setTheme(client, theme);
  await settle(client, 600);
  await evaluate(client, INSTALL_TIMELINE);
  const rows = [];
  for (let i = 1; i <= 6; i += 1) {
    const row = await rectOf(
      client,
      `[data-testid="epic-sidebar-item-agent-${String(i)}"]`,
    );
    rows.push({ ...row, key: `epic-sidebar-item-agent-${String(i)}` });
  }
  const content = await rectOf(client, "[data-fixture-content]");
  const far = { x: content.x, y: content.y + 200 };
  const away = async () => {
    await moveTo(client, far);
    await settle(client, 600);
    await takeEvents(client);
  };
  await away();

  await runScenario(theme, "A1", async () => {
    const [a, b] = rows;
    await moveTo(client, a);
    await settle(client, 1000);
    const onA = await openCards(client);
    await shot(client, `${theme}-a1-agent-row`);
    await glide(client, a, b, 4, 8);
    await settle(client, 250);
    const onB = await openCards(client);
    await shot(client, `${theme}-a1-agent-row-next`);
    await settle(client, 700);
    await moveTo(client, far);
    await settle(client, LEAVE_CLOSE_MAX_MS);
    const out = await openCards(client);
    const { events, maxPainted } = await takeEvents(client);
    const [titleA, titleB] = AGENT_TITLES;
    const aMs = openLatency(events, a.key, titleA);
    const bMs = openLatency(events, b.key, titleB);
    record(
      theme,
      "A1",
      "agent rows: open, row to row, leave",
      [
        [
          `first card ${FIRST_OPEN_MIN_MS}-${FIRST_OPEN_MAX_MS}ms after entering`,
          aMs !== null && aMs >= FIRST_OPEN_MIN_MS && aMs <= FIRST_OPEN_MAX_MS,
          { aMs, onA },
        ],
        [
          `next row's card within ${HANDOFF_MAX_MS}ms`,
          bMs !== null && bMs <= HANDOFF_MAX_MS,
          { bMs, onB },
        ],
        [
          "only the next row's card open 250ms after arriving",
          onB.length === 1 && onB[0].includes(titleB),
          onB,
        ],
        ["leave closes it", out.length === 0, out],
        ["never two painted at once", maxPainted <= 1, maxPainted],
      ],
      events,
    );
  });
  await away();

  await runScenario(theme, "A4", async () => {
    const a = rows[2];
    await moveTo(client, a);
    await delay(120);
    await click(client, a, "left");
    await delay(120);
    await moveTo(client, far);
    await settle(client, 1200);
    const after = await openCards(client);
    const { events } = await takeEvents(client);
    const opened = events.filter((e) => e.kind === "open").map((e) => e.text);
    record(
      theme,
      "A4",
      "agent row: click during the delay, leave",
      [
        ["no card open", after.length === 0, after],
        ["no card ever opened", opened.length === 0, opened],
      ],
      events,
    );
    await click(client, far, "left");
  });
  await away();

  await runScenario(theme, "A6", async () => {
    // d (card) -> e (label) -> f (label) -> d (card)
    const [d, e, f] = [rows[3], rows[4], rows[5]];
    await moveTo(client, d);
    await settle(client, 1000);
    const onD = await openCards(client);
    await takeEvents(client);
    await glide(client, d, e, 4, 8);
    await settle(client, 150);
    const onE = await openCards(client);
    await shot(client, `${theme}-a6-label-row`);
    await settle(client, 700);
    await glide(client, e, f, 4, 8);
    await settle(client, 150);
    const onF = await openCards(client);
    await settle(client, 700);
    await glide(client, f, d, 6, 8);
    await settle(client, 150);
    const backOnD = await openCards(client);
    await settle(client, 700);
    const { events, maxPainted } = await takeEvents(client);
    const eMs = openLatency(
      events,
      "epic-sidebar-item-agent-5",
      AGENT_TITLES[4],
    );
    const fMs = openLatency(
      events,
      "epic-sidebar-item-agent-6",
      AGENT_TITLES[5],
    );
    const dMs = openLatency(
      events,
      "epic-sidebar-item-agent-4",
      AGENT_TITLES[3],
    );
    record(
      theme,
      "A6",
      "card row -> label row -> label row -> card row",
      [
        [
          "the card row's card opened first",
          onD.length === 1 && onD[0].includes(AGENT_TITLES[3]),
          onD,
        ],
        [
          `card -> label within ${HANDOFF_MAX_MS}ms`,
          eMs !== null && eMs <= HANDOFF_MAX_MS,
          { eMs, onE },
        ],
        [
          `label -> label within ${HANDOFF_MAX_MS}ms`,
          fMs !== null && fMs <= HANDOFF_MAX_MS,
          { fMs, onF },
        ],
        [
          `label -> card within ${HANDOFF_MAX_MS}ms`,
          dMs !== null && dMs <= HANDOFF_MAX_MS,
          { dMs, backOnD },
        ],
        ["never two painted at once", maxPainted <= 1, maxPainted],
      ],
      events,
    );
  });
  await moveTo(client, far);
  await settle(client, 500);
  await takeEvents(client);

  await runScenario(theme, "L1", async () => {
    // An actionable card inside a real modal dialog: the dialog disables the
    // body's pointer events, so the card has to be a layer above it.
    await click(
      client,
      await rectOf(client, '[data-testid="open-modal"]'),
      "left",
    );
    await waitFor(
      client,
      "document.querySelector('[data-slot=\"dialog-content\"]') !== null",
      "the modal dialog",
    );
    await settle(client, 300);
    const trigger = await rectOf(client, '[data-testid="modal-trigger"]');
    await moveTo(client, trigger);
    await settle(client, 900);
    const onTrigger = await openCards(client);
    const link = await rectOf(client, '[data-testid="modal-link"]');
    let reached = false;
    let clicks = 0;
    if (link !== null) {
      await glide(client, trigger, link, 6, 10);
      await settle(client, 100);
      reached = await evaluate(
        client,
        `document.elementFromPoint(${String(link.x)}, ${String(link.y)})?.closest('[data-testid="modal-link"]') != null`,
      );
      await click(client, link, "left");
      await settle(client, 100);
      clicks = await evaluate(client, "window.__hoverCardLinkClicks ?? 0");
    }
    const afterClick = await openCards(client);
    await shot(client, `${theme}-l1-card-in-modal`);
    await key(client, "Escape", "Escape", 27);
    await settle(client, 300);
    const firstEscape = {
      cards: await openCards(client),
      dialog: await evaluate(
        client,
        "document.querySelector('[data-slot=\"dialog-content\"]') !== null",
      ),
    };
    await key(client, "Escape", "Escape", 27);
    await settle(client, 300);
    const secondEscape = {
      cards: await openCards(client),
      dialog: await evaluate(
        client,
        "document.querySelector('[data-slot=\"dialog-content\"]') !== null",
      ),
    };
    // Whatever the outcome, leave no dialog behind for the next scenario.
    for (let i = 0; i < 3; i += 1) {
      const up = await evaluate(
        client,
        "document.querySelector('[data-slot=\"dialog-content\"]') !== null",
      );
      if (!up) break;
      await key(client, "Escape", "Escape", 27);
      await settle(client, 300);
    }
    const { events } = await takeEvents(client);
    record(
      theme,
      "L1",
      "an actionable card inside a modal dialog",
      [
        [
          "hovering the trigger opens the card",
          onTrigger.length === 1,
          onTrigger,
        ],
        ["the pointer reaches the card's link", reached === true, reached],
        [
          "a click on the link lands, and the card stays",
          clicks === 1 && afterClick.length === 1,
          { clicks, afterClick },
        ],
        [
          "the first Escape closes the card, not the dialog",
          firstEscape.cards.length === 0 && firstEscape.dialog === true,
          firstEscape,
        ],
        [
          "the second Escape closes the dialog",
          secondEscape.dialog === false,
          secondEscape,
        ],
      ],
      events,
    );
  });
  await moveTo(client, far);
  await settle(client, 500);
  await takeEvents(client);

  await runScenario(theme, "K1", async () => {
    // A card left open under the pointer while the keyboard moves on: its
    // enabled controls, the late one included, are no tab stops.
    await moveTo(
      client,
      await rectOf(client, '[data-testid="actions-trigger"]'),
    );
    await settle(client, 1100);
    const open = await openCards(client);
    const controls = await evaluate(
      client,
      `document.querySelectorAll('[data-testid="actions-card"] a, [data-testid="actions-card"] button:not(:disabled)').length`,
    );
    await evaluate(
      client,
      `document.querySelector('[data-testid="last-stop"]').focus()`,
    );
    const stops = [];
    for (let i = 0; i < 3; i += 1) {
      await key(client, "Tab", "Tab", 9);
      await settle(client, 50);
      stops.push(
        await evaluate(
          client,
          `(() => { const a = document.activeElement; return a === null ? null : { testid: a.dataset?.testid ?? a.tagName, inCard: a.closest('[data-slot="hover-card-content"]') !== null }; })()`,
        ),
      );
    }
    // Tabbing on wraps to the agent rows, whose own card may open by focus:
    // the claim is only about THIS card.
    const stillOpen = await evaluate(
      client,
      `document.querySelector('[data-testid="actions-card"]')?.dataset.state === "open"`,
    );
    const { events } = await takeEvents(client);
    record(
      theme,
      "K1",
      "Tab past an open card with enabled buttons",
      [
        [
          "the card is open with its link and both buttons",
          open.length === 1 && controls === 3,
          { open, controls },
        ],
        [
          "no Tab stop lands inside the card",
          stops.every((s) => s === null || !s.inCard),
          stops,
        ],
        ["the card stayed open while tabbing", stillOpen === true, stillOpen],
      ],
      events,
    );
  });
  await moveTo(client, far);
  await settle(client, 500);

  const errors = await evaluate(client, "window.__hoverCardAgentsErrors ?? []");
  if (errors.length > 0)
    record(
      theme,
      "agents-errors",
      "agent fixture errors",
      [["no page errors", false, errors]],
      null,
    );
}

async function canvasScenarios(client, origin, theme) {
  await open(
    client,
    origin + CANVAS_FIXTURE,
    "window.__layoutCanvasProbe?.ready === true && document.querySelector('[data-testid=\"epic-sidebar-rail\"]') !== null",
    "the canvas fixture",
  );
  await setTheme(client, theme);
  await settle(client, 900);
  await evaluate(client, INSTALL_TIMELINE);
  const rail = await evaluate(
    client,
    `[...document.querySelectorAll('[data-testid="epic-sidebar-rail"] button[aria-label]')].map((n) => { const r = n.getBoundingClientRect(); return { key: n.dataset.testid ?? n.getAttribute("aria-label"), label: n.getAttribute("aria-label"), x: r.x + r.width / 2, y: r.y + r.height / 2 }; })`,
  );
  const frame = await rectOf(client, "[data-layout-column] main > div");
  const far = { x: frame.x + 200, y: frame.y + 200 };
  const away = async () => {
    await moveTo(client, far);
    await settle(client, 600);
    await takeEvents(client);
  };
  await away();

  await runScenario(theme, "R1", async () => {
    if (rail.length < 2) {
      record(
        theme,
        "R1",
        "rail labels",
        [["two rail icons", false, rail]],
        null,
      );
      return;
    }
    const [first, second] = rail;
    await moveTo(client, first);
    await settle(client, 900);
    const onFirst = await openCards(client);
    await moveTo(client, second);
    await settle(client, 150);
    const onSecond = await openCards(client);
    await shot(client, `${theme}-r2-rail-neighbour`);
    await settle(client, 600);
    const { events, maxPainted } = await takeEvents(client);
    const secondMs = openLatency(events, second.key, second.label);
    record(
      theme,
      "R1",
      "rail: first icon, then its neighbour",
      [
        [
          "the first icon's label opened",
          onFirst.length === 1 && onFirst[0].includes(first.label),
          onFirst,
        ],
        [
          `the neighbour's label within ${HANDOFF_MAX_MS}ms`,
          secondMs !== null && secondMs <= HANDOFF_MAX_MS,
          secondMs,
        ],
        [
          "only the neighbour's label open 150ms after arriving",
          onSecond.length === 1 && onSecond[0].includes(second.label),
          onSecond,
        ],
        ["never two painted at once", maxPainted <= 1, maxPainted],
      ],
      events,
    );
  });
  await away();

  const errors = await evaluate(client, "window.__layoutCanvasErrors ?? []");
  if (errors.length > 0)
    record(
      theme,
      "canvas-errors",
      "canvas fixture errors",
      [["no page errors", false, errors]],
      null,
    );
}

// --- plumbing ---------------------------------------------------------------

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      resolve(address.port);
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} exited: ${readError()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}: ${readError()}`);
}

/** Uncaught exceptions and `console.error`s, for a fixture that never boots. */
const consoleErrors = [];

if (EVIDENCE_DIR !== null) await mkdir(EVIDENCE_DIR, { recursive: true });
const chromePath = await findChrome("the hover card regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
let viteConfigDir;
const viteReloads = [];
try {
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  // File watching off, through a wrapper around the shared config (as
  // `composer-queue-dock-browser.mjs` and `layout-editor-browser.mjs` do): the
  // run never follows an edit, and in a tree several agents write at once a
  // watcher hot-updates the fixture under a running scenario on a peer's save.
  viteConfigDir = await mkdtemp(path.join(tmpdir(), "hover-card-vite-"));
  const viteConfigPath = path.join(viteConfigDir, "vite.no-watch.config.mjs");
  await writeFile(
    viteConfigPath,
    [
      `import base from ${JSON.stringify(path.join(projectRoot, "vitest.config.ts"))};`,
      "export default { ...base, server: { ...base.server, watch: null } };",
      "",
    ].join("\n"),
  );
  viteProcess = spawn(
    "node",
    [
      viteEntry,
      "--config",
      viteConfigPath,
      "--host",
      "127.0.0.1",
      "--force",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  // A reload or hot update under a running scenario invalidates it (another
  // agent's edit, a dependency optimized late): say so at the end.
  viteProcess.stdout.setEncoding("utf8");
  viteProcess.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (/reload|hmr update|optimiz/i.test(line))
        viteReloads.push(line.trim());
    }
  });
  const origin = `http://127.0.0.1:${String(vitePort)}`;
  await waitForHttp(
    origin + STRIP_FIXTURE,
    viteProcess,
    () => viteError,
    "Vite",
  );
  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-hover-card-",
    [],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  await waitForHttp(
    new URL("/json/version", launched.devtoolsHttpUrl),
    chrome,
    launched.readError,
    "Chrome DevTools",
  );
  const target = await (
    await fetch(
      new URL(
        `/json/new?${encodeURIComponent("about:blank")}`,
        launched.devtoolsHttpUrl,
      ),
      { method: "PUT" },
    )
  ).json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  client.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type !== "error") return;
    consoleErrors.push(
      args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
    );
  });
  await client.send("Runtime.enable", undefined);
  await client.send("Page.enable", undefined);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1500,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await warmUp(client, origin);
  const theme = "light";
  for (const [fixture, run] of [
    ["strip", stripScenarios],
    ["agents", agentScenarios],
    ["canvas", canvasScenarios],
  ]) {
    // A fixture that does not boot is one red, not the end of the run.
    try {
      await run(client, origin, theme);
    } catch (error) {
      record(
        theme,
        `${fixture}-fixture`,
        "the fixture did not boot",
        [["booted", false, String(error.message)]],
        null,
      );
    }
  }
} finally {
  client?.close();
  if (chrome !== undefined) await terminateProcessTree(chrome);
  viteProcess?.kill("SIGTERM");
  if (viteConfigDir !== undefined) {
    await rm(viteConfigDir, { recursive: true, force: true, maxRetries: 3 });
  }
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

if (EVIDENCE_DIR !== null) {
  await writeFile(
    path.join(EVIDENCE_DIR, "timeline.json"),
    JSON.stringify(results, null, 1),
  );
}
const failed = results.filter((result) => !result.pass);
console.log(
  `\n${String(results.length - failed.length)}/${String(results.length)} scenarios passed${failed.length === 0 ? "" : `; failed: ${failed.map((r) => `${r.theme}/${r.id}`).join(", ")}`}`,
);
if (results.length === 0) throw new Error("no scenario ran");
if (viteReloads.length > 0) {
  console.log(
    `Vite reloaded or hot-updated the page mid-run, so this run is not evidence:\n  ${viteReloads.join("\n  ")}`,
  );
  process.exit(1);
}
if (failed.length > 0) process.exit(1);
