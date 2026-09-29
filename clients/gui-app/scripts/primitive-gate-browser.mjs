// Browser-only migration gate. Pixel baselines live outside git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  mkdtemp,
  symlink,
  rename,
} from "node:fs/promises";
import { platform, arch, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import {
  connect,
  installPresentationProbes,
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./gate-browser-support.mjs";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  assert(
    args[i + 1] && !args[i + 1].startsWith("--"),
    `${name} requires a value`,
  );
  return args[i + 1];
};
if (args.includes("--help")) {
  console.log(`bun scripts/primitive-gate-browser.mjs --behavior [--only toast|conceal|nested|command]
bun scripts/primitive-gate-browser.mjs --capture DIR [--filter family/state] [--viewport desktop|portrait|landscape]
bun scripts/primitive-gate-browser.mjs --compare BASELINE --out DIR [--filter family/state]
bun scripts/primitive-gate-browser.mjs --known-defects
bun scripts/primitive-gate-browser.mjs --motion --out DIR
bun scripts/primitive-gate-browser.mjs --self-check-paths
Subset options: --theme light|dark, --smoke (first state per family), --from-family NAME.
Optional --motion-reference DIR selects revised motion measurements while preserving the original pixel manifest.
Capture includes separate motion measurements. Compare checks browser/platform/DPR, exact pixels and motion. --filter matches a substring of family/state. Omitted runs all 990 images.`);
  process.exit(0);
}
if (args.includes("--self-check-paths")) {
  const root = await mkdtemp(path.join(tmpdir(), "primitive-gate-path-check-"));
  try {
    const reference = path.join(root, "reference");
    await mkdir(reference);
    const sentinel = path.join(reference, "manifest.json");
    await writeFile(sentinel, "immutable reference");
    await symlink(reference, path.join(root, "alias"));
    for (const output of [
      reference,
      path.join(reference, "..", "reference"),
      path.join(root, "alias"),
      path.join(reference, "new", "child"),
      root,
    ]) {
      let rejected = false;
      try {
        execFileSync(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            "--compare",
            reference,
            "--out",
            output,
          ],
          { stdio: "pipe" },
        );
      } catch (error) {
        rejected = String(error.stderr).includes("must not overlap");
      }
      assert(rejected, `Overlapping output was not rejected: ${output}`);
      assert.equal(await readFile(sentinel, "utf8"), "immutable reference");
    }
    console.log("PASS 5 canonical-path rejection cases; reference unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
const capture = flag("--capture"),
  baseline = flag("--compare"),
  motionReference = flag("--motion-reference"),
  out = capture ?? flag("--out"),
  behavior = args.includes("--behavior"),
  knownDefects = args.includes("--known-defects");
assert(!(capture && baseline), "Capture and compare are exclusive");
assert(
  behavior || knownDefects || out,
  "Choose --behavior, --capture DIR, --compare BASELINE --out DIR or --motion --out DIR",
);
// Resolve existing ancestors as well, so a not-yet-created output under a
// symlink cannot alias the reference. Reject before starting Vite/Chrome.
async function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(
      await canonicalDirectory(path.dirname(absolute)),
      path.basename(absolute),
    );
  }
}
for (const referenceDirectory of [baseline, motionReference].filter(Boolean)) {
  assert(out, "--compare requires --out");
  const reference = await canonicalDirectory(referenceDirectory);
  const candidate = await canonicalDirectory(out);
  const contains = (parent, child) =>
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  assert(
    !contains(reference, candidate) && !contains(candidate, reference),
    "Reference and output directories must not overlap (including symlinks)",
  );
}
const inventory = JSON.parse(
  await readFile(
    path.join(project, "scripts/primitive-gate-cases.json"),
    "utf8",
  ),
);
const views = [
  {
    name: "desktop",
    width: 1280,
    height: 800,
    mobile: false,
    insets: [0, 0, 0, 0],
  },
  {
    name: "portrait",
    width: 393,
    height: 852,
    mobile: true,
    insets: [47, 0, 34, 0],
  },
  {
    name: "landscape",
    width: 852,
    height: 393,
    mobile: true,
    insets: [0, 47, 21, 0],
  },
];
let server,
  chrome,
  client,
  chromeVersion,
  current = "startup",
  documentSequence = 0;
const exceptions = [];
const report = {
  parameters: {},
  images: {},
  motion: {},
  behavior: [],
  deferrals: [],
  measurements: {},
};
// Pixel/motion diffs are collected here rather than thrown immediately, so one
// residual raster difference doesn't abort the run before the rest of the
// ~990 images (or the 7 motion cases) are even captured. Everything else
// (behavior assertions, the baseline-manifest guard, `check`/`wait`) keeps
// failing fast - only this comparison is deferred.
const diffFailures = [];
// Shared by `launchBrowserAndTarget` (both the original launch and a
// restart), so a restart's browser gets exactly the same one-time page
// bootstrap as the first.
const BOOTSTRAP_SCRIPT_SOURCE = `Math.random = () => 0.5; (${installPresentationProbes.toString()})(); (${installMotionProbe.toString()})();`;
// Same reasoning: identical flags for the original launch and every restart.
const CHROME_LAUNCH_FLAGS = [
  "--force-device-scale-factor=1",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  // Avoid run-dependent edge pixels from partial raster/Skia fast paths.
  // See GoogleChrome/chrome-launcher docs/chrome-flags-for-tools.md.
  "--disable-partial-raster",
  "--disable-skia-runtime-opts",
  "--hide-scrollbars",
  "--disable-features=Translate,BackForwardCache",
];
let cleaning;
function cleanup() {
  if (!cleaning)
    cleaning = (async () => {
      client?.close();
      if (chrome) {
        await terminateProcessTree(chrome.chrome);
        await rm(chrome.profilePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
      }
      if (server) await terminateProcessTree(server);
    })();
  return cleaning;
}
process.once("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.once("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});
const previous = baseline
  ? JSON.parse(await readFile(path.join(baseline, "manifest.json"), "utf8"))
  : null;
const previousMotion = motionReference
  ? JSON.parse(
      await readFile(path.join(motionReference, "manifest.json"), "utf8"),
    )
  : previous;
try {
  const port = await new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      assert(a && typeof a === "object");
      s.close(() => resolve(a.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const require = createRequire(import.meta.url),
    manifestPath = require.resolve("vite/package.json");
  const vite = path.resolve(
    path.dirname(manifestPath),
    require(manifestPath).bin.vite,
  );
  server = spawn(
    "node",
    [
      vite,
      "--config",
      path.join(project, "vitest.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: project, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let serverError = "";
  server.stderr.on("data", (chunk) => {
    serverError += String(chunk);
  });
  server.on("error", (error) => {
    serverError += String(error);
  });
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      if (
        (await fetch(origin + "/src/__tests__/browser/primitive-gate.html")).ok
      )
        break;
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error("Vite failed: " + serverError);
    await delay(100);
  }
  chromeVersion = await launchBrowserAndTarget();
  const version = chromeVersion;
  report.parameters = {
    chrome: version.product,
    revision: version.revision,
    platform: platform(),
    arch: arch(),
    dpr: 1,
    fonts: "Figtree Variable (bundled), 400/500/600/700",
    colorProfile: "srgb",
    fontRenderHinting: "none",
    partialRaster: false,
    skiaRuntimeOptimizations: false,
    viewports: views,
    randomSeed: 0.5,
    caseInventorySha256: createHash("sha256")
      .update(JSON.stringify(inventory))
      .digest("hex"),
  };
  for (const reference of [previous, previousMotion].filter(Boolean))
    assert.deepEqual(
      report.parameters,
      reference.parameters,
      "Baseline environment differs; use pinned browser/platform",
    );
  report.harnessSha256 = Object.fromEntries(
    await Promise.all(
      [
        "scripts/primitive-gate-browser.mjs",
        "scripts/gate-browser-support.mjs",
        "scripts/chrome-launcher.mjs",
        "src/__tests__/browser/primitive-gate.tsx",
        "src/__tests__/browser/primitive-gate.html",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(project, file)))
          .digest("hex"),
      ]),
    ),
  );
  report.source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  if (out) await mkdir(out, { recursive: true });
  async function load(
    family,
    state,
    mode,
    view,
    theme,
    retriedBlankFixture = false,
  ) {
    current = `${mode}/${family}/${state}/${theme}/${view.name}`;
    exceptions.length = 0;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: view.width,
      height: view.height,
      deviceScaleFactor: 1,
      mobile: view.mobile,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 1,
      y: 1,
    });
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: view.mobile,
      maxTouchPoints: 1,
    });
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: "no-preference" },
      ],
    });
    const url = new URL("/src/__tests__/browser/primitive-gate.html", origin);
    for (const [k, v] of Object.entries({ family, state, mode, theme }))
      url.searchParams.set(k, v);
    url.searchParams.set("document", String(++documentSequence));
    await client.send("Page.navigate", { url: url.href });
    try {
      await wait(
        "fixture",
        `location.href===${JSON.stringify(url.href)} && !!window.primitiveGate && !!document.querySelector('[data-gate-state]')`,
      );
    } catch (error) {
      // A blank page after the full timeout is a wedged browser bootstrap,
      // not a failed fixture assertion. Retry that one case in a fresh browser.
      if (
        retriedBlankFixture ||
        !(error instanceof Error) ||
        error.message.trim() !== "Timed out: fixture;"
      )
        throw error;
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(`Vite exited during ${current}: ${serverError}`);
      console.error(
        `RETRY ${current}: blank fixture - restarting browser once`,
      );
      await restartBrowser();
      return load(family, state, mode, view, theme, true);
    }
    await evaluate(`(async()=>{
   const insets=${JSON.stringify(view.insets)};['top','right','bottom','left'].forEach((edge,i)=>document.documentElement.style.setProperty('--safe-area-inset-'+edge,insets[i]+'px'));window.dispatchEvent(new Event('resize'));
   await Promise.all([400,500,600,700].map(w=>document.fonts.load(w+' 14px "Figtree Variable"','Project settings')));await document.fonts.ready;
   if(![...document.fonts].some(f=>f.family.includes('Figtree')&&f.status==='loaded')||!document.fonts.check('400 14px "Figtree Variable"'))throw new Error('Bundled app font not loaded');
   if(devicePixelRatio!==1)throw new Error('DPR changed');
   if(matchMedia('(pointer: coarse)').matches!==${view.mobile}||(navigator.maxTouchPoints>0)!==${view.mobile})throw new Error('Touch/pointer emulation mismatch');
   if(document.documentElement.classList.contains('dark')!==${theme === "dark"})throw new Error('Theme mismatch');
  })()`);
    await settle();
  }
  async function open(family, state, view) {
    if (family === "sidebar") {
      if (view.width < 768) {
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait(
          "mobile sidebar",
          "window.gatePresented('[data-slot=sidebar][data-mobile=true]')",
        );
      }
      return;
    }
    if (
      ![
        "dialog",
        "frame",
        "sheet",
        "drawer",
        "popover",
        "dropdown-menu",
        "context-menu",
        "menubar",
        "select",
        "nested",
        "tooltip",
        "hover-card",
        "command-in-dialog",
        "command-in-popover",
      ].includes(family) ||
      (family === "select" && state === "disabled")
    )
      return;
    if (family === "tooltip" || family === "hover-card")
      await hoverSelector("[data-gate-trigger]");
    else
      await clickSelector(
        "[data-gate-trigger]",
        family === "context-menu" ? "right" : "left",
        true,
      );
    await wait("opened popup", "window.gatePresented('[data-gate-popup]')");
    if (family === "nested") {
      await settle();
      if (state === "tooltip-in-popover")
        await hoverSelector('[data-gate-trigger="tooltip"]');
      else await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested popup",
        "window.gatePresented('[data-gate-popup=nested], [data-gate-popup=tooltip]') && [...document.querySelectorAll('[data-gate-popup]')].filter(window.gatePainted).length === 2",
      );
    }
    if (state.startsWith("submenu")) {
      await settle();
      await openSubmenuTrigger(view);
    }
  }
  // Shared by `open()`'s submenu states and `motionChecks()`'s submenu cases -
  // the latter needs the parent menu already open and settled BEFORE it opens
  // (and starts recording) just the submenu, so it can't go through `open()`
  // as one call the way every other motion case does.
  async function openSubmenuTrigger(view) {
    await evaluate(
      "document.querySelector('[data-gate-subtrigger]').scrollIntoView({block:'nearest'})",
    );
    if (view.mobile) {
      const point = await center("[data-gate-subtrigger]");
      await tapAt(point.x, point.y);
    } else await hoverSelector("[data-gate-subtrigger]");
    await wait("submenu", "window.gatePresented('[data-gate-subpopup]')");
  }
  async function visual(family, state, view, theme) {
    await load(family, state, "visual", view, theme);
    await open(family, state, view);
    if (family === "avatar" && state === "image")
      await wait(
        "avatar image decoded",
        "!!document.querySelector('[data-slot=avatar-image]') && document.querySelector('[data-slot=avatar-image]').complete",
      );
    if (state === "hover") await hoverSelector("[data-gate-control]");
    else if (state === "focus") {
      await key(family === "dropdown-menu" ? "ArrowDown" : "Tab", 0);
      // `[data-gate-control]` on the Slider case forwards to the measured
      // outer positioner div, not the focusable element: the Thumb's real
      // role/aria/focus live on its nested native `input[type=range]`.
      if (family === "slider") {
        await evaluate(
          "document.querySelector('[data-gate-control] input[type=range]')?.focus()",
        );
        assert(
          await evaluate(
            "document.activeElement === document.querySelector('[data-gate-control] input[type=range]')",
          ),
          "Focus state not exercised",
        );
      } else {
        await evaluate(
          "document.querySelector('[data-gate-control], [data-gate-item]')?.focus()",
        );
        assert(
          await evaluate(
            "document.activeElement.matches('[data-gate-control], [data-gate-item]')",
          ),
          "Focus state not exercised",
        );
      }
    }
    if (family === "drawer" && state === "input") {
      await settle();
      await clickSelector("[data-gate-input]", "left", true);
      await client.send("Input.insertText", { text: " ready" });
    }
    await settle();
    assert.equal(exceptions.length, 0, exceptions.join("\n"));
    const name = `${family}--${state}--${theme}--${view.name}.png`;
    const bytes = Buffer.from(
      (
        await client.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        })
      ).data,
      "base64",
    );
    const referenceBytes = baseline
      ? await readFile(path.join(baseline, name))
      : null;
    await writeCandidate(path.join(out, name), bytes);
    report.images[name] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: view.width,
      height: view.height,
    };
    if (baseline) {
      const diff = await canvasDiff(referenceBytes, bytes);
      if (diff.pixels !== 0) {
        await writeCandidate(
          path.join(out, name.replace(".png", ".diff.png")),
          Buffer.from(diff.image.split(",")[1], "base64"),
        );
        const message = `${name}: ${diff.pixels} changed pixels (max delta ${diff.maxDelta})`;
        console.error(`DIFF ${message}`);
        diffFailures.push(message);
      }
    }
  }
  async function canvasDiff(a, b) {
    return evaluate(`(async()=>{
  const load=async data=>{const image=new Image();image.src=data;await image.decode();return image;};const [a,b]=await Promise.all([load('data:image/png;base64,${a.toString("base64")}'),load('data:image/png;base64,${b.toString("base64")}')]);
  if(a.width!==b.width||a.height!==b.height)throw new Error('Image dimensions changed');const canvas=document.createElement('canvas');canvas.width=a.width;canvas.height=a.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(a,0,0);const x=ctx.getImageData(0,0,a.width,a.height);ctx.clearRect(0,0,a.width,a.height);ctx.drawImage(b,0,0);const y=ctx.getImageData(0,0,b.width,b.height);let pixels=0,maxDelta=0;
  for(let i=0;i<x.data.length;i+=4){let changed=false;for(let c=0;c<4;c++){const d=Math.abs(x.data[i+c]-y.data[i+c]);maxDelta=Math.max(maxDelta,d);changed ||= d!==0;}if(changed)pixels++;x.data.set(changed?[255,0,80,255]:[0,0,0,0],i);}ctx.putImageData(x,0,0);return {pixels,maxDelta,image:canvas.toDataURL()};})()`);
  }
  /**
   * On a cold runner Vite's optimizer can discover a family's dependencies
   * only when that family first loads, and reload the page mid-case - a CDP
   * evaluate then waits out its whole timeout. Load every family the lanes
   * start from once, then let the optimizer settle, before any lane runs.
   */
  async function warmUpFamilies() {
    for (const family of [
      "dialog",
      "popover",
      "frame",
      "drawer",
      "dropdown-menu",
      "context-menu",
      "menubar",
      "select",
    ]) {
      await load(family, "default", "toast", views[0], "light");
    }
    await delay(3_000);
  }
  async function toastChecks() {
    // D16: DropdownMenu, ContextMenu, Menubar and Select all route their
    // outside-dismiss through isToastEvent same as Popover, so a toast stays
    // reachable and an ordinary outside gesture still dismisses normally -
    // this is independent of each family's own modal/backdrop behavior,
    // which the branch below keys off separately. Drawer defaults modal
    // like Dialog.
    for (const [family, state] of [
      ["dialog", "default"],
      ["popover", "default"],
      ["frame", "default"],
      ["frame", "nonmodal"],
      ["drawer", "default"],
      ["dropdown-menu", "default"],
      ["context-menu", "default"],
      ["menubar", "default"],
      ["select", "default"],
    ]) {
      await load(family, state, "toast", views[0], "light");
      await open(family, state, views[0]);
      await evaluate("window.primitiveGate.toast()");
      await wait(
        "toast",
        "!!document.querySelector('[data-gate-toast-action]')",
      );
      await delay(400);
      await settle();
      if (
        ["dialog", "frame", "drawer"].includes(family) &&
        state !== "nonmodal"
      ) {
        // D17: Base's dialog backdrop does not mask the whole viewport with a
        // body pointer-events lock the way Radix's DismissableLayer did (see
        // useDialogRoot: only useScrollLock + useDismiss, no pointer mask), so
        // the toast action is genuinely reachable and interactive while the
        // modal is open. Approved by the coordinator/user, replacing the old
        // KNOWN-DEFECT expectation (blocked action, press-through dismissal).
        const p = await center("[data-gate-toast-action]");
        await check(
          "modal toast hit lands on the action, not the backdrop",
          `document.elementFromPoint(${p.x},${p.y}).matches('[data-gate-toast-action]')`,
        );
        await clickAt(p.x, p.y, "left");
        await check(
          "modal toast action fires exactly once, modal stays open",
          "document.querySelector('[data-gate-state]').dataset.actions === '1' && document.querySelector('[data-gate-state]').dataset.open === 'true' && window.gatePresented('[data-gate-popup]')",
        );
        await hoverSelector("[data-sonner-toast]");
        await settle();
        await clickSelector(
          "[data-sonner-toast] [data-close-button]",
          "left",
          true,
        );
        await wait(
          "toast removed",
          "!document.querySelector('[data-sonner-toast]')",
        );
        await check(
          "toast close retains the modal",
          "document.querySelector('[data-gate-state]').dataset.open === 'true' && window.gatePresented('[data-gate-popup]')",
        );
        await clickAt(8, 8, "left");
        await wait(
          "ordinary backdrop press closes the modal normally",
          "document.querySelector('[data-gate-state]').dataset.open === 'false'",
        );
        // `open==='false'` only means React's committed; Base keeps the
        // Popup mounted through its exit animation (`data-closed`/
        // `data-ending-style`). finalFocus fires once that completes, so
        // wait for the real animation settle AND the popup's actual removal
        // from the DOM before asserting on it - no arbitrary delay.
        await settle();
        await wait(
          "modal popup actually unmounts after its exit completes",
          "!document.querySelector('[data-gate-popup]')",
        );
        // Dialog's close-focus callback is wired (unlike frame's - the raw
        // PromotableModalFrame counter isn't); assert the real baseline for
        // each: Dialog's counted callback fired once, frame's actual
        // activeElement still matches Radix's ordinary-close convention
        // (focus returns to the trigger) without an artificial counter.
        if (family === "dialog")
          await check(
            "ordinary backdrop close fires close-focus once, returns to trigger",
            "document.querySelector('[data-gate-state]').dataset.closeFocus === '1' && document.activeElement.matches('[data-gate-trigger]')",
          );
        else
          await check(
            "ordinary backdrop close returns focus to the trigger",
            "document.activeElement.matches('[data-gate-trigger]')",
          );
        report.behavior.push(`toast/${family}/current-modal-action-reachable`);
        continue;
      }
      await clickSelector("[data-gate-toast-action]", "left", true);
      await check(
        "toast action once, overlay retained",
        "document.querySelector('[data-gate-state]').dataset.actions === '1' && document.querySelector('[data-gate-state]').dataset.open === 'true' && window.gatePresented('[data-gate-popup]')",
      );
      await hoverSelector("[data-sonner-toast]");
      await settle();
      await clickSelector(
        "[data-sonner-toast] [data-close-button]",
        "left",
        true,
      );
      await wait(
        "toast removed",
        "!document.querySelector('[data-sonner-toast]')",
      );
      await check(
        "toast close retains overlay",
        "document.querySelector('[data-gate-state]').dataset.open === 'true' && window.gatePresented('[data-gate-popup]')",
      );
      await clickAt(8, 8, "left");
      if (family === "frame" && state === "nonmodal") {
        await check(
          "nonmodal frame deliberately ignores outside press",
          "document.querySelector('[data-gate-state]').dataset.open === 'true'",
        );
        await clickSelector("[data-testid=close]", "left", true);
      }
      await wait(
        "ordinary close path",
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      await settle();
      // Select retains its Popup DOM node hidden instead of unmounting it, so
      // a stale logical counter can't be trusted - prove real closure instead
      // (ported from the lifecycle lane's assertClosed/waitClosed).
      await wait(
        "popup reaches the closed-pure boundary",
        "window.gateClosedPure('[data-gate-popup]')",
      );
      const unreachable = await evaluate(
        "window.gateUnreachable('[data-gate-popup]', '[data-gate-trigger]')",
      );
      assert(
        unreachable.closed,
        `popup must be fully unreachable after ordinary close: ${JSON.stringify(unreachable)}`,
      );
      const stillExists = await evaluate(
        "!!document.querySelector('[data-gate-popup]')",
      );
      if (stillExists) {
        const rect = await evaluate(
          "(() => { const r = document.querySelector('[data-gate-popup]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()",
        );
        if (rect.w > 0 && rect.h > 0) {
          const hitInside = await evaluate(
            `document.querySelector('[data-gate-popup]').contains(document.elementFromPoint(${rect.x}, ${rect.y}))`,
          );
          assert(
            !hitInside,
            "a real hit-test at the retained popup's own rect must not resolve inside it",
          );
        }
        await key("Tab", 0);
        const landedInside = await evaluate(
          "document.querySelector('[data-gate-popup]')?.contains(document.activeElement) ?? false",
        );
        assert(
          !landedInside,
          "a real Tab press must never land focus inside the closed/retained popup",
        );
      }
      report.behavior.push(`toast/${family}/${state}/pointer`);
    }
    // Positive control for the isToastEvent widening: Select's cancel-open
    // close comes from a press-on-trigger/release-outside gesture (native
    // <select> shape), not a full click, so drive that exact sequence with
    // no toast involved and prove the wider guard doesn't swallow it.
    await load("select", "default", "toast", views[0], "light");
    const selectTrigger = await center("[data-gate-trigger]");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: selectTrigger.x,
      y: selectTrigger.y,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: selectTrigger.x,
      y: selectTrigger.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await wait(
      "select opens on press",
      "window.gatePresented('[data-gate-popup]')",
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 8,
      y: 8,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 8,
      y: 8,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await wait(
      "press-drag-release-outside closes Select with no toast involved",
      "document.querySelector('[data-gate-state]').dataset.open === 'false'",
    );
    report.behavior.push("toast/select/cancel-open-outside-no-toast");
    await load("popover", "default", "toast", views[0], "light");
    await open("popover", "default", views[0]);
    await evaluate("window.primitiveGate.toast()");
    await wait("toast", "!!document.querySelector('[data-gate-toast-action]')");
    // Sonner's real keyboard shortcut enters the toaster; Tab reaches its action.
    await key("t", 1);
    await wait(
      "keyboard focus in toaster",
      "!!document.activeElement.closest('[data-sonner-toaster]')",
    );
    for (
      let i = 0;
      i < 6 &&
      !(await evaluate(
        "document.activeElement.matches('[data-gate-toast-action]')",
      ));
      i++
    )
      await key("Tab", 0);
    await check(
      "popup → toast action retains popup",
      "document.activeElement.matches('[data-gate-toast-action]') && document.querySelector('[data-gate-state]').dataset.open === 'true'",
    );
    await key("Enter", 0);
    await wait(
      "keyboard action once",
      "document.querySelector('[data-gate-state]').dataset.actions === '1'",
    );
    // Sonner 2.0.8 restores the element that had focus before Alt+T when
    // focus leaves its list. Today Tab cannot proceed to an ordinary control.
    await key("Tab", 0);
    await settle();
    await check(
      "current toaster exit restores popup focus",
      "!!document.activeElement.closest('[data-gate-popup]') && document.querySelector('[data-gate-state]').dataset.open === 'true'",
    );
    console.log(
      "KNOWN DEFECT popover keyboard: leaving toaster restores popup focus; desired next ordinary control is not reachable by that Tab",
    );
    await clickSelector("[data-gate-outside]", "left", true);
    await wait(
      "ordinary outside control closes popup",
      "document.querySelector('[data-gate-state]').dataset.open === 'false'",
    );
    report.behavior.push("toast/popover/keyboard-restores-popup");
  }
  async function knownDefectChecks() {
    for (const family of ["dialog", "frame"]) {
      await load(family, "default", "toast", views[0], "light");
      await open(family, "default", views[0]);
      await evaluate("window.primitiveGate.toast()");
      await wait(
        "toast",
        "!!document.querySelector('[data-gate-toast-action]')",
      );
      await delay(400);
      await settle();
      await clickSelector("[data-gate-toast-action]", "left", false);
      await settle();
      const observed = await evaluate(
        "({actions:Number(document.querySelector('[data-gate-state]').dataset.actions),open:document.querySelector('[data-gate-state]').dataset.open==='true'})",
      );
      console.log(
        `KNOWN-DEFECT lane (non-gating) ${family}: ${JSON.stringify(observed)}; desired actions=1, open=true; ${observed.actions === 1 && observed.open ? "RESOLVED" : "PRESENT"}`,
      );
    }
    await load("popover", "default", "toast", views[0], "light");
    await open("popover", "default", views[0]);
    await evaluate("window.primitiveGate.toast()");
    await wait("toast", "!!document.querySelector('[data-gate-toast-action]')");
    await key("t", 1);
    for (
      let i = 0;
      i < 6 &&
      !(await evaluate(
        "document.activeElement.matches('[data-gate-toast-action]')",
      ));
      i++
    )
      await key("Tab", 0);
    await key("Enter", 0);
    await key("Tab", 0);
    await settle();
    const keyboard = await evaluate(
      "({outside:document.activeElement.matches('[data-gate-outside]'),open:document.querySelector('[data-gate-state]').dataset.open==='true'})",
    );
    console.log(
      `KNOWN-DEFECT lane (non-gating) popover keyboard: ${JSON.stringify(keyboard)}; desired outside=true, open=false; ${keyboard.outside && !keyboard.open ? "RESOLVED" : "PRESENT"}`,
    );
    for (const state of ["menu", "select"])
      for (const scenario of ["backdrop", "rapid", "virtual"]) {
        await load("frame", state, "nested", views[0], "light");
        await open("frame", state, views[0]);
        await settle();
        await clickSelector("[data-gate-trigger=nested]", "left", true);
        await wait(
          "nested opens",
          "window.gatePresented('[data-gate-popup=nested]')",
        );
        await settle();
        if (scenario === "virtual") {
          await evaluate(
            "document.querySelector('[data-slot=dialog-overlay]').click()",
          );
          await key("Escape", 0);
        } else await clickAt(8, 8, "left");
        await settle();
        if (scenario === "rapid") {
          await clickSelector("[data-gate-trigger=nested]", "left", true);
          await wait(
            "nested reopens",
            "window.gatePresented('[data-gate-popup=nested]')",
          );
          await key("Escape", 0);
          await settle();
        }
        await clickAt(8, 8, "left");
        await settle();
        const closed = await evaluate(
          "document.querySelector('[data-gate-state]').dataset.open==='false'",
        );
        console.log(
          `KNOWN-DEFECT lane (non-gating) nested ${state}/${scenario}: second gesture closed=${closed}; ${closed ? "RESOLVED" : "PRESENT"}`,
        );
      }
  }
  async function comparatorCheck() {
    const images = await evaluate(
      `(()=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle='black';x.fillRect(0,0,1,1);const a=c.toDataURL().split(',')[1];x.fillStyle='white';x.fillRect(0,0,1,1);return [a,c.toDataURL().split(',')[1]];})()`,
    );
    const [a, b] = images.map((v) => Buffer.from(v, "base64"));
    assert.equal(
      (await canvasDiff(a, a)).pixels,
      0,
      "Comparator rejects identical images",
    );
    assert.equal(
      (await canvasDiff(a, b)).pixels,
      1,
      "Comparator misses a changed pixel",
    );
  }
  async function concealChecks() {
    const guarded = [
      ["dialog", "default"],
      ["popover", "default"],
      ["dropdown-menu", "default"],
      ["select", "controlled"],
      ["select", "uncontrolled"],
      ["context-menu", "controlled"],
      ["context-menu", "uncontrolled"],
    ];
    // Positive controls: each callback we assert must fire on an ordinary close.
    for (const [family, state] of guarded) {
      await load(family, state, "conceal", views[0], "light");
      // ContextMenu's trigger wraps a real focusable `<button>` child (its
      // own gate case, primitive-gate.tsx:722-724) inside a non-focusable
      // right-click zone - not plain text. Measured via
      // portal-lifecycle-gate's native-vs-production `contextButton=true`
      // comparison (both native Base and production agree): a right-click on
      // it DOES focus that child button in a real browser, and Escape's
      // close-focus restores to it, not to any previously-focused element.
      // Establish a real previously-focused element (B) first anyway, so the
      // restoration check below stays a genuine proof that the close-focus
      // callback moved focus, not a no-op because it was already there.
      // Every other family keeps its existing expectation.
      if (family === "context-menu")
        await clickSelector("[data-gate-outside]", "left", true);
      await open(family, state, views[0]);
      await settle();
      if (["dialog", "popover"].includes(family))
        await check(
          "open autofocus probe connected",
          "document.querySelector('[data-gate-state]').dataset.openFocus==='1'",
        );
      await key("Escape", 0);
      await settle();
      await wait(
        "ordinary close callback connected",
        "document.querySelector('[data-gate-state]').dataset.closeFocus==='1'",
      );
      await check(
        family === "context-menu"
          ? "ordinary close restores the captured child button inside the trigger zone"
          : "ordinary close restores trigger",
        family === "context-menu"
          ? "document.activeElement.matches('[data-gate-trigger] button')"
          : "document.activeElement.matches('[data-gate-trigger]')",
      );
      report.behavior.push(`focus-control/${family}/${state}`);
    }
    for (const control of ["focus", "visible", "conceal"]) {
      const families =
        control === "conceal"
          ? [
              ...guarded,
              ["sheet", "right"],
              ["tooltip", "default"],
              ["hover-card", "default"],
            ]
          : guarded;
      for (const [family, state] of families) {
        await load(family, state, "conceal", views[0], "light");
        current += `/${control}`;
        await clickSelector("[data-gate-owner-input]", "left", true);
        await client.send("Input.insertText", { text: " retained" });
        const unlocked = await evaluate("window.gateLockStyles()");
        await open(family, state, views[0]);
        await settle();
        // Guards the CSS promise (#466) with a real hit-test rather than a DOM
        // structure match: a label-only tooltip must stay transparent to the
        // pointer, while a hover-card preview - real controls inside it - must
        // not.
        if (family === "tooltip" || family === "hover-card") {
          const popupSelector =
            family === "tooltip"
              ? '[data-gate-popup="tooltip"]'
              : '[data-gate-popup="hover"]';
          const positionerSlot =
            family === "tooltip"
              ? "tooltip-positioner"
              : "hover-card-positioner";
          const p = await center(popupSelector);
          const hitsPositioner = await evaluate(
            `!!document.elementFromPoint(${p.x},${p.y})?.closest('[data-slot="${positionerSlot}"]')`,
          );
          assert.equal(
            hitsPositioner,
            family === "hover-card",
            `${family}: popup center hit-test ${family === "tooltip" ? "must stay transparent to the pointer" : "must remain interactive"}`,
          );
        }
        const before = await evaluate(
          "({...document.querySelector('[data-gate-state]').dataset})",
        );
        // D13 (user ruling, t07-overlay-wave-2): menus and dropdowns close on
        // concealment, no patch. Every family here EXCEPT Dialog/Popover
        // (their older useOverlayPresentation guard never touches the owner)
        // and the borrowed conceal-only Sheet/Tooltip/Hover-card cases now
        // routes presentation-loss through the real useClosingOverlay guard,
        // so its owner genuinely closes - `open` flips false and `changes`
        // increments by exactly one - instead of merely hiding while staying
        // logically open.
        const genuinelyCloses = ![
          "dialog",
          "popover",
          "sheet",
          "tooltip",
          "hover-card",
        ].includes(family);
        // Tracks the `changes` count a genuinely-closing family is expected to
        // carry at each checkpoint below - bumped exactly where a real
        // `changeOpen` call is expected (a presentation-loss close or an
        // explicit reopen), never guessed as a flat multiple.
        let expectedChanges = Number(before.changes);
        const hide = `window.primitiveGate.${control}(${control === "conceal"})`;
        const show = `window.primitiveGate.${control}(${control !== "conceal"})`;
        await evaluate(hide);
        const attribute = {
          focus: "focused",
          visible: "visible",
          conceal: "concealed",
        }[control];
        await wait(
          "independent presentation control committed",
          `document.querySelector('[data-gate-state]').dataset.${attribute}==='${control === "conceal"}'`,
        );
        if (family === "select" && control !== "conceal") await settle(); // Pane activity forces a genuine Select close, including its normal exit.
        await check(
          "no painted popup, backdrop or positioner after commit",
          "window.gateSurfacesHidden()",
        );
        await delay(150); // Observe deferred Radix FocusScope cleanup, not just React's commit.
        await settle();
        if (control !== "conceal") {
          assert.deepEqual(
            await evaluate("window.primitiveGate.focusEvents"),
            ["B"],
            "Focus returned to A during/after the host switch",
          );
          await check(
            "focus remains in B without repair",
            "document.activeElement.matches('[data-gate-outside]')",
          );
        }
        assert.deepEqual(
          await evaluate("window.gateLockStyles()"),
          unlocked,
          "Document/body lock styles were not released",
        );
        // Real document scroll, outside the independently scrollable pane child.
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 1100,
          y: 600,
          deltaX: 0,
          deltaY: 100,
        });
        await wait(
          "document scroll released",
          "document.scrollingElement.scrollTop > 0",
        );
        await evaluate("window.scrollTo(0,0)");
        const p = await center("[data-gate-scroll]");
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...p,
          deltaX: 0,
          deltaY: 60,
        });
        await wait(
          "pane inner scroll released",
          "document.querySelector('[data-gate-scroll]').scrollTop > 0",
        );
        await key("Escape", 0);
        await clickSelector("[data-gate-outside]", "left", true);
        if (genuinelyCloses) expectedChanges += 1;
        await check(
          "hidden owners untouched",
          `document.querySelector('[data-gate-state]').dataset.changes===${JSON.stringify(String(expectedChanges))} && document.querySelector('[data-gate-state]').dataset.draft===${JSON.stringify(before.draft)}`,
        );
        const hidden = await evaluate(
          "({...document.querySelector('[data-gate-state]').dataset})",
        );
        // D13: every family that genuinely closes on presentation loss still
        // routes it through the real useClosingOverlay guard as a mandatory,
        // non-cancellable notification - never a counted close-focus event
        // (that stays reserved for an ordinary, user-driven close). This
        // matches Dialog/Popover's pre-existing useOverlayPresentation
        // guarantee, just reached by a different mechanism.
        assert.equal(
          Number(hidden.closeFocus) - Number(before.closeFocus),
          0,
          `${family}: presentation-loss must not fire a close-focus event on ${control}`,
        );
        await evaluate(show);
        await wait(
          "presentation restored",
          `document.querySelector('[data-gate-state]').dataset.${attribute}==='${control !== "conceal"}'`,
        );
        if (genuinelyCloses) {
          if (family === "select")
            await check(
              `${family}/${state}: closes on presentation loss but keeps its value`,
              "!window.gatePresented('[data-gate-popup]') && document.querySelector('[data-gate-trigger]').textContent.includes('First view')",
            );
          else
            await check(
              `${family}: closes on presentation loss`,
              "!window.gatePresented('[data-gate-popup]')",
            );
          // Genuinely closed means Base never mounts a closed owner's popup -
          // restoring presentation alone cannot bring it back, unlike
          // Dialog/Popover which never lost `open` to begin with. Reopen
          // explicitly so every assertion below still exercises a real,
          // presented popup.
          await open(family, state, views[0]);
          await settle();
          expectedChanges += 1;
        } else if (["tooltip", "hover-card"].includes(family)) {
          await hoverSelector("[data-gate-trigger]");
          await wait(
            "hover reopens",
            "window.gatePresented('[data-gate-popup]')",
          );
        } else
          await wait(
            "logical open re-presents",
            "window.gatePresented('[data-gate-popup]')",
          );
        await settle();
        await check(
          "draft and logical callback count preserved",
          `document.querySelector('[data-gate-state]').dataset.changes===${JSON.stringify(String(expectedChanges))} && document.querySelector('[data-gate-state]').dataset.draft===${JSON.stringify(before.draft)}`,
        );
        // Each owner-controlled family gets a quick A→B→A cycle and a distinct
        // close-while-concealed commit. Completion API probes belong to T02.
        if (
          !["tooltip", "hover-card"].includes(family) &&
          state !== "uncontrolled"
        ) {
          const beforeRapid = await evaluate(
            "({...document.querySelector('[data-gate-state]').dataset})",
          );
          const interruptedSelect =
            family === "select" && control !== "conceal";
          await evaluate(hide);
          await wait(
            "quick control commit",
            `document.querySelector('[data-gate-state]').dataset.${attribute}==='${control === "conceal"}'`,
          );
          if (genuinelyCloses) expectedChanges += 1;
          if (interruptedSelect) {
            // (a) Observe the mid-exit state and restore presentation WITHOUT
            // any trigger action. D13 already closed the owner for real the
            // instant `hide` ran, so `show` restoring presentation cannot by
            // itself reopen anything - this only proves the exit animation is
            // left alone (not force-finished, not restarted) while focus and
            // callbacks stay untouched throughout it.
            const pending = await evaluate(`(() => {
              const popup = document.querySelector('[data-gate-popup]');
              const animations = document.getAnimations().filter(a => a.effect?.target instanceof Element && (a.effect.target === popup || a.effect.target.contains(popup)));
              const pending = animations.some(a => a.playState !== 'finished' && Number(a.currentTime) < a.effect.getComputedTiming().endTime / 2);
              const painted = window.gatePainted(popup);
              ${show};
              return {pending, painted};
            })()`);
            assert.deepEqual(
              pending,
              { pending: true, painted: true },
              "Rapid Select cycle did not observe a pending visible close",
            );
            console.log(
              `PASS observed Select ${control} close before halfway, no reopen`,
            );
            await wait(
              "exit finishes fully closed",
              "!window.gatePresented('[data-gate-popup]')",
            );
            await settle();
            await check(
              "mid-exit presentation return preserves focus in B",
              "document.activeElement.matches('[data-gate-outside]')",
            );
            assert.deepEqual(
              await evaluate("window.primitiveGate.focusEvents"),
              ["B"],
              "Presentation return during exit transiently stole focus",
            );
            assert.equal(
              await evaluate(
                "document.querySelector('[data-gate-state]').dataset.closeFocus",
              ),
              beforeRapid.closeFocus,
              "Presentation return during exit fired a stale close-focus callback",
            );
            // (b) A separate, later reopen is a FRESH open and owns focus
            // normally - deliberately not conflated with the mid-exit return
            // above, which must never itself trigger a reopen.
            await open(family, state, views[0]);
            expectedChanges += 1;
            await settle();
            await check(
              "separate reopen after exit owns focus normally",
              "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
            );
          } else {
            await evaluate(show);
            if (genuinelyCloses) {
              await open(family, state, views[0]);
              expectedChanges += 1;
            }
            await wait(
              "quick re-present",
              "window.gatePresented('[data-gate-popup]')",
            );
            await settle();
            await check(
              "re-presented popup owns focus",
              "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
            );
          }
          await check(
            "rapid cycle retains logical owner state",
            `document.querySelector('[data-gate-state]').dataset.open===${JSON.stringify(before.open)} && document.querySelector('[data-gate-state]').dataset.changes===${JSON.stringify(String(expectedChanges))} && document.querySelector('[data-gate-state]').dataset.draft===${JSON.stringify(before.draft)}`,
          );
          const focusHistory = await evaluate(
            "window.primitiveGate.focusEvents.slice()",
          );
          const cycle = await evaluate(
            "({...document.querySelector('[data-gate-state]').dataset})",
          );
          const active = await evaluate("document.activeElement?.outerHTML");
          await delay(500);
          assert.deepEqual(
            await evaluate(
              "({...document.querySelector('[data-gate-state]').dataset})",
            ),
            cycle,
            "Old cycle mutated owner/callback state after re-presentation",
          );
          assert.deepEqual(
            await evaluate("window.primitiveGate.focusEvents"),
            focusHistory,
            "Old cycle caused a transient focus move",
          );
          assert.equal(
            await evaluate("document.activeElement?.outerHTML"),
            active,
            "Old cycle stole focus after re-presentation",
          );
          await evaluate(hide);
          await wait(
            "hidden before owner close",
            "window.gateSurfacesHidden()",
          );
          await evaluate("window.primitiveGate.ownerClose()");
          await wait(
            "closed owner committed while unpresented",
            `document.querySelector('[data-gate-state]').dataset.open==='false' && document.querySelector('[data-gate-state]').dataset.${attribute}==='${control === "conceal"}'`,
          );
          await settle();
          const closed = await evaluate(
            "({...document.querySelector('[data-gate-state]').dataset})",
          );
          await delay(500);
          assert.deepEqual(
            await evaluate(
              "({...document.querySelector('[data-gate-state]').dataset})",
            ),
            closed,
            "Delayed hidden close mutated owner/callback state",
          );
          await evaluate(show);
          await settle();
          await check(
            "closed owner does not reopen on presentation",
            "!window.gatePresented('[data-gate-popup]') && document.querySelector('[data-gate-state]').dataset.open==='false'",
          );
          await check(
            "closed owner preserves staged draft",
            `document.querySelector('[data-gate-state]').dataset.draft===${JSON.stringify(before.draft)}`,
          );
        }
        report.behavior.push(`${control}/${family}/${state}`);
      }
    }
    // Negative control for the real-wheel proof: a document lock must stop it.
    await load("button", "default", "conceal", views[0], "light");
    await evaluate(
      "document.documentElement.style.overflow='hidden'; document.body.style.overflow='hidden'",
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 1100,
      y: 600,
      deltaX: 0,
      deltaY: 100,
    });
    await delay(150);
    assert.equal(
      await evaluate("document.scrollingElement.scrollTop"),
      0,
      "Scroll negative control is ineffective",
    );
    await evaluate(
      "document.documentElement.style.overflow=''; document.body.style.overflow=''",
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 1100,
      y: 600,
      deltaX: 0,
      deltaY: 100,
    });
    await wait(
      "scroll positive control",
      "document.scrollingElement.scrollTop > 0",
    );
  }
  // Radix parity for Base's default (undefined) initialFocus: auto-select an
  // automatically-focused INPUT's text, never a textarea, never a caller-
  // directed target, and only once per genuine open (see useOverlayFocus).
  // The fixture only arms the real default path in mode="visual" - any other
  // mode supplies the counting callback the other checks need, which is
  // itself the "custom target" case here.
  async function defaultFocusChecks() {
    for (const family of ["dialog", "popover"]) {
      await load(family, "default", "visual", views[0], "light");
      await open(family, "default", views[0]);
      await settle();
      await check(
        "default open selects the first tabbable input",
        "document.activeElement.matches('[data-gate-input]') && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length",
      );
      report.behavior.push(`default-focus/${family}/input-selected`);

      await clickSelector("[data-gate-body]", "left", true);
      await wait(
        "focus left the input",
        "!document.activeElement.matches('[data-gate-input]')",
      );
      await clickSelector("[data-gate-input]", "left", true);
      await wait(
        "input refocused",
        "document.activeElement.matches('[data-gate-input]')",
      );
      await check(
        "a later manual refocus does not re-select - the one-shot arm already expired",
        "document.activeElement.selectionStart === document.activeElement.selectionEnd",
      );
      report.behavior.push(`default-focus/${family}/refocus-no-select`);
    }

    for (const family of ["dialog", "popover"]) {
      await load(family, "textarea", "visual", views[0], "light");
      await open(family, "textarea", views[0]);
      await settle();
      await check(
        "default open focuses a textarea but never selects it",
        "document.activeElement.matches('[data-gate-textarea]') && document.activeElement.selectionStart === document.activeElement.selectionEnd",
      );
      report.behavior.push(`default-focus/${family}/textarea-not-selected`);
    }

    for (const family of ["dialog", "popover"]) {
      await load(family, "default", "conceal", views[0], "light");
      await open(family, "default", views[0]);
      await settle();
      await check(
        "a caller-supplied initialFocus never selects, even focusing the same input",
        "document.activeElement.matches('[data-gate-input]') && document.activeElement.selectionStart === document.activeElement.selectionEnd",
      );
      report.behavior.push(
        `default-focus/${family}/custom-target-not-selected`,
      );
    }

    for (const family of ["dialog", "popover"]) {
      await load(family, "default", "visual", views[0], "light");
      await open(family, "default", views[0]);
      await settle();
      await evaluate("window.primitiveGate.focus(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-state]').dataset.focused==='false'",
      );
      await delay(150);
      await evaluate("window.primitiveGate.focus(true)");
      await wait(
        "logical open re-presents",
        "window.gatePresented('[data-gate-popup]')",
      );
      await settle();
      await check(
        "a default presentation-return focuses the popup container, not the input",
        "document.activeElement.matches('[data-gate-popup]') && !document.activeElement.matches('[data-gate-input]')",
      );
      report.behavior.push(
        `default-focus/${family}/return-focuses-popup-container`,
      );
    }

    // Sheet's wrapper never receives a counting `initialFocus`/`finalFocus`
    // at all (the fixture's `sheet` case renderer doesn't forward them), so
    // it always exercises the real default path already - covered once here
    // to prove its own independent `useOverlayFocus` usage in sheet.tsx.
    await load("sheet", "default", "visual", views[0], "light");
    await open("sheet", "default", views[0]);
    await settle();
    await check(
      "Sheet's own wrapper also selects the first tabbable input by default",
      "document.activeElement.matches('[data-gate-input]') && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length",
    );
    report.behavior.push("default-focus/sheet/input-selected");

    // Raw frame (PromotableModalFrame): NOT covered. Its own header renders
    // the promote/close buttons before the body in DOM order, so the first
    // TABBABLE element there is "Open as tab", not `data-gate-input` -
    // measured directly (the initial attempt asserted the input and failed
    // on exactly this), not a production defect. Left out rather than
    // guessing a different selector this round.
  }
  // Ported off the retired T02 proof lane's own row dataset and assertions
  // (see git history 5bcc0c8ad, base-ui-proofs.{tsx,mjs}) - now driven
  // against the real, shipped `@/components/ui/command`, plus net-new cases
  // (dynamic mutation, D16 Command-in-overlay) the proof never covered.
  async function commandChecks() {
    const visibleValues = (name) =>
      `[...document.querySelectorAll('[data-gate-palette=${name}] [role=option]:not([hidden])')].map(e=>e.dataset.value)`;
    const pickedOf = (name) =>
      `document.querySelector('[data-gate-command-state=${name}]').dataset.picked`;
    const activeIdOf = (name) =>
      `document.getElementById(document.querySelector('[data-gate-palette=${name}] input').getAttribute('aria-activedescendant'))?.dataset.value`;
    const focusInput = async (name) => {
      // The stacked fixtures are taller than the viewport, and
      // `[data-gate-stage]` vertically centers its content - a click's
      // coordinates are viewport-relative and never auto-scroll, so an
      // un-scrolled palette below/above the fold hit-tests against nothing.
      await evaluate(
        `document.querySelector('[data-gate-palette=${name}] input').scrollIntoView({block:'center'})`,
      );
      await clickSelector(`[data-gate-palette=${name}] input`, "left", true);
    };
    const typeQuery = async (name, text) => {
      await focusInput(name);
      await evaluate(
        `document.querySelector('[data-gate-palette=${name}] input').select()`,
      );
      await client.send("Input.insertText", { text });
      await delay(40);
    };

    await load("command", "default", "command", views[0], "light");

    await check(
      "default highlight lands on the first ENABLED row, skipping the disabled one entirely",
      `${activeIdOf("one")}==='tree'`,
    );
    report.behavior.push("command/ranking/default-highlight-skips-disabled");

    const beforeExactId = await evaluate(
      "document.querySelector('[data-gate-palette=one] [data-value=exact]').id",
    );
    await typeQuery("one", "Project");
    await check(
      "an exact label match ranks first, ties keep source-registration order, and non-matching duplicates are excluded",
      `JSON.stringify(${visibleValues("one")})===JSON.stringify(['exact','r2','r3','r4','r5','r6','r7','r8','r9','r10','r11'])`,
    );
    report.behavior.push(
      "command/ranking/exact-match-first-ties-in-source-order",
    );
    const afterExactId = await evaluate(
      "document.querySelector('[data-gate-palette=one] [data-value=exact]').id",
    );
    assert.equal(
      beforeExactId,
      afterExactId,
      "command/stable-ids: filtering must not remount a row",
    );
    report.behavior.push("command/stable-ids/row-not-remounted-by-filter");

    await key("Enter", 0);
    await check(
      "Enter picks the highlighted row and RETAINS the typed query",
      `${pickedOf("one")}==='exact' && document.querySelector('[data-gate-palette=one] input').value==='Project'`,
    );
    await check(
      "a second, independent Command instance is untouched by the first's query/pick",
      `document.querySelector('[data-gate-palette=two] input').value==='' && ${pickedOf("two")}===''`,
    );
    report.behavior.push(
      "command/independence/two-instances-do-not-share-state",
    );
    report.behavior.push("command/selection/query-retained-after-pick");

    await typeQuery("one", "Duplicate");
    await check(
      "both tied 'Duplicate' rows survive filtering, nothing else does",
      `JSON.stringify(${visibleValues("one")})===JSON.stringify(['r0','r1'])`,
    );
    await key("ArrowDown", 0);
    await key("Enter", 0);
    await check(
      "ArrowDown moved off the default first duplicate onto the second",
      `${pickedOf("one")}==='r1'`,
    );
    report.behavior.push(
      "command/duplicates/both-tied-rows-kept-arrowdown-picks-second",
    );

    await typeQuery("one", "zzzz");
    await check(
      "a zero-match query empties the row list and shows the empty state, without clearing the LAST pick",
      `${visibleValues("one")}.length===0 && ${pickedOf("one")}==='r1' && document.querySelector('[data-gate-palette=one] [data-slot=command-empty]')?.textContent==='No results'`,
    );
    report.behavior.push(
      "command/empty/zero-matches-shows-empty-state-keeps-last-pick",
    );

    // Fresh page for paging/disabled-skip/controlled-highlight/IME.
    await load("command", "default", "command", views[0], "light");
    await focusInput("one");
    await key("ArrowDown", 0);
    await check(
      "ArrowDown from the default skips the disabled row entirely",
      `${activeIdOf("one")}==='r0'`,
    );
    report.behavior.push("command/navigation/arrowdown-skips-disabled-row");
    await key("Home", 0);
    await check(
      "Home returns to the first enabled row",
      `${activeIdOf("one")}==='tree'`,
    );

    const pageSize = await evaluate(
      "(()=>{const list=document.querySelector('[data-gate-palette=one] [data-slot=command-list]');const first=list.querySelector('[role=option]:not([hidden])');return Math.max(1,Math.floor(list.clientHeight/(first?.offsetHeight||36))-1)})()",
    );
    await key("PageDown", 0);
    const afterPageDown = await evaluate(activeIdOf("one"));
    const enabledInOrder = await evaluate(
      "[...document.querySelectorAll('[data-gate-palette=one] [role=option]:not([hidden])')].filter(e=>e.getAttribute('aria-disabled')!=='true').map(e=>e.dataset.value)",
    );
    assert.equal(
      afterPageDown,
      enabledInOrder[pageSize],
      "command/navigation: PageDown must land exactly pageSize enabled rows forward",
    );
    report.behavior.push(
      "command/navigation/pagedown-moves-by-page-size-over-enabled-rows",
    );
    await key("PageUp", 0);
    await check(
      "PageUp returns symmetrically",
      `${activeIdOf("one")}==='tree'`,
    );
    report.behavior.push("command/navigation/pageup-returns-symmetrically");

    await evaluate("window.primitiveGate.command.setHighlight('one','r1')");
    await delay(20);
    await check(
      "an externally controlled highlight resolves through the real input's aria-activedescendant",
      `${activeIdOf("one")}==='r1'`,
    );
    report.behavior.push(
      "command/controlled-highlight/aria-activedescendant-resolves-to-forced-row",
    );

    // IME: three ways an Enter can arrive mid-composition must all be
    // swallowed; only a real Enter past the 50ms post-composition grace
    // window may pick. The compositionend/Enter boundary cases are driven
    // by an EXPLICIT synthetic `timeStamp` (via `Object.defineProperty`,
    // which shadows the read-only prototype getter) rather than a real
    // wall-clock `delay()` - a fixed, deterministic ms gap on either side
    // of the 50ms threshold, never flaky against CI/host clock jitter.
    const IME_T0 = 100000;
    const dispatchAt = (type, ctor, init, timeStamp) =>
      evaluate(
        `(()=>{const input=document.querySelector('[data-gate-palette=one] input');const ev=new ${ctor}(${JSON.stringify(type)},${JSON.stringify(init)});Object.defineProperty(ev,'timeStamp',{value:${timeStamp},configurable:true});input.dispatchEvent(ev);})()`,
      );
    await evaluate(
      "document.querySelector('[data-gate-palette=one] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))",
    );
    await check(
      "a composing Enter (isComposing=true) never picks",
      `${pickedOf("one")}!=='r1'`,
    );
    await evaluate(
      "(()=>{const input=document.querySelector('[data-gate-palette=one] input');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:false,bubbles:true,cancelable:true}));})()",
    );
    await check(
      "an Enter while composition is still ACTIVE never picks",
      `${pickedOf("one")}!=='r1'`,
    );
    await dispatchAt(
      "compositionend",
      "CompositionEvent",
      { bubbles: true },
      IME_T0,
    );
    await dispatchAt(
      "keydown",
      "KeyboardEvent",
      { key: "Enter", isComposing: false, bubbles: true, cancelable: true },
      IME_T0 + 49,
    );
    await check(
      "an Enter 49ms after compositionend - just INSIDE the 50ms grace window - never picks",
      `${pickedOf("one")}!=='r1'`,
    );
    report.behavior.push(
      "command/ime/three-negative-enters-swallowed-during-and-just-after-composition",
    );
    await dispatchAt(
      "keydown",
      "KeyboardEvent",
      { key: "Enter", isComposing: false, bubbles: true, cancelable: true },
      IME_T0 + 51,
    );
    await check(
      "an Enter 51ms after compositionend - just PAST the 50ms grace window - picks normally",
      `${pickedOf("one")}==='r1'`,
    );
    report.behavior.push("command/ime/enter-past-grace-window-picks");

    // shouldFilter=false: caller order survives even a query that would
    // zero-score everything under the real scorer.
    const beforeNoFilter = await evaluate(visibleValues("nofilter"));
    await typeQuery("nofilter", "zzzz");
    const afterNoFilter = await evaluate(visibleValues("nofilter"));
    assert.deepEqual(
      afterNoFilter,
      beforeNoFilter,
      "command/shouldFilter-false: row order must survive an unmatched query untouched",
    );
    report.behavior.push(
      "command/shouldFilter-false/order-preserved-under-unmatched-query",
    );

    // Dynamic mutation against live-registered rows: remove / disable /
    // reorder, each proven against the real DOM, not a bypassed assertion.
    await check(
      "dynamic fixture starts as a,b,c,d",
      `JSON.stringify(${visibleValues("dyn")})===JSON.stringify(['a','b','c','d'])`,
    );
    await evaluate("window.primitiveGate.command.setHighlight('dyn','b')");
    await delay(20);
    await check(
      "b is the highlighted row before removal (setup)",
      `${activeIdOf("dyn")}==='b'`,
    );
    await evaluate("window.primitiveGate.command.removeRow('dyn','b')");
    await delay(20);
    await check(
      "a removed row is gone from the DOM entirely, not just hidden",
      `!document.querySelector('[data-gate-palette=dyn] [data-value=b]') && JSON.stringify(${visibleValues("dyn")})===JSON.stringify(['a','c','d'])`,
    );
    await check(
      "removing the HIGHLIGHTED row leaves aria-activedescendant resolving to a REAL remaining row, never a stale id pointing at nothing",
      `${activeIdOf("dyn")}!==undefined && document.querySelector('[data-gate-palette=dyn] input').getAttribute('aria-activedescendant')===document.querySelector('[data-gate-palette=dyn] [role=option]:not([hidden])').id`,
    );
    report.behavior.push(
      "command/dynamic/removeRow-drops-the-row-from-the-dom",
    );

    // Stashed on `window` rather than compared by `.id` string: an id
    // attribute survives a hypothetical `cloneNode` swap, so only a real
    // `===` reference comparison against the SAME DOM node object actually
    // proves "reused", not "recreated with a matching id".
    await evaluate(
      "void (window.__gateReorderElement = document.querySelector('[data-gate-palette=dyn] [data-value=a]'))",
    );
    await evaluate("window.primitiveGate.command.toggleDisabled('dyn','c')");
    await delay(20);
    await focusInput("dyn");
    await key("Home", 0);
    await key("ArrowDown", 0);
    await check(
      "navigation honors the live-toggled disabled row c, skipping straight to d",
      `${activeIdOf("dyn")}==='d'`,
    );
    report.behavior.push(
      "command/dynamic/toggleDisabled-is-honored-by-navigation-live",
    );

    await evaluate("window.primitiveGate.command.reorder('dyn',['d','a','c'])");
    await delay(20);
    await check(
      "reorder changes DOM order to the supplied sequence",
      "JSON.stringify([...document.querySelectorAll('[data-gate-palette=dyn] [role=option]')].map(e=>e.dataset.value))===JSON.stringify(['d','a','c'])",
    );
    await check(
      "command/dynamic: reordering must reuse the EXACT SAME DOM node (real === reference identity, not just a matching id string), never remount",
      "document.querySelector('[data-gate-palette=dyn] [data-value=a]')===window.__gateReorderElement",
    );
    report.behavior.push("command/dynamic/reorder-preserves-row-identity");

    // T08 review R1: navigation must read the COMMITTED anchor order, not a
    // render-time DOM snapshot that still describes the previous caller
    // order. Reorder just landed ['d','a','c'] with 'c' disabled (toggled
    // above); press Home/End IMMEDIATELY, with no intervening query change -
    // the exact gap the review's own probe found (the old browser case
    // changed the query before its next order check, which happened to
    // refresh the stale collection and mask the bug).
    await focusInput("dyn");
    await key("Home", 0);
    await check(
      "immediately after a reorder, with no query change, Home lands on the NEW first row - not the pre-reorder one",
      `${activeIdOf("dyn")}==='d'`,
    );
    await key("End", 0);
    await check(
      "immediately after a reorder, with no query change, End lands on the NEW last ENABLED row - not the pre-reorder one, and not the disabled 'c'",
      `${activeIdOf("dyn")}==='a'`,
    );
    report.behavior.push(
      "command/dynamic/reorder-immediate-home-end-no-query-change",
    );

    // After an external reorder, a re-render triggered by something else
    // (query typed then cleared) must not silently revert to the
    // pre-reorder authored order - `orderCommandElements` re-derives DOM
    // order from ranked/blocks (tied scores + anchor position) on every
    // query change, and the anchors themselves now follow the REORDERED
    // `rows` state, not the original JSX literal order.
    await typeQuery("dyn", "zzzz");
    await typeQuery("dyn", "");
    await check(
      "a later unrelated re-render keeps the externally-set order - it does not revert to source/authored order",
      "JSON.stringify([...document.querySelectorAll('[data-gate-palette=dyn] [role=option]:not([hidden])')].map(e=>e.dataset.value))===JSON.stringify(['d','a','c'])",
    );
    report.behavior.push(
      "command/dynamic/reorder-survives-a-later-unrelated-rerender",
    );

    // ArrowUp/Home/End against a dataset disabled at BOTH array endpoints -
    // must land on the nearest ENABLED row, never clamp onto a disabled
    // edge. Ports the unit-level "Home/End skip disabled rows even at the
    // array's own endpoints" case into the real browser lane.
    await focusInput("endpoints");
    await check(
      "default highlight already skips the disabled first row",
      `${activeIdOf("endpoints")}==='one'`,
    );
    await key("End", 0);
    await check(
      "End lands on the last ENABLED row, skipping the disabled last row",
      `${activeIdOf("endpoints")}==='three'`,
    );
    await key("Home", 0);
    await check(
      "Home lands on the first ENABLED row, skipping the disabled first row",
      `${activeIdOf("endpoints")}==='one'`,
    );
    await key("ArrowDown", 0);
    await check(
      "ArrowDown from the first enabled row moves forward normally",
      `${activeIdOf("endpoints")}==='two'`,
    );
    await key("ArrowUp", 0);
    await check(
      "ArrowUp moves back to the first enabled row",
      `${activeIdOf("endpoints")}==='one'`,
    );
    await key("ArrowUp", 0);
    await check(
      "ArrowUp from the first enabled row clamps there rather than reaching past it toward the disabled endpoint",
      `${activeIdOf("endpoints")}==='one'`,
    );
    report.behavior.push(
      "command/navigation/arrowup-home-end-clamp-at-disabled-endpoints",
    );

    // Fresh page: T08 review R1 (tied-query + nested-consumer reorder) and
    // R2 (dropped modifier-key chords) regressions, against a clean mount of
    // every fixture below.
    await load("command", "default", "command", views[0], "light");

    // R1, second probe case: tied rows reordered while an ACTIVE query stays
    // UNCHANGED - no query change is inserted anywhere in this case to force
    // a refresh, which is exactly what let the bug through the review's own
    // probe missed it with.
    await typeQuery("dyn", "Row");
    await check(
      "a query that ties every row (same label prefix, same match position) keeps source-registration order",
      `JSON.stringify(${visibleValues("dyn")})===JSON.stringify(['a','b','c','d'])`,
    );
    await evaluate(
      "window.primitiveGate.command.reorder('dyn',['d','c','b','a'])",
    );
    await delay(20);
    await check(
      "tied rows reordered under an ACTIVE, UNCHANGED query: DOM reflects the new caller order immediately - it does not stay on the pre-reorder order waiting for a later query change",
      `JSON.stringify(${visibleValues("dyn")})===JSON.stringify(['d','c','b','a'])`,
    );
    report.behavior.push(
      "command/dynamic/tied-query-reorder-applies-without-a-query-change",
    );

    // R1, third probe case: a reorder driven entirely by a component NESTED
    // under Command (its own local state) - Command itself never re-renders
    // from this trigger, so only its MutationObserver can pick it up. Same
    // tied-query shape as above, to exercise the SCORED reordering path
    // (`orderCommandElements` under `filtering=true`), which is the one that
    // needs the observer's own fresh `committedSourcePositions` read, not
    // just `navigate()`'s independent live read.
    await typeQuery("nested", "Nested");
    await check(
      "nested fixture: a tying query keeps source-registration order before any reorder",
      `JSON.stringify(${visibleValues("nested")})===JSON.stringify(['n1','n2','n3'])`,
    );
    await evaluate(
      "window.primitiveGate.command.nestedReorder(['n3','n1','n2'])",
    );
    await delay(20);
    await check(
      "a reorder driven by a component NESTED under Command (Command itself never re-renders) still lands in the new order under an active tied query - only the MutationObserver path can produce this",
      `JSON.stringify(${visibleValues("nested")})===JSON.stringify(['n3','n1','n2'])`,
    );
    report.behavior.push(
      "command/dynamic/nested-consumer-owned-reorder-observed-without-command-rerender",
    );

    // R2: default modifier-key navigation. `chords` is 3 groups - g1=[a,b],
    // g2=[skip1,skip2] (disabled-only), g3=[c,d] - so `enabled` is
    // [a,b,c,d] and g2 is invisible to every one of these checks.
    await focusInput("chords");
    await check(
      "chords fixture: default highlight lands on the first enabled row",
      `${activeIdOf("chords")}==='a'`,
    );
    await key("n", 2);
    await check("Ctrl+N maps to ArrowDown", `${activeIdOf("chords")}==='b'`);
    await key("j", 2);
    await check(
      "Ctrl+J maps to ArrowDown too, and skips the disabled-only group g2 the same way plain ArrowDown would",
      `${activeIdOf("chords")}==='c'`,
    );
    await key("p", 2);
    await check("Ctrl+P maps to ArrowUp", `${activeIdOf("chords")}==='b'`);
    await key("k", 2);
    await check("Ctrl+K maps to ArrowUp too", `${activeIdOf("chords")}==='a'`);
    report.behavior.push("command/chords/ctrl-njpk-remap-to-arrow-navigation");

    await key("ArrowDown", 4);
    await check(
      "Meta+ArrowDown jumps to the last ENABLED row (End)",
      `${activeIdOf("chords")}==='d'`,
    );
    await key("ArrowUp", 4);
    await check(
      "Meta+ArrowUp jumps to the first ENABLED row (Home)",
      `${activeIdOf("chords")}==='a'`,
    );
    report.behavior.push("command/chords/meta-arrow-jumps-to-endpoints");

    await key("ArrowDown", 1);
    await check(
      "Alt+ArrowDown from g1 hops to g3's FIRST enabled row, skipping the disabled-only g2 AND skipping 'b' within g1 - proving this is a GROUP hop, not an ordinary/Ctrl-remapped single step (which would land on 'b')",
      `${activeIdOf("chords")}==='c'`,
    );
    await key("ArrowDown", 0);
    await check(
      "plain ArrowDown (no modifier) still moves by one enabled row within the current group",
      `${activeIdOf("chords")}==='d'`,
    );
    await key("ArrowUp", 1);
    await check(
      "Alt+ArrowUp from g3's LAST row hops back to g1's FIRST enabled row 'a' - not the nearer row 'c' it started next to and not 'b' - confirming the hop always lands on the target group's first enabled row regardless of direction or starting row",
      `${activeIdOf("chords")}==='a'`,
    );
    report.behavior.push(
      "command/chords/alt-arrow-hops-groups-lands-on-first-enabled-row",
    );

    await key("ArrowDown", 4);
    await key("ArrowDown", 1);
    await check(
      "Alt+ArrowDown at the LAST group (no next group) falls back to an ordinary single step rather than erroring or wrapping - here that clamps at the already-last row",
      `${activeIdOf("chords")}==='d'`,
    );
    report.behavior.push(
      "command/chords/alt-arrow-falls-back-to-ordinary-step-at-group-boundary",
    );

    // R2 collision audit: a consumer's own onKeyDown that preventDefault()s
    // unconditionally must short-circuit Command's chord handling entirely -
    // `Command`'s bubble handler checks `event.defaultPrevented` right after
    // calling the consumer callback, before any navigation.
    await focusInput("guarded");
    await check(
      "guarded fixture: default highlight lands on the first enabled row (setup)",
      `${activeIdOf("guarded")}==='a'`,
    );
    await key("n", 2);
    await key("ArrowDown", 4);
    await key("ArrowDown", 1);
    await check(
      "a consumer onKeyDown that calls preventDefault() unconditionally blocks EVERY chord family - Ctrl+N, Meta+ArrowDown and Alt+ArrowDown all leave the highlight untouched",
      `${activeIdOf("guarded")}==='a'`,
    );
    report.behavior.push(
      "command/chords/consumer-preventdefault-short-circuits-all-chord-families",
    );

    // R2 collision audit: window-capture precedence. `KeybindingProvider`
    // claims app shortcuts (Ctrl+K/J/N on non-mac) in window CAPTURE phase,
    // before any bubble-phase listener (including Command's own) ever sees
    // the event; `composer-drafts-control.tsx` claims ArrowUp/Down for its
    // own dialog the same way. This reproduces that same real DOM
    // capture-before-bubble guarantee with a minimal capture listener rather
    // than mounting the full KeybindingProvider/Drafts dialog trees, which
    // need router/action-registry/composer context this fixture does not
    // carry - the guarantee under test is the event-order structure, which
    // this exercises identically.
    await focusInput("chords");
    await key("ArrowUp", 4);
    await check(
      "chords fixture: back at the first enabled row (setup)",
      `${activeIdOf("chords")}==='a'`,
    );
    await evaluate(
      "window.__gateCaptured=false; window.__gateCapture=(e)=>{if(e.ctrlKey&&e.key==='n'){e.preventDefault();e.stopPropagation();window.__gateCaptured=true;}}; window.addEventListener('keydown',window.__gateCapture,true);",
    );
    await key("n", 2);
    await check(
      "a window-capture listener claiming Ctrl+N (mirrors KeybindingProvider's app-shortcut precedence on non-mac) intercepts the event before Command's own bubble handler ever sees it - the capture listener fired, and Command did not navigate",
      `window.__gateCaptured===true && ${activeIdOf("chords")}==='a'`,
    );
    await evaluate(
      "window.removeEventListener('keydown',window.__gateCapture,true); delete window.__gateCapture; delete window.__gateCaptured;",
    );
    await evaluate(
      "window.__gateCaptured=false; window.__gateCapture=(e)=>{if(e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();window.__gateCaptured=true;}}; window.addEventListener('keydown',window.__gateCapture,true);",
    );
    await key("ArrowDown", 0);
    await check(
      "a window-capture ArrowDown listener (mirrors composer-drafts-control's own capture-phase interception while its dialog is open) wins the same way - Command's chord handling never reaches it either",
      `window.__gateCaptured===true && ${activeIdOf("chords")}==='a'`,
    );
    await evaluate(
      "window.removeEventListener('keydown',window.__gateCapture,true); delete window.__gateCapture; delete window.__gateCaptured;",
    );
    report.behavior.push(
      "command/chords/window-capture-listener-precedes-commands-own-bubble-handler",
    );

    // Two real production `<Command>` instances sharing the SAME real
    // `pathTreeRow` tree id, rendered through the actual exported
    // `SubpageView` -> `PathSubpageRows`. Isolation must come from
    // `Command`'s own per-instance store (`useState(createOpenerFileTreeStore)`),
    // never a global one.
    const treeOptionValues = (name) =>
      `[...document.querySelectorAll('[data-gate-palette=${name}] [role=option]')].map(e=>e.textContent)`;
    await evaluate(
      "document.querySelector('[data-gate-palette=tree-one] input').scrollIntoView({block:'center'})",
    );
    const beforeExpand = await evaluate(treeOptionValues("tree-one"));
    assert.deepEqual(
      beforeExpand,
      ["src", "README.md"],
      "command/tree-isolation setup: both instances start collapsed",
    );
    await clickSelector(
      "[data-gate-palette=tree-one] [role=option]",
      "left",
      true,
    );
    await delay(60);
    const afterExpandOne = await evaluate(treeOptionValues("tree-one"));
    const afterExpandTwo = await evaluate(treeOptionValues("tree-two"));
    assert.deepEqual(
      afterExpandOne,
      ["src", "lib", "index.ts", "README.md"],
      "command/tree-isolation: expanding tree-one must reveal its real nested rows",
    );
    assert.deepEqual(
      afterExpandTwo,
      ["src", "README.md"],
      "command/tree-isolation: an identically-keyed second instance must stay collapsed",
    );
    report.behavior.push(
      "command/tree-isolation/same-tree-id-two-instances-stay-independent",
    );

    // Real `AgentSubpageRows` / `ArtifactSubpageRows` (via `SubpageView`),
    // two side-by-side instances per surface with the SAME node ids - proves
    // their ArrowLeft/ArrowRight `document.addEventListener(..., true)`
    // handlers are scoped to the instance that OWNS the event's target, not
    // just that each instance's expand/collapse STATE happens to be local
    // (local state alone doesn't isolate a document-level listener - an
    // unscoped one fires against every mounted instance on every keydown).
    // Depth-0 rows default-expanded (`isExpanded`'s `row.depth === 0` term),
    // so both start at 2 visible rows (parent + child); ArrowLeft on the
    // highlighted parent collapses it.
    const optionCount = (name) =>
      `document.querySelectorAll('[data-gate-palette=${name}] [role=option]:not([hidden])').length`;
    for (const [one, two, kind] of [
      ["agents-one", "agents-two", "agent"],
      ["artifacts-one", "artifacts-two", "artifact"],
    ]) {
      await focusInput(one);
      await check(
        `command/${kind}-tree setup: both ${one} and ${two} start with the depth-0 parent's child row already visible`,
        `${optionCount(one)}===2 && ${optionCount(two)}===2`,
      );
      await key("ArrowLeft", 0);
      await check(
        `command/${kind}-tree: ArrowLeft on ${one}'s highlighted parent collapses ONLY ${one}, never the sibling ${two} instance sharing the same node ids`,
        `${optionCount(one)}===1 && ${optionCount(two)}===2`,
      );
      await key("ArrowRight", 0);
      await check(
        `command/${kind}-tree: ArrowRight re-expands ${one} without affecting ${two}`,
        `${optionCount(one)}===2 && ${optionCount(two)}===2`,
      );
      report.behavior.push(
        `command/${kind}-tree/arrowleft-right-scoped-to-owning-command-instance`,
      );
    }

    // Real `PinToggle`, composed the same way `command-palette-shell.tsx`'s
    // own `GroupBlock` does it (`buildPinnedBucket` returns null with no
    // pins, exactly like this fixture's own `pinnedItems.length > 0 ? ... :
    // null` - confirmed by reading `src/lib/commands/grouping.ts` before
    // writing this case, not assumed). A keyboard user arrows to a row (the
    // real reveal trigger - `group-data-[selected=true]/command-item:inline-flex`,
    // not hover) then Tabs to its pin button and activates it with a real
    // keyboard Enter (CDP `Input.dispatchKeyEvent`, which triggers the
    // browser's own default button-activation - unlike a raw
    // `dispatchEvent(new KeyboardEvent(...))`, which does not synthesize a
    // click at all).
    //
    // Production fix (`pin-toggle.tsx`): on click, if the button owned
    // keyboard focus, it calls `highlight(row.id)` on the row's PRE-remount
    // id (the row is still in its CURRENT group at that point, so the
    // context's `enabled.find` lookup resolves), then re-focuses the
    // palette's own input - both before `onToggle()` moves the row to the
    // other CommandGroup. This is now a real gating check: it throws (via
    // `check`) rather than deferring, for both directions on the same item.
    async function pinTogglePreservesFocusAndHighlight(
      itemId,
      testid,
      direction,
    ) {
      await focusInput("pin");
      await key("Home", 0);
      for (
        let i = 0;
        i < 5 && (await evaluate(activeIdOf("pin"))) !== itemId;
        i++
      ) {
        await key("ArrowDown", 0);
      }
      await check(
        `command/pin setup: keyboard navigation reaches ${itemId} before ${direction}`,
        `${activeIdOf("pin")}==='${itemId}'`,
      );
      // Proves onToggle() actually fired, not just the focus/highlight fix.
      const groupHeadingOf = (id) =>
        `document.querySelector('[data-gate-palette=pin] [data-value="${id}"]').closest('[data-slot="command-group"]').querySelector('[data-slot="command-group-heading"]').textContent`;
      const beforePressed = direction === "pin" ? "false" : "true";
      const afterPressed = direction === "pin" ? "true" : "false";
      const beforeGroup = direction === "pin" ? "Actions" : "Pinned";
      const afterGroup = direction === "pin" ? "Pinned" : "Actions";
      await check(
        `command/pin setup: ${itemId}'s pin button starts aria-pressed=${beforePressed} in the "${beforeGroup}" group before ${direction}`,
        `document.querySelector('[data-gate-palette=pin] [data-testid="${testid}"]').getAttribute('aria-pressed')==='${beforePressed}' && ${groupHeadingOf(itemId)}==='${beforeGroup}'`,
      );
      await settle();
      await key("Tab", 0);
      await delay(40);
      await check(
        `command/pin setup: Tab from the highlighted row ${itemId} reaches its own pin button before ${direction}`,
        `document.activeElement.dataset.testid==='${testid}'`,
      );
      await key("Enter", 0);
      await delay(60);
      const name = `command/pin/${direction}-${itemId}-keyboard-activation`;
      await check(
        `${direction} ${itemId} via real keyboard Enter returns focus to the palette's own input, not the pin button or <body>`,
        `document.activeElement===document.querySelector('[data-gate-palette=pin] input')`,
      );
      await check(
        `${direction} ${itemId} keeps it the highlighted row across the CommandGroup move, with a live aria-activedescendant resolving to it`,
        `${activeIdOf("pin")}==='${itemId}'`,
      );
      await check(
        `${direction} ${itemId} actually toggled - pin button now aria-pressed=${afterPressed} and the row now lives in the "${afterGroup}" CommandGroup, not a no-op onToggle`,
        `document.querySelector('[data-gate-palette=pin] [data-testid="${testid}"]').getAttribute('aria-pressed')==='${afterPressed}' && ${groupHeadingOf(itemId)}==='${afterGroup}'`,
      );
      report.behavior.push(name);
    }
    // First call pins beta (Actions -> Pinned, a newly-mounted group);
    // second call unpins it (Pinned -> Actions, both groups already
    // mounted) - both directions.
    await pinTogglePreservesFocusAndHighlight(
      "beta",
      "command-palette-pin-beta",
      "pin",
    );
    await pinTogglePreservesFocusAndHighlight(
      "beta",
      "command-palette-pin-beta",
      "unpin",
    );

    // A genuinely harmless rerender (a controlled `highlightedValue` change
    // that does NOT move the row across CommandGroup parents) must NOT
    // itself cause focus loss - isolates that the defect above is
    // specifically about the cross-group move, not "any rerender
    // whatsoever". Uses "gamma", never pinned/moved by the cases above.
    await evaluate(
      'document.querySelector(\'[data-gate-palette=pin] [data-value="gamma"]\').scrollIntoView({block:"center"})',
    );
    await clickSelector("[data-gate-palette=pin] input", "left", true);
    await hoverSelector('[data-gate-palette=pin] [data-value="gamma"]');
    await settle();
    await key("Tab", 0);
    await delay(40);
    await check(
      "Tab reaches gamma's pin button (never pinned/moved by the cases above)",
      "document.activeElement.dataset.testid==='command-palette-pin-gamma'",
    );
    await evaluate("window.primitiveGate.command.setHighlight('pin','gamma')");
    await delay(60);
    await check(
      "a harmless rerender that does not move the row across groups retains focus on its pin button",
      "document.activeElement.dataset.testid==='command-palette-pin-gamma'",
    );
    report.behavior.push("command/pin/harmless-rerender-retains-focus");

    // D16: Command mounted inside Dialog/Popover gets Base's REAL default
    // focus (first-tabbable on open, restore-to-trigger on close) - never a
    // forced `initialFocus`, so this proves the actual production wiring a
    // real call site gets, not a callback the fixture injected for itself.
    for (const family of ["command-in-dialog", "command-in-popover"]) {
      await load(family, "default", "visual", views[0], "light");
      await open(family, "default", views[0]);
      await settle();
      await check(
        "opening focuses the Command search input by Base's real default (no forced initialFocus)",
        "document.activeElement.matches('[data-gate-palette=one] input')",
      );
      report.behavior.push(
        `command/in-overlay/${family}/opens-focused-on-search-input`,
      );
      await evaluate(
        "document.querySelector('[data-gate-palette=one] input').select()",
      );
      await client.send("Input.insertText", { text: "Project" });
      await delay(40);
      await key("Enter", 0);
      await check(
        "picking a row inside the overlay still works exactly like the standalone case",
        `${pickedOf("one")}==='exact'`,
      );
      report.behavior.push(`command/in-overlay/${family}/pick-still-works`);
      await key("Escape", 0);
      await wait(
        "overlay closed",
        "!document.querySelector('[data-gate-popup]')",
      );
      await check(
        "closing restores focus to the trigger by Base's real default",
        "document.activeElement.matches('[data-gate-trigger]')",
      );
      report.behavior.push(
        `command/in-overlay/${family}/closes-focus-returns-to-trigger`,
      );
    }
  }
  async function nestedChecks() {
    for (const state of ["menu", "select"])
      for (const gesture of [
        "backdrop",
        "body",
        "escape",
        "touch",
        "cancel",
        "virtual",
        "rapid",
      ]) {
        const view = gesture === "touch" ? views[1] : views[0];
        await load("frame", state, "nested", view, "light");
        current += `/${gesture}`;
        await open("frame", state, view);
        await settle();
        await clickSelector('[data-gate-trigger="nested"]', "left", true);
        await wait(
          "nested opens",
          "window.gatePresented('[data-gate-popup=nested]')",
        );
        await settle();
        if (gesture === "escape") await key("Escape", 0);
        else if (gesture === "touch") await tapAt(8, 8);
        else if (gesture === "body")
          await clickSelector("[data-gate-body]", "left", false);
        else if (gesture === "cancel") {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: 8, y: 8 }],
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchCancel",
            touchPoints: [],
          });
        } else if (gesture === "virtual")
          await evaluate(
            "document.querySelector('[data-slot=dialog-overlay]').click()",
          );
        else await clickAt(8, 8, "left");
        await settle();
        await check(
          "first gesture preserves frame",
          "document.querySelector('[data-gate-state]').dataset.open === 'true'",
        );
        if (["cancel", "virtual"].includes(gesture)) {
          if (
            await evaluate("window.gatePresented('[data-gate-popup=nested]')")
          )
            await key("Escape", 0);
        } else
          await wait(
            "first gesture closes inner",
            "!window.gatePresented('[data-gate-popup=nested]')",
          );
        if (gesture === "rapid") {
          await clickSelector('[data-gate-trigger="nested"]', "left", true);
          await wait(
            "reopened",
            "window.gatePresented('[data-gate-popup=nested]')",
          );
          await key("Escape", 0);
        }
        await settle();
        let presses = 1;
        if (gesture === "escape") await key("Escape", 0);
        else if (gesture === "touch") await tapAt(8, 8);
        else await clickAt(8, 8, "left");
        await settle();
        const secondClosed = await evaluate(
          "document.querySelector('[data-gate-state]').dataset.open === 'false'",
        );
        if (
          gesture === "escape" ||
          (state === "select" && !["rapid", "virtual"].includes(gesture))
        )
          assert(secondClosed, "Frame must close on second gesture");
        if (!secondClosed) {
          presses++;
          if (gesture === "touch") await tapAt(8, 8);
          else await clickAt(8, 8, "left");
        }
        await wait(
          "frame closes within three gestures",
          "document.querySelector('[data-gate-state]').dataset.open === 'false'",
        );
        console.log(
          `nested ${state}/${gesture}: frame closes on gesture ${presses + 1}${secondClosed ? "" : " (known extra press)"}`,
        );
        report.behavior.push(`nested/${state}/${gesture}`);
      }
    // Distinct from the "cancel" gesture above (a touch/pointer INTERACTION
    // cancellation) - this cancels via Base's own onOpenChange `details.cancel()`,
    // the owner's logical veto lever. A press that would otherwise close the
    // child must instead preserve both child and frame.
    for (const state of ["menu", "select"]) {
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      await evaluate("window.primitiveGate.cancelNestedClose(true)");
      await clickAt(8, 8, "left");
      await settle();
      await check(
        "owner-cancelled close preserves the child",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await check(
        "owner-cancelled close preserves the frame",
        "document.querySelector('[data-gate-state]').dataset.open === 'true'",
      );
      // Disarm and prove the same press closes normally - the veto above was
      // genuinely load-bearing, not a press that does nothing on its own.
      await evaluate("window.primitiveGate.cancelNestedClose(false)");
      await clickAt(8, 8, "left");
      await wait(
        "child closes once the veto is disarmed",
        "!window.gatePresented('[data-gate-popup=nested]')",
      );
      report.behavior.push(
        `nested/${state}/owner-cancelled-close-preserves-child-and-frame`,
      );
    }
    // An overlay outside this frame's OverlayFrameContext.Provider must
    // never be counted as one of its children. The sibling is wired to
    // never close itself on an ordinary press, so it stays genuinely open
    // (and excluded from the registry) for the whole exchange below.
    for (const state of ["menu", "select"]) {
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      await check(
        "registry holds only the nested child before the sibling opens",
        "window.primitiveGate.registrySize() === 1",
      );
      await evaluate("window.primitiveGate.openUnrelated()");
      await wait(
        "unrelated overlay opens",
        "window.gatePresented('[data-gate-unrelated]')",
      );
      await settle();
      await check(
        "registry excludes the unrelated overlay",
        "window.primitiveGate.registrySize() === 1",
      );
      await clickAt(8, 8, "left");
      await settle();
      await check(
        "unrelated overlay does not claim frame ownership: first gesture still closes the child",
        "!window.gatePresented('[data-gate-popup=nested]')",
      );
      await check(
        "first gesture preserves the frame",
        "document.querySelector('[data-gate-state]').dataset.open === 'true'",
      );
      await check(
        "unrelated overlay is still presented after the first press",
        "window.gatePresented('[data-gate-unrelated]')",
      );
      await clickAt(8, 8, "left");
      await wait(
        "frame closes on the next press despite the unrelated overlay staying open",
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      await check(
        "unrelated overlay is still presented after the frame closes",
        "window.gatePresented('[data-gate-unrelated]')",
      );
      report.behavior.push(
        `nested/${state}/unrelated-overlay-excluded-from-frame-ownership`,
      );
    }
    // Child release paths with a passive tooltip coexisting in the same
    // frame: the tooltip never registers in OverlayFrameContext, so it must
    // stay open, unaffected, and never block the frame from recognizing the
    // child's own release, whichever path releases it.
    for (const state of ["menu", "select"])
      for (const operation of ["close", "unmount", "conceal"]) {
        await load("frame", state, "nested", views[0], "light");
        await open("frame", state, views[0]);
        await settle();
        await clickSelector('[data-gate-trigger="nested"]', "left", true);
        await wait(
          "nested opens",
          "window.gatePresented('[data-gate-popup=nested]')",
        );
        await settle();
        // Fully controlled (open, no onOpenChange) - matches base-ui-
        // proofs.tsx's own passive tooltip exactly, so nothing (hover loss,
        // a backdrop, the release below) can close it out from under this
        // test.
        await evaluate("window.primitiveGate.showNestedTooltip()");
        await wait(
          "passive tooltip opens",
          "window.gatePresented('[data-gate-popup=tooltip]')",
        );
        await settle();
        await check(
          "registry holds only the nested child while both are painted",
          "window.primitiveGate.registrySize() === 1",
        );
        await evaluate(
          operation === "close"
            ? "window.primitiveGate.closeNested()"
            : operation === "unmount"
              ? "window.primitiveGate.unmountNested()"
              : "window.primitiveGate.concealNested(true)",
        );
        await wait(
          `child releases via ${operation}`,
          "!window.gatePresented('[data-gate-popup=nested]')",
        );
        await settle();
        await check(
          `${operation}: registry releases the child`,
          "window.primitiveGate.registrySize() === 0",
        );
        await check(
          `${operation}: passive tooltip stays painted and unaffected`,
          "window.gatePresented('[data-gate-popup=tooltip]')",
        );
        await clickAt(8, 8, "left");
        await wait(
          `${operation}: frame closes normally despite the passive tooltip`,
          "document.querySelector('[data-gate-state]').dataset.open === 'false'",
        );
        report.behavior.push(
          `nested/${state}/${operation}-with-passive-tooltip`,
        );
      }
    for (const state of ["menu", "select"]) {
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector("[data-gate-trigger=nested]", "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await evaluate("window.primitiveGate.focus(false)");
      await wait(
        "nested concealed",
        "!window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      await check(
        "frame remains open",
        "document.querySelector('[data-gate-state]').dataset.open==='true'",
      );
      await clickAt(8, 8, "left");
      await settle();
      if (
        await evaluate(
          "document.querySelector('[data-gate-state]').dataset.open==='true'",
        )
      )
        await clickAt(8, 8, "left");
      await wait(
        "concealed nested layer cannot indefinitely own backdrop",
        "document.querySelector('[data-gate-state]').dataset.open==='false'",
      );
      report.behavior.push(`nested/${state}/concealed`);
    }
    await load("frame", "tooltip", "nested", views[0], "light");
    await open("frame", "tooltip", views[0]);
    await settle();
    await hoverSelector('[data-gate-trigger="tooltip"]');
    await wait(
      "tooltip opens",
      "window.gatePresented('[data-gate-popup=tooltip]')",
    );
    await clickAt(8, 8, "left");
    await wait(
      "passive tooltip does not own backdrop",
      "document.querySelector('[data-gate-state]').dataset.open === 'false'",
    );
    report.behavior.push("nested/passive-tooltip");
    // T02 promotion (base-ui-proofs.mjs's `pointerdown ownership survives
    // synchronous child close` and `virtual click without pointerdown while
    // child is open`): `overlay-frame-context.ts`'s registry is the exact
    // logic T02's own synthetic prototype proved out - a document-level
    // CAPTURE-phase pointerdown listener snapshots `registry.size > 0`
    // before any bubble-phase handler on the target can react, and a click
    // with no paired pointerdown (`detail === 0`) samples ownership fresh
    // instead of trusting a stale snapshot. Both cases drive the REAL
    // production frame/menu/select fixture already used above, with no new
    // fixture surface - only raw DOM event dispatch, the same technique the
    // existing "virtual" gesture case already relies on.
    for (const state of ["menu", "select"]) {
      // Positive: an ordinary trigger.click() only SCHEDULES React's close -
      // it is not proof of a synchronous commit. Use the fixture's
      // `closeNested()` (flushSync) instead, and PROVE the close and the
      // registry's deregistration already committed - via the real,
      // live `registrySize()`, not inferred timing - strictly BEFORE the
      // paired click is dispatched.
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      await check(
        "registry holds exactly the nested child before closing it",
        "window.primitiveGate.registrySize() === 1",
      );
      // One-time BUBBLE-phase listener on the backdrop that closes the
      // child synchronously, mid-gesture - after the registry's own
      // document-level CAPTURE-phase handler has already run (capture
      // always precedes the target's own bubble-phase listeners), so the
      // ownership snapshot it took is necessarily from BEFORE the child
      // closed.
      await evaluate(
        `document.querySelector('[data-slot=dialog-overlay]').addEventListener('pointerdown', () => window.primitiveGate.closeNested(), {once: true})`,
      );
      await evaluate(
        `document.querySelector('[data-slot=dialog-overlay]').dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,bubbles:true}))`,
      );
      // Proves the COMMITTED logical closure (registry deregistered, the
      // popup's own data-closed and the trigger's aria-expanded=false, all
      // synchronous with the flushSync commit) - not that the ~100ms exit
      // animation has already finished painting. gatePresented/gatePainted
      // answer a different question (is it still visible) and would still
      // be true here even though the close already committed.
      await check(
        "child closed and deregistered synchronously, strictly before the paired click",
        "window.primitiveGate.registrySize() === 0 && document.querySelector('[data-gate-popup=nested]')?.hasAttribute('data-closed') === true && document.querySelector('[data-gate-trigger=\"nested\"]')?.getAttribute('aria-expanded') === 'false'",
      );
      await evaluate(
        `document.querySelector('[data-slot=dialog-overlay]').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}))`,
      );
      await settle();
      await check(
        "pointerdown ownership survives the synchronous child close: frame stays open",
        "document.querySelector('[data-gate-state]').dataset.open === 'true'",
      );
      await clickAt(8, 8, "left");
      await wait(
        "frame closes on the next ordinary backdrop press",
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      report.behavior.push(
        `nested/${state}/race-survives-synchronous-child-close`,
      );
      // Negative control: identical setup, but the paired close is a
      // VIRTUAL click (no real pointerdown at all) - no snapshot exists to
      // protect it, so the registry samples ownership FRESH at click time
      // (already empty, since the child closed first), and this must
      // dismiss the frame in ONE press. This is the case that must FAIL to
      // stay open, proving the positive result above is genuinely load-
      // bearing on the snapshot, not on frames always staying open.
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      await evaluate("window.primitiveGate.closeNested()");
      // Same committed-logical-closure proof as the positive case above -
      // not the exit animation's paint completion.
      await check(
        "negative control: child closed and deregistered before the virtual click",
        "window.primitiveGate.registrySize() === 0 && document.querySelector('[data-gate-popup=nested]')?.hasAttribute('data-closed') === true && document.querySelector('[data-gate-trigger=\"nested\"]')?.getAttribute('aria-expanded') === 'false'",
      );
      await evaluate(
        "document.querySelector('[data-slot=dialog-overlay]').click()",
      );
      await wait(
        "negative control: frame dismisses in one press with no snapshot to protect it",
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      report.behavior.push(
        `nested/${state}/race-negative-control-no-snapshot-dismisses`,
      );
    }
    for (const state of ["menu", "select"]) {
      await load("frame", state, "nested", views[0], "light");
      await open("frame", state, views[0]);
      await settle();
      await clickSelector('[data-gate-trigger="nested"]', "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      // A virtual click (`.click()`, `detail === 0`, no preceding real
      // pointerdown) has no paired-pointerdown snapshot to trust, so the
      // registry samples ownership fresh at click time. With the child
      // still open and registered, that fresh sample is `owned === true`,
      // so this must dismiss nothing - not the child, not the frame.
      await evaluate(
        "document.querySelector('[data-slot=dialog-overlay]').click()",
      );
      await settle();
      await check(
        "virtual click while child is open dismisses nothing: child stays open",
        "window.gatePresented('[data-gate-popup=nested]')",
      );
      await check(
        "virtual click while child is open dismisses nothing: frame stays open",
        "document.querySelector('[data-gate-state]').dataset.open === 'true'",
      );
      await key("Escape", 0);
      await wait(
        "child closes on Escape",
        "!window.gatePresented('[data-gate-popup=nested]')",
      );
      await settle();
      // Same virtual-click technique, now with the child gone (unowned) -
      // proving the earlier non-dismissal was genuinely about ownership,
      // not about virtual clicks being ignored outright.
      await evaluate(
        "document.querySelector('[data-slot=dialog-overlay]').click()",
      );
      await wait(
        "frame closes once the child no longer owns the gesture",
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      report.behavior.push(
        `nested/${state}/virtual-click-respects-child-ownership`,
      );
    }
  }
  async function passivePreviewInMenuChecks() {
    // D16: a real DropdownMenu item serving as a passive Tooltip trigger -
    // it must present while the menu stays open, hovering away must not
    // dismiss or steal ownership from the menu, and ordinary menu dismissal
    // (Escape) must still close everything afterward. The HoverCard row this
    // loop also ran is gone with main's hover card, which stays shut while
    // any menu is open (`ui/hover-card.tsx`, its own suite's case (k)); no
    // product surface puts a hover card inside a menu.
    for (const [item, popup] of [["tooltip-preview", "tooltip-in-menu"]]) {
      await load(
        "dropdown-menu",
        "passive-previews",
        "visual",
        views[0],
        "light",
      );
      await open("dropdown-menu", "passive-previews", views[0]);
      await settle();
      await hoverSelector(`[data-gate-item="${item}"]`);
      await wait(
        `${item} presents while the menu stays open`,
        `window.gatePresented('[data-gate-popup="${popup}"]') && window.gatePresented('[data-gate-popup="outer"]')`,
      );
      await check(
        `${item}: presenting the passive preview does not steal focus from the menu`,
        `document.querySelector('[data-gate-popup="outer"]').contains(document.activeElement)`,
      );
      await hoverSelector("[data-gate-item]");
      await wait(
        `${item} closes on hover-away, menu stays open`,
        `!window.gatePresented('[data-gate-popup="${popup}"]') && window.gatePresented('[data-gate-popup="outer"]')`,
      );
      await check(
        `${item}: closing the passive preview leaves focus inside the menu`,
        `document.querySelector('[data-gate-popup="outer"]').contains(document.activeElement)`,
      );
      await key("Escape", 0);
      await wait(
        `ordinary Escape still closes the whole menu after ${item}`,
        "document.querySelector('[data-gate-state]').dataset.open === 'false' && !window.gatePresented('[data-gate-popup=\"outer\"]')",
      );
      report.behavior.push(`passivePreview/${item}/coexists-with-open-menu`);
    }
  }
  async function guideOwnershipChecks() {
    // Real-Chrome parity for guide-overlays.ts's escapeOwnedElsewhere(): each
    // family's actual popup DOM (data-open/role/data-slot, not a jsdom
    // approximation) must be recognized as owning Escape while open. Calls
    // the real production function through window.primitiveGate.
    // escapeOwnedElsewhere - no reimplemented selector logic here.
    for (const family of [
      "dialog",
      "popover",
      "sheet",
      "dropdown-menu",
      "context-menu",
      "menubar",
      "select",
      "drawer",
    ]) {
      await load(family, "default", "visual", views[0], "light");
      await check(
        `${family}: nothing owns Escape before opening`,
        "!window.primitiveGate.escapeOwnedElsewhere([])",
      );
      await open(family, "default", views[0]);
      await wait(
        `${family}: real popup DOM owns Escape once open`,
        "window.primitiveGate.escapeOwnedElsewhere([])",
      );
      await check(
        `${family}: a node inside the actual popup is not counted as elsewhere`,
        "!window.primitiveGate.escapeOwnedElsewhere([document.querySelector('[data-gate-popup]')])",
      );
      await key("Escape", 0);
      await wait(
        `${family}: closes on Escape`,
        "document.querySelector('[data-gate-state]').dataset.open === 'false'",
      );
      await settle();
      await wait(
        `${family}: nothing owns Escape after closing`,
        "!window.primitiveGate.escapeOwnedElsewhere([])",
      );
      report.behavior.push(`guideOwnership/${family}`);
    }
  }
  async function drawerGestureChecks() {
    // D16: real touch-emulated drags against Base's own useSwipeDismiss/
    // DrawerViewport thresholds (getBaseSwipeSize*0.5 distance,
    // MIN_SWIPE_RELEASE_VELOCITY), not a reimplementation of them - margins
    // are generous (well past/under threshold, paused before release for a
    // near-zero velocity dismiss) rather than tuned to the exact constants.
    async function popupRect() {
      return evaluate(
        "(() => { const r = document.querySelector('[data-gate-popup]').getBoundingClientRect(); return {height:r.height}; })()",
      );
    }
    async function touchPressAndDrag(startX, startY, totalDeltaY) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: startX, y: startY }],
      });
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: startX, y: startY + (totalDeltaY * i) / steps }],
        });
        await delay(30);
      }
    }
    async function touchRelease(pauseBeforeRelease) {
      if (pauseBeforeRelease) await delay(300);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }

    // Keyboard: Escape still closes an ordinary (non-dragging) drawer.
    await load("drawer", "default", "visual", views[1], "light");
    await open("drawer", "default", views[1]);
    await key("Escape", 0);
    await wait(
      "drawer: Escape closes normally",
      "document.querySelector('[data-gate-state]').dataset.open === 'false'",
    );
    report.behavior.push("drawer/keyboard-escape-closes");

    // Cancel: a short drag (above the ~10px registration floor, well under
    // the ~50%-of-height dismiss threshold) must spring back open.
    await load("drawer", "default", "visual", views[1], "light");
    await open("drawer", "default", views[1]);
    await settle();
    let rect = await popupRect();
    let start = await center("[data-slot=drawer-header]");
    await touchPressAndDrag(start.x, start.y, Math.max(20, rect.height * 0.08));
    await wait(
      "drawer: short drag registers as a real swipe",
      "document.querySelector('[data-gate-popup]').hasAttribute('data-swiping')",
    );
    await touchRelease(false);
    await settle();
    await check(
      "drawer: short drag below threshold cancels, drawer stays open",
      "document.querySelector('[data-gate-state]').dataset.open === 'true' && !document.querySelector('[data-gate-popup]').hasAttribute('data-swiping')",
    );
    report.behavior.push("drawer/short-drag-cancels");

    // Dismiss: a large, slow (paused-before-release, near-zero velocity)
    // drag well past half the popup's own height must close the drawer.
    await load("drawer", "default", "visual", views[1], "light");
    await open("drawer", "default", views[1]);
    await settle();
    rect = await popupRect();
    start = await center("[data-slot=drawer-header]");
    await touchPressAndDrag(start.x, start.y, rect.height * 0.9);
    await wait(
      "drawer: large drag registers as a real swipe",
      "document.querySelector('[data-gate-popup]').hasAttribute('data-swiping')",
    );
    await touchRelease(true);
    await wait(
      "drawer: large slow drag past threshold dismisses",
      "document.querySelector('[data-gate-state]').dataset.open === 'false'",
    );
    report.behavior.push("drawer/large-drag-dismisses");

    // Scroll region: a drag starting inside [data-base-ui-swipe-ignore] must
    // never register as a swipe - it must actually scroll instead, not just
    // fail to swipe. Upward finger motion (negative deltaY) is native
    // scroll-down semantics: scrollTop must move off zero.
    await load("drawer", "long", "visual", views[1], "light");
    await open("drawer", "long", views[1]);
    await settle();
    const overflows = await evaluate(
      "(() => { const el = document.querySelector('[data-base-ui-swipe-ignore]'); return el.scrollHeight > el.clientHeight; })()",
    );
    assert(
      overflows,
      "swipe-ignore region precondition: it must actually have overflow content to scroll",
    );
    const ignoreStart = await center("[data-base-ui-swipe-ignore]");
    await touchPressAndDrag(ignoreStart.x, ignoreStart.y, -60);
    await check(
      "drawer: a drag starting inside the swipe-ignore region never registers as a swipe",
      "!document.querySelector('[data-gate-popup]').hasAttribute('data-swiping')",
    );
    await touchRelease(false);
    await check(
      "drawer: stays open after releasing inside the swipe-ignore region",
      "document.querySelector('[data-gate-state]').dataset.open === 'true'",
    );
    await check(
      "drawer: the region actually scrolled, not merely avoided swiping",
      "document.querySelector('[data-base-ui-swipe-ignore]').scrollTop > 0",
    );
    report.behavior.push("drawer/swipe-ignore-region-actually-scrolls");
  }
  async function drawerInterruptedEnterChecks() {
    // Compare a real touch during enter against HEAD using portable geometry.
    async function popupState() {
      return evaluate(`(() => {
        const popup = document.querySelector('[data-gate-popup]');
        if (!popup) return null;
        const animations = popup.getAnimations().map(a => {
          const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          return { progress: timing ? timing.progress : null, playState: a.playState, currentTime: a.currentTime, duration: timing ? timing.duration : null };
        });
        const r = popup.getBoundingClientRect();
        return {
          animations,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          // Base diagnostic; HEAD comparison uses rect movement.
          swiping: popup.hasAttribute("data-swiping"),
        };
      })()`);
    }
    // Deterministic mid-enter pin (0.35, inside 0.2-0.6): observer, discovery
    // and pin all run in one page-side promise chain, started before the click.
    async function pinEnterAnimation() {
      await evaluate(`(() => {
        window.__enterAnimationPoint = new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            const popup = document.querySelector('[data-gate-popup]');
            if (!popup) return;
            observer.disconnect();
            (async () => {
              let target = null, duration = null;
              for (let frame = 0; frame < 30 && !target; frame++) {
                for (const a of popup.getAnimations()) {
                  if (a.playState !== 'running') continue;
                  const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
                  if (timing && typeof timing.duration === 'number' && timing.duration > 0) {
                    target = a; duration = timing.duration; break;
                  }
                }
                if (!target) await new Promise((r) => requestAnimationFrame(r));
              }
              if (!target) { reject(new Error('interrupted-enter: no running enter animation found to pin')); return; }
              target.playbackRate = 0;
              target.currentTime = duration * 0.35;
              window.__pinnedEnterAnimation = target;
              const progress = target.effect.getComputedTiming().progress;
              if (progress === null || progress < 0.2 || progress >= 0.6) {
                reject(new Error('interrupted-enter: pinned progress left the deterministic window (' + progress + ')'));
                return;
              }
              const header = document.querySelector('[data-slot="drawer-header"]');
              if (!header) { resolve(null); return; }
              const r = header.getBoundingClientRect();
              const left = Math.max(r.left, 0);
              const top = Math.max(r.top, 0);
              const right = Math.min(r.right, innerWidth);
              const bottom = Math.min(r.bottom, innerHeight);
              if (right <= left || bottom <= top) { resolve(null); return; }
              resolve({ x: (left + right) / 2, y: (top + bottom) / 2 });
            })();
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
      })()`);
      await clickSelector("[data-gate-trigger]", "left", true);
      return evaluate("window.__enterAnimationPoint");
    }
    await load("drawer", "default", "visual", views[1], "light");
    const start = await pinEnterAnimation();
    assert(
      start,
      "drawer header has no visible on-screen point yet - the enter transform hasn't placed any of it in the viewport",
    );
    const sampleBeforeTouch = await popupState();
    // Sample before library handlers can cancel enter; prove the actual hit too.
    await evaluate(`(() => {
      window.__interruptedEnterProbe = null;
      const popup = document.querySelector('[data-gate-popup]');
      const header = document.querySelector('[data-slot="drawer-header"]');
      document.addEventListener('touchstart', (event) => {
        const animations = popup.getAnimations().map(a => {
          const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          return { progress: timing ? timing.progress : null, playState: a.playState, currentTime: a.currentTime, duration: timing ? timing.duration : null };
        });
        const r = popup.getBoundingClientRect();
        window.__interruptedEnterProbe = {
          animations,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          clientX: event.touches[0].clientX,
          clientY: event.touches[0].clientY,
          hitInsidePopup: popup.contains(event.target),
          hitInsideHeader: !!header && header.contains(event.target),
        };
      }, { capture: true, once: true });
    })()`);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x, y: start.y }],
    });
    const sampleAtTouchstart = await evaluate("window.__interruptedEnterProbe");
    assert(
      sampleAtTouchstart?.hitInsideHeader,
      `interrupted-enter touch missed the drawer header - not valid parity evidence: ${JSON.stringify(sampleAtTouchstart)}`,
    );
    assert(
      sampleAtTouchstart.animations.some(
        (a) =>
          a.playState === "running" &&
          typeof a.progress === "number" &&
          a.progress > 0 &&
          a.progress < 1,
      ),
      `interrupted-enter probe missed the animation window - not counted as evidence either way: ${JSON.stringify(sampleAtTouchstart)}`,
    );
    const sampleAfterTouchstartHandled = await popupState();
    // Assert before settle() - a forced-broken cancellation leaves this
    // frozen (never restored on the main path), and settle() would
    // otherwise time out generically instead of failing here.
    if (process.env.DRAWER_REFERENCE !== "1")
      assert(
        sampleAfterTouchstartHandled.animations.every(
          (animation) => animation.playState !== "running",
        ),
        `enter must yield to native drag at touchstart: ${JSON.stringify(sampleAfterTouchstartHandled.animations)}`,
      );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x, y: start.y + 20 }],
    });
    const sampleAfterFirstMove = await popupState();
    const steps = 5;
    for (let i = 2; i <= steps; i++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x, y: start.y + 20 * i }],
      });
      await delay(30);
    }
    const sampleHeld = await popupState();
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    // All samples the assertions below read are already captured. Only the
    // HEAD/vaul reference run unfreezes a surviving animation here, so it
    // settles naturally instead of hanging settle() forever - a real Base
    // run that failed to cancel it must stay frozen, or settle()'s own
    // timeout is the only thing left to catch the missing cancellation.
    if (process.env.DRAWER_REFERENCE === "1") {
      await evaluate(`(() => {
        const a = window.__pinnedEnterAnimation;
        if (a && a.playState === 'running') a.playbackRate = 1;
      })()`);
    }
    await settle();
    const sampleSettled = {
      ...(await popupState()),
      open: await evaluate(
        "document.querySelector('[data-gate-state]').dataset.open",
      ),
    };
    const direction = await evaluate(
      "document.querySelector('[data-gate-popup]')?.getAttribute('data-swipe-direction') ?? document.querySelector('[data-gate-popup]')?.getAttribute('data-vaul-drawer-direction') ?? null",
    );
    report.measurements.drawerInterruptedEnter = {
      direction,
      sampleBeforeTouch,
      sampleAtTouchstart,
      sampleAfterTouchstartHandled,
      sampleAfterFirstMove,
      sampleHeld,
      sampleSettled,
    };
    for (const [name, sample] of [
      ["sampleBeforeTouch", sampleBeforeTouch],
      ["sampleAtTouchstart", sampleAtTouchstart],
      ["sampleAfterTouchstartHandled", sampleAfterTouchstartHandled],
      ["sampleAfterFirstMove", sampleAfterFirstMove],
      ["sampleHeld", sampleHeld],
      ["sampleSettled", sampleSettled],
    ])
      assert(sample, `${name} must not be null`);
    // D12#6: strict Base outcome assertions. Skipped only here under
    // DRAWER_REFERENCE=1 (a HEAD/vaul run) - vaul rejects drag during its
    // own enter window entirely, so these would be false failures there, not
    // evidence of a bug. Preconditions above (hit/animation window) still
    // run either way - they prove the gesture itself is valid, not Base's
    // outcome.
    if (process.env.DRAWER_REFERENCE !== "1") {
      assert(
        sampleAfterTouchstartHandled.swiping,
        "swiping must be true right after touchstart is handled",
      );
      assert(sampleHeld.swiping, "swiping must still be true while held");
      assert(
        Math.abs(sampleAfterFirstMove.rect.y - sampleAtTouchstart.rect.y) <= 1,
        `first move must not visually jump from the captured touchstart position: ${sampleAfterFirstMove.rect.y} vs ${sampleAtTouchstart.rect.y}`,
      );
      assert(
        Math.abs(sampleHeld.rect.y - sampleAfterFirstMove.rect.y - 80) <= 1,
        `held minus first-move must track the remaining 80px of finger travel: ${sampleHeld.rect.y - sampleAfterFirstMove.rect.y}`,
      );
      const viewportHeight = await evaluate("innerHeight");
      assert(
        sampleSettled.open === "true",
        "drawer must still be open after a sub-threshold release",
      );
      assert(!sampleSettled.swiping, "swiping must clear after release");
      assert(
        Math.abs(
          sampleSettled.rect.y - (viewportHeight - sampleSettled.rect.height),
        ) <= 1,
        `settled drawer must rest flush at the viewport bottom: ${sampleSettled.rect.y} vs ${viewportHeight - sampleSettled.rect.height}`,
      );
    }
    report.behavior.push("drawer/interrupted-enter-measured");
  }
  async function probeChecks() {
    await load("button", "default", "visual", views[0], "light");
    const result = await evaluate(`(() => {
      const parent = document.createElement('div');
      parent.style.cssText='position:fixed;left:10px;top:10px;z-index:99999;width:40px;height:40px';
      const popup = document.createElement('button');
      popup.dataset.probe=''; popup.style.cssText='width:40px;height:40px;background:red';
      parent.append(popup); document.body.append(parent);
      const presentation = [window.gatePresented('[data-probe]')];
      for (const attribute of ['hidden','inert','aria-hidden']) {
        parent.setAttribute(attribute, 'true'); presentation.push(window.gatePresented('[data-probe]')); parent.removeAttribute(attribute);
      }
      parent.style.opacity='0'; presentation.push(window.gatePresented('[data-probe]')); parent.style.opacity='1';
      parent.dataset.slot='gate-positioner'; parent.style.pointerEvents='none'; popup.style.pointerEvents='auto'; popup.dataset.gatePopup='probe';
      popup.hidden=true; const hiddenMounted=window.gateSurfacesHidden();
      parent.style.backgroundColor='red'; const paintedPositioner=window.gateSurfacesHidden();
      parent.style.backgroundColor='transparent'; popup.hidden=false;
      const timing = {duration:100,delay:20,endDelay:30,iterations:2,fill:'both'};
      const measure = animations => {const result=window.gateMeasureMotion(popup,animations,animations.map(() => 0)); animations.forEach(a=>a.cancel());return result;};
      const combined = measure([popup.animate([{transform:'translateX(0px)',opacity:0},{transform:'translateX(10px)',opacity:1}],timing)]);
      const split = measure([popup.animate([{transform:'translateX(0px)'},{transform:'translateX(10px)'}],timing),popup.animate([{opacity:0},{opacity:1}],timing)]);
      const ancestor = measure([parent.animate([{transform:'translateX(0px)'},{transform:'translateX(10px)'}],timing),popup.animate([{opacity:0},{opacity:1}],timing)]);
      const prolonged = measure([popup.animate([{transform:'translateX(0px)',opacity:0},{transform:'translateX(10px)',opacity:1}],{...timing,endDelay:80})]);
      parent.remove(); return {presentation,hiddenMounted,paintedPositioner,combined,split,ancestor,prolonged};
    })()`);
    assert.equal(
      result.hiddenMounted,
      true,
      "Hidden retained popup/transparent positioner rejected",
    );
    assert.equal(
      result.paintedPositioner,
      false,
      "Painted positioner leak missed",
    );
    assert.deepEqual(
      result.presentation,
      [true, false, false, false, false],
      "Presentation predicate positive/negative controls",
    );
    assert.deepEqual(
      result.combined,
      result.split,
      "Equivalent combined/split motion differs",
    );
    assert.deepEqual(
      result.combined,
      result.ancestor,
      "Equivalent positioner motion differs",
    );
    assert.equal(
      result.combined.to.rect[0] - result.combined.from.rect[0],
      10,
      "Motion misses rendered translation",
    );
    assert.deepEqual(
      [result.combined.from.opacity, result.combined.to.opacity],
      [0, 1],
    );
    assert.equal(
      result.combined.totalDuration,
      250,
      "Motion ignores delay/iterations/endDelay",
    );
    assert.equal(result.prolonged.totalDuration, 300);
    assert.notDeepEqual(
      result.combined,
      result.prolonged,
      "Prolonged completion was missed",
    );
    const live = await evaluate(`(async () => {
      const popup = document.createElement('div');
      popup.dataset.gatePopup='collector-probe';
      popup.style.cssText='position:fixed;left:10px;top:10px;width:40px;height:40px;background:red';
      document.body.append(popup);
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const run = async replay => {
        window.gateStartMotion('[data-gate-popup]');
        const effects = [];
        for (let i=0; i<(replay ? 2 : 1); i++) {
          const a = popup.animate([{transform:'translateX(0px)',opacity:0},{transform:'translateX(10px)',opacity:1}], {duration:100,fill:'both'});
          effects.push(a);
          while (a.playState !== 'finished') await frame();
        }
        await frame();
        window.gateMotionRunning=false;
        const result=window.gateMotion;
        effects.forEach(a=>a.cancel());
        return result;
      };
      const single=await run(false), replay=await run(true);
      popup.remove(); return {single,replay};
    })()`);
    assert.equal(
      live.single.totalDuration,
      100,
      "Live collector single-enter control",
    );
    assert.deepEqual(live.single.from, live.replay.from);
    assert.deepEqual(live.single.to, live.replay.to);
    assert(
      live.replay.totalDuration >= 200,
      "Live collector lost the sequential second enter",
    );
    assert.throws(
      () => assert.deepEqual(live.single, live.replay),
      { name: "AssertionError" },
      "Motion comparator accepted a doubled enter",
    );
    console.log(
      `PASS live phase collector: single=${live.single.totalDuration}ms; sequential replay=${live.replay.totalDuration}ms rejected`,
    );
    console.log(
      "PASS presentation and aggregate-motion positive/negative controls",
    );
  }
  // Shared by both motion loops below: stores the measurement, diffs it
  // against `previousMotion` the same way every other accumulated diff in
  // this script is handled (logged and collected, never thrown - one
  // residual motion difference must not hide the rest), and logs it.
  function recordMotion(family, state, enter, exit) {
    assert(enter !== null, `${family} has no enter motion`);
    report.motion[`${family}/${state}`] = { enter, exit };
    if (previousMotion) {
      try {
        assert.deepEqual(
          report.motion[`${family}/${state}`],
          previousMotion.motion[`${family}/${state}`],
          `${family}/${state}: motion changed`,
        );
      } catch {
        const message = `${family}/${state}: motion changed - ${JSON.stringify({
          was: previousMotion.motion[`${family}/${state}`],
          now: report.motion[`${family}/${state}`],
        })}`;
        console.error(`DIFF ${message}`);
        diffFailures.push(message);
      }
    }
    console.log(
      `motion ${family}/${state}: ${JSON.stringify({ enter, exit })}`,
    );
  }
  async function motionChecks() {
    assert(
      !previousMotion ||
        previousMotion.motion?.["dialog/padded"]?.enter?.timeline === "phase",
      "Legacy motion format: pass --motion-reference DIR with a phase-timeline capture; keep the original pixel reference unchanged",
    );
    for (const [family, state] of [
      ["dialog", "padded"],
      ["sheet", "top"],
      ["sheet", "right"],
      ["sheet", "bottom"],
      ["sheet", "left"],
      ["drawer", "bottom"],
      ["tooltip", "default"],
      // Newly measured overlay families - same open()/close() shape as the
      // seven above, so they run through the identical single-phase loop.
      // "default" here is each family's behavior-probe state (also used by
      // concealChecks' `guarded`/hover-card-tooltip conceal list), not
      // necessarily its pixel-inventory state name in
      // primitive-gate-cases.json.
      ["hover-card", "default"],
      ["popover", "default"],
      ["dropdown-menu", "default"],
      ["context-menu", "default"],
      ["select", "default"],
    ]) {
      await load(family, state, "motion", views[0], "light");
      await evaluate("window.gateStartMotion('[data-gate-popup]')");
      await open(family, state, views[0]);
      await settle();
      const enter = await evaluate(
        "window.gateMotionRunning=false; window.gateMotion",
      );
      await evaluate("window.gateStartMotion('[data-gate-popup]')");
      // hover-card, like tooltip, is a hover-only interaction with no Escape
      // binding - it closes on pointer-away, same as open() opens it via
      // hoverSelector rather than a click.
      if (family === "tooltip" || family === "hover-card")
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 1,
          y: 1,
        });
      else await key("Escape", 0);
      await delay(500);
      await settle();
      const exit = await evaluate(
        "window.gateMotionRunning=false; window.gateMotion",
      );
      recordMotion(family, state, enter, exit);
    }
    // Submenu motion is measured in its own two-phase pass, not folded into
    // the loop above: `open()`'s submenu handling opens the PARENT menu and
    // the submenu in one call, and the loop above starts recording before
    // calling `open()` - so measuring a submenu state that way would fold
    // the parent's own (already-proven, unrelated) entrance animation into
    // the submenu's numbers. Here the parent is opened and settled with the
    // probe off, then the probe starts and only the submenu itself is
    // opened/closed. The probe is pointed at `[data-gate-subpopup]`
    // specifically (gateStartMotion's selector argument) - `[data-gate-popup]`
    // would keep tracking the PARENT popup the whole time, since that
    // selector still matches while the submenu is open too.
    // ArrowLeft, not Escape, closes just the submenu: Escape is the
    // whole-menu-tree dismiss key in this Menu primitive (same as every
    // standard ARIA menu pattern), so it would take the parent down with it
    // and the "independent" measurement would really be the whole tree's
    // exit. ArrowLeft is the standard collapse-submenu-only key, and the
    // assertion below hard-fails the case (rather than silently recording
    // whatever happened) if that assumption doesn't hold for this primitive.
    // "submenu-panel" is a pixel/content variant of the same submenu
    // animation, not a distinct one, so it's not measured separately.
    for (const [family, state] of [
      ["dropdown-menu", "submenu"],
      ["context-menu", "submenu"],
    ]) {
      await load(family, state, "motion", views[0], "light");
      await clickSelector(
        "[data-gate-trigger]",
        family === "context-menu" ? "right" : "left",
        true,
      );
      await wait("opened popup", "window.gatePresented('[data-gate-popup]')");
      await settle();
      await evaluate("window.gateStartMotion('[data-gate-subpopup]')");
      await openSubmenuTrigger(views[0]);
      await settle();
      const enter = await evaluate(
        "window.gateMotionRunning=false; window.gateMotion",
      );
      // openSubmenuTrigger opens the submenu by hovering it - hover moves the
      // menu's roving highlight to the subtrigger item, but never moves real
      // keyboard focus INTO the submenu itself. Radix/Base's submenu
      // ArrowLeft handler only reacts when focus is already inside the
      // submenu, so ArrowLeft alone here would silently no-op. ArrowRight
      // from the (hover-highlighted) subtrigger is the standard key to move
      // focus into an already-open submenu's first item; assert it actually
      // landed there before trusting ArrowLeft to close it.
      await key("ArrowRight", 0);
      // Base's list navigation schedules this focus move via
      // requestAnimationFrame (floating-ui-react's enqueueFocus, sync only
      // when forced) - an immediate synchronous check here races that frame.
      await wait(
        `${family}/${state}: ArrowRight must move focus into the submenu before ArrowLeft can close it`,
        "!!document.activeElement?.closest('[data-gate-subpopup]')",
      );
      await evaluate("window.gateStartMotion('[data-gate-subpopup]')");
      await key("ArrowLeft", 0);
      await delay(500);
      await settle();
      assert(
        await evaluate(
          "!document.querySelector('[data-gate-subpopup]') && !!document.querySelector('[data-gate-popup]')",
        ),
        `${family}/${state}: ArrowLeft must close only the submenu, leaving the parent menu open`,
      );
      const exit = await evaluate(
        "window.gateMotionRunning=false; window.gateMotion",
      );
      recordMotion(family, state, enter, exit);
    }
  }
  await comparatorCheck();
  await probeChecks();
  if (knownDefects) {
    await knownDefectChecks();
  } else if (behavior) {
    const only = flag("--only");
    assert(
      !only ||
        [
          "toast",
          "conceal",
          "nested",
          "defaultFocus",
          "passivePreview",
          "guideOwnership",
          "drawerGesture",
          "drawerInterrupted",
          "command",
        ].includes(only),
      "Unknown behavior lane",
    );
    await warmUpFamilies();
    if (!only || only === "toast") await toastChecks();
    if (!only || only === "conceal") await concealChecks();
    if (!only || only === "nested") await nestedChecks();
    if (!only || only === "defaultFocus") await defaultFocusChecks();
    if (!only || only === "passivePreview") await passivePreviewInMenuChecks();
    if (!only || only === "guideOwnership") await guideOwnershipChecks();
    if (!only || only === "drawerGesture") await drawerGestureChecks();
    if (!only || only === "drawerInterrupted")
      await drawerInterruptedEnterChecks();
    if (!only || only === "command") await commandChecks();
    console.log(
      `PASS ${report.behavior.length} behavior cases; ${report.deferrals.length} named deferral(s)`,
    );
    for (const deferral of report.deferrals)
      console.log(`  DEFERRED ${deferral.name}: ${deferral.reason}`);
  } else {
    if (!args.includes("--motion")) {
      let count = 0;
      for (const [family, states] of Object.entries(inventory))
        for (const state of states) {
          if (
            flag("--from-family") &&
            Object.keys(inventory).indexOf(family) <
              Object.keys(inventory).indexOf(flag("--from-family"))
          )
            continue;
          if (args.includes("--smoke") && state !== states[0]) continue;
          if (
            flag("--filter") &&
            !`${family}/${state}`.includes(flag("--filter"))
          )
            continue;
          for (const theme of ["light", "dark"])
            for (const view of views) {
              if (flag("--theme") && theme !== flag("--theme")) continue;
              if (flag("--viewport") && view.name !== flag("--viewport"))
                continue;
              try {
                await visual(family, state, view, theme);
              } catch (error) {
                // Only a wedged renderer gets a second chance, and only once -
                // a real pixel/motion diff already returned normally (it's
                // accumulated in `diffFailures`, not thrown), and every other
                // failure (a `check`/`wait`/`assert` mismatch, a genuine CDP
                // socket error) still fails this case immediately.
                if (!isCdpTimeout(error)) throw error;
                console.error(
                  `RETRY ${current}: ${error.message} - restarting the browser and retrying once`,
                );
                await restartBrowser();
                await visual(family, state, view, theme);
              }
              count++;
              if (count % 30 === 0)
                console.log(`Checked ${count} images; ${current}`);
            }
        }
      assert(count > 0, "No matching cases");
      console.log(
        `Checked ${count} images${baseline ? `, ${diffFailures.length} pixel difference(s)` : " captured"}`,
      );
    }
    if (!flag("--filter")) await motionChecks();
  }
  if (out)
    await writeCandidate(
      path.join(out, "manifest.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  // Every accumulated pixel/motion diff, from either a full or a `--filter`
  // run: reported together and gated here rather than at the point each one
  // was found, so one residual raster difference never hides the rest.
  if (diffFailures.length) {
    console.error(
      `FAIL ${diffFailures.length} pixel/motion diff(s):\n${diffFailures.join("\n")}`,
    );
    if (out)
      await writeCandidate(
        path.join(out, "diff-failures.json"),
        JSON.stringify(diffFailures, null, 2) + "\n",
      );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL ${current}:`, error);
  if (out) {
    await mkdir(out, { recursive: true });
    await writeCandidate(
      path.join(out, "failure.json"),
      JSON.stringify(
        { case: current, error: String(error), exceptions, report },
        null,
        2,
      ),
    );
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
// Replacing a candidate atomically also avoids following an existing output
// file symlink or modifying a hard-linked reference PNG in place.
async function writeCandidate(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function evaluate(expression) {
  const r = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
}
async function wait(label, expression) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exceptions.length) throw new Error(exceptions.join("\n"));
    if (await evaluate(expression)) return;
    await delay(20);
  }
  throw new Error(
    `Timed out: ${label}; ${await evaluate("document.body.innerText.slice(0,2000)")}`,
  );
}
async function check(label, expression) {
  assert(
    await evaluate(expression),
    `${label}: ${await evaluate("JSON.stringify({...document.querySelector('[data-gate-state]').dataset,focus:document.activeElement.outerHTML})")}`,
  );
}
async function settle() {
  await evaluate(
    `(async()=>{for(let round=0;round<5;round++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const all=document.getAnimations().filter(a=>a.playState==='running');for(const a of all)if(a.effect?.getTiming().iterations===Infinity){a.pause();a.currentTime=0;}const finite=all.filter(a=>a.effect?.getTiming().iterations!==Infinity);if(!finite.length)return;await Promise.race([Promise.all(finite.map(a=>a.finished.catch(()=>undefined))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Animations did not settle')),3000))]);}throw new Error('Animation queue did not settle');})()`,
  );
}
async function center(selector) {
  return evaluate(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Not presented '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
}
async function hoverSelector(selector) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...(await center(selector)),
  });
}
async function clickSelector(selector, button, hitTest) {
  const p = await center(selector);
  if (hitTest)
    assert(
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${p.x},${p.y}))`,
      ),
      `Hit target blocked: ${selector}; ${await evaluate("JSON.stringify({hit:document.elementFromPoint(" + p.x + "," + p.y + ")?.outerHTML, target:document.querySelector(" + JSON.stringify(selector) + ")?.outerHTML, bodyPointer:getComputedStyle(document.body).pointerEvents})")}`,
    );
  await clickAt(p.x, p.y, button);
}
async function clickAt(x, y, button) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: button === "right" ? 2 : 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}
async function tapAt(x, y) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}
async function key(key, modifiers) {
  const codes = {
    Tab: 9,
    Enter: 13,
    Escape: 27,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    t: 84,
    n: 78,
    j: 74,
    p: 80,
    k: 75,
  };
  const letterCode = { n: "KeyN", j: "KeyJ", p: "KeyP", k: "KeyK" };
  const code = key === "t" ? "KeyT" : (letterCode[key] ?? key);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: key === "Enter" ? "\r" : "",
    key,
    code,
    windowsVirtualKeyCode: codes[key],
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: codes[key],
    modifiers,
  });
}

/**
 * `Runtime.evaluate` past `connect()`'s own 45s per-call timeout - not just
 * one slow call, but a wedged renderer (an infinite loop, accumulated memory,
 * a hung microtask queue in the page under test) that a fresh page in the
 * SAME process would inherit. Deliberately exact, not any CDP method: a
 * `Page.navigate` or `Input.dispatchMouseEvent` timing out is a different,
 * probably-infrastructure problem this retry isn't built for. Distinct from
 * every other failure mode this script has, too - a pixel/motion diff, a
 * `check`/`wait`/`assert` mismatch, or an actual CDP socket error all mean
 * something real to report, and must keep failing immediately.
 */
function isCdpTimeout(error) {
  return (
    error instanceof Error && error.message === "CDP timeout: Runtime.evaluate"
  );
}

/**
 * Launches Chrome, opens one target and connects a CDP client to it, and
 * registers the page bootstrap script - the exact sequence the original
 * startup and `restartBrowser` both need, so a restart can't drift from the
 * first launch. Assigns the module-level `chrome`/`client` the moment each is
 * acquired, before any step that can still fail (the target fetch, the
 * connect, `Page.enable`) - so a failure here always leaves the globals
 * pointing at whatever process/socket was actually opened, and `cleanup()`
 * (the top-level `finally`, and the SIGINT handler) tears down the real
 * thing instead of leaking a spawned Chrome that no reference survived to.
 */
async function launchBrowserAndTarget() {
  chrome = await launchChromeWithDevTools(
    await findChrome("the primitive gate"),
    "traycer-primitive-gate-",
    CHROME_LAUNCH_FLAGS,
  );
  const response = await fetch(
    new URL("/json/new?about:blank", chrome.devtoolsHttpUrl),
    { method: "PUT" },
  );
  assert(response.ok);
  const target = await response.json();
  client = await connect(target.webSocketDebuggerUrl, exceptions, 45000);
  await client.send("Page.enable", {});
  await client.send("Runtime.enable", {});
  const version = await client.send("Browser.getVersion", {});
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: BOOTSTRAP_SCRIPT_SOURCE,
  });
  return version;
}

/**
 * Recovers from a wedged renderer with a FULL Chrome restart - terminating
 * the old process tree and removing its profile before relaunching, so
 * accumulated renderer memory and any hung process state actually reset
 * rather than carrying over into a same-process fresh tab. Captures the old
 * `chrome`/`client` in locals first, because `launchBrowserAndTarget` reuses
 * those same module-level names for the replacement the instant it acquires
 * one. Verifies the relaunch is still the identical pinned binary
 * (`Browser.getVersion` must agree with the original); a mismatch throws
 * AFTER the globals already point at the new process, so the top-level
 * cleanup tears down the mismatched new Chrome rather than the one already
 * terminated above.
 */
async function restartBrowser() {
  const oldChrome = chrome;
  const oldClient = client;
  oldClient?.close();
  await terminateProcessTree(oldChrome.chrome);
  await rm(oldChrome.profilePath, {
    recursive: true,
    force: true,
    maxRetries: 3,
  });
  const version = await launchBrowserAndTarget();
  assert.equal(
    version.product,
    chromeVersion.product,
    `Restarted Chrome product differs from the original (${version.product} vs ${chromeVersion.product})`,
  );
  assert.equal(
    version.revision,
    chromeVersion.revision,
    `Restarted Chrome revision differs from the original (${version.revision} vs ${chromeVersion.revision})`,
  );
}

// Installed in each fresh document; selectors are app-owned, not library markers.
// Rendered motion, independent of animation count, CSS animation vs transition,
// and whether the movement belongs to the popup or an ancestor positioner.
function installMotionProbe() {
  window.gateMeasureMotion = (popup, animations, offsets) => {
    const tracks = animations.map((animation, index) => ({
      animation,
      offset: offsets[index],
      startTime: animation.startTime,
      effect: animation.effect,
      time: animation.currentTime,
      state: animation.playState,
      timing: animation.effect.getTiming(),
      computed: animation.effect.getComputedTiming(),
    }));
    if (!tracks.length) return null;
    const round = (value) => Math.round(value * 100) / 100;
    const duration = Math.max(
      ...tracks.map(
        (t) => t.offset + t.computed.endTime / t.animation.playbackRate,
      ),
    );
    const start = Math.min(
      ...tracks.map(
        (t) => t.offset + t.timing.delay / t.animation.playbackRate,
      ),
    );
    const end = Math.max(
      ...tracks.map(
        (t) =>
          t.offset +
          (t.timing.delay + t.computed.activeDuration) /
            t.animation.playbackRate,
      ),
    );
    for (const t of tracks) {
      t.animation.pause();
      t.effect.updateTiming({ fill: "both" });
    }
    const sample = (time) => {
      for (const t of tracks)
        t.animation.currentTime = (time - t.offset) * t.animation.playbackRate;
      const r = popup.getBoundingClientRect();
      let opacity = 1;
      for (let el = popup; el; el = el.parentElement)
        opacity *= Number(getComputedStyle(el).opacity);
      return {
        rect: [r.x, r.y, r.width, r.height].map(round),
        opacity: round(opacity),
      };
    };
    const from = sample(start),
      to = sample(end);
    for (const t of tracks) {
      t.effect.updateTiming({ fill: t.timing.fill });
      t.animation.currentTime = t.time;
      if (t.state === "running") {
        t.animation.play();
        if (t.startTime !== null) t.animation.startTime = t.startTime;
      }
    }
    return {
      totalDuration: round(duration),
      activeStart: round(start),
      activeEnd: round(end),
      from,
      to,
    };
  };
  window.gateStartMotion = (selector) => {
    cancelAnimationFrame(window.gateMotionFrame);
    window.gateMotion = null;
    window.gateMotionRunning = true;
    const seen = new WeakMap();
    const timeline = [];
    const round = (value) => Math.round(value * 100) / 100;
    const tick = () => {
      if (!window.gateMotionRunning) return;
      const popup = document.querySelector(selector);
      if (popup) {
        const animations = document
          .getAnimations()
          .filter(
            (a) =>
              a.effect?.target instanceof Element &&
              (a.effect.target === popup || a.effect.target.contains(popup)) &&
              a.effect.getComputedTiming().iterations !== Infinity &&
              a.playState !== "finished" &&
              a.startTime !== null,
          );
        let changed = false;
        for (const animation of animations) {
          // Retain earlier effects and replayed incarnations after they finish.
          // startTime is a document-timeline timestamp, not an effect-local time.
          const start = Number(animation.startTime);
          if (seen.get(animation) === start) continue;
          seen.set(animation, start);
          const timing = animation.effect.getComputedTiming();
          timeline.push({
            start,
            activeStart: start + timing.delay / animation.playbackRate,
            activeEnd:
              start +
              (timing.delay + timing.activeDuration) / animation.playbackRate,
            end: start + timing.endTime / animation.playbackRate,
          });
          changed = true;
        }
        if (changed) {
          const origin = Math.min(...timeline.map((t) => t.start));
          const sampled = window.gateMeasureMotion(
            popup,
            animations,
            animations.map((a) => Number(a.startTime) - origin),
          );
          const first = window.gateMotion;
          window.gateMotion = {
            timeline: "phase",
            totalDuration: round(
              Math.max(...timeline.map((t) => t.end)) - origin,
            ),
            activeStart: round(
              Math.min(...timeline.map((t) => t.activeStart)) - origin,
            ),
            activeEnd: round(
              Math.max(...timeline.map((t) => t.activeEnd)) - origin,
            ),
            from: first ? first.from : sampled.from,
            to: sampled.to,
          };
        }
      }
      window.gateMotionFrame = requestAnimationFrame(tick);
    };
    window.gateMotionFrame = requestAnimationFrame(tick);
  };
}
