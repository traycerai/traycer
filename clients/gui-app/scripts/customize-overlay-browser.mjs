// Browser regression for the Customize overlay over the sample workspace, on
// REAL layout with NATIVE input (CDP): overlapping proxy rects and their hit
// testing, Tab / arrow navigation, a real wheel on the sample transcript, bar
// wrapping and long labels, bar drag, OS / app reduced motion (including the
// pressed `:active` state), and search -> Enter -> change -> Undo -> Esc.
// jsdom has no layout, so none of that can be answered there.
//
// Fixture: src/__tests__/browser/customize-overlay-browser.tsx (see its header
// for what is real and what is not - it is NOT the full AppShell).
// Structure follows `status-bar-usage-scroll-browser.mjs`. Manual run:
//   bun scripts/customize-overlay-browser.mjs   (CHROME_BIN to pick Chrome)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
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
const fixtureUrlPath = "/src/__tests__/browser/customize-overlay-browser.html";
const chromePath = await findChrome("the Customize overlay regression");
const vitePort = await freePort();
const BAR = "[data-customize-bar]";
const SEARCH = "[data-customize-search]";
const PROXY = "[data-customize-proxy]";
const TRANSCRIPT = '[aria-label="Sample conversation"]';
const KEYS = {
  Tab: { code: "Tab", vk: 9 },
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  z: { code: "KeyZ", vk: 90 },
};
const SHIFT = 8;
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
let devtoolsUrl;
let targetId;

try {
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
  await waitForHttp(pageUrl(""), viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-customize-overlay-",
    [
      "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
    ],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  devtoolsUrl = launched.devtoolsHttpUrl;
  await waitForHttp(
    new URL("/json/version", devtoolsUrl).href,
    chrome,
    launched.readError,
    "Chrome DevTools",
  );
  client = await newTab("about:blank", 1280, 800);

  // Each scenario reports on its own, so one failing assertion (say, a real
  // overlap) does not hide the rest of the QA. The run fails if any failed.
  const failures = [];
  async function scenario(name, run) {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    client.stage = name;
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(
        `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
      );
      // Bound the debugging: what the page logged, and what it looked like.
      try {
        const file = `/tmp/w6-customize-fail-${failures.length}.png`;
        client.stage = `${name}: failure screenshot`;
        await screenshot(file);
        console.error(`  screenshot: ${file}`);
        for (const line of client.logs.slice(-20))
          console.error(`  page ${line}`);
      } catch (diagnosticError) {
        console.error(`  (no diagnostics: ${diagnosticError})`);
      }
    }
  }

  // Layouts: `crowded` overflows the footer at the narrowest desktop width
  // (eight long-labelled accounts), `roomy` fits everything.
  const layouts = {
    crowded: ["?accounts=8&long=1", 768, 600],
    roomy: ["?accounts=3", 1280, 800],
  };
  for (const [name, [query, width, height]] of Object.entries(layouts)) {
    await scenario(`proxies exist (${name})`, async () => {
      await open(query, width, height);
      await screenshot(
        name === "roomy"
          ? "/tmp/w6-customize-wide.png"
          : "/tmp/w6-customize-narrow.png",
      );
      const keys = (await readProxies(client)).map((p) => p.key);
      // Sample body, footer cluster, footer resources, the usage handle and the Home tab.
      for (const id of [
        "composer.mic",
        "chat.minimapSide",
        "statusBar.provider",
        "statusBar.resources",
        "statusBar.usage",
        "tabs.home",
      ]) {
        assert.ok(
          keys.some((key) => key.startsWith(`${id}@`)),
          `no ${id} proxy (got ${keys.join(", ")})`,
        );
      }
      assertInside(await rectOf(client, BAR), width, `bar at ${width}px`);
    });
    await scenario(`proxy centres are hit-testable (${name})`, async () => {
      await open(query, width, height);
      const covered = (await readProxies(client))
        .filter((p) => p.onScreen && !p.hitSelf && !p.hitBar)
        .map((p) => p.key);
      assert.deepEqual(
        covered,
        [],
        "proxies whose own centre is covered by another element",
      );
    });
    await scenario(`no two proxies overlap (${name})`, async () => {
      await open(query, width, height);
      // Exact hit regions: any positive-area intersection is a click that has
      // two candidates. 0.5px slack per axis is sub-pixel rounding, not overlap.
      const proxies = await readProxies(client);
      const overlaps = [];
      for (let a = 0; a < proxies.length; a++) {
        for (let b = a + 1; b < proxies.length; b++) {
          const w =
            Math.min(proxies[a].right, proxies[b].right) -
            Math.max(proxies[a].left, proxies[b].left);
          const h =
            Math.min(proxies[a].bottom, proxies[b].bottom) -
            Math.max(proxies[a].top, proxies[b].top);
          if (w > 0.5 && h > 0.5)
            overlaps.push(
              `${proxies[a].key} x ${proxies[b].key} (${w.toFixed(1)}x${h.toFixed(1)}px)`,
            );
        }
      }
      assert.deepEqual(overlaps, [], "proxy hit regions that intersect");
    });
  }

  await scenario("Tab / arrow navigation over proxies", async () => {
    await open("?accounts=3", 1280, 800);
    await waitFor(
      client,
      "the search to hold focus",
      `document.activeElement?.matches('${SEARCH}')`,
    );
    // The bar comes after the proxies in DOM order, so Shift+Tab walks back
    // from the search: the bar's drag handle first, then the roving tab stop.
    await press(client, "Tab", SHIFT);
    await press(client, "Tab", SHIFT);
    const stop = await evaluate(
      client,
      `document.activeElement?.matches('${PROXY}') ? document.activeElement.dataset.customizeProxy : null`,
    );
    assert.notEqual(
      stop,
      null,
      "Shift+Tab twice from the search must land on a proxy",
    );
    assert.equal(
      await evaluate(
        client,
        `document.querySelectorAll('${PROXY}[tabindex="0"]').length`,
      ),
      1,
      "exactly one proxy is a tab stop (roving tabindex)",
    );
    await press(client, "ArrowRight", 0);
    const next = await evaluate(
      client,
      `document.activeElement?.dataset.customizeProxy ?? null`,
    );
    assert.ok(
      next !== null && next !== stop,
      "ArrowRight must move focus to another proxy",
    );
    await press(client, "Tab", 0);
    assert.equal(
      await evaluate(client, `document.activeElement?.matches('${PROXY}')`),
      false,
      "Tab leaves the proxy group",
    );
  });

  await scenario("native wheel scrolls the sample transcript", async () => {
    await open("?accounts=3", 1280, 560);
    const before = await evaluate(
      client,
      `(() => {
      const s = document.querySelector('${TRANSCRIPT}');
      const r = s.getBoundingClientRect();
      return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('${TRANSCRIPT}') !== null };
    })()`,
    );
    assert.ok(
      before.max > 0,
      "the transcript must overflow at 560px for a wheel to have work to do",
    );
    assert.equal(
      before.hit,
      true,
      "the point over the transcript must hit the transcript, not the overlay",
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: before.x,
      y: before.y,
      deltaX: 0,
      deltaY: 200,
    });
    await settle(client);
    assert.ok(
      (await evaluate(
        client,
        `document.querySelector('${TRANSCRIPT}').scrollTop`,
      )) > before.top,
      "a native wheel over the sample transcript must scroll it",
    );
  });

  await scenario("bar wraps when narrow and stays in the window", async () => {
    await open(...layouts.crowded);
    const narrowBar = await rectOf(client, BAR);
    assertInside(narrowBar, 768, "bar at 768px");
    await open(...layouts.roomy);
    const wideBar = await rectOf(client, BAR);
    assertInside(wideBar, 1280, "bar at 1280px");
    for (const layout of [layouts.crowded, layouts.roomy]) {
      await open(...layout);
      assert.equal(
        await evaluate(
          client,
          `(() => {const bar = document.querySelector("${BAR}"); const b = bar.getBoundingClientRect(); return Array.from(bar.children).filter(c => !c.classList.contains("sr-only")).every(c => {const r=c.getBoundingClientRect(); return r.left>=b.left-0.5 && r.right<=b.right+0.5 && r.top>=b.top-0.5 && r.bottom<=b.bottom+0.5;});})()`,
        ),
        true,
        "bar controls stay inside its wrapped bounds",
      );
    }
  });

  await scenario(
    "a 200-char search label stays inside the window",
    async () => {
      await open("?accounts=3", 768, 600);
      await clickAt(client, await centerOf(client, SEARCH));
      await client.send("Input.insertText", { text: "x".repeat(200) });
      await settle(client);
      const long = await evaluate(
        client,
        `(() => {
      const r = document.querySelector('[role="listbox"]')?.getBoundingClientRect();
      return { left: r?.left, right: r?.right, scroll: document.documentElement.scrollWidth };
    })()`,
      );
      assert.ok(
        long.left >= 0 && long.right <= 768,
        `the results must stay inside the window (${long.left}..${long.right})`,
      );
      assert.ok(
        long.scroll <= 768,
        `long text must not create horizontal page scroll (${long.scroll}px)`,
      );
    },
  );

  await scenario("pointer drag moves the bar and opens nothing", async () => {
    await open(...layouts.roomy);
    const grip = await centerOf(
      client,
      `${BAR} button[aria-label="Move Customize bar"]`,
    );
    const before = await rectOf(client, BAR);
    await drag(client, grip, { x: grip.x - 200, y: grip.y + 150 });
    const after = await rectOf(client, BAR);
    assert.ok(
      Math.abs(after.left - before.left) > 100 && after.top > before.top + 100,
      "dragging the handle must move the bar",
    );
    assertInside(after, 1280, "dragged bar");
    assert.equal(
      await evaluate(
        client,
        `document.querySelector('[data-slot="dropdown-menu-content"]') === null`,
      ),
      true,
      "a bar drag must not open the handle's menu",
    );
  });

  // Both drags use the sample transcript's real `minimap:<side>` slots. Other
  // drag kinds (dock rows, toolbar reorder, footer provider order) stay manual.
  const minimapSide = () =>
    evaluate(
      client,
      `window.__fixture.settings.getState().chatTurnMinimapSide`,
    );
  const historyLength = () =>
    evaluate(
      client,
      `window.__fixture.customize.getState().history.past.length`,
    );
  const minimapDrag = async () => {
    await open(...layouts.roomy);
    const from = await proxyCenter(client, "chat.minimapSide@");
    const side = (await minimapSide()) === "left" ? "right" : "left";
    const to = await centerOf(
      client,
      `[data-customize-drop-target^="minimap:${side}@"]`,
    );
    return { from, to, side, before: await minimapSide() };
  };
  await scenario(
    "dragging the minimap proxy to the other slot commits one history entry",
    async () => {
      const { from, to, side } = await minimapDrag();
      await drag(client, from, to);
      assert.equal(
        await minimapSide(),
        side,
        `the minimap must land on the ${side}`,
      );
      assert.equal(
        await historyLength(),
        1,
        "one drop is exactly one history entry",
      );
      assert.equal(
        await popoverKey(client),
        null,
        "a completed drag must not open the popover",
      );
    },
  );
  await scenario(
    "Esc during a minimap drag cancels: no setting change, no history",
    async () => {
      const { from, to, before } = await minimapDrag();
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...from,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...from,
        button: "left",
        clickCount: 1,
      });
      for (let step = 1; step <= 8; step++) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          button: "left",
          buttons: 1,
          x: from.x + ((to.x - from.x) * step) / 8,
          y: from.y + ((to.y - from.y) * step) / 8,
        });
        await delay(16);
      }
      assert.equal(
        await evaluate(
          client,
          `document.querySelector("[data-customize-dragging]") !== null`,
        ),
        true,
        "the drag must be in progress before Esc",
      );
      await press(client, "Escape", 0);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...to,
        button: "left",
        clickCount: 1,
      });
      await settle(client);
      assert.equal(
        await minimapSide(),
        before,
        "a cancelled drag must not change the setting",
      );
      assert.equal(
        await historyLength(),
        0,
        "a cancelled drag must not record history",
      );
      assert.equal(
        await evaluate(
          client,
          `window.__fixture.customize.getState().session !== null`,
        ),
        true,
        "Esc during a drag cancels the drag, it does not leave Customize",
      );
      assert.equal(
        await popoverKey(client),
        null,
        "a cancelled drag must not open the popover",
      );
    },
  );

  await scenario(
    "forced colors keeps a visible proxy focus outline",
    async () => {
      await open(...layouts.roomy);
      try {
        await client.send("Emulation.setEmulatedMedia", {
          features: [{ name: "forced-colors", value: "active" }],
        });
        await press(client, "Tab", SHIFT);
        await press(client, "Tab", SHIFT);
        const focus = await evaluate(
          client,
          `(() => {
        const el = document.activeElement;
        const style = getComputedStyle(el);
        return { proxy: el.matches('${PROXY}'), width: style.outlineWidth, style: style.outlineStyle,
          forced: matchMedia('(forced-colors: active)').matches };
      })()`,
        );
        assert.equal(focus.forced, true);
        assert.equal(focus.proxy, true);
        assert.equal(focus.width, "2px");
        assert.equal(focus.style, "solid");
      } finally {
        await client.send("Emulation.setEmulatedMedia", { features: [] });
      }
    },
  );

  await scenario("OS reduced motion: press does not scale", async () => {
    await open(...layouts.roomy);
    const grip = await centerOf(
      client,
      `${BAR} button[aria-label="Move Customize bar"]`,
    );
    const bar = await rectOf(client, BAR);
    // Pointer input, clear of every control, so `data-customize-keyboard` is not set.
    await clickAt(client, {
      x: Math.round(bar.left + 2),
      y: Math.round(bar.top + 2),
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...grip,
    });
    assert.equal(
      await pressedTransform(
        client,
        `${BAR} button[aria-label="Move Customize bar"]`,
      ),
      "matrix(0.97, 0, 0, 0.97, 0, 0)",
      "baseline: a pointer press scales the bar button",
    );
    try {
      await client.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      assertNotScaled(
        await pressedTransform(
          client,
          `${BAR} button[aria-label="Move Customize bar"]`,
        ),
        "OS reduced motion",
      );
      assert.equal(
        await scrimMinOpacity(),
        1,
        "OS reduced motion: no scrim fade",
      );
    } finally {
      await client.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  await scenario(
    "app reduced motion: store switch -> attr, no press scale, no scrim fade",
    async () => {
      await open(...layouts.roomy); // fixture starts with panelAnimations: true
      assert.equal(
        await evaluate(
          client,
          `document.documentElement.hasAttribute("data-reduce-panel-motion")`,
        ),
        false,
        "animations on: no reduce attribute",
      );
      const bar = await rectOf(client, BAR);
      // A real pointerdown makes the next entry a pointer entry (the one that fades in).
      await clickAt(client, {
        x: Math.round(bar.left + 2),
        y: Math.round(bar.top + 2),
      });
      // Lowest scrim opacity over ~400ms after (re-)entering: <1 means it faded.
      assert.ok(
        (await scrimMinOpacity()) < 0.9,
        "baseline: with panel animations on, a pointer entry fades the scrim in",
      );
      // The app's own switch, not a hand-set attribute: the theme applier must mirror it.
      await evaluate(client, `window.__fixture.exit()`);
      await waitFor(
        client,
        "the bar to unmount",
        `document.querySelector('${BAR}') === null`,
      );
      await evaluate(
        client,
        `window.__fixture.theme.setState({ panelAnimations: false })`,
      );
      await waitFor(
        client,
        "the theme applier to set the attribute",
        `document.documentElement.hasAttribute("data-reduce-panel-motion")`,
      );
      assert.equal(
        await scrimMinOpacity(),
        1,
        "panelAnimations off: the scrim must not fade",
      );
      await waitFor(
        client,
        "the bar",
        `document.querySelector('${BAR}') !== null`,
      );
      assertNotScaled(
        await pressedTransform(
          client,
          `${BAR} button[aria-label="Move Customize bar"]`,
        ),
        "app reduced motion (panelAnimations off)",
      );
      assert.equal(
        await evaluate(
          client,
          `getComputedStyle(document.querySelector('[data-customize-editor]')).animationDuration`,
        ),
        "0s",
      );
    },
  );

  await scenario(
    "keyboard search -> Enter -> radio change -> Ctrl+Z -> Esc",
    async () => {
      await open(...layouts.roomy);
      const micBefore = await evaluate(
        client,
        `window.__fixture.layout.getState().composer.mic`,
      );
      assert.equal(
        await evaluate(client, `document.activeElement?.matches('${SEARCH}')`),
        true,
        "entry focuses search",
      );
      await client.send("Input.insertText", { text: "mic" });
      await press(client, "Enter", 0);
      await waitFor(
        client,
        "the mic popover",
        `window.__fixture.customize.getState().popoverKey?.startsWith("composer.mic@")`,
      );
      await waitFor(
        client,
        "radio focus",
        `document.activeElement?.getAttribute("role") === "radio"`,
      );
      await press(client, "ArrowDown", 0);
      await waitFor(
        client,
        "the mic change",
        `window.__fixture.layout.getState().composer.mic !== "${micBefore}"`,
      );
      await press(client, "z", 2);
      await waitFor(
        client,
        "Undo to restore the mic",
        `window.__fixture.layout.getState().composer.mic === "${micBefore}"`,
      );
      for (
        let presses = 0;
        presses < 5 &&
        (await evaluate(
          client,
          `window.__fixture.customize.getState().session !== null`,
        ));
        presses++
      ) {
        await press(client, "Escape", 0);
        await settle(client);
      }
      assert.equal(
        await evaluate(client, `window.__fixture.customize.getState().session`),
        null,
        "Esc must unwind popover, search, then leave Customize",
      );
      await waitFor(
        client,
        "the bar to unmount",
        `document.querySelector('${BAR}') === null`,
      );
    },
  );

  await scenario("resizing below md exits Customize", async () => {
    await open(...layouts.roomy);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 700,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      client,
      "the session to end",
      `window.__fixture.customize.getState().session === null`,
    );
    await waitFor(
      client,
      "the bar to unmount",
      `document.querySelector('${BAR}') === null`,
    );
  });

  await scenario("legacy Layout page fits at 320 CSS pixels", async () => {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Page.navigate", { url: pageUrl("?view=layout") });
    await waitFor(
      client,
      "the Layout panel",
      `Array.from(document.querySelectorAll('h1,h2')).some(el => el.textContent === 'Layout')`,
    );
    await settle(client);
    await screenshot("/tmp/w6-customize-layout-320.png");
    const layout = await evaluate(
      client,
      `({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      session: window.__fixture.customize.getState().session, text: document.body.innerText })`,
    );
    assert.equal(layout.session, null);
    assert.ok(
      layout.scrollWidth <= layout.width,
      `Layout overflows: ${layout.scrollWidth}/${layout.width}`,
    );
    assert.ok(
      layout.text.includes("Composer") && layout.text.includes("Status bar"),
    );
  });

  // Last: it closes the main tab, then reopens one.
  await scenario(
    "a second window waits, then takes the lease within 8s of the owner closing",
    async () => {
      await open(...layouts.roomy); // this window owns the lease
      assert.equal(
        await evaluate(
          client,
          `window.__fixture.customize.getState().session !== null`,
        ),
        true,
        "the first window must own the session",
      );
      const second = await newTab(pageUrl(layouts.roomy[0]), 1280, 800);
      try {
        await waitFor(
          second.client,
          "the second window to mount",
          `window.__fixture !== undefined`,
        );
        await delay(500);
        assert.equal(
          await evaluate(
            second.client,
            `window.__fixture.customize.getState().session`,
          ),
          null,
          "a second window must not enter while the first holds the lease",
        );
        assert.equal(
          await evaluate(
            second.client,
            `window.__fixture.customize.getState().lockedBy`,
          ),
          "other-window",
        );
        assert.equal(
          await evaluate(
            second.client,
            `document.querySelector('${BAR}') === null`,
          ),
          true,
          "the locked window draws no bar",
        );
        await closeTab(targetId);
        const closedAt = Date.now();
        let acquired = false;
        while (!acquired && Date.now() - closedAt < 8000) {
          acquired = await evaluate(second.client, `window.__fixture.enter()`);
          if (!acquired) await delay(250);
        }
        assert.equal(
          acquired,
          true,
          "the second window must acquire within 8s of the owner closing",
        );
        await waitFor(
          second.client,
          "the second window's bar",
          `document.querySelector('${BAR}') !== null`,
        );
      } finally {
        second.client.close();
        await closeTab(second.id);
      }
    },
  );

  if (failures.length > 0) {
    process.exitCode = 1;
    console.error(
      `${failures.length} scenario(s) failed: ${failures.join("; ")}`,
    );
  } else {
    console.log("customize overlay browser regression passed");
  }
} catch (error) {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
} finally {
  try {
    client?.close();
  } finally {
    try {
      if (chrome !== undefined) await terminateProcessTree(chrome);
    } finally {
      try {
        viteProcess?.kill("SIGTERM");
      } finally {
        if (chromeProfilePath !== undefined) {
          await rm(chromeProfilePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
          });
        }
      }
    }
  }
}

/** Opens a tab and attaches CDP. The MAIN tab (`client`) also records its target id. */
async function newTab(url, width, height) {
  const response = await fetch(
    new URL(`/json/new?${encodeURIComponent(url)}`, devtoolsUrl),
    { method: "PUT" },
  );
  if (!response.ok)
    throw new Error(`Chrome could not open a tab: ${response.status}`);
  const target = await response.json();
  const tab = await connectCdp(target.webSocketDebuggerUrl);
  await tab.send("Runtime.enable", {});
  await tab.send("Page.enable", {});
  await tab.send("Log.enable", {});
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (url === "about:blank") targetId = target.id;
  return Object.assign(tab, { client: tab, id: target.id });
}

async function closeTab(id) {
  await fetch(new URL(`/json/close/${id}`, devtoolsUrl));
}

async function screenshot(file) {
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(file, Buffer.from(data, "base64"));
}

function pageUrl(query) {
  return `http://127.0.0.1:${vitePort}${fixtureUrlPath}${query}`;
}

/** Fresh page at a viewport, waiting for the editor and its proxies to mount. */
async function open(query, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(client, "window.__w6Navigating = true");
  await client.send("Page.navigate", { url: pageUrl(query) });
  await waitFor(
    client,
    "the overlay and proxies",
    `window.__w6Navigating !== true && document.querySelector('${BAR}') !== null && document.querySelectorAll('${PROXY}').length > 0`,
  );
  await settle(client);
}

async function readProxies(client) {
  return evaluate(
    client,
    `Array.from(document.querySelectorAll('${PROXY}')).map((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const onScreen = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
    return { key: el.dataset.customizeProxy, left: r.left, top: r.top, right: r.right, bottom: r.bottom, cx, cy, onScreen,
      hitBar: onScreen && document.elementFromPoint(cx, cy)?.closest("[data-customize-bar]") !== null,
      hitSelf: onScreen ? document.elementFromPoint(cx, cy) === el : null };
  })`,
  );
}

function assertInside(rect, width, label) {
  assert.ok(
    rect.left >= 0 && rect.right <= width,
    `${label} must sit inside the window (left ${rect.left}, right ${rect.right})`,
  );
}

async function proxyCenter(client, prefix) {
  const p = (await readProxies(client)).find((item) =>
    item.key.startsWith(prefix),
  );
  assert.ok(p, `no proxy for ${prefix}`);
  return { x: Math.round(p.cx), y: Math.round(p.cy) };
}

function popoverKey(client) {
  return evaluate(client, `window.__fixture.customize.getState().popoverKey`);
}

/** Holds the pointer DOWN on a control, reads its settled transform, releases elsewhere. */
/** A press must not scale: `none`, or the identity a `scale(1)` resolves to. */
function assertNotScaled(transform, label) {
  assert.ok(
    transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)",
    `${label}: a pointer press must not scale (got ${transform})`,
  );
}

async function scrimMinOpacity() {
  await evaluate(client, `window.__fixture.exit()`);
  await waitFor(
    client,
    "the bar to unmount",
    `document.querySelector('${BAR}') === null`,
  );
  return evaluate(
    client,
    `new Promise((resolve) => {
        window.__fixture.enter();
        let min = 1;
        const end = performance.now() + 400;
        const sample = () => {
          const svg = document.querySelector('[data-customize-editor] svg');
          if (svg) min = Math.min(min, Number(getComputedStyle(svg.parentElement).opacity));
          if (performance.now() < end) requestAnimationFrame(sample); else resolve(min);
        };
        requestAnimationFrame(sample);
      })`,
  );
}

async function pressedTransform(client, selector) {
  const at = await centerOf(client, selector);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...at,
    button: "left",
    clickCount: 1,
  });
  await delay(350);
  const transform = await evaluate(
    client,
    `getComputedStyle(document.elementFromPoint(${at.x}, ${at.y}).closest("button")).transform`,
  );
  // The release lands 12px away: a drag, so the handle's click does not open its menu.
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: at.x + 12,
    y: at.y,
    button: "left",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: at.x + 12,
    y: at.y,
    button: "left",
    clickCount: 1,
  });
  await delay(200);
  return transform;
}

async function rectOf(client, selector) {
  return evaluate(
    client,
    `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; })()`,
  );
}

async function centerOf(client, selector) {
  const r = await rectOf(client, selector);
  return {
    x: Math.round((r.left + r.right) / 2),
    y: Math.round((r.top + r.bottom) / 2),
  };
}

async function clickAt(client, at) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...at,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...at,
    button: "left",
    clickCount: 1,
  });
  await delay(60);
}

async function drag(client, from, to) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...from,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...from,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step++) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: from.x + ((to.x - from.x) * step) / 8,
      y: from.y + ((to.y - from.y) * step) / 8,
    });
    await delay(16);
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...to,
    button: "left",
    clickCount: 1,
  });
  await settle(client);
}

async function press(client, name, modifiers) {
  const { code, vk, text } = KEYS[name];
  const base = { key: name, code, windowsVirtualKeyCode: vk, modifiers };
  await client.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(text ? { text } : {}),
  });
  await delay(60);
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await delay(60);
}

function settle(client) {
  return evaluate(client, `new Promise((r) => setTimeout(r, 250))`);
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
    const logs = [];
    let nextId = 0;
    let connectTimer;
    const fail = (error) => {
      clearTimeout(connectTimer);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    connectTimer = setTimeout(() => {
      fail(new Error("CDP connect timed out"));
      socket.close();
    }, 15_000);
    socket.addEventListener("error", () =>
      fail(new Error("CDP socket failed")),
    );
    socket.addEventListener("close", () =>
      fail(new Error("CDP socket closed")),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") {
        logs.push(
          `exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`,
        );
      } else if (
        message.method === "Runtime.consoleAPICalled" &&
        (message.params.type === "error" || message.params.type === "warning")
      ) {
        logs.push(
          `console.${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")}`,
        );
      } else if (
        message.method === "Log.entryAdded" &&
        message.params.entry.level === "error"
      ) {
        logs.push(
          `log: ${message.params.entry.text} ${message.params.entry.url ?? ""}`,
        );
      }
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
        logs,
        stage: "setup",
        send(method, params) {
          const stage = this.stage;
          const expression =
            method === "Runtime.evaluate"
              ? String(params.expression).replace(/\s+/g, " ").slice(0, 240)
              : method;
          const started = Date.now();
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              requestReject(
                new Error(
                  `Timed out sending CDP command ${method}; stage=${stage}; expression=${expression}; elapsed=${Date.now() - started}ms`,
                ),
              );
            }, 15_000);
            pending.set(id, {
              resolve(value) {
                clearTimeout(timer);
                requestResolve(value);
              },
              reject(error) {
                clearTimeout(timer);
                requestReject(error);
              },
            });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              clearTimeout(timer);
              requestReject(error);
            }
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

async function waitFor(client, label, expression) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    client,
    `({ text: document.body.innerText.slice(0, 1500), html: document.body.innerHTML.slice(0, 2000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}
