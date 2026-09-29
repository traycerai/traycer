import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SIGNAL_EXIT_CODES } from "./signal-exit-codes.ts";

/**
 * The GUI's real-browser regressions. Each driver starts its own Vite and a
 * headless Chrome (Electron for the Pierre zoom one) and drives it over CDP,
 * for claims jsdom cannot decide: layout, painted pixels and real input
 * dispatch. The note beside each entry says which.
 *
 * CI runs them in `.github/workflows/browser-regressions.yml`, one parallel
 * job per GROUP below; they are not a required check. They used to run one
 * after another at the end of gui-app Vitest shard 1 (`run-tests.ts`), the one
 * gui-app check the `main` ruleset requires: about 31 minutes of drivers took
 * that job from about 7 minutes to about 35 and held every PR behind it. A
 * group is sized to finish in about five minutes on the standard runner, so
 * the two long drivers are split: layout-editor by
 * `LAYOUT_EDITOR_BROWSER_SHARD`, sheet-join by suite.
 *
 *   bun scripts/run-browser-regressions.ts                # every group, in turn
 *   bun scripts/run-browser-regressions.ts --group <name> # one group (one CI job)
 *   bun scripts/run-browser-regressions.ts --list-groups  # the names, as JSON (CI's matrix)
 *
 * Every regression in a run starts even after an earlier one failed, so one
 * red driver does not hide the next; the exit code is the first failure's.
 */

interface BrowserRegression {
  /** Driver path relative to `clients/gui-app/`. */
  readonly script: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface BrowserRegressionGroup {
  readonly name: string;
  readonly regressions: readonly BrowserRegression[];
}

const GUI_APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function driver(script: string): BrowserRegression {
  return { script, args: [], env: {} };
}

/**
 * The layout editor driver is about fourteen minutes of phases on the CI
 * runner, so it runs as this many jobs. Its own `selectedPhases` splits the
 * phase list by measured weight, so every phase - including one added later -
 * lands in exactly one shard.
 */
const LAYOUT_EDITOR_SHARDS = 4;

function layoutEditorShard(index: number): BrowserRegressionGroup {
  const shard = `${String(index)}/${String(LAYOUT_EDITOR_SHARDS)}`;
  return {
    name: `layout-editor-${String(index)}-of-${String(LAYOUT_EDITOR_SHARDS)}`,
    // The layout editor's parity rule (P2, L-11, L-53) is a claim about
    // RESOLVED styles and laid-out rects - whether two pictures of the same
    // region look the same, whether a preset card is a scaled app frame
    // rather than a reflowed one, and where Chrome's anchor positioning
    // actually paints the hover chip. jsdom has no cascade, no layout and no
    // anchor positioning, so none of the four is decidable without a browser.
    regressions: [
      {
        script: "scripts/layout-editor-browser.mjs",
        args: [],
        env: { LAYOUT_EDITOR_BROWSER_SHARD: shard },
      },
    ],
  };
}

const GROUPS: readonly BrowserRegressionGroup[] = [
  {
    name: "surfaces",
    regressions: [
      driver("scripts/diff-edit-browser-regression.mjs"),
      driver("scripts/pierre-tree-zoom-browser-regression.mjs"),
      driver("scripts/destructive-dialog-focus-browser.mjs"),
      // The strongest case for a real browser in this list: the boot card's
      // escape hatch is lost to an INPUT-DISPATCH rule - a press whose element
      // is removed before release emits no click at all - and jsdom dispatches
      // `click` directly, so every jsdom test of that button passes on the
      // broken build. Ablated before wiring: reverting the button to `onClick`
      // turns this red (0 activations) while its ordinary-click premise stays
      // green.
      driver("scripts/boot-escape-hatch-press-browser.mjs"),
      // The toast close button's touch visibility is a MEDIA-QUERY question
      // and jsdom evaluates none, so a jsdom test sees identical class names
      // on a phone and a desktop. Ablated before wiring: an unscoped hide, a
      // missing hit area and a missing mobile-app offset each turn it red.
      driver("scripts/toast-close-button-touch-browser.mjs"),
      driver("scripts/docx-preview-browser-regression.mjs"),
      // A CSS duration accidentally applied to transition-property: all sends
      // Floating UI surfaces from the viewport corner on mount and re-anchor;
      // only a real browser can measure that layout and style interpolation.
      driver("scripts/panel-motion-position-browser.mjs"),
      // Whether the status bar's usage cluster overflows and scrolls at a real
      // width, which edge its fade lands on, and whether the resource readout
      // beside it stays whole are all layout - jsdom reports every box as 0px
      // wide and cannot see what a mask class does.
      driver("scripts/status-bar-usage-scroll-browser.mjs"),
      // The message queue is never a pill (G1-G2) - it sits directly on the
      // composer with no gap, the pill row above it, and every one-line row
      // holds the dock's one row metric (L-171, L-172). All of that is laid
      // out geometry plus real key input, none of which jsdom has. Ablated
      // before wiring: HEAD's Compact queue pill fails 14 checks, and an
      // unbudgeted row toolbar or an unfloated provenance badge fails the
      // metric.
      driver("scripts/composer-queue-dock-browser.mjs"),
      // Whether a non-overflowing tab strip's scroller has ANY vertical scroll
      // range, and whether a real mouse wheel over it wobbles the active tab's
      // row by a pixel, are both layout questions - jsdom reports
      // scrollHeight/clientHeight as 0 and has no native scroll-on-wheel
      // action behind its synthetic wheel event, which is exactly the
      // mechanism the bug lived in. Ablated before wiring: reverting the tab
      // item's height back to a fixed h-9 turns both the vertical-range and
      // the wheel-wobble checks red while the horizontal-overflow-scrolls
      // checks stay green.
      driver("scripts/canvas-tab-strip-overflow-browser.mjs"),
      // The CDP client every driver here talks over: a command in flight when
      // Chrome dies must reject rather than hang, since each driver is spawned
      // with no timeout of its own and a hang holds the CI job until its own
      // limit. Needs a real DevTools socket to die under it. Ablated before
      // wiring: removing the client's close/error handlers leaves the command
      // pending (red).
      driver("scripts/cdp-client-browser.mjs"),
    ],
  },
  {
    name: "sign-in-and-hover-card",
    regressions: [
      // Whether the sign-in page is legible is a question about rendered
      // colours under a given theme preset, and jsdom has no cascade and no
      // pixels. Ablated before wiring: without the page's dark palette scope,
      // "Enter code manually" reads 1.04:1 under every light preset.
      driver("scripts/sign-in-theme-contrast-browser.mjs"),
      // Hover-card timing (G8) is pointer events, focus modality, portals and
      // frames, none of which jsdom has. Ablated before wiring: the Radix
      // cards failed 22 of 26 scenario runs, when the driver still ran each in
      // both themes (hand-off ~510ms, a card that opens after a
      // click-and-leave, a blink on click, a card under the menu).
      driver("scripts/hover-card-browser.mjs"),
    ],
  },
  {
    name: "layout-settings",
    regressions: [
      // Settings ▸ Layout beside the live app column (G6, G7). An area's body
      // scrolls under a pinned rail and header, the page fits a desktop and a
      // phone width with the rail or the select the breakpoint draws, a short
      // pane's rail scrolls under a real wheel, the Radix select and a row's ↺
      // work by real pointer and key, the header's readings leave the tabs
      // room, and every setting visibly changes the app column. Layout, media
      // queries, hit testing and real input: none of it is jsdom's.
      driver("scripts/layout-settings-browser.mjs"),
    ],
  },
  // The sheet join's concave corners are pseudo-element offsets resolved
  // against an anchored bridge's padding box and painted arcs. jsdom has no
  // anchor positioning, no used-value offsets and no pixels. Ablated before
  // wiring: arcs 1px short of the bridge's inner edge fail the offsets suite,
  // and the hard-stop gradient arcs fail the corners suite's anti-aliasing
  // check at DPR 1 and 2. The driver's two suites are its whole run (it runs
  // both when given neither flag), so these two groups cover all of it.
  {
    name: "sheet-join-offsets",
    regressions: [
      {
        script: "scripts/sheet-join-geometry-browser.mjs",
        args: ["--offsets"],
        env: {},
      },
    ],
  },
  {
    name: "sheet-join-corners",
    regressions: [
      {
        script: "scripts/sheet-join-geometry-browser.mjs",
        args: ["--corners"],
        env: {},
      },
    ],
  },
  layoutEditorShard(1),
  layoutEditorShard(2),
  layoutEditorShard(3),
  layoutEditorShard(4),
  // NOT here, deliberately, and each for its own reason:
  // - `scripts/window-host-modal-alignment-browser.mjs` measures the
  //   local-bootstrap body against ONE LEFT EDGE (A1/A2/A5/PC4) - the design
  //   `HostBootCard` superseded when the boot card became a CENTRED surface
  //   (`local-host-loading.tsx`: "the card is centred now"). Run against the
  //   current component it reports the centring as a 58px misalignment. It
  //   is a manual instrument for the left-aligned arrangement it was written
  //   for, not a gate on the current one; re-base it before wiring it here.
  // - `scripts/toast-over-modal-hittest.mjs` prints hit-test figures and
  //   asserts nothing, so a gate on it would be a gate on a number nobody
  //   reads - run it by hand.
];

function runDriver(regression: BrowserRegression): number {
  const result = spawnSync(
    process.execPath,
    [path.join(GUI_APP_ROOT, regression.script), ...regression.args],
    {
      cwd: GUI_APP_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...regression.env },
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    return SIGNAL_EXIT_CODES[result.signal] ?? 1;
  }
  return result.status ?? 1;
}

function describeRegression(regression: BrowserRegression): string {
  return [
    ...Object.entries(regression.env).map(
      ([name, value]) => `${name}=${value}`,
    ),
    regression.script,
    ...regression.args,
  ].join(" ");
}

type Request =
  | { readonly kind: "list" }
  | { readonly kind: "run"; readonly groups: readonly BrowserRegressionGroup[] }
  | { readonly kind: "invalid"; readonly message: string };

function readGroupName(args: readonly string[]): string | undefined {
  const [first, second] = args;
  if (args.length === 2 && first === "--group") return second;
  if (args.length === 1 && first.startsWith("--group=")) {
    return first.slice("--group=".length);
  }
  return undefined;
}

function parseRequest(args: readonly string[]): Request {
  const names = GROUPS.map((group) => group.name).join(", ");
  if (args.length === 0) return { kind: "run", groups: GROUPS };
  if (args.length === 1 && args[0] === "--list-groups") return { kind: "list" };
  const groupName = readGroupName(args);
  if (groupName === undefined || groupName === "") {
    return {
      kind: "invalid",
      message: `expected no arguments, --list-groups, or --group <name>; got: ${args.join(" ")}`,
    };
  }
  const group = GROUPS.find((candidate) => candidate.name === groupName);
  if (group === undefined) {
    return {
      kind: "invalid",
      message: `unknown group "${groupName}"; the groups are ${names}`,
    };
  }
  return { kind: "run", groups: [group] };
}

const request = parseRequest(process.argv.slice(2));
if (request.kind === "invalid") {
  console.error(`[browser-regressions] ${request.message}`);
  process.exit(2);
}
if (request.kind === "list") {
  process.stdout.write(
    `${JSON.stringify(GROUPS.map((group) => group.name))}\n`,
  );
  process.exit(0);
}

let exitCode = 0;
for (const group of request.groups) {
  for (const regression of group.regressions) {
    const label = describeRegression(regression);
    process.stdout.write(`\n[browser-regressions] ${group.name}: ${label}\n`);
    const startedAt = performance.now();
    const status = runDriver(regression);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `[browser-regressions] ${group.name}: ${label} exited ${String(status)} after ${seconds}s\n`,
    );
    if (exitCode === 0) exitCode = status;
  }
}
process.exit(exitCode);
