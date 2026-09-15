// Spike driver, not a CI regression: exercises the real react-joyride 3.2 in
// a real headless Chrome against `src/__tests__/browser/joyride-spike.html`
// and prints one PASS / FAIL / OBSERVE line per A4 gate item it can reach
// without Electron. Structure copied from `toast-over-modal-hittest.mjs`
// (vite + headless Chrome over CDP).
//
//   node scripts/joyride-spike-browser.mjs [--out <dir>]
//
// `--out` receives PNG screenshots named after each checkpoint plus
// `results.json`. Exit code is 1 when any hard check FAILS; OBSERVE lines
// are measurements the gate must weigh, not assertions. One FAIL is expected
// on react-joyride 3.2 and accepted by the coordinator: the equal-size
// translation check in section 6 (see the comment there).
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/joyride-spike.html";
const outDirArgIndex = process.argv.indexOf("--out");
const outDir =
  outDirArgIndex === -1 ? null : path.resolve(process.argv[outDirArgIndex + 1]);
const chromePath = await findChrome("the joyride spike");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

const results = [];
function record(kind, name, ok, details) {
  results.push({ kind, name, ok, details });
  const tag = kind === "observe" ? "OBSERVE" : ok ? "PASS" : "FAIL";
  console.log(`${tag.padEnd(7)} ${name}`);
  if (details !== undefined) {
    console.log(`        ${JSON.stringify(details)}`);
  }
}
const check = (name, ok, details) => record("check", name, ok, details);
const observe = (name, details) => record("observe", name, true, details);

try {
  if (outDir !== null) await mkdir(outDir, { recursive: true });
  const pageUrl = `http://127.0.0.1:${vitePort}${fixtureUrlPath}`;
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  viteProcess = spawn(
    "node",
    [
      viteEntry,
      "--config",
      path.join(projectRoot, "vitest.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(pageUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-joyride-spike-",
    [],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  const devtoolsUrl = launched.devtoolsHttpUrl;
  await waitForHttp(
    new URL("/json/version", devtoolsUrl).href,
    chrome,
    launched.readError,
    "Chrome DevTools",
  );
  const versionInfo = await (
    await fetch(new URL("/json/version", devtoolsUrl))
  ).json();
  observe("runtime", {
    browser: versionInfo.Browser,
    userAgent: versionInfo["User-Agent"],
    node: process.version,
    platform: process.platform,
  });
  const targetResponse = await fetch(
    new URL(`/json/new?${encodeURIComponent(pageUrl)}`, devtoolsUrl),
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(
      `Chrome could not open the fixture: ${targetResponse.status}`,
    );
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable", {});
  await client.send("Page.enable", {});
  await setViewport(1200, 800);

  // ---------------------------------------------------------------- helpers
  const PROBE = `Object.fromEntries(Object.entries(document.querySelector('#probe-state').dataset))`;
  const probe = () => evaluate(client, PROBE);
  const events = () => evaluate(client, `window.__joyrideSpike.getEvents()`);
  const clearEvents = () =>
    evaluate(client, `window.__joyrideSpike.clearEvents()`);
  const control = (call) => evaluate(client, `window.__joyrideSpike.${call}`);
  const rectOf = (selector) =>
    evaluate(
      client,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height,
                 x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 scrollY: window.scrollY };
      })()`,
    );
  const READ_OVERLAY = `(() => {
    const overlay = document.querySelector('.react-joyride__overlay');
    const svg = document.querySelector('.react-joyride__spotlight');
    const floater = document.querySelector('.react-joyride__floater');
    const paths = svg === null ? [] : [...svg.querySelectorAll('path')];
    const describePath = (p) => ({
      fill: getComputedStyle(p).fill,
      pointerEvents: getComputedStyle(p).pointerEvents,
      transitionProperty: getComputedStyle(p).transitionProperty,
      transitionDuration: getComputedStyle(p).transitionDuration,
      d: p.getAttribute('d'),
    });
    const parseCutout = (d) => {
      if (d === null) return null;
      const n = '([\\\\d.-]+)';
      const m = new RegExp('^M' + n + ' ' + n + 'H' + n + 'A' + n + ' ' + n + ' 0 0 1 ' + n + ' ' + n + 'V' + n).exec(d);
      if (m === null) return null;
      const r = Number(m[4]);
      const left = Number(m[1]) - r;
      const top = Number(m[2]);
      const right = Number(m[6]);
      const bottom = Number(m[8]) + r;
      return { left, top: top - window.scrollY, width: right - left, height: bottom - top, radius: r };
    };
    return {
      portalPresent: document.querySelector('#react-joyride-portal') !== null,
      overlayPresent: overlay !== null,
      overlayZIndex: overlay === null ? null : getComputedStyle(overlay).zIndex,
      overlayPosition: overlay === null ? null : getComputedStyle(overlay).position,
      overlayPointerEvents: overlay === null ? null : getComputedStyle(overlay).pointerEvents,
      overlayTransition: overlay === null ? null : getComputedStyle(overlay).transitionProperty,
      overlayRect: overlay === null ? null : (() => { const r = overlay.getBoundingClientRect(); return { width: r.width, height: r.height }; })(),
      svgPosition: svg === null ? null : getComputedStyle(svg).position,
      pathCount: paths.length,
      coverPath: paths.length > 0 ? describePath(paths[0]) : null,
      cutoutPath: paths.length > 1 ? describePath(paths[1]) : null,
      cutout: paths.length > 1 ? parseCutout(paths[1].getAttribute('d')) : null,
      floaterPresent: floater !== null,
      floaterZIndex: floater === null ? null : getComputedStyle(floater).zIndex,
      floaterTransition: floater === null ? null : getComputedStyle(floater).transitionProperty,
      floaterOpacity: floater === null ? null : getComputedStyle(floater).opacity,
      floaterRect: floater === null ? null : (() => { const r = floater.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })(),
      tooltip: (() => {
        const t = document.querySelector('[data-spike="tooltip"]');
        if (t === null) return null;
        return {
          role: t.getAttribute('role'),
          ariaModal: t.getAttribute('aria-modal'),
          labelledBy: t.getAttribute('aria-labelledby'),
          describedBy: t.getAttribute('aria-describedby'),
          labelResolves: document.getElementById(t.getAttribute('aria-labelledby') ?? '') !== null,
          descriptionResolves: document.getElementById(t.getAttribute('aria-describedby') ?? '') !== null,
          counter: t.querySelector('[data-spike="step-counter"]')?.textContent ?? null,
          buttons: [...t.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
          alertdialogPresent: document.querySelector('[role="alertdialog"]') !== null,
        };
      })(),
      resolvedOverlayVar: getComputedStyle(document.documentElement).getPropertyValue('--onboarding-tour-overlay').trim(),
      activeElement: (() => {
        const a = document.activeElement;
        if (a === null) return null;
        return a.getAttribute('data-spike') ?? a.getAttribute('data-action') ?? a.tagName.toLowerCase();
      })(),
      activeInsideFloater: document.activeElement !== null && floater !== null && floater.contains(document.activeElement),
      scrollY: window.scrollY,
    };
  })()`;
  const readOverlay = () => evaluate(client, READ_OVERLAY);
  const hitAt = (x, y) =>
    evaluate(
      client,
      `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el === null) return 'NOTHING';
        const spike = el.closest('[data-spike]');
        if (spike !== null) return 'spike:' + spike.getAttribute('data-spike');
        if (el.closest('.react-joyride__spotlight') !== null) return 'joyride-overlay-path';
        if (el.closest('[data-slot="dialog-content"]') !== null) return 'dialog-content';
        if (el.closest('[data-slot="dialog-overlay"]') !== null) return 'dialog-overlay';
        if (el.closest('[data-sonner-toast]') !== null) return 'sonner-toast';
        return el.tagName.toLowerCase();
      })()`,
    );
  const waitForTooltip = (counter) =>
    waitFor(
      client,
      `the tour card showing "${counter}"`,
      `document.querySelector('[data-spike="step-counter"]')?.textContent === ${JSON.stringify(counter)} && getComputedStyle(document.querySelector('.react-joyride__floater')).opacity === '1'`,
      30_000,
    );
  const rectsMatch = (cutout, rect, pad) =>
    cutout !== null &&
    rect !== null &&
    Math.abs(cutout.left - (rect.left - pad)) <= 1.5 &&
    Math.abs(cutout.top - (rect.top - pad)) <= 1.5 &&
    Math.abs(cutout.width - (rect.width + 2 * pad)) <= 1.5 &&
    Math.abs(cutout.height - (rect.height + 2 * pad)) <= 1.5;
  const snap = async (name) => {
    if (outDir === null) return;
    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      path.join(outDir, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
  };

  // ------------------------------------------------ 1. step 0 presents
  await waitForTooltip("1 of 4");
  await delay(400);
  await snap("01-step0-composer");
  let ov = await readOverlay();
  const composer = await rectOf('[data-spike="composer"]');
  check(
    "overlay: portal + overlay + spotlight svg mounted, floater visible",
    ov.portalPresent &&
      ov.overlayPresent &&
      ov.pathCount >= 2 &&
      ov.floaterPresent &&
      ov.floaterOpacity === "1",
    {
      pathCount: ov.pathCount,
      svgPosition: ov.svgPosition,
      overlayPosition: ov.overlayPosition,
    },
  );
  check(
    "overlay: options.zIndex 45 -> overlay z-index 45, floater 46",
    ov.overlayZIndex === "45" && ov.floaterZIndex === "46",
    {
      overlayZIndex: ov.overlayZIndex,
      floaterZIndex: ov.floaterZIndex,
    },
  );
  check(
    "overlay: wrapper pointer-events none, cover path auto, cutout path none (blockTargetInteraction:false)",
    ov.overlayPointerEvents === "none" &&
      ov.coverPath.pointerEvents === "auto" &&
      ov.cutoutPath.pointerEvents === "none",
    {
      overlay: ov.overlayPointerEvents,
      cover: ov.coverPath.pointerEvents,
      cutout: ov.cutoutPath.pointerEvents,
    },
  );
  check(
    "overlay: hole = composer rect + spotlightPadding 8, radius 8",
    rectsMatch(ov.cutout, composer, 8) && ov.cutout.radius === 8,
    {
      cutout: ov.cutout,
      composer: {
        left: composer.left,
        top: composer.top,
        width: composer.width,
        height: composer.height,
      },
    },
  );
  check(
    "overlay: overlayColor var(--onboarding-tour-overlay) resolves on the SVG fill (not the #00000080 default)",
    ov.coverPath.fill !== "rgba(0, 0, 0, 0.5)" &&
      ov.coverPath.fill !== "rgb(0, 0, 0)" &&
      ov.coverPath.fill !== "none",
    {
      fill: ov.coverPath.fill,
      cssVar: ov.resolvedOverlayVar,
    },
  );
  check(
    "overlay: the cutout (cover) path carries upstream's hardcoded opacity transition; the outer overlay path has none",
    ov.cutoutPath.transitionProperty === "opacity" &&
      ov.cutoutPath.transitionDuration === "0.2s" &&
      ov.coverPath.transitionProperty === "all" &&
      ov.coverPath.transitionDuration === "0s",
    {
      cutoutPath: {
        transitionProperty: ov.cutoutPath.transitionProperty,
        transitionDuration: ov.cutoutPath.transitionDuration,
      },
      overlayPath: {
        transitionProperty: ov.coverPath.transitionProperty,
        transitionDuration: ov.coverPath.transitionDuration,
      },
    },
  );
  check(
    "tooltip: role=dialog aria-modal=false, labelled/described ids resolve, no alertdialog",
    ov.tooltip.role === "dialog" &&
      ov.tooltip.ariaModal === "false" &&
      ov.tooltip.labelResolves &&
      ov.tooltip.descriptionResolves &&
      !ov.tooltip.alertdialogPresent,
    ov.tooltip,
  );
  check(
    "tooltip: Next / Skip / Pause tour rendered, counter 1 of 4",
    ov.tooltip.buttons.includes("Next") &&
      ov.tooltip.buttons.includes("Skip") &&
      ov.tooltip.buttons.includes("Pause tour") &&
      ov.tooltip.counter === "1 of 4",
    { buttons: ov.tooltip.buttons },
  );
  check(
    "focus: presenting with disableFocusTrap does not steal focus (activeElement is body)",
    ov.activeElement === "body" && !ov.activeInsideFloater,
    { activeElement: ov.activeElement },
  );
  const startEvents = await events();
  check(
    "events: tour:start, step:before, tooltip fired for index 0 with controlled:true",
    startEvents.some((e) => e.type === "tour:start") &&
      startEvents.some((e) => e.type === "step:before" && e.index === 0) &&
      startEvents.some((e) => e.type === "tooltip" && e.index === 0) &&
      startEvents.every((e) => e.controlled),
    { events: startEvents.map((e) => `${e.type}/${e.action}/${e.index}`) },
  );

  // ------------------------------------------------ 2. hit testing
  const send = await rectOf('[data-spike="send"]');
  const covered = await rectOf('[data-spike="covered"]');
  const sendHit = await hitAt(send.x, send.y);
  const coveredHit = await hitAt(covered.x, covered.y);
  await click(client, send.x, send.y);
  await delay(150);
  await click(client, covered.x, covered.y);
  await delay(250);
  let p = await probe();
  const afterCoveredClick = await events();
  check(
    "hit-test: exposed target (Send) is under the pointer through the hole and a real click reaches it",
    sendHit === "spike:send" && p.sendClicks === "1",
    { sendHit, sendClicks: p.sendClicks },
  );
  check(
    "hit-test: control outside the hole is covered by the overlay path; click swallowed, tour untouched (overlayClickAction:false)",
    coveredHit === "joyride-overlay-path" &&
      p.coveredClicks === "0" &&
      p.stepIndex === "0" &&
      p.run === "true" &&
      !afterCoveredClick.some(
        (e) => e.action === "close" || e.type === "step:after",
      ),
    {
      coveredHit,
      coveredRect: covered,
      coveredClicks: p.coveredClicks,
      stepIndex: p.stepIndex,
    },
  );
  await snap("02-hit-test");

  // ------------------------------------------------ 3. sonner over the tour
  await control("showToast()");
  await waitFor(
    client,
    "the toast",
    `Boolean(document.querySelector('[data-spike="toast-action"]'))`,
    30_000,
  );
  await delay(700);
  const toastAction = await rectOf('[data-spike="toast-action"]');
  const toastHit = await hitAt(toastAction.x, toastAction.y);
  await click(client, toastAction.x, toastAction.y);
  await delay(200);
  p = await probe();
  check(
    "sonner: toast action is under the pointer above the tour overlay and a real click registers",
    toastHit === "spike:toast-action" && p.toastClicks === "1",
    { toastHit, toastClicks: p.toastClicks },
  );
  await snap("03-sonner");

  // ------------------------------------------------ 4. keyboard / focus
  const editor = await rectOf('[data-spike="editor"]');
  await click(client, editor.x, editor.y);
  await delay(100);
  await client.send("Input.insertText", { text: "hello" });
  await delay(100);
  await pressTab();
  await delay(100);
  ov = await readOverlay();
  p = await probe();
  check(
    "keyboard: click in the hole focuses the editor, typing lands there, Tab reaches Send",
    p.editorValue === "hello" && ov.activeElement === "send",
    { editorValue: p.editorValue, activeAfterTab: ov.activeElement },
  );
  await evaluate(
    client,
    `document.querySelector('[data-action="primary"]').focus()`,
  );
  await pressTab();
  await delay(100);
  ov = await readOverlay();
  check(
    "keyboard: disableFocusTrap:true - Tab from the card's last button LEAVES the card (no trap)",
    !ov.activeInsideFloater,
    { activeAfterTab: ov.activeElement, insideFloater: ov.activeInsideFloater },
  );
  // Control arm: the trap ON must behave differently, or the check above is vacuous.
  await control("setDisableFocusTrap(false)");
  await delay(300);
  ov = await readOverlay();
  const trapAutofocused =
    ov.activeElement === "primary" && ov.activeInsideFloater;
  await evaluate(
    client,
    `document.querySelector('[data-action="primary"]').focus()`,
  );
  await pressTab();
  await delay(100);
  ov = await readOverlay();
  check(
    "keyboard (control arm): disableFocusTrap:false autofocuses Next and Tab wraps INSIDE the card",
    trapAutofocused && ov.activeInsideFloater,
    {
      autofocusedPrimary: trapAutofocused,
      activeAfterTab: ov.activeElement,
      insideFloater: ov.activeInsideFloater,
    },
  );
  await control("setDisableFocusTrap(true)");
  await delay(200);
  await evaluate(client, `document.activeElement.blur()`);

  // ------------------------------------------------ 5. controlled Next round trip
  await clearEvents();
  let next = await rectOf('[data-action="primary"]');
  await click(client, next.x, next.y);
  await waitForTooltip("2 of 4");
  await delay(400);
  const nextEvents = await events();
  p = await probe();
  const stepAfter = nextEvents.find((e) => e.type === "step:after");
  check(
    "controlled: Next -> step:after {action:next,index:0,origin:button_primary} -> app sets stepIndex 1 -> step 1 presents",
    stepAfter !== undefined &&
      stepAfter.action === "next" &&
      stepAfter.index === 0 &&
      stepAfter.origin === "button_primary" &&
      p.stepIndex === "1" &&
      nextEvents.some((e) => e.type === "tooltip" && e.index === 1),
    {
      stepAfter,
      stepIndex: p.stepIndex,
      events: nextEvents.map((e) => `${e.type}/${e.action}/${e.index}`),
    },
  );
  ov = await readOverlay();
  let column = await rectOf('[data-visible="true"] [data-spike="column"]');
  check(
    "function target: step 1 resolved the VISIBLE surface's column (hidden duplicate ignored); hole matches",
    rectsMatch(ov.cutout, column, 8),
    { cutout: ov.cutout, column },
  );
  await snap("04-step1-column");

  // ------------------------------------------------ 6. resize / translate / zero / detach
  await control("setColumnWidth(360)");
  await delay(200);
  ov = await readOverlay();
  column = await rectOf('[data-visible="true"] [data-spike="column"]');
  check(
    "geometry: style.width resize 240->360 - hole follows within 200ms",
    rectsMatch(ov.cutout, column, 8) && Math.round(column.width) === 360,
    { cutout: ov.cutout, column },
  );
  const floaterAfterResize = ov.floaterRect;
  observe("geometry: floater after resize (should sit right of the column)", {
    floaterLeft: floaterAfterResize.left,
    columnRight: column.left + column.width,
  });

  await control("setColumnOffset(80)");
  await delay(200);
  ov = await readOverlay();
  column = await rectOf('[data-visible="true"] [data-spike="column"]');
  const translationTracked = rectsMatch(ov.cutout, column, 8);
  // Expected to FAIL on react-joyride 3.2 (one-node ResizeObserver plus
  // scroll/resize listeners cannot see a pure translation). Recorded as a
  // hard FAIL rather than an observation because the gate asks for it; the
  // coordinator accepted the limitation on 2026-09-13.
  check(
    "geometry: equal-size translation (margin-left 80px, no size change) - hole follows within 200ms",
    translationTracked,
    {
      tracked: translationTracked,
      cutout: ov.cutout,
      column,
      floaterLeft: ov.floaterRect.left,
    },
  );
  await snap("05-translation");
  await evaluate(client, `window.dispatchEvent(new Event('resize'))`);
  await delay(200);
  ov = await readOverlay();
  check(
    "geometry: the same translation IS re-measured within 200ms of a window resize event (the escape hatch)",
    rectsMatch(ov.cutout, column, 8),
    { cutout: ov.cutout },
  );
  await control("setColumnOffset(0)");
  await delay(200);

  await control("setColumnZero(true)");
  await delay(200);
  ov = await readOverlay();
  p = await probe();
  check(
    "geometry: zero-sized target (resolver returns null per the plan's nonzero-box filter) -> no cutout path within 200ms, step not consumed",
    ov.overlayPresent && ov.pathCount === 1 && p.stepIndex === "1",
    { pathCount: ov.pathCount, cutout: ov.cutout, stepIndex: p.stepIndex },
  );
  observe(
    "geometry: zero-sized target - is the CARD still mounted while the resolver returns null? (Step only re-renders on a store change; the app's MutationObserver/epoch must re-present)",
    {
      floaterPresent: ov.floaterPresent,
      floaterOpacity: ov.floaterOpacity,
      floaterRect: ov.floaterRect,
      eventsSince: (await events())
        .slice(-3)
        .map((e) => `${e.type}/${e.action}/${e.index}`),
    },
  );
  await snap("06-zero-size");
  await control("setColumnZero(false)");
  await delay(200);
  ov = await readOverlay();
  column = await rectOf('[data-visible="true"] [data-spike="column"]');
  check(
    "geometry: target returns from zero size -> hole back on the column within 200ms",
    rectsMatch(ov.cutout, column, 8),
    { cutout: ov.cutout, column },
  );

  await control("setColumnDetached(true)");
  await delay(200);
  ov = await readOverlay();
  const rail = await rectOf('[data-spike="rail"]');
  p = await probe();
  check(
    "geometry: column unmounted -> function target resolves rail -> hole matches rail within 200ms, step not consumed",
    rectsMatch(ov.cutout, rail, 8) &&
      p.stepIndex === "1" &&
      p.targetNotFound === "0",
    { cutout: ov.cutout, rail, stepIndex: p.stepIndex },
  );
  const floaterOnRail = ov.floaterRect;
  const floaterFollowedRail =
    floaterOnRail.left >= rail.left + rail.width &&
    floaterOnRail.left < rail.left + rail.width + 80;
  observe(
    "geometry: does the CARD follow the column->rail swap too (floater left edge just right of the rail)?",
    { followed: floaterFollowedRail, floaterRect: floaterOnRail, rail },
  );
  await snap("07-rail-swap");
  await control("setColumnDetached(false)");
  await delay(200);
  ov = await readOverlay();
  column = await rectOf('[data-visible="true"] [data-spike="column"]');
  check(
    "geometry: rail -> column again - hole back on the column",
    rectsMatch(ov.cutout, column, 8),
    { cutout: ov.cutout, column },
  );

  // ------------------------------------------------ 7. dialog suspension (z-50)
  await clearEvents();
  await control("setDialogOpen(true)");
  await waitFor(
    client,
    "the dialog",
    `Boolean(document.querySelector('[data-spike="dialog"]'))`,
    30_000,
  );
  await delay(400);
  ov = await readOverlay();
  p = await probe();
  const suspendEvents = await events();
  check(
    "dialog: run=false while a modal is presented -> overlay and card unmounted",
    !ov.overlayPresent &&
      !ov.floaterPresent &&
      p.run === "false" &&
      p.stepIndex === "1",
    {
      overlayPresent: ov.overlayPresent,
      floaterPresent: ov.floaterPresent,
      run: p.run,
    },
  );
  observe(
    "dialog: events emitted by the suspension itself (run true->false) - note any step:after and its action",
    {
      events: suspendEvents.map(
        (e) => `${e.type}/${e.action}/${e.index}/${e.status}`,
      ),
    },
  );
  const dialogInput = await rectOf('[data-spike="dialog-input"]');
  const dialogHit = await hitAt(dialogInput.x, dialogInput.y);
  await click(client, dialogInput.x, dialogInput.y);
  await delay(100);
  await client.send("Input.insertText", { text: "/tmp" });
  await delay(100);
  const dialogInputValue = await evaluate(
    client,
    `document.querySelector('[data-spike="dialog-input"]').value`,
  );
  check(
    "dialog: z-50 Dialog is usable while the tour is suspended (click + type)",
    dialogHit === "spike:dialog-input" && dialogInputValue === "/tmp",
    { dialogHit, dialogInputValue },
  );
  await snap("08-dialog-open");
  // nested
  await control("setNestedOpen(true)");
  await waitFor(
    client,
    "the nested dialog",
    `Boolean(document.querySelector('[data-spike="nested-dialog"]'))`,
    30_000,
  );
  await delay(300);
  await control("setNestedOpen(false)");
  await delay(400);
  ov = await readOverlay();
  p = await probe();
  check(
    "dialog: closing the NESTED dialog does not resume the tour while the outer one is presented",
    !ov.overlayPresent && p.run === "false" && p.modalCount === "1",
    { overlayPresent: ov.overlayPresent, modalCount: p.modalCount },
  );
  // Esc closes the picker only. Two arms: `run` re-derived synchronously
  // from the modal count (the naive wiring) vs deferred by one macrotask.
  await control("setResumeDeferred(false)");
  await clearEvents();
  await pressEscape();
  await delay(500);
  p = await probe();
  const escSyncEvents = await events();
  const dialogGoneSync = await evaluate(
    client,
    `document.querySelector('[data-spike="dialog"]') === null`,
  );
  observe(
    "dialog (sync-resume arm): Esc closes the Dialog - does the SAME keystroke also reach the just-resumed tour as a CLOSE?",
    {
      dialogGone: dialogGoneSync,
      tourStatus: p.tourStatus,
      run: p.run,
      stepIndex: p.stepIndex,
      events: escSyncEvents.map(
        (e) => `${e.type}/${e.action}/${e.index}/${e.status}`,
      ),
    },
  );
  await control("setRun(true)");
  await waitForTooltip("2 of 4");
  await delay(200);
  await control("setResumeDeferred(true)");
  await control("setDialogOpen(true)");
  await waitFor(
    client,
    "the dialog again",
    `Boolean(document.querySelector('[data-spike="dialog"]'))`,
    30_000,
  );
  await delay(400);
  await clearEvents();
  await pressEscape();
  await delay(500);
  p = await probe();
  const escEvents = await events();
  const dialogGone = await evaluate(
    client,
    `document.querySelector('[data-spike="dialog"]') === null`,
  );
  check(
    "dialog (deferred-resume arm): Esc closes the Dialog only; tour resumes the SAME step, no CLOSE from the tour",
    dialogGone &&
      p.dialogOpen === "false" &&
      p.run === "true" &&
      p.stepIndex === "1" &&
      p.tourStatus === "active" &&
      !escEvents.some((e) => e.action === "close"),
    {
      dialogGone,
      stepIndex: p.stepIndex,
      run: p.run,
      tourStatus: p.tourStatus,
      events: escEvents.map((e) => `${e.type}/${e.action}/${e.index}`),
    },
  );
  await waitForTooltip("2 of 4");
  await delay(300);
  ov = await readOverlay();
  column = await rectOf('[data-visible="true"] [data-spike="column"]');
  check(
    "dialog: after resume the hole is back on the step-1 target",
    rectsMatch(ov.cutout, column, 8),
    { cutout: ov.cutout },
  );
  observe(
    "dialog: events emitted by resume (run false->true at the same stepIndex)",
    {
      events: escEvents.map(
        (e) => `${e.type}/${e.action}/${e.index}/${e.status}`,
      ),
    },
  );
  await snap("09-resumed");

  // ------------------------------------------------ 8. Esc on the tour itself -> pause
  await clearEvents();
  await pressEscape();
  await delay(400);
  p = await probe();
  ov = await readOverlay();
  const escTourEvents = await events();
  const escStepAfter = escTourEvents.find((e) => e.type === "step:after");
  check(
    "esc: dismissKeyAction close -> step:after {action:close, origin:keyboard} -> app pauses, stepIndex unchanged, overlay gone",
    escStepAfter !== undefined &&
      escStepAfter.action === "close" &&
      escStepAfter.origin === "keyboard" &&
      p.tourStatus === "paused" &&
      p.stepIndex === "1" &&
      !ov.overlayPresent,
    {
      escStepAfter,
      tourStatus: p.tourStatus,
      stepIndex: p.stepIndex,
      overlayPresent: ov.overlayPresent,
    },
  );
  await control("setRun(true)");
  await waitForTooltip("2 of 4");
  check("esc: resume after pause re-presents the same step", true);

  // ------------------------------------------------ 9. scroll: normal vs reduced motion
  await clearEvents();
  next = await rectOf('[data-action="primary"]');
  await click(client, next.x, next.y);
  await waitForTooltip("3 of 4");
  await delay(200);
  let scrollEvents = (await events()).filter((e) =>
    e.type.startsWith("scroll:"),
  );
  const normalScroll =
    scrollEvents.length >= 2
      ? {
          duration: scrollEvents[0].scrollDuration,
          elapsedMs:
            scrollEvents[scrollEvents.length - 1].at - scrollEvents[0].at,
          scrollY: (await readOverlay()).scrollY,
        }
      : null;
  check(
    "scroll: step 2 (below the fold) scrolled with scrollDuration 300 under normal motion",
    normalScroll !== null &&
      normalScroll.duration === 300 &&
      normalScroll.scrollY > 0,
    normalScroll,
  );
  await snap("10-step2-scrolled");
  // Reduced motion: motion's `useReducedMotion` samples the media query
  // once per mount, so the preference is emulated BEFORE a fresh page load
  // (which is also how a real OS preference reaches the app).
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await client.send("Page.navigate", { url: pageUrl });
  await waitFor(
    client,
    "the reloaded harness",
    `Boolean(window.__joyrideSpike) && document.querySelector('#probe-state')?.dataset.reducedMotion === 'true'`,
    30_000,
  );
  await waitForTooltip("1 of 4");
  await delay(400);
  ov = await readOverlay();
  check(
    "reduced motion: harness reads prefers-reduced-motion via motion/react useReducedMotion",
    ov.tooltip !== null,
    { reducedMotion: (await probe()).reducedMotion },
  );
  await control("setStepIndex(1)");
  await waitForTooltip("2 of 4");
  await delay(300);
  ov = await readOverlay();
  const transitionOff = (path) =>
    path !== null &&
    (path.transitionProperty === "none" ||
      Number.parseFloat(path.transitionDuration) === 0);
  check(
    "reduced motion: scoped CSS override removes the transition on BOTH spotlight paths (outer overlay path and cutout cover path)",
    transitionOff(ov.coverPath) && transitionOff(ov.cutoutPath),
    {
      overlayPath:
        ov.coverPath === null
          ? null
          : {
              transitionProperty: ov.coverPath.transitionProperty,
              transitionDuration: ov.coverPath.transitionDuration,
            },
      cutoutPath:
        ov.cutoutPath === null
          ? null
          : {
              transitionProperty: ov.cutoutPath.transitionProperty,
              transitionDuration: ov.cutoutPath.transitionDuration,
            },
    },
  );
  check(
    "reduced motion: styles.floater/overlay transition none",
    ov.floaterTransition === "none" && ov.overlayTransition === "none",
    { floater: ov.floaterTransition, overlay: ov.overlayTransition },
  );
  await clearEvents();
  next = await rectOf('[data-action="primary"]');
  await click(client, next.x, next.y);
  await waitForTooltip("3 of 4");
  await delay(200);
  scrollEvents = (await events()).filter((e) => e.type.startsWith("scroll:"));
  const reducedScroll =
    scrollEvents.length >= 2
      ? {
          duration: scrollEvents[0].scrollDuration,
          elapsedMs:
            scrollEvents[scrollEvents.length - 1].at - scrollEvents[0].at,
        }
      : null;
  check(
    "reduced motion: scrollDuration 0 -> scroll:start/end report duration 0",
    reducedScroll !== null && reducedScroll.duration === 0,
    reducedScroll,
  );
  observe(
    "reduced motion: scroll wall time normal vs reduced (upstream floors any <100px scroll at 50ms)",
    { normal: normalScroll, reduced: reducedScroll },
  );
  await snap("11-reduced-motion");

  // ------------------------------------------------ 10. narrow viewport
  await setViewport(480, 600);
  await control("setStepIndex(0)");
  await waitForTooltip("1 of 4");
  await delay(500);
  ov = await readOverlay();
  const fr = ov.floaterRect;
  check(
    "narrow viewport 480x600: card (placement top, composer target) stays fully inside the viewport",
    fr !== null &&
      fr.left >= 0 &&
      fr.top >= 0 &&
      fr.right <= 480 &&
      fr.bottom <= 600,
    { floaterRect: fr, scrollY: ov.scrollY },
  );
  await snap("12-narrow-viewport");
  await control("setStepIndex(1)");
  await waitForTooltip("2 of 4");
  await delay(400);
  ov = await readOverlay();
  const fr1 = ov.floaterRect;
  check(
    "narrow viewport 480x600: card (placement right, column target) stays fully inside the viewport (flip/shift)",
    fr1 !== null &&
      fr1.left >= 0 &&
      fr1.top >= 0 &&
      fr1.right <= 480 &&
      fr1.bottom <= 600,
    { floaterRect: fr1, cutout: ov.cutout },
  );
  await snap("12b-narrow-viewport-column");
  await setViewport(1200, 800);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "" }],
  });
  await delay(400);

  // ------------------------------------------------ 11. missing target keeps the step
  await clearEvents();
  const missingEnteredAt = await evaluate(
    client,
    `(() => { window.__joyrideSpike.setStepIndex(3); return Math.round(performance.now()); })()`,
  );
  await delay(600);
  p = await probe();
  ov = await readOverlay();
  const loaderAt600 = await evaluate(
    client,
    `Boolean(document.querySelector('[data-testid="loader"], .react-joyride__loader'))`,
  );
  observe(
    "missing target: state 600ms into the 8s wait (loader shown after loaderDelay 300ms?)",
    {
      stepIndex: p.stepIndex,
      overlayPresent: ov.overlayPresent,
      pathCount: ov.pathCount,
      floaterPresent: ov.floaterPresent,
      loaderPresent: loaderAt600,
      targetNotFound: p.targetNotFound,
    },
  );
  await snap("13-missing-waiting");
  await waitFor(
    client,
    "target_not_found after targetWaitTimeout 8000",
    `document.querySelector('#probe-state').dataset.targetNotFound === '1'`,
    12_000,
  );
  const waitEvents = await events();
  const tnf = waitEvents.find((e) => e.type === "error:target_not_found");
  p = await probe();
  ov = await readOverlay();
  // Both stamps are page `performance.now()` values: `missingEnteredAt` was
  // taken in the same evaluate call that set the controlled index.
  const msAfterStepEntry = tnf === undefined ? null : tnf.at - missingEnteredAt;
  check(
    "missing target: error:target_not_found fired 8000-9000ms after step entry (targetWaitTimeout 8000, 100ms poll) and the controlled index stayed at 3",
    tnf !== undefined &&
      tnf.index === 3 &&
      p.stepIndex === "3" &&
      tnf.controlled &&
      msAfterStepEntry !== null &&
      msAfterStepEntry >= 8000 &&
      msAfterStepEntry <= 9000,
    {
      tnf,
      stepIndex: p.stepIndex,
      msAfterStepEntry,
      eventsDuringWait: waitEvents.map(
        (e) => `${e.type}/${e.action}/${e.index}`,
      ),
    },
  );
  observe(
    "missing target: what Joyride renders AFTER the timeout in controlled mode (the app must swap in the unanchored fallback step)",
    {
      overlayPresent: ov.overlayPresent,
      pathCount: ov.pathCount,
      floaterPresent: ov.floaterPresent,
      tourStatus: p.tourStatus,
    },
  );
  await snap("14-missing-timed-out");

  // ------------------------------------------------ 12. Skip
  await control("setStepIndex(0)");
  await waitForTooltip("1 of 4");
  await clearEvents();
  const skip = await rectOf('[data-action="skip"]');
  await click(client, skip.x, skip.y);
  await delay(400);
  p = await probe();
  ov = await readOverlay();
  const skipEvents = await events();
  check(
    "skip: Skip -> tour:end {action:skip, status:skipped} -> app ends, overlay gone",
    skipEvents.some(
      (e) =>
        e.type === "tour:end" && e.action === "skip" && e.status === "skipped",
    ) &&
      p.tourStatus === "skipped" &&
      !ov.overlayPresent,
    {
      tourStatus: p.tourStatus,
      events: skipEvents.map((e) => `${e.type}/${e.action}/${e.status}`),
    },
  );
  observe(
    "skip: does Skip emit a step:after at all? (plan wires ACTIONS.SKIP off step:after)",
    {
      stepAfterEmitted: skipEvents.some((e) => e.type === "step:after"),
      events: skipEvents.map((e) => `${e.type}/${e.action}/${e.status}`),
    },
  );
  // Control arm for the covered-control check: with the tour gone the same click must register.
  const coveredNow = await rectOf('[data-spike="covered"]');
  await click(client, coveredNow.x, coveredNow.y);
  await delay(200);
  p = await probe();
  check(
    "hit-test (control arm): with the overlay gone the covered control receives the same click",
    p.coveredClicks === "1",
    { coveredClicks: p.coveredClicks },
  );
  await snap("15-skipped");
} catch (error) {
  console.error("SPIKE DRIVER FAILED:", error);
  process.exitCode = 1;
} finally {
  const failed = results.filter((r) => r.kind === "check" && !r.ok);
  console.log(
    `\n${results.filter((r) => r.kind === "check" && r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.kind === "observe").length} observations`,
  );
  if (failed.length > 0) process.exitCode = 1;
  if (outDir !== null) {
    await writeFile(
      path.join(outDir, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
  client?.close();
  if (chrome !== undefined) {
    await terminateProcessTree(chrome);
  }
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

async function setViewport(width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function pressTab() {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
}

async function pressEscape() {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early: ${readError()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(150);
  }
  throw new Error(`${label} did not become reachable: ${readError()}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(
      () => reject(new Error("CDP connect timed out")),
      15_000,
    );
    socket.addEventListener("error", (event) =>
      reject(new Error(String(event))),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(message.error.message));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params) {
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            pending.set(id, { resolve: requestResolve, reject: requestReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

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
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

async function waitFor(client, label, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    client,
    `({ text: document.body.innerText.slice(0, 1500), probe: Object.fromEntries(Object.entries(document.querySelector('#probe-state')?.dataset ?? {})) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}

async function click(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
