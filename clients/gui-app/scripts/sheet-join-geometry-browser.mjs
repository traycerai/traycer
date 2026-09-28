// Browser regression: the "sheet join" arcs (the concave corners that stitch
// a joined tab - a side strip's active row/tile/split pair, or the top
// header's active tab - onto its task's sheet) land at the bridge's true
// inner edge, not 1px short of it.
//
// `src/index.css`'s `:has([data-sheet-joined=...]) > [data-sheet-join-bridge=...]`
// rules position each arc's `::before`/`::after` pseudo-element with a plain
// percentage offset. The bridge itself carries a 1px border
// (`border-block`/`border-inline`), and an absolutely positioned pseudo's
// containing block is its host's PADDING box - so an offset of
// `calc(100% - 1px)` (the bug) lands the arc's edge 1 CSS px inside the
// bridge, short of the padding box's true edge; the fix is a plain `100%`.
// jsdom has no anchor positioning, no real border resolution and no pseudo
// geometry, so this renders the real fixture in headless Chrome and reads
// `getComputedStyle(bridge, "::before"/"::after")`'s resolved offsets - which
// Chrome reports as used-value px, not the raw `calc()`/`%` - against the
// bridge's own measured padding box.
//
// Usage: node scripts/sheet-join-geometry-browser.mjs [--offsets | --corners]
//   Runs both suites against its own Vite by default.
//   --offsets   only the offsets suite (arcs on the bridge's true inner edge)
//               - see `runOffsets`.
//   --corners   only the seam suite (flush surface: arcs must land on the
//               surface frame's own seam line - its border on the tab-facing
//               edge - never past it, plus the top strip's first (Home) and
//               scrolled-to-last tab) - see `runCorners` - and the arcs'
//               anti-aliasing - see `runArcAntialiasCheck`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { openTabSession } from "./cdp-client.mjs";

// The bug is a full 1px error; this tolerance cleanly separates broken from
// fixed while allowing for legitimate sub-pixel layout rounding across DPRs.
const EPSILON = 0.025;
/**
 * The device pixel ratios every join is measured at: rounding is the only
 * thing that differs between them. A theme or preset recolours the join and
 * moves none of its offsets (no preset carries a radius or border token).
 */
const DPRS = [1, 1.5, 2];
/**
 * The first boot's ceiling (`warmUp`): about ten times a laptop's cold boot,
 * so a slow runner still fits and a reload loop still ends.
 */
const WARM_UP_CAP_MS = 180_000;

/**
 * The join variants to cover. `kind` picks which pair of invariants applies
 * (top: ::before's right / ::after's left, against the bridge's padding-box
 * WIDTH; side: ::before's bottom / ::after's top, against its HEIGHT).
 * `bridge` is both the `[data-sheet-join-bridge=...]` and
 * `[data-sheet-joined=...]` attribute value to match. Every side query
 * carries `header=app&surface=epic` explicitly - without it the joined pane
 * this fixture activates does not exist. Strip/panel collapse state is always
 * set explicitly through the probe (`setCollapsed`/`setPanelCollapsed`)
 * rather than left to a query-param default, for every variant below.
 */
function sideVariants(tabSide, panelSide) {
  const sameSide = panelSide === tabSide;
  const query = `tabs=${tabSide}&sidebar=${panelSide}&header=app&surface=epic`;
  const label = `tabs=${tabSide} sidebar=${panelSide} (${sameSide ? "same" : "far"})`;
  return [
    {
      label: `${label}, strip expanded`,
      query,
      kind: "side",
      bridge: tabSide,
      activate: activateEpsilon,
      extra: (client) => setCollapsed(client, false),
    },
    {
      label: `${label}, strip collapsed`,
      query: `${query}&collapsed=1`,
      kind: "side",
      bridge: tabSide,
      activate: activateEpsilon,
      extra: (client) => setCollapsed(client, true),
    },
    // Same-side panel, collapsed to its rail, crossed with both strip states.
    ...(sameSide
      ? [
          {
            label: `${label}, strip expanded, panel collapsed`,
            query,
            kind: "side",
            bridge: tabSide,
            activate: activateEpsilon,
            extra: async (client) => {
              await setCollapsed(client, false);
              await setPanelCollapsed(client, true);
            },
          },
          {
            label: `${label}, strip collapsed, panel collapsed`,
            query: `${query}&collapsed=1`,
            kind: "side",
            bridge: tabSide,
            activate: activateEpsilon,
            extra: async (client) => {
              await setCollapsed(client, true);
              await setPanelCollapsed(client, true);
            },
          },
        ]
      : []),
    {
      label: `${label}, split pair, strip expanded`,
      query,
      kind: "side",
      bridge: tabSide,
      activate: activateSplit,
      extra: (client) => setCollapsed(client, false),
    },
    {
      label: `${label}, split pair, strip collapsed`,
      query: `${query}&collapsed=1`,
      kind: "side",
      bridge: tabSide,
      activate: activateSplit,
      extra: (client) => setCollapsed(client, true),
    },
  ];
}

const VARIANTS = [
  ...sideVariants("left", "left"),
  ...sideVariants("left", "right"),
  ...sideVariants("right", "left"),
  ...sideVariants("right", "right"),
  {
    label: "top normal",
    query: "tabs=top&header=app&surface=epic",
    kind: "top",
    bridge: "top",
    activate: activateEpsilon,
  },
  {
    label: "top home",
    query: "tabs=top&header=app&surface=epic",
    kind: "top",
    bridge: "top",
    activate: activateHome,
  },
  {
    label: "top split",
    query: "tabs=top&header=app&surface=epic",
    kind: "top",
    bridge: "top",
    activate: activateSplit,
  },
];

/** [corners mode] One representative case per bridge; see `runCorners`. */
const CORNER_VARIANTS = [
  {
    label: "top single",
    query: "tabs=top&header=app&surface=epic",
    bridge: "top",
    activate: activateFirstSingle,
  },
  {
    label: "top split",
    query: "tabs=top&header=app&surface=epic",
    bridge: "top",
    activate: activateFirstSplit,
  },
  {
    label: "top home",
    query: "tabs=top&header=app&surface=epic",
    bridge: "top",
    activate: activateHome,
  },
  {
    label: "left single",
    query: "tabs=left&sidebar=left&header=app&surface=epic",
    bridge: "left",
    activate: activateFirstSingle,
  },
  {
    label: "left split",
    query: "tabs=left&sidebar=left&header=app&surface=epic",
    bridge: "left",
    activate: activateFirstSplit,
  },
  {
    label: "right single",
    query: "tabs=right&sidebar=right&header=app&surface=epic",
    bridge: "right",
    activate: activateFirstSingle,
  },
  {
    label: "right split",
    query: "tabs=right&sidebar=right&header=app&surface=epic",
    bridge: "right",
    activate: activateFirstSplit,
  },
];
/**
 * [corners mode] One middle row per bridge, so both arcs are clear of the
 * strip's ends, across the three fills a join takes (canvas, panel, and the
 * top strip's canvas).
 */
const ARC_VARIANTS = [
  {
    label: "left arcs, canvas",
    query: "tabs=left&sidebar=right&header=app&surface=epic",
    bridge: "left",
  },
  {
    label: "right arcs, panel",
    query: "tabs=right&sidebar=right&header=app&surface=epic",
    bridge: "right",
  },
  {
    label: "top arcs",
    query: "tabs=top&header=app&surface=epic",
    bridge: "top",
  },
];
/** Where each arc's centre sits in its box, per bridge (`index.css`). */
const ARC_CENTRES = {
  top: {
    before: { right: false, bottom: false },
    after: { right: true, bottom: false },
  },
  left: {
    before: { right: false, bottom: false },
    after: { right: false, bottom: true },
  },
  right: {
    before: { right: true, bottom: false },
    after: { right: true, bottom: true },
  },
};

/** In-page: a base64 PNG's pixels, as `at(x, y)` rgb triples. */
const decodePngSource = `async (data) => {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve);
    image.addEventListener("error", () => reject(new Error("decode failed")));
    image.src = "data:image/png;base64," + data;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data: bytes, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const at = (x, y) => { const i = (y * width + x) * 4; return [bytes[i], bytes[i + 1], bytes[i + 2]]; };
  return { at, width, height };
}`;

const TOKEN_OVERRIDE_CSS =
  ":root { --shell-gap: 10px; --radius-xl: 16px; --radius-lg: 12px; }";

async function activateEpsilon(client) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.activateEpicTab('fixture-epsilon')`,
  );
}

async function activateSplit(client) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.activateStripItem('fixture-split')`,
  );
}

async function activateHome(client) {
  // Home is hidden by default in this fixture; a naive geometry check would
  // then find no `[data-sheet-joined]`/`[data-sheet-join-bridge]` pair at
  // all and could silently no-op instead of asserting anything.
  await evaluate(
    client,
    `import('/src/stores/layout/layout-store.ts').then(m => m.useLayoutStore.getState().setRegionValues('homeTab', { shown: 'shown' }))`,
  );
  await evaluate(client, `window.__layoutCanvasProbe.activateStripItem(null)`);
}

async function setHomeShown(client, shown) {
  await evaluate(
    client,
    `import('/src/stores/layout/layout-store.ts').then((m) => m.useLayoutStore.getState().setRegionValues('homeTab', { shown: ${JSON.stringify(shown ? "shown" : "hidden")} }))`,
  );
}

async function moveItemFirst(client, itemId) {
  await evaluate(
    client,
    `import('/src/stores/tabs/store.ts').then((m) => {
      m.useTabsStore.setState((state) => {
        const idx = state.items.findIndex((item) => item.id === ${JSON.stringify(itemId)});
        if (idx <= 0) return {};
        const item = state.items[idx];
        const without = state.items.filter((_entry, i) => i !== idx);
        return { items: [item, ...without], groups: {}, customizations: {} };
      });
    })`,
  );
}

async function activateFirstSingle(client) {
  await setHomeShown(client, false);
  await moveItemFirst(client, "tab:epic:fixture-alpha");
  await evaluate(
    client,
    `window.__layoutCanvasProbe.activateEpicTab('fixture-alpha')`,
  );
}

async function activateFirstSplit(client) {
  await setHomeShown(client, false);
  await moveItemFirst(client, "fixture-split");
  await activateSplit(client);
}

async function setCollapsed(client, collapsed) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.setCollapsed(${JSON.stringify(collapsed)})`,
  );
}

async function setPanelCollapsed(client, collapsed) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.setPanelCollapsed(${JSON.stringify(collapsed)})`,
  );
}

async function setThemeMode(client, theme) {
  await evaluate(
    client,
    `window.__layoutCanvasProbe.setTheme(${JSON.stringify(theme)})`,
  );
}

const TOKEN_OVERRIDE_STYLE_ID = "sheet-join-corner-token-override";

async function injectStyle(client, css) {
  await evaluate(
    client,
    `{
      const el = document.createElement("style");
      el.id = ${JSON.stringify(TOKEN_OVERRIDE_STYLE_ID)};
      el.textContent = ${JSON.stringify(css)};
      document.head.append(el);
    }`,
  );
}

async function removeInjectedStyle(client) {
  await evaluate(
    client,
    `document.getElementById(${JSON.stringify(TOKEN_OVERRIDE_STYLE_ID)})?.remove()`,
  );
}

/**
 * Shared by `measureExpression` and `cornerMeasureExpression`: `bridge`/
 * `bridgeBox` must already be in scope. Computes the bridge's own padding
 * box (an absolutely positioned pseudo's containing block) and its
 * `::before`/`::after` computed styles, plus `resolveAxis`, which turns a
 * pseudo's resolved offset(s) (Chrome reports these as used-value px, never
 * the raw `calc()`/`%`, for a positioned pseudo) into that pseudo's actual
 * page-space start/end edge along one axis. Declared before the top-level
 * `try` below (not beside its own builder functions further down) because
 * this script runs top-level `await`s in file order - a `const` declared
 * after `try` would still be in its temporal dead zone when a function
 * invoked from inside `try` first reads it.
 */
const AXIS_HELPERS = `
    const bridgeStyle = getComputedStyle(bridge);
    const borders = {
      top: parseFloat(bridgeStyle.borderTopWidth),
      right: parseFloat(bridgeStyle.borderRightWidth),
      bottom: parseFloat(bridgeStyle.borderBottomWidth),
      left: parseFloat(bridgeStyle.borderLeftWidth),
    };
    const paddingBox = {
      left: bridgeBox.left + borders.left,
      top: bridgeBox.top + borders.top,
      right: bridgeBox.right - borders.right,
      bottom: bridgeBox.bottom - borders.bottom,
    };
    const parseOffset = (raw) => {
      if (raw === "auto") return null;
      const value = parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    };
    const resolveAxis = (startRaw, endRaw, size, cbStart, cbEnd) => {
      const start = parseOffset(startRaw);
      const end = parseOffset(endRaw);
      if (start !== null && end !== null) return { start: cbStart + start, end: cbEnd - end };
      if (start !== null) return { start: cbStart + start, end: cbStart + start + size };
      if (end !== null) return { start: cbEnd - end - size, end: cbEnd - end };
      return { start: cbStart, end: cbStart + size };
    };
    const before = getComputedStyle(bridge, "::before");
    const after = getComputedStyle(bridge, "::after");
`;

const suites = process.argv.includes("--offsets")
  ? ["offsets"]
  : process.argv.includes("--corners")
    ? ["corners"]
    : ["offsets", "corners"];
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePath = "/src/__tests__/browser/layout-editor-canvas.html";
const chromePath = await findChrome("the sheet join geometry regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
/** Fixture loads retried after a stalled boot; see `openFixture`. */
let stalledBootRetries = 0;

try {
  const baseUrl = `http://127.0.0.1:${vitePort}${fixturePath}`;
  viteProcess = await spawnVite(vitePort);
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(baseUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-sheet-join-",
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
  client = await openTabSession(launched.devtoolsHttpUrl);
  await warmUp(client, `${baseUrl}?${VARIANTS[0].query}`);

  // Every selected suite runs even after one fails, so one run reports both.
  const failures = [];
  for (const suite of suites) {
    try {
      if (suite === "offsets") await runOffsets(client, baseUrl);
      else await runCorners(client, baseUrl);
    } catch (error) {
      failures.push(error);
    }
  }
  if (stalledBootRetries > 1)
    failures.push(
      new Error(
        `${stalledBootRetries} fixture loads stalled and were retried in a fresh tab; one is tolerated, a repeat is a regression (see openFixture)`,
      ),
    );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Both sheet join suites failed");
} finally {
  await client?.close();
  if (chrome !== undefined) await terminateProcessTree(chrome);
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

/** [offsets mode] The bug this file was written for: arcs 1px short of the bridge's true inner edge. */
async function runOffsets(client, baseUrl) {
  const violations = [];
  let combinations = 0;

  for (const variant of VARIANTS) {
    await openFixture(client, `${baseUrl}?${variant.query}`, variant.label);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await variant.activate(client);
    if (variant.extra !== undefined) await variant.extra(client);
    await settle(client);

    const bridgeSelector = `[data-sheet-join-bridge="${variant.bridge}"]`;
    const joinedSelector = `[data-sheet-joined="${variant.bridge}"]`;
    // Every variant, Home included, must find a matching joined element and
    // bridge with real size before geometry is asserted on it - otherwise a
    // variant whose join never rendered would silently contribute zero
    // assertions and read as passing.
    await waitFor(
      client,
      `the ${variant.label} join to render`,
      joinPresenceExpression(bridgeSelector, joinedSelector),
    );

    for (const dpr of DPRS) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1400,
        height: 860,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await settle(client);
      combinations += 1;
      const where = `${variant.label} / dpr=${dpr}`;
      const result = await evaluate(
        client,
        measureExpression(bridgeSelector, joinedSelector, variant.kind),
      );
      if (!result.present) {
        violations.push(`${where}: no matching join rendered`);
        continue;
      }
      for (const violation of result.violations) {
        violations.push(`${where}: ${violation}`);
      }
    }
  }

  console.log(
    `${VARIANTS.length} variants x ${DPRS.length} DPRs = ${combinations} combinations measured`,
  );
  assert.deepEqual(
    violations,
    [],
    `Sheet join geometry regression failed:\n${violations.join("\n")}`,
  );
  console.log("sheet join geometry regression passed");
}

/**
 * [corners mode / flush surface] A visible arc's OUTER edge must never land
 * past the surface FRAME's own bounds (`[data-tab-edge]`, the
 * `task-surface-frame` element itself - both top and side bridges anchor to
 * it via `--task-frame`). The frame draws one seam line, on the edge facing
 * the tabs, with no radius left to carve a corner out of - so "past the
 * joined sheet's own corner radius" (the pre-flush-surface invariant) is now
 * just "past the frame's own edge on the flare axis": the seam runs straight
 * the whole way, and an arc that overshoots it has overshot the surface it is
 * supposed to land on. Re-run with `--shell-gap`/`--radius-xl`/`--radius-lg`
 * enlarged to prove the bound still holds as the join's own `--join-radius`
 * (`--radius-lg`) grows the arcs. Also checks that a partially clipped active
 * top tab unjoins and rejoins, and that the strip's first (Home) and
 * scrolled-to-last tabs still land on the seam at both ends of the strip.
 */
async function runCorners(client, baseUrl) {
  const violations = [];
  const measure = (bridgeSelector, joinedSelector, bridge) =>
    evaluate(
      client,
      cornerMeasureExpression(bridgeSelector, joinedSelector, bridge),
    );
  const record = (where, result) => {
    if (!result.present) {
      violations.push(`${where}: no matching join rendered`);
      return;
    }
    for (const violation of result.violations)
      violations.push(`${where}: ${violation}`);
  };

  for (const variant of CORNER_VARIANTS) {
    await openFixture(client, `${baseUrl}?${variant.query}`, variant.label);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await variant.activate(client);
    await settle(client);

    const bridgeSelector = `[data-sheet-join-bridge="${variant.bridge}"]`;
    const joinedSelector = `[data-sheet-joined="${variant.bridge}"]`;
    await waitFor(
      client,
      `the ${variant.label} join to render`,
      joinPresenceExpression(bridgeSelector, joinedSelector),
    );

    for (const dpr of DPRS) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1400,
        height: 860,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await settle(client);
      record(
        `${variant.label} dpr=${dpr}`,
        await measure(bridgeSelector, joinedSelector, variant.bridge),
      );
    }

    await injectStyle(client, TOKEN_OVERRIDE_CSS);
    for (const dpr of DPRS) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1400,
        height: 860,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await settle(client);
      record(
        `${variant.label} (enlarged tokens) dpr=${dpr}`,
        await measure(bridgeSelector, joinedSelector, variant.bridge),
      );
    }
    await removeInjectedStyle(client);
  }
  console.log(
    `${CORNER_VARIANTS.length} corner variants x 2 (default + enlarged tokens) x ${DPRS.length} DPRs measured`,
  );

  await runTopClipRejoinCheck(client, baseUrl, violations);
  await runSideEdgeExtremesCheck(client, baseUrl, violations);
  await runTopEdgeExtremesCheck(client, baseUrl, violations);
  await runArcAntialiasCheck(client, baseUrl, violations);

  assert.deepEqual(
    violations,
    [],
    `Sheet join corner regression failed:\n${violations.join("\n")}`,
  );
  console.log("sheet join corner regression passed");
}

/**
 * [corners mode] The arcs are anti-aliased: each concave corner's box, read
 * off a screenshot at the device's own resolution, holds a band of blended
 * pixels along both edges of its outline ring, as every convex corner does.
 * Each pixel is either one of the three flat colours the corner is drawn
 * from (what shows through it, the outline, the fill) or a blend of them. A
 * hard-stop gradient (the bug) paints only flat colours, so its arc
 * stair-steps: not one blended pixel at DPR 1 or 2 (at 1.5 the gradient is
 * resampled, which blurs rather than anti-aliases it). A rounded box blends
 * the ring's two edges; half a pixel per CSS px of radius is a floor the
 * light theme, whose three colours sit within 27 levels, still clears. The
 * outermost device pixel on each side is skipped: the box's own edge is not
 * the arc.
 */
async function runArcAntialiasCheck(client, baseUrl, violations) {
  let measured = 0;
  for (const variant of ARC_VARIANTS) {
    await openFixture(client, `${baseUrl}?${variant.query}`, variant.label);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await activateEpsilon(client);
    await settle(client);
    const bridgeSelector = `[data-sheet-join-bridge="${variant.bridge}"]`;
    await waitFor(
      client,
      `the ${variant.label} join to render`,
      joinPresenceExpression(
        bridgeSelector,
        `[data-sheet-joined="${variant.bridge}"]`,
      ),
    );
    for (const theme of ["light", "dark"]) {
      await setThemeMode(client, theme);
      for (const dpr of DPRS) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: 1400,
          height: 860,
          deviceScaleFactor: dpr,
          mobile: false,
        });
        await settle(client);
        const where = `${variant.label} / ${theme} / dpr=${dpr}`;
        const arcs = await evaluate(client, arcBoxesExpression(variant.bridge));
        if (arcs === null) {
          violations.push(`${where}: no bridge to read the arcs of`);
          continue;
        }
        const outline = await swatchPixel(client, "var(--canvas-border)");
        const fill = await swatchPixel(client, arcs.fill);
        for (const arc of arcs.boxes) {
          // The box widened to whole device pixels, so the capture is not
          // resampled; its outermost pixel is skipped below.
          const snap = (v, round) => round(v * dpr) / dpr;
          const x = snap(arc.box.x, Math.floor);
          const y = snap(arc.box.y, Math.floor);
          const shot = await client.send("Page.captureScreenshot", {
            format: "png",
            clip: {
              x,
              y,
              width: snap(arc.box.x + arc.box.width, Math.ceil) - x,
              height: snap(arc.box.y + arc.box.height, Math.ceil) - y,
              scale: 1,
            },
            captureBeyondViewport: false,
          });
          const blended = await evaluate(
            client,
            arcBlendExpression(shot.data, arc.corner, outline, fill),
          );
          const needed = Math.floor((arc.box.width * dpr) / 2);
          measured += 1;
          if (blended < needed)
            violations.push(
              `${where}: the ${arc.pseudo} arc has ${blended} blended device pixels, fewer than ${needed}: its outline and fill are not anti-aliased`,
            );
        }
      }
    }
  }
  console.log(`${measured} arcs checked for anti-aliasing`);
}

/**
 * [corners mode] Each arc's box in page px, with the corner the arc's
 * centre sits at (away from the bridge and the sheet, where the backdrop
 * shows through), plus the bridge's own fill.
 */
function arcBoxesExpression(side) {
  return `(() => {
    const bridge = document.querySelector('[data-sheet-join-bridge="${side}"]');
    if (bridge === null) return null;
    const bridgeBox = bridge.getBoundingClientRect();
    if (bridgeBox.width === 0 || bridgeBox.height === 0) return null;
    ${AXIS_HELPERS}
    const box = (style) => {
      const x = resolveAxis(style.left, style.right, parseFloat(style.width), paddingBox.left, paddingBox.right);
      const y = resolveAxis(style.top, style.bottom, parseFloat(style.height), paddingBox.top, paddingBox.bottom);
      return { x: x.start, y: y.start, width: x.end - x.start, height: y.end - y.start };
    };
    return {
      fill: bridgeStyle.backgroundColor,
      boxes: [
        { pseudo: "::before", box: box(before), corner: ${JSON.stringify(ARC_CENTRES[side].before)} },
        { pseudo: "::after", box: box(after), corner: ${JSON.stringify(ARC_CENTRES[side].after)} },
      ],
    };
  })()`;
}

/** A colour as the screenshot paints it, off a swatch laid over the page. */
async function swatchPixel(client, cssColor) {
  await evaluate(
    client,
    `{
      const node = document.createElement("div");
      node.id = "sheet-join-swatch";
      Object.assign(node.style, { position: "fixed", left: "0px", top: "0px", width: "8px", height: "8px", zIndex: "2147483000", background: ${JSON.stringify(cssColor)} });
      document.body.append(node);
    }`,
  );
  await settle(client);
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 2, y: 2, width: 4, height: 4, scale: 1 },
    captureBeyondViewport: false,
  });
  const pixel = await evaluate(
    client,
    `(${decodePngSource})(${JSON.stringify(shot.data)}).then(({ at }) => at(1, 1))`,
  );
  await evaluate(
    client,
    `document.getElementById("sheet-join-swatch")?.remove()`,
  );
  return pixel;
}

/**
 * In-page: how many of an arc crop's inner pixels are none of its three flat
 * colours. The backdrop is read just inside the arc's centre corner.
 */
function arcBlendExpression(png, corner, outline, fill) {
  return `(${decodePngSource})(${JSON.stringify(png)}).then(({ at, width, height }) => {
    const backdrop = at(${corner.right ? "width - 2" : "1"}, ${corner.bottom ? "height - 2" : "1"});
    const flats = [backdrop, ${JSON.stringify(outline)}, ${JSON.stringify(fill)}];
    const flat = (p) => flats.some((c) => Math.max(...c.map((v, i) => Math.abs(v - p[i]))) <= 1);
    let blended = 0;
    for (let y = 1; y < height - 1; y += 1)
      for (let x = 1; x < width - 1; x += 1) if (!flat(at(x, y))) blended += 1;
    return blended;
  })`;
}

async function runTopClipRejoinCheck(client, baseUrl, violations) {
  const label = "top overflow/clip";
  await openFixture(
    client,
    `${baseUrl}?tabs=top&header=app&surface=epic`,
    label,
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await setHomeShown(client, false);
  await evaluate(
    client,
    `window.__layoutCanvasProbe.activateEpicTab('fixture-alpha')`,
  );
  await settle(client);
  await waitFor(
    client,
    `the ${label} baseline join`,
    joinPresenceExpression(
      '[data-sheet-join-bridge="top"]',
      '[data-sheet-joined="top"]',
    ),
  );

  const scrolled = await evaluate(
    client,
    `(() => {
      const tab = document.querySelector('[data-header-tab-key="epic:fixture-alpha"]');
      const scroller = document.querySelector('[data-strip-axis="x"]');
      if (tab === null || scroller === null) return false;
      const tabRect = tab.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollLeft += tabRect.left - scrollerRect.left + 10;
      return true;
    })()`,
  );
  if (!scrolled) {
    violations.push(`${label}: tab or scroller not found`);
    return;
  }
  await settle(client);

  const clipped = await evaluate(
    client,
    `(() => {
      const tab = document.querySelector('[data-header-tab-key="epic:fixture-alpha"]');
      const scroller = document.querySelector('[data-strip-axis="x"]');
      const joined = document.querySelector('[data-sheet-joined]');
      const bridge = document.querySelector('[data-sheet-join-bridge]');
      const tabRect = tab?.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      return {
        tabLeft: tabRect?.left ?? null,
        tabRight: tabRect?.right ?? null,
        scrollerLeft: scrollerRect?.left ?? null,
        joinedPresent: joined !== null,
        bridgeVisible: bridge !== null && bridge.getBoundingClientRect().width > 0,
      };
    })()`,
  );
  if (
    clipped.tabLeft === null ||
    clipped.scrollerLeft === null ||
    !(
      clipped.tabLeft < clipped.scrollerLeft &&
      clipped.tabRight > clipped.scrollerLeft
    )
  ) {
    violations.push(
      `${label}: tab is not actually straddling the scroller's clip edge after scrolling (tab ${clipped.tabLeft}..${clipped.tabRight}, scroller starts ${clipped.scrollerLeft}) - this doesn't prove a genuine partial clip`,
    );
    return;
  }
  if (clipped.joinedPresent) {
    violations.push(
      `${label}: [data-sheet-joined] still present while the active tab is partially clipped`,
    );
  }
  if (clipped.bridgeVisible) {
    violations.push(
      `${label}: the join bridge is still visible while the active tab is partially clipped`,
    );
  }

  await evaluate(
    client,
    `document.querySelector('[data-header-tab-key="epic:fixture-alpha"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })`,
  );
  await settle(client);
  const rejoined = await evaluate(
    client,
    `(() => {
      const joined = document.querySelector('[data-sheet-joined]');
      const bridge = document.querySelector('[data-sheet-join-bridge]');
      return (
        joined !== null &&
        joined.getBoundingClientRect().width > 0 &&
        bridge !== null &&
        bridge.getBoundingClientRect().width > 0
      );
    })()`,
  );
  if (!rejoined) {
    violations.push(
      `${label}: did not rejoin (joined element and visible bridge) after scrolling the tab back into view`,
    );
  }

  const bridgeSelector = '[data-sheet-join-bridge="top"]';
  const joinedSelector = '[data-sheet-joined="top"]';
  await evaluate(
    client,
    `{ window.__layoutCanvasProbe.activateEpicTab('fixture-zeta'); document.querySelector('[data-strip-axis="x"]').scrollLeft = 99999; }`,
  );
  await settle(client);
  await waitFor(
    client,
    `the ${label} last-tab join`,
    joinPresenceExpression(bridgeSelector, joinedSelector),
  );
  const last = await evaluate(
    client,
    cornerMeasureExpression(bridgeSelector, joinedSelector, "top"),
  );
  if (!last.present)
    violations.push(`${label} last tab: no matching join rendered`);
  for (const v of last.violations) violations.push(`${label} last tab: ${v}`);
}

async function runSideEdgeExtremesCheck(client, baseUrl, violations) {
  for (const edge of ["left", "right"]) {
    const label = `side ${edge} extremes`;
    await openFixture(
      client,
      `${baseUrl}?tabs=${edge}&sidebar=${edge}&header=app&surface=epic`,
      label,
    );
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 420,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const bridgeSelector = `[data-sheet-join-bridge="${edge}"]`;
    const joinedSelector = `[data-sheet-joined="${edge}"]`;
    const measureRow = () =>
      evaluate(
        client,
        cornerMeasureExpression(bridgeSelector, joinedSelector, edge),
      );
    const recordRow = (row, result) => {
      if (!result.present) {
        violations.push(`${label} ${row}: no matching join rendered`);
        return;
      }
      for (const v of result.violations)
        violations.push(`${label} ${row}: ${v}`);
    };

    await evaluate(
      client,
      `window.__layoutCanvasProbe.activateEpicTab('fixture-alpha')`,
    );
    await settle(client);
    await waitFor(
      client,
      `the ${label} first-row join`,
      joinPresenceExpression(bridgeSelector, joinedSelector),
    );
    recordRow("first", await measureRow());

    await evaluate(
      client,
      `{ window.__layoutCanvasProbe.activateEpicTab('fixture-zeta'); document.querySelector('[data-strip-axis="y"]').scrollTop = 99999; }`,
    );
    await settle(client);
    await waitFor(
      client,
      `the ${label} last-row join`,
      joinPresenceExpression(bridgeSelector, joinedSelector),
    );
    recordRow("last", await measureRow());
  }
}

/**
 * [corners mode / flush surface] Replaces the removed browser-only header
 * edge-reserve check (no sheet corner exists to reserve for any more): the
 * top strip's own extremes still land on the seam - the first tab (Home,
 * leftmost) and the last tab scrolled to the strip's right extreme.
 */
async function runTopEdgeExtremesCheck(client, baseUrl, violations) {
  const label = "top extremes";
  await openFixture(
    client,
    `${baseUrl}?tabs=top&header=app&surface=epic`,
    label,
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const bridgeSelector = '[data-sheet-join-bridge="top"]';
  const joinedSelector = '[data-sheet-joined="top"]';
  const measureRow = () =>
    evaluate(
      client,
      cornerMeasureExpression(bridgeSelector, joinedSelector, "top"),
    );
  const recordRow = (row, result) => {
    if (!result.present) {
      violations.push(`${label} ${row}: no matching join rendered`);
      return;
    }
    for (const v of result.violations) violations.push(`${label} ${row}: ${v}`);
  };

  await activateHome(client);
  await settle(client);
  await waitFor(
    client,
    `the ${label} first-tab (Home) join`,
    joinPresenceExpression(bridgeSelector, joinedSelector),
  );
  recordRow("first (Home)", await measureRow());

  await evaluate(
    client,
    `{ window.__layoutCanvasProbe.activateEpicTab('fixture-zeta'); document.querySelector('[data-strip-axis="x"]').scrollLeft = 99999; }`,
  );
  await settle(client);
  await waitFor(
    client,
    `the ${label} last-tab join`,
    joinPresenceExpression(bridgeSelector, joinedSelector),
  );
  recordRow("last", await measureRow());
}

function joinPresenceExpression(bridgeSelector, joinedSelector) {
  return `(() => {
    const bridge = document.querySelector(${JSON.stringify(bridgeSelector)});
    const joined = document.querySelector(${JSON.stringify(joinedSelector)});
    if (bridge === null || joined === null) return false;
    const bridgeBox = bridge.getBoundingClientRect();
    const joinedBox = joined.getBoundingClientRect();
    return (
      bridgeBox.width > 0 &&
      bridgeBox.height > 0 &&
      joinedBox.width > 0 &&
      joinedBox.height > 0
    );
  })()`;
}

/**
 * [offsets mode] Builds the in-page expression that measures one bridge's arc
 * geometry and returns `{ present, violations }`. Done in-page (real floats,
 * no CDP-side rounding) rather than shipping raw rects over CDP and
 * reimplementing padding-box math in Node. The four invariants compare each
 * pseudo's resolved inner edge against the padding-box edge it should
 * coincide with.
 */
function measureExpression(bridgeSelector, joinedSelector, kind) {
  return `(() => {
    const bridge = document.querySelector(${JSON.stringify(bridgeSelector)});
    const joined = document.querySelector(${JSON.stringify(joinedSelector)});
    if (bridge === null || joined === null) return { present: false, violations: [] };
    const bridgeBox = bridge.getBoundingClientRect();
    const joinedBox = joined.getBoundingClientRect();
    if (
      bridgeBox.width === 0 ||
      bridgeBox.height === 0 ||
      joinedBox.width === 0 ||
      joinedBox.height === 0
    ) {
      return { present: false, violations: [] };
    }
    ${AXIS_HELPERS}
    const EPS = ${EPSILON};
    const violations = [];
    if (${JSON.stringify(kind)} === "top") {
      const beforeAxis = resolveAxis(
        before.left,
        before.right,
        parseFloat(before.width),
        paddingBox.left,
        paddingBox.right,
      );
      const beforeDelta = beforeAxis.end - paddingBox.left;
      if (Math.abs(beforeDelta) > EPS) {
        violations.push(
          "::before's right edge is " + beforeDelta.toFixed(3) + "px off the bridge's inner left edge (bridge.left + borderLeftWidth)",
        );
      }
      const afterAxis = resolveAxis(
        after.left,
        after.right,
        parseFloat(after.width),
        paddingBox.left,
        paddingBox.right,
      );
      const afterDelta = afterAxis.start - paddingBox.right;
      if (Math.abs(afterDelta) > EPS) {
        violations.push(
          "::after's left edge is " + afterDelta.toFixed(3) + "px off the bridge's inner right edge (bridge.right - borderRightWidth)",
        );
      }
    } else {
      const beforeAxis = resolveAxis(
        before.top,
        before.bottom,
        parseFloat(before.height),
        paddingBox.top,
        paddingBox.bottom,
      );
      const beforeDelta = beforeAxis.end - paddingBox.top;
      if (Math.abs(beforeDelta) > EPS) {
        violations.push(
          "::before's bottom edge is " + beforeDelta.toFixed(3) + "px off the bridge's inner top edge (bridge.top + borderTopWidth)",
        );
      }
      const afterAxis = resolveAxis(
        after.top,
        after.bottom,
        parseFloat(after.height),
        paddingBox.top,
        paddingBox.bottom,
      );
      const afterDelta = afterAxis.start - paddingBox.bottom;
      if (Math.abs(afterDelta) > EPS) {
        violations.push(
          "::after's top edge is " + afterDelta.toFixed(3) + "px off the bridge's inner bottom edge (bridge.bottom - borderBottomWidth)",
        );
      }
    }
    return { present: true, violations };
  })()`;
}

/**
 * [corners mode / flush surface] Builds the in-page expression asserting a
 * bridge's arcs stay within the surface FRAME's own bounds on the axis they
 * flare along, never past it. Both top and side bridges anchor to this one
 * frame element (`[data-tab-edge]`, `--task-frame`'s own anchor). There is no
 * radius left anywhere on the frame or the sheet it holds - flush surface
 * draws one straight seam line the full width/height of the facing edge - so
 * the old "past the sheet's corner radius" bound collapses to "past the
 * frame's own edge" with no radius term. Reuses `AXIS_HELPERS`' padding-box
 * axis math, but reads each pseudo's OUTER edge (the end away from the
 * bridge) instead of its inner one, and compares it to the frame's rect
 * instead of the bridge's own padding box.
 */
function cornerMeasureExpression(bridgeSelector, joinedSelector, bridgeSide) {
  return `(() => {
    const bridge = document.querySelector(${JSON.stringify(bridgeSelector)});
    const joined = document.querySelector(${JSON.stringify(joinedSelector)});
    const frame = document.querySelector('[data-tab-edge]');
    if (bridge === null || joined === null || frame === null) return { present: false, violations: [] };
    const bridgeBox = bridge.getBoundingClientRect();
    const joinedBox = joined.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    if (
      bridgeBox.width === 0 ||
      bridgeBox.height === 0 ||
      joinedBox.width === 0 ||
      joinedBox.height === 0 ||
      frameBox.width === 0 ||
      frameBox.height === 0
    ) {
      return { present: false, violations: [] };
    }
    ${AXIS_HELPERS}
    const EPS = ${EPSILON};
    const violations = [];
    if (${JSON.stringify(bridgeSide)} === "top") {
      const beforeAxis = resolveAxis(before.left, before.right, parseFloat(before.width), paddingBox.left, paddingBox.right);
      if (beforeAxis.start < frameBox.left - EPS) {
        violations.push(
          "left arc's outer edge is " + (frameBox.left - beforeAxis.start).toFixed(3) + "px past the surface frame's left edge - the seam has no corner to flare past",
        );
      }
      const afterAxis = resolveAxis(after.left, after.right, parseFloat(after.width), paddingBox.left, paddingBox.right);
      if (afterAxis.end > frameBox.right + EPS) {
        violations.push(
          "right arc's outer edge is " + (afterAxis.end - frameBox.right).toFixed(3) + "px past the surface frame's right edge",
        );
      }
    } else {
      const beforeAxis = resolveAxis(before.top, before.bottom, parseFloat(before.height), paddingBox.top, paddingBox.bottom);
      if (beforeAxis.start < frameBox.top - EPS) {
        violations.push(
          "top arc's outer edge is " + (frameBox.top - beforeAxis.start).toFixed(3) + "px past the surface frame's top edge",
        );
      }
      const afterAxis = resolveAxis(after.top, after.bottom, parseFloat(after.height), paddingBox.top, paddingBox.bottom);
      if (afterAxis.end > frameBox.bottom + EPS) {
        violations.push(
          "bottom arc's outer edge is " + (afterAxis.end - frameBox.bottom).toFixed(3) + "px past the surface frame's bottom edge",
        );
      }
    }
    return { present: true, violations };
  })()`;
}

function settle(targetClient) {
  return evaluate(
    targetClient,
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))`,
  );
}

/**
 * Navigates and returns once the NEW document is the one being evaluated: the
 * frame's loader is no longer the old page's (a Vite reload after it counts
 * too). The browser answers that without asking the old page, so a page that
 * stopped answering CDP can still be navigated away from. A context destroyed
 * by the navigation is retried.
 */
async function navigate(targetClient, url) {
  const loaderOf = async () =>
    (await targetClient.send("Page.getFrameTree", undefined)).frameTree.frame
      .loaderId;
  const previous = await loaderOf();
  await targetClient.send("Page.navigate", { url });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await loaderOf()) !== previous) {
      try {
        if (await evaluate(targetClient, `document.readyState === "complete"`))
          return;
      } catch (error) {
        if (!isNavigationContextError(error)) throw error;
      }
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for the navigation to ${url}`);
}

function isNavigationContextError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /context was destroyed|Cannot find context|Inspected target navigated/i.test(
    message,
  );
}

/**
 * Loads the fixture in a fresh tab (`openTabSession`), so every load gets its
 * own renderer: one tab navigated from load to load stalls or loses its
 * renderer every few loads on this fixture (measured 4-6 in 30-40 loads that
 * way, 0 in 140 with a tab per load; tickets/12).
 *
 * A stall that still happens is retried ONCE, in another fresh tab, loudly and
 * counted: the run fails on a second one, so a repeat surfaces in CI instead
 * of hiding behind the retry.
 */
async function openFixture(client, url, label) {
  try {
    await loadFixtureInFreshTab(client, url, label);
  } catch (error) {
    if (!(error instanceof Error) || !stalledBoot(error.message)) throw error;
    stalledBootRetries += 1;
    console.error(
      `\n  WARNING ${label}: the fixture's boot stalled in a fresh tab (${error.message.split("\n")[0]}; renderer ${client.crashed() ? "gone" : "alive"}); retrying once in another fresh tab (retry ${stalledBootRetries}, a second one fails the run).\n`,
    );
    await loadFixtureInFreshTab(client, url, label);
  }
}

async function loadFixtureInFreshTab(client, url, label) {
  await client.freshTab();
  await client.send("Runtime.enable", undefined);
  await client.send("Page.enable", undefined);
  await client.send("Network.enable", undefined);
  await loadFixture(client, url, label);
}

/**
 * Boots the fixture once before any suite. A `--force` Vite compiles the
 * fixture's whole module graph and optimizes its dependencies on the first
 * boot: about 12s on a laptop, and past the 30s every later load is allowed
 * on a CI runner, where it failed the first variant before this existed. So
 * this one boot waits while the dev server keeps answering (compiling is
 * progress) and fails once 30s pass with no response, or once
 * `WARM_UP_CAP_MS` has passed in all: a reload loop answers forever and must
 * still end the run. It is not a stall retry and does not count as one.
 */
async function warmUp(client, url) {
  const idleMs = 30_000;
  await client.freshTab();
  await client.send("Runtime.enable", undefined);
  await client.send("Page.enable", undefined);
  await client.send("Network.enable", undefined);
  const started = Date.now();
  let lastResponse = started;
  const heard = () => {
    lastResponse = Date.now();
  };
  const stops = [
    client.on("Network.responseReceived", heard),
    client.on("Network.loadingFinished", heard),
  ];
  try {
    await client.send("Page.navigate", { url });
    while (Date.now() - started < WARM_UP_CAP_MS) {
      if (client.crashed())
        throw new Error("The renderer was killed while warming up the fixture");
      if (Date.now() - lastResponse >= idleMs)
        throw new Error(
          `The fixture's first boot stalled: no response from Vite for ${String(idleMs / 1000)}s and no ready probe`,
        );
      try {
        if (
          await evaluate(client, `window.__layoutCanvasProbe?.ready === true`)
        ) {
          console.log(
            `fixture warm-up boot: ${String(Date.now() - started)}ms`,
          );
          return;
        }
      } catch (error) {
        if (!isNavigationContextError(error)) throw error;
      }
      await delay(250);
    }
    throw new Error(
      `The fixture's first boot was not ready within ${String(WARM_UP_CAP_MS / 1000)}s although Vite kept answering (a reload loop?)`,
    );
  } finally {
    for (const stop of stops) stop();
  }
}

/** A CDP timeout, or a readiness timeout on a document whose module never ran. */
function stalledBoot(message) {
  if (message.includes("got no answer within")) return true;
  if (message.startsWith("The renderer was killed")) return true;
  return (
    message.startsWith("Timed out waiting for") &&
    message.includes('<div id=\\"root\\"></div>')
  );
}

/** Reload only when Vite explicitly invalidates an optimized dependency. */
async function loadFixture(client, url, label) {
  const ready = `window.__layoutCanvasProbe?.ready === true`;
  let outdatedDeps = 0;
  const unsubscribe = client.on("Network.responseReceived", ({ response }) => {
    if (
      response.status === 504 &&
      response.url.includes("/node_modules/.vite/deps/")
    ) {
      outdatedDeps += 1;
    }
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const before = outdatedDeps;
      await navigate(client, url);
      if (
        await waitFor(
          client,
          `the ${label} fixture probe`,
          ready,
          () => outdatedDeps > before,
        )
      )
        return;
      console.error(
        `Vite invalidated a dependency while loading ${label}; reloading`,
      );
    }
    throw new Error(
      `Timed out loading ${label} after Vite dependency invalidation`,
    );
  } finally {
    unsubscribe();
  }
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} exited before ready:\n${readError()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local server has not opened its port yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}:\n${readError()}`);
}

/**
 * This run's own Vite, serving the tree as it is when the run starts, with
 * file watching off (as `layout-editor-browser.mjs` does): in a tree several
 * agents write at once a watcher reloads the fixture mid-suite on a peer's
 * save. HMR stays on: it is the channel the cold dependency optimizer
 * (`--force`) reloads the first boot through.
 */
async function spawnVite(port) {
  const configDir = await mkdtemp(path.join(tmpdir(), "sheet-join-vite-"));
  const configPath = path.join(configDir, "vite.no-watch.config.mjs");
  await writeFile(
    configPath,
    [
      `import base from ${JSON.stringify(path.join(projectRoot, "vitest.config.ts"))};`,
      "export default { ...base, server: { ...base.server, watch: null } };",
      "",
    ].join("\n"),
  );
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  const child = spawn(
    "node",
    [
      viteEntry,
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--force",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.once("exit", () => {
    void rm(configDir, { recursive: true, force: true });
  });
  return child;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a free Vite port"));
        return;
      }
      server.close();
      resolve(address.port);
    });
  });
}

async function evaluate(targetClient, expression) {
  const response = await targetClient.send("Runtime.evaluate", {
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

async function waitFor(targetClient, label, expression, abortWhen) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (targetClient.crashed())
      throw new Error(`The renderer was killed while waiting for ${label}`);
    if (abortWhen?.()) return false;
    if (await evaluate(targetClient, expression)) return true;
    await delay(50);
  }
  const state = await evaluate(
    targetClient,
    `({ body: document.body.innerHTML.slice(0, 4000), viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "" })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(state, null, 2)}`,
  );
}
