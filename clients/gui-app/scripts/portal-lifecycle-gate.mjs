// T06 production lifecycle gate — CDP driver for
// src/__tests__/browser/portal-lifecycle-gate.tsx. Runs in run-tests.ts
// alongside the primitive behavior gate, preserving T02's promoted cases.
// Run directly: `node scripts/portal-lifecycle-gate.mjs`.
// GATE_CASE narrows to matching test names, same convention as PROOF_CASE.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
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
const exceptions = [];
let client;
const server = await createServer({
  configFile: path.join(project, "vitest.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
});
await server.listen();
const origin = server.resolvedUrls.local[0];
const chrome = await launchChromeWithDevTools(
  await findChrome("Portal lifecycle gate"),
  "traycer-portal-lifecycle-",
  ["--force-device-scale-factor=1"],
);
const report = { cases: [] };
try {
  const response = await fetch(
    new URL("/json/new?about:blank", chrome.devtoolsHttpUrl),
    { method: "PUT" },
  );
  client = await connect(
    (await response.json()).webSocketDebuggerUrl,
    exceptions,
    45000,
  );
  await client.send("Page.enable", {});
  await client.send("Runtime.enable", {});
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${installPresentationProbes.toString()})()`,
  });
  report.chrome = await client.send("Browser.getVersion", {});
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let sequence = 0;
  async function load(query) {
    exceptions.length = 0;
    const url = new URL(
      "src/__tests__/browser/portal-lifecycle-gate.html?" +
        query +
        "&sequence=" +
        ++sequence,
      origin,
    );
    await client.send("Page.navigate", { url: url.href });
    await wait(
      "fixture",
      `location.href===${JSON.stringify(url.href)} && !!window.gate && !!document.querySelector('[data-gate-trigger]')`,
    );
    await delay(100);
  }
  async function snapshot() {
    return evaluate(
      `({state:{...document.querySelector('[data-gate-state]')?.dataset},popupPresented:window.gatePresented('[data-gate-popup]'),draft:document.querySelector('[data-gate-draft]')?.value,nestedDraft:document.querySelector('[data-gate-nested-draft]')?.value,events:window.gate.events,focusEvents:window.gate.focusEvents,active:document.activeElement?.outerHTML.slice(0,200)})`,
    );
  }
  async function test(name, fn) {
    if (process.env.GATE_CASE && !name.includes(process.env.GATE_CASE)) return;
    try {
      const evidence = await fn();
      if (exceptions.length) throw new Error(exceptions.join("\n"));
      report.cases.push({ name, pass: true, evidence });
      console.log("PASS", name);
    } catch (error) {
      report.cases.push({
        name,
        pass: false,
        error: String(error),
        snapshot: await snapshot(),
      });
      console.error("FAIL", name, String(error));
    }
  }

  for (const family of ["dialog", "popover"])
    for (const controlled of [true, false]) {
      const label = `${family} ${controlled ? "controlled" : "uncontrolled"}`;

      await test(`${label} retains logical state and draft across a concealment round-trip, no spurious change/complete`, async () => {
        await load(`family=${family}&controlled=${controlled}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        const opened = await snapshot();
        assert.equal(opened.state.changes, "1");
        assert.equal(opened.state.completes, "1");
        await evaluate(
          `document.querySelector('[data-gate-draft]').focus();document.querySelector('[data-gate-draft]').select()`,
        );
        await client.send("Input.insertText", { text: "typed value" });
        const typed = await snapshot();
        assert.equal(typed.draft, "typed value");

        await evaluate("window.gate.conceal(true)");
        await delay(250);
        const concealed = await snapshot();
        assert.equal(concealed.popupPresented, false);
        assert.equal(concealed.state.changes, "1");
        assert.equal(concealed.state.completes, "1");
        assert.equal(concealed.state.finals, "0");

        await evaluate("window.gate.conceal(false)");
        await delay(250);
        const returned = await snapshot();
        assert.equal(returned.popupPresented, true);
        assert.equal(returned.draft, "typed value");
        assert.equal(returned.state.changes, "1");
        assert.equal(returned.state.completes, "1");
        assert.equal(returned.state.finals, "0");
        return { opened, typed, concealed, returned };
      });

      await test(`${label} Activity actually disconnects content while concealed and reconnects on return`, async () => {
        await load(`family=${family}&controlled=${controlled}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        const before = await snapshot();
        assert(before.events.includes("content:connect"));
        assert(!before.events.includes("content:disconnect"));

        await evaluate("window.gate.conceal(true)");
        await wait(
          "content disconnects",
          "window.gate.events.includes('content:disconnect')",
        );
        const hidden = await snapshot();
        assert.equal(
          hidden.events.filter((e) => e === "content:connect").length,
          1,
        );
        assert.equal(
          hidden.events.filter((e) => e === "content:disconnect").length,
          1,
        );

        await evaluate("window.gate.conceal(false)");
        await delay(250);
        const returned = await snapshot();
        assert.equal(
          returned.events.filter((e) => e === "content:connect").length,
          2,
          "content reconnects once returned - Activity really remounted it, not just a CSS hide",
        );
        return { before, hidden, returned };
      });

      await test(`${label} a rapid conceal/reveal never leaves content disconnected, retains state through it`, async () => {
        await load(`family=${family}&controlled=${controlled}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        const before = await snapshot();
        assert.equal(
          before.events.filter((e) => e === "content:connect").length,
          1,
        );

        // `rapidConcealReveal()` commits the first flip (flushSync) then
        // issues the second right after in the same turn, no delay - the
        // fastest interruption reachable from outside React. Measured:
        // `content:disconnect` fires anyway (React's own passive-effect
        // flush from the first commit wins the race either way), so this
        // asserts what is actually true - content ends up connected, never
        // left mid-teardown, and every counter is retained exactly as a
        // normal round-trip.
        await evaluate("window.gate.rapidConcealReveal()");
        await delay(250);
        const after = await snapshot();
        assert.equal(after.popupPresented, true);
        const connects = after.events.filter(
          (e) => e === "content:connect",
        ).length;
        const disconnects = after.events.filter(
          (e) => e === "content:disconnect",
        ).length;
        assert.equal(
          connects,
          disconnects + 1,
          "content must end up connected - never left mid-teardown",
        );
        assert.equal(after.state.changes, before.state.changes);
        assert.equal(after.state.completes, before.state.completes);
        assert.equal(after.state.finals, "0");
        return { before, after, connects, disconnects };
      });

      await test(`${label} an ordinary Escape close (not concealed) completes, calls finalFocus, and returns focus to the trigger`, async () => {
        await load(`family=${family}&controlled=${controlled}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        await key("Escape", 0);
        await delay(250);
        const after = await snapshot();
        assert.equal(after.state.changes, "2");
        assert.equal(after.state.completes, "2");
        assert.equal(after.state.finals, "1");
        assert(after.active.includes("data-gate-trigger"));
        return after;
      });
    }

  for (const family of ["dialog", "popover"])
    for (const control of ["focus", "visible"]) {
      const label = `${family} pane-${control}`;
      await test(`${label} loss un-presents through the real SurfacePresentationBoundary (paneAware), retains, and returns focus to Pane B`, async () => {
        await load(`family=${family}&controlled=true`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        const before = await snapshot();
        assert.equal(before.state.changes, "1");
        assert.equal(before.state.completes, "1");

        const attribute = { focus: "focused", visible: "visible" }[control];
        await evaluate(`window.gate.${control}Pane(false)`);
        await wait(
          "pane state committed",
          `document.querySelector('[data-gate-pane-state]').dataset.${attribute}==='false'`,
        );
        await delay(250);
        const lost = await snapshot();
        // useOverlayPresentation's own `present = !concealed && (!paneAware
        // || paneFocused)` treats EITHER focus loss or visibility loss as a
        // presentation loss - Dialog/Popover are both `paneAware: true`, so
        // there is no case where the popup stays visually presented while
        // its pane is unfocused. It behaves exactly like concealment: the
        // popup un-presents, nothing counts as a real close, and the pane
        // switch moves focus straight to Pane B - never left dangling on a
        // now-hidden popup control.
        assert.equal(lost.popupPresented, false);
        assert.equal(lost.state.changes, "1");
        assert.equal(lost.state.completes, "1");
        assert.equal(lost.state.finals, "0");
        assert.deepEqual(lost.focusEvents, ["B"]);
        assert(lost.active.includes("data-gate-outside"));

        await evaluate(`window.gate.${control}Pane(true)`);
        // Rapid: focus must land in the popup quickly, not just eventually.
        await wait(
          "rapid focused return lands focus in the popup",
          "document.querySelector('[data-gate-popup]')?.contains(document.activeElement) === true",
        );
        await delay(250);
        const returned = await snapshot();
        assert.equal(returned.popupPresented, true);
        assert.equal(returned.state.changes, "1");
        assert.equal(returned.state.completes, "1");
        assert.equal(returned.state.finals, "0");
        // Settled: still true after the full round-trip has quiesced.
        assert(
          await evaluate(
            "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
          ),
          "settled focused return must land focus inside the popup",
        );
        return { before, lost, returned };
      });
    }

  for (const family of ["dialog", "popover"])
    await test(`${family} a visibility-only return while still unfocused never refocuses the popup; focus returning after does`, async () => {
      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);

      await evaluate("window.gate.focusPane(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-pane-state]').dataset.focused==='false'",
      );
      await evaluate("window.gate.visiblePane(false)");
      await wait(
        "pane visibility lost",
        "document.querySelector('[data-gate-pane-state]').dataset.visible==='false'",
      );
      await delay(250);

      // `usePaneFocused()` is `focused && visible` - restoring visibility
      // ALONE, while focus is still lost, must not re-present or refocus
      // anything.
      await evaluate("window.gate.focusEvents.length = 0");
      await evaluate("window.gate.visiblePane(true)");
      await delay(250);
      const visibleOnly = await snapshot();
      assert.equal(visibleOnly.popupPresented, false);
      assert.deepEqual(visibleOnly.focusEvents, []);
      assert(visibleOnly.active.includes("data-gate-outside"));

      // Now restore focus too - this is the axis that actually re-presents.
      await evaluate("window.gate.focusPane(true)");
      await wait(
        "focused return lands focus in the popup",
        "document.querySelector('[data-gate-popup]')?.contains(document.activeElement) === true",
      );
      await delay(250);
      const focusedToo = await snapshot();
      assert.equal(focusedToo.popupPresented, true);
      assert(
        await evaluate(
          "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
        ),
      );
      return { visibleOnly, focusedToo };
    });

  // Cold-pane activation (overlay-guards.ts's isOwnPaneTriggerEvent), real
  // Chrome: `coldActivation` wires the real usePaneActivationOwnership hook
  // so the ONE click below is what commits activation, same as production.
  for (const family of ["popover", "menu"])
    await test(`${family} cold pane: own trigger click activates, and once the pane is focused the popup presents with focus inside`, async () => {
      await load(`family=${family}&controlled=true&coldActivation=true`);
      await evaluate("window.gate.focusPane(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-pane-state]').dataset.focused==='false'",
      );
      await evaluate(
        "window.gate.events.length = 0; window.gate.focusEvents.length = 0",
      );

      // One-shot click listener records pre-commit state in the same
      // synchronous dispatch as the real click, before the deferred commit.
      await evaluate(
        `window.__coldProbe = null;
         document.addEventListener('click', () => {
           window.__coldProbe = {
             focused: document.querySelector('[data-gate-pane-state]').dataset.focused,
             popupPresented: window.gatePresented('[data-gate-popup]'),
           };
         }, { once: true });`,
      );

      await clickSelector("[data-gate-trigger]", "left", true);
      const preCommit = await evaluate("window.__coldProbe");
      assert.equal(
        preCommit.focused,
        "false",
        "pane activation must be deferred past the click's own synchronous handling, not committed inline",
      );
      assert.equal(preCommit.popupPresented, false);

      await wait(
        "committed activation presents the popup with focus inside",
        "window.gatePresented('[data-gate-popup]') && document.querySelector('[data-gate-popup]')?.contains(document.activeElement) === true",
      );
      await delay(250);
      const activated = await snapshot();
      assert.equal(activated.popupPresented, true);
      assert(
        await evaluate(
          "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
        ),
        "focus must land inside the popup once activation commits",
      );
      return { preCommit, activated };
    });

  for (const family of ["popover", "menu"])
    await test(`${family} cold pane: a concealed trigger click never activates`, async () => {
      await load(`family=${family}&controlled=true`);
      await evaluate("window.gate.focusPane(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-pane-state]').dataset.focused==='false'",
      );
      await evaluate("window.gate.conceal(true)");
      await delay(150);
      await evaluate("window.gate.events.length = 0");

      // Trigger is unpainted while concealed; `.click()` is the supported
      // app-triggered path that can still reach it, so the guard must reject.
      const preClick = await evaluate(
        `(() => {
          const trigger = document.querySelector('[data-gate-trigger]');
          return {
            exists: trigger !== null,
            painted: trigger !== null && (trigger.checkVisibility?.() ?? true),
          };
        })()`,
      );
      assert.equal(
        preClick.exists,
        true,
        "trigger must still exist in the DOM while concealed",
      );
      assert.equal(
        preClick.painted,
        false,
        "a concealed owner's trigger must not be painted",
      );

      await evaluate("document.querySelector('[data-gate-trigger]').click()");
      await delay(200);
      const after = await snapshot();
      assert.equal(after.popupPresented, false);
      // "0": the owner's own onOpenChange (which increments data-changes)
      // is never reached at all - the guard cancels before it runs.
      assert.equal(after.state.changes, "0");
      return { after };
    });

  // `window.gate.openOuter()` flips the Root's controlled `open` prop
  // directly, with no onOpenChange/reason/trigger - same lever both families.
  for (const family of ["popover", "menu"])
    await test(`${family} cold pane: a programmatic open with no trigger gesture at all never presents`, async () => {
      await load(`family=${family}&controlled=true`);
      await evaluate("window.gate.focusPane(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-pane-state]').dataset.focused==='false'",
      );
      await evaluate("window.gate.openOuter()");
      await delay(250);
      const after = await snapshot();
      assert.equal(after.popupPresented, false);
      return { after };
    });

  // Root ownership stays pane A; `foreignPaneTrigger` portals its own
  // trigger element into pane B's DOM - the pane check must still reject it.
  for (const family of ["popover", "menu"])
    await test(`${family} cold pane: own Root's trigger portaled into another pane never activates`, async () => {
      await load(`family=${family}&controlled=true&foreignPaneTrigger=true`);
      await evaluate("window.gate.focusPane(false)");
      await wait(
        "pane focus lost",
        "document.querySelector('[data-gate-pane-state]').dataset.focused==='false'",
      );
      await wait(
        "trigger portaled into pane B",
        "!!document.querySelector('[data-gate-pane-b] [data-gate-trigger]')",
      );
      await evaluate("window.gate.events.length = 0");

      await clickSelector(
        "[data-gate-pane-b] [data-gate-trigger]",
        "left",
        true,
      );
      await delay(200);
      const after = await snapshot();
      assert.equal(after.popupPresented, false);
      // "0": the pane check must reject before the Owner's own onOpenChange
      // (which increments data-changes) is ever reached.
      assert.equal(after.state.changes, "0");
      return { after };
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} controlled owner close while concealed never reopens`, async () => {
      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      const before = await snapshot();

      await evaluate(
        "window.gate.conceal(true);document.querySelector('[data-gate-outside]').focus()",
      );
      await delay(180);
      // The owner's own close and the presentation return land in the same
      // synchronous turn - close must win regardless of order (T02's
      // `owner close while concealed never reopens`, promoted here).
      await evaluate("window.gate.closeOwner();window.gate.conceal(false)");
      await delay(500);
      const after = await snapshot();
      assert.equal(after.popupPresented, false);
      assert.equal(after.state.changes, before.state.changes);
      assert.equal(after.state.completes, before.state.completes);
      assert.equal(after.state.initials, before.state.initials);
      assert.equal(after.state.finals, before.state.finals);
      assert(after.active.includes("data-gate-outside"));
      return { before, after };
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} R1: a genuine pane transfer during close must not be stolen back by the queued final-focus restore`, async () => {
      // Base resolves `finalFocus` during effect cleanup and performs the
      // actual `.focus()` in a LATER queued microtask - review R1's finding
      // was that a real focus move happening in that gap (a pane transfer
      // that lands the instant the popup's DOM node is removed) got
      // stomped by that stale queued restore. Race the two here: arm an
      // observer that fires `focusPane(false)` (the SAME real transfer the
      // pane-loss cases above use) the instant the popup disconnects, then
      // close for real (Escape, not a programmatic close) so the queued
      // restore is actually scheduled and racing it.
      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      await evaluate("window.gate.focusEvents.length = 0");
      await evaluate(`
        window.__gateRace = new MutationObserver(() => {
          if (!document.querySelector('[data-gate-popup]')) {
            window.__gateRace.disconnect();
            window.gate.focusPane(false);
          }
        });
        window.__gateRace.observe(document.body, { childList: true, subtree: true });
      `);
      await key("Escape", 0);
      await delay(300);
      const after = await snapshot();
      // The full sequence, not just the final element: a late steal would
      // append a second entry (the trigger doesn't match `[data-gate-outside]`,
      // so it records as another "A"), even if a subsequent check only read
      // the final activeElement and happened to still see B by then.
      assert.deepEqual(
        after.focusEvents,
        ["B"],
        "a stale queued restore reactivated the unfocused pane after B already took focus",
      );
      assert(after.active.includes("data-gate-outside"));
      return after;
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} R2: a genuine owner unmount of an open Root still restores the connected opener`, async () => {
      // The owner never flips `open` to `false` here - it removes the whole
      // Root while `open` stays a literal `true` (ThemeManager's real
      // pattern). `finalAllowed` must permit this via the mounted-ref path,
      // not just the ordinary `!cycle.open` path the other cases exercise.
      await load(`family=${family}&conditionalRoot=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      const before = await snapshot();
      assert.equal(before.state.finals, "0");

      await evaluate("window.gate.closeOwner()");
      await wait(
        "the Root actually unmounts, not just closes",
        "!document.querySelector('[data-gate-popup]')",
      );
      await delay(300);
      const after = await snapshot();
      assert.equal(
        after.state.finals,
        "1",
        "finalFocus must still fire when the owner unmounts the open Root outright",
      );
      assert(
        after.active.includes("data-gate-trigger"),
        "focus must return to the connected opener, not be left on document.body",
      );
      return { before, after };
    });

  for (const mode of ["tab", "outside"])
    await test(`popover R4: a nonmodal dismissal (${mode}) lands the complete focus-event sequence on the real destination, not a restore to the trigger`, async () => {
      // Base suppresses restoration after focus-out, including Tab-out and
      // a click on another focusable control. Preserve the destination.
      await load("family=popover&controlled=true");
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      if (mode === "tab")
        // Focus the popup's own last control first, so Tab is a genuine
        // Tab-out of the popup, not a Tab from wherever focus already was.
        await evaluate("document.querySelector('[data-gate-close]').focus()");
      // Only the gesture's own focus events matter here - clear right
      // before firing it, not after opening (which has its own initial-focus
      // transit into the popup that would otherwise contaminate the count).
      await evaluate("window.gate.focusEvents.length = 0");
      if (mode === "tab") await key("Tab", 0);
      else await clickSelector("[data-gate-outside]", "left", true);
      await wait(
        "the popup actually unmounts, not just loses focus",
        "!document.querySelector('[data-gate-popup]')",
      );
      await delay(300);
      const after = await snapshot();
      assert(
        after.active.includes("data-gate-outside"),
        `a nonmodal ${mode} dismissal must land focus on the actual destination ([data-gate-outside]), not be overridden by a return-focus restore to the trigger`,
      );
      // The fixture records native data-base-ui-focus-guard transits as G.
      // All application focus events must still be exactly one transition to B.
      assert.deepEqual(
        after.focusEvents.filter((event) => event !== "G"),
        ["B"],
        `the ${mode} dismissal's real (non-guard) focus-event sequence must be exactly one transition to B: ${JSON.stringify(after.focusEvents)}`,
      );
      return after;
    });

  await test(`popover R4 parity: an outside press on plain non-focusable background must land focus exactly where native Base does`, async () => {
    // Pin the measured Base 1.8 background-press contract as well as comparing
    // live native and production results, so a shared behavior change fails too.
    const RECORDED_NATIVE_BASE_1_8_LANDS_ON_TRIGGER = true;
    const RECORDED_NATIVE_BASE_1_8_LANDS_ON_BODY = false;

    await load("family=popover&native=true");
    await clickSelector("[data-gate-trigger]", "left", true);
    await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
    await delay(180);
    assert.equal(
      await evaluate(
        "document.elementFromPoint(500,600)?.matches('[data-gate-background]')",
      ),
      true,
      "background click point must actually be an uncovered, non-focusable background element (native)",
    );
    await clickAt(500, 600, "left");
    await wait(
      "the native popup actually unmounts, proving the press really closed it",
      "!document.querySelector('[data-gate-popup]')",
    );
    await delay(300);
    // Compare identity (which element), not the raw markup - production's
    // wrapper adds its own incidental attributes (e.g. `data-slot`) to the
    // same trigger node, which would make an outerHTML string compare fail
    // for a reason that has nothing to do with WHERE focus landed.
    const nativeIsTrigger = await evaluate(
      "document.activeElement?.matches('[data-gate-trigger]') ?? false",
    );
    const nativeIsBody = await evaluate(
      "document.activeElement === document.body",
    );
    assert.equal(
      nativeIsTrigger,
      RECORDED_NATIVE_BASE_1_8_LANDS_ON_TRIGGER,
      "native Base's own measured contract changed - re-verify this case and update the recorded constants before trusting the dynamic compare below",
    );
    assert.equal(nativeIsBody, RECORDED_NATIVE_BASE_1_8_LANDS_ON_BODY);

    await load("family=popover&controlled=true");
    await clickSelector("[data-gate-trigger]", "left", true);
    await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
    await delay(180);
    assert.equal(
      await evaluate(
        "document.elementFromPoint(500,600)?.matches('[data-gate-background]')",
      ),
      true,
      "background click point must actually be an uncovered, non-focusable background element (production)",
    );
    await clickAt(500, 600, "left");
    await wait(
      "the production popup actually unmounts, proving the press really closed it",
      "!document.querySelector('[data-gate-popup]')",
    );
    await delay(300);
    const after = await snapshot();
    const afterIsTrigger = after.active.includes("data-gate-trigger");
    const afterIsBody = after.active.startsWith("<body");

    assert.equal(
      afterIsTrigger,
      nativeIsTrigger,
      `production's outside press on plain background must match native Base's own measured behavior (native landed on trigger: ${nativeIsTrigger})`,
    );
    assert.equal(
      afterIsBody,
      nativeIsBody,
      `production's outside press on plain background must match native Base's own measured behavior (native landed on body: ${nativeIsBody})`,
    );
    return { nativeIsTrigger, nativeIsBody, after };
  });

  for (const family of ["menu", "select"])
    await test(`${family} R1 parity: a controlled reopen after a real Tab-out must land on native Base's own destination, not document.body`, async () => {
      // Controlled open:false->true never fires onOpenChange, so a stale
      // close reason can survive into the next open. Native measured first.
      async function measure() {
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        // Break on the logical close (aria-expanded), not the hidden boundary -
        // the wrapper's exit transition lags native's instant one, so polling
        // gateClosedPure here sends an extra, unwanted real Tab mid-exit.
        for (let i = 0; i < 3; i++) {
          await key("Tab", 0);
          await delay(60);
          if (
            await evaluate(
              "document.querySelector('[data-gate-trigger]')?.getAttribute('aria-expanded') === 'false'",
            )
          )
            break;
        }
        await waitClosed(
          "[data-gate-popup]",
          "[data-gate-trigger]",
          "Tab-out closes",
        );
        await delay(180);
        const afterTab = await snapshot();
        assert(
          afterTab.active.includes("data-gate-outside"),
          `Tab-out must land on the outside control before the programmatic reopen, for a symmetric sequence: ${afterTab.active}`,
        );
        // Programmatic reopen, not a trigger click - the transition onOpenChange skips.
        await evaluate("window.gate.openOuter()");
        await wait(
          "reopen focuses inside",
          "document.querySelector('[data-gate-popup]')?.contains(document.activeElement)",
        );
        await delay(180);
        await evaluate("window.gate.closeOwner()");
        await delay(300);
        return snapshot();
      }

      // quietComplete: skip Owner's own completes-counter rerender, which
      // recomputes the resolver after aria-controls is gone and can mask this.
      await load(
        `family=${family}&native=true&controlled=true&modal=false&quietComplete=true`,
      );
      const native = await measure();
      const nativeOutside = native.active.includes("data-gate-outside");
      const nativeTrigger = native.active.includes("data-gate-trigger");
      assert(
        nativeOutside || nativeTrigger,
        `native Base's own measured contract changed - re-verify this case before trusting the dynamic compare below: ${native.active}`,
      );

      await load(
        `family=${family}&controlled=true&modal=false&quietComplete=true`,
      );
      const wrapper = await measure();

      assert(
        !wrapper.active.startsWith("<body"),
        `a controlled reopen after a real Tab-out must not leave focus on document.body (stale close reason inherited from the prior cycle): ${wrapper.active}`,
      );
      assert.equal(
        wrapper.active.includes("data-gate-outside"),
        nativeOutside,
        `wrapper's reopen-close destination must match native Base's (outside control): native=${nativeOutside} wrapper=${wrapper.active}`,
      );
      assert.equal(
        wrapper.active.includes("data-gate-trigger"),
        nativeTrigger,
        `wrapper's reopen-close destination must match native Base's (trigger): native=${nativeTrigger} wrapper=${wrapper.active}`,
      );
      return { native, wrapper };
    });

  for (const family of ["menu", "select"])
    await test(`${family} R2 parity: a first programmatic open with a connected trigger and a focused external control must preserve native Base's focus ownership`, async () => {
      // Resolver prefers the aria-controls trigger; native prefers the
      // last-focused element on a programmatic open. First open, no R1 overlap.
      async function measure() {
        await evaluate(
          "document.querySelector('[data-gate-outside]').focus();window.gate.openOuter()",
        );
        await wait(
          "programmatic open focuses inside",
          "document.querySelector('[data-gate-popup]')?.contains(document.activeElement)",
        );
        await delay(180);
        await evaluate("window.gate.closeOwner()");
        await delay(300);
        return snapshot();
      }

      await load(
        `family=${family}&native=true&controlled=true&modal=false&quietComplete=true`,
      );
      const native = await measure();
      const nativeOutside = native.active.includes("data-gate-outside");
      assert.equal(
        nativeOutside,
        true,
        `native Base's own measured contract changed - re-verify this case before trusting the dynamic compare below: ${native.active}`,
      );

      await load(
        `family=${family}&controlled=true&modal=false&quietComplete=true`,
      );
      const wrapper = await measure();

      assert.equal(
        wrapper.active.includes("data-gate-outside"),
        nativeOutside,
        `a first programmatic ${family} open must preserve the captured external opener like native Base does, not fall back to the positioning trigger: ${wrapper.active}`,
      );
      return { native, wrapper };
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} R5: Escape restores the connected opener even when a child self-focused in its own mount effect`, async () => {
      // Child effects can focus inside before Base resolves initialFocus;
      // opener capture must already have happened.
      await load(`family=${family}&controlled=true&autofocus=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait(
        "the self-focusing child lands focus inside the popup",
        "document.querySelector('[data-gate-popup]')?.contains(document.activeElement)",
      );
      await delay(180);
      await key("Escape", 0);
      await delay(300);
      const after = await snapshot();
      assert(
        after.active.includes("data-gate-trigger"),
        "a child that self-focused before the deferred initialFocus resolver ran must not leave Escape with no return target",
      );
      return after;
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} R5: a triggerless conditional root still captures the previous opener before a child self-focuses`, async () => {
      // No DialogTrigger/PopoverTrigger exists in conditionalRoot mode, so
      // the aria-controls lookup can never find a trigger - the capture must
      // fall back to "the previously active element", and must do so BEFORE
      // the child's mount-effect self-focus moves it.
      await load(`family=${family}&conditionalRoot=true&autofocus=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await wait(
        "the self-focusing child lands focus inside the popup",
        "document.querySelector('[data-gate-popup]')?.contains(document.activeElement)",
      );
      await delay(180);
      await evaluate("window.gate.closeOwner()");
      await wait(
        "the Root actually unmounts",
        "!document.querySelector('[data-gate-popup]')",
      );
      await delay(300);
      const after = await snapshot();
      assert(
        after.active.includes("data-gate-trigger"),
        "a triggerless conditional root's previous-opener capture must survive a child self-focusing before the deferred resolver runs",
      );
      return after;
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} controlled a rapid open→close interrupts the enter before it ever completes, settles closed with no stale completion`, async () => {
      await load(`family=${family}&controlled=true`);
      const before = await snapshot();
      assert.equal(before.state.changes, "0");
      assert.equal(before.state.completes, "0");

      await evaluate("window.gate.rapidOpenClose()");
      await delay(500);
      const after = await snapshot();
      assert.equal(after.popupPresented, false);
      assert(
        !after.events.includes("complete:true"),
        "an interrupted enter must not leave a stale open-completion behind",
      );
      return { before, after };
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} initialFocus re-fires on a presentation-loss return, Activity-conceal doubly so`, async () => {
      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      const opened = await snapshot();
      assert.equal(opened.state.initials, "1");

      // Measured: `focusPane`/`visiblePane` loss-and-return is an ordinary
      // Base open/close toggle on the same mounted Popup, so `initialFocus`
      // re-fires once per return. `conceal` goes through Activity instead,
      // which detaches+re-runs the whole subtree's effects (including
      // FloatingFocusManager's setup) on the way back, firing it TWICE.
      // `finals` never moves either way (D13). This Activity+2/ordinary+1
      // asymmetry is already asserted by T02, not a new finding.
      //
      // `conceal`'s boolean is CONCEALED (true=hide), while `focusPane`/
      // `visiblePane`'s boolean is PRESENTED (true=show) - opposite
      // polarity, so each pair below is [hide-call, show-call] in its own
      // control's own terms.
      const roundTrips = {
        conceal: { calls: ["true", "false"], initialsPerReturn: 2 },
        focusPane: { calls: ["false", "true"], initialsPerReturn: 1 },
        visiblePane: { calls: ["false", "true"], initialsPerReturn: 1 },
      };
      let expectedInitials = 1;
      for (const [
        control,
        {
          calls: [hide, show],
          initialsPerReturn,
        },
      ] of Object.entries(roundTrips)) {
        await evaluate(`window.gate.${control}(${hide})`);
        await delay(250);
        await evaluate(`window.gate.${control}(${show})`);
        await delay(250);
        expectedInitials += initialsPerReturn;
        const after = await snapshot();
        assert.equal(
          after.state.initials,
          String(expectedInitials),
          `initialFocus after ${control} return`,
        );
        assert.equal(after.state.finals, "0");
      }
      return { opened };
    });

  for (const family of ["dialog", "popover"])
    await test(`${family} nested overlay (through useOverlayFrame) retains its own open state and content across the owner's concealment cycle`, async () => {
      await load(`family=${family}&controlled=true&nested=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      await clickSelector("[data-gate-nested-trigger]", "left", true);
      await wait(
        "nested opens",
        "window.gatePresented('[data-gate-subpopup]')",
      );
      await delay(180);
      await evaluate(
        `document.querySelector('[data-gate-nested-draft]').focus();document.querySelector('[data-gate-nested-draft]').select()`,
      );
      await client.send("Input.insertText", { text: "nested typed" });
      const before = await snapshot();
      assert.equal(before.nestedDraft, "nested typed");

      await evaluate("window.gate.conceal(true)");
      await delay(250);
      const concealed = await snapshot();
      assert.equal(
        await evaluate("window.gatePresented('[data-gate-subpopup]')"),
        false,
      );

      await evaluate("window.gate.conceal(false)");
      await delay(250);
      const returned = await snapshot();
      assert.equal(
        await evaluate("window.gatePresented('[data-gate-subpopup]')"),
        true,
        "the nested overlay must still be open after the owner's concealment round-trip",
      );
      assert.equal(returned.nestedDraft, "nested typed");
      return { before, concealed, returned };
    });

  // Menu/Select native-vs-wrapper lifecycle parity - D13 makes both genuinely
  // close on presentation loss (unlike Dialog/Popover's Activity-hide), and
  // neither Popup supports `initialFocus`, so these are a distinct battery
  // from the Dialog/Popover cases above rather than a reuse of them. No
  // `finalFocus` is passed on the wrapper side for any of these (see the
  // fixture's own comment on `usesDefaultTarget`) - each case measures the
  // DEFAULT policy, same as production call sites actually use.

  // Every case below measures native Base's OWN behavior first (no wrapper,
  // no finalFocus) in the SAME run, then compares production against that
  // measured destination - never an assumed one. Source reasoning about
  // `finalAllowed()` is not evidence a test can fail; only a live measured
  // comparison is.
  for (const family of ["menu", "select", "context"])
    await test(`${family} Escape parity: an ordinary close lands focus exactly where native Base does`, async () => {
      await load(`family=${family}&native=true`);
      if (family === "context") {
        // A real right-click on a non-focusable trigger span does not
        // itself focus anything - establish real focus on B first, same as
        // the primitive gate's own positive control.
        await clickSelector("[data-gate-outside]", "left", true);
        await clickSelector("[data-gate-trigger]", "right", true);
      } else {
        await clickSelector("[data-gate-trigger]", "left", true);
      }
      await wait(
        "native popup opens",
        "window.gatePresented('[data-gate-popup]')",
      );
      await delay(180);
      await key("Escape", 0);
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "native popup closes and becomes unreachable",
      );
      await delay(250);
      // Read the destination BEFORE assertClosed: its real Tab-press proof
      // deliberately moves focus and does not restore it.
      const nativeIsTrigger = await evaluate(
        "document.activeElement?.matches('[data-gate-trigger]') ?? false",
      );
      const nativeIsOutside = await evaluate(
        "document.activeElement?.matches('[data-gate-outside]') ?? false",
      );
      const nativeIsBody = await evaluate(
        "document.activeElement === document.body",
      );
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family} native: closed popup must be unreachable (not presented, hidden ancestor, unfocusable, no id collisions)`,
      );

      await load(`family=${family}&controlled=true`);
      if (family === "context") {
        await clickSelector("[data-gate-outside]", "left", true);
        await clickSelector("[data-gate-trigger]", "right", true);
      } else {
        await clickSelector("[data-gate-trigger]", "left", true);
      }
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      await key("Escape", 0);
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "popup closes and becomes unreachable",
      );
      await delay(250);
      const after = await snapshot();
      const afterIsTrigger = after.active.includes("data-gate-trigger");
      const afterIsOutside = after.active.includes("data-gate-outside");
      const afterIsBody = after.active.startsWith("<body");
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family}: closed popup must be unreachable (not presented, hidden ancestor, unfocusable, no id collisions) - Select's own SelectTrigger.js keeps the DOM node mounted after the trigger is focused, so this must not require DOM removal`,
      );
      assert.equal(
        afterIsTrigger,
        nativeIsTrigger,
        `${family}: Escape close must match native Base's own measured destination (native landed on trigger: ${nativeIsTrigger})`,
      );
      assert.equal(
        afterIsOutside,
        nativeIsOutside,
        `${family}: Escape close must match native Base's own measured destination (native landed on outside/B: ${nativeIsOutside})`,
      );
      assert.equal(
        afterIsBody,
        nativeIsBody,
        `${family}: Escape close must match native Base's own measured destination (native landed on body: ${nativeIsBody})`,
      );
      assert.equal(after.state.changes, "2");
      assert.equal(after.state.completes, "2");
      return { nativeIsTrigger, nativeIsOutside, nativeIsBody, after };
    });

  // `primitive-gate.tsx`'s own ContextMenu case wraps a real focusable
  // `<Button>` inside the trigger span (not plain text), so a real
  // right-click CAN land focus on that child button - unlike the plain-text
  // shape above, where a right-click never focuses anything and B has to be
  // established first. Measure this shape too, rather than assuming it
  // behaves like the text shape.
  await test("context Escape parity (button trigger child): an ordinary close lands focus exactly where native Base does", async () => {
    await load("family=context&native=true&contextButton=true");
    await clickSelector("[data-gate-trigger]", "right", true);
    await wait(
      "native popup opens",
      "window.gatePresented('[data-gate-popup]')",
    );
    await delay(180);
    await key("Escape", 0);
    await waitClosed(
      "[data-gate-popup]",
      "[data-gate-trigger]",
      "native popup closes and becomes unreachable",
    );
    await delay(250);
    const nativeIsTrigger = await evaluate(
      "document.activeElement?.matches('[data-gate-trigger]') ?? false",
    );
    const nativeIsChildButton = await evaluate(
      "document.activeElement?.matches('[data-gate-trigger] button') ?? false",
    );
    const nativeIsBody = await evaluate(
      "document.activeElement === document.body",
    );
    await assertClosed(
      "[data-gate-popup]",
      "[data-gate-trigger]",
      "context native (button child): closed popup must be unreachable",
    );

    await load("family=context&controlled=true&contextButton=true");
    await clickSelector("[data-gate-trigger]", "right", true);
    await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
    await delay(180);
    await key("Escape", 0);
    await waitClosed(
      "[data-gate-popup]",
      "[data-gate-trigger]",
      "popup closes and becomes unreachable",
    );
    await delay(250);
    const after = await snapshot();
    const afterIsTrigger = after.active.includes("data-gate-trigger");
    const afterIsChildButton = await evaluate(
      "document.activeElement?.matches('[data-gate-trigger] button') ?? false",
    );
    const afterIsBody = after.active.startsWith("<body");
    await assertClosed(
      "[data-gate-popup]",
      "[data-gate-trigger]",
      "context (button child): closed popup must be unreachable",
    );
    assert.equal(
      afterIsTrigger,
      nativeIsTrigger,
      `context (button child): Escape close must match native Base's own measured destination (native landed on trigger span: ${nativeIsTrigger})`,
    );
    assert.equal(
      afterIsChildButton,
      nativeIsChildButton,
      `context (button child): Escape close must match native Base's own measured destination (native landed on the child button: ${nativeIsChildButton})`,
    );
    assert.equal(
      afterIsBody,
      nativeIsBody,
      `context (button child): Escape close must match native Base's own measured destination (native landed on body: ${nativeIsBody})`,
    );
    return { nativeIsTrigger, nativeIsChildButton, nativeIsBody, after };
  });

  // Shared by the Activity-reopen matrix and the Select value/stale-highlight
  // case below. `method: "keyboard"` on `family: "context"` synthesizes the
  // same contextmenu dispatch T02's own fixture uses, since a real context
  // menu has no keyboard-only open gesture of its own.
  async function openTrigger(family, method) {
    if (method === "pointer")
      await clickSelector(
        "[data-gate-trigger]",
        family === "context" ? "right" : "left",
        true,
      );
    else {
      await evaluate("document.querySelector('[data-gate-trigger]').focus()");
      if (family === "context")
        await evaluate(
          `(()=>{const t=document.querySelector('[data-gate-trigger]');const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,detail:0,button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()`,
        );
      else await key("ArrowDown", 0);
    }
    await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
    await delay(180);
    if (family === "context" && method === "keyboard")
      await key("ArrowDown", 0);
  }
  const activeItem = () =>
    evaluate(
      `({role:document.activeElement.getAttribute('role'),text:document.activeElement.textContent})`,
    );
  const itemClicks = () =>
    evaluate("window.gate.events.filter((e) => e === 'item:click').length");

  // T02's own "reopen after Activity preserves ordinary focus" matrix
  // (16 cases: menu/context x controlled/uncontrolled x keyboard/pointer,
  // doubled for select's committed-value/no-value axis), promoted onto the
  // real production stack via `window.gate.conceal` (the actual
  // `PortalConcealmentBoundary`, not a synthetic Activity stand-in).
  for (const family of ["menu", "context", "select"])
    for (const controlled of [true, false])
      for (const method of ["keyboard", "pointer"])
        for (const value of family === "select" ? ["one", "none"] : ["one"])
          await test(`${family} ${controlled ? "controlled" : "uncontrolled"} ${
            family === "context" && method === "keyboard"
              ? "synthetic contextmenu + keyboard"
              : method
          } reopen after Activity preserves ordinary focus (${value})`, async () => {
            await load(
              `family=${family}&controlled=${controlled}` +
                (family === "select" ? `&value=${value}` : "") +
                (family === "context" && method === "keyboard"
                  ? "&keepOpen=true"
                  : ""),
            );
            await openTrigger(family, method);
            const before = await activeItem();
            let clicksBefore = 0;
            if (family === "context" && method === "keyboard") {
              await key("Enter", 0);
              clicksBefore = await itemClicks();
              assert.equal(clicksBefore, 1);
              // closeOnClick=false (keepOpen) - conceal below must land on
              // a genuinely open popup, not one Enter already closed.
              assert.equal(
                await evaluate("window.gatePresented('[data-gate-popup]')"),
                true,
              );
            }
            await key("ArrowDown", 0);
            await evaluate("window.gate.conceal(true)");
            await evaluate(
              "document.querySelector('[data-gate-outside]').focus()",
            );
            await delay(180);
            // Scoped snapshot: returning from concealment on its own must
            // fire neither a focus nor a blur event.
            await evaluate(
              "window.gate.focusEvents.length = 0; window.gate.blurEvents.length = 0",
            );
            await evaluate("window.gate.conceal(false)");
            await delay(180);
            const returned = await snapshot();
            const blurEventsOnReturn = await evaluate("window.gate.blurEvents");
            assert.equal(returned.popupPresented, false);
            assert.deepEqual(
              returned.focusEvents,
              [],
              "returning from concealment must not itself move focus",
            );
            assert.deepEqual(
              blurEventsOnReturn,
              [],
              "returning from concealment must not itself blur anything",
            );
            await openTrigger(family, method);
            const after = await activeItem();
            assert.deepEqual(after, before);
            if (method === "keyboard")
              assert.equal(
                after.role,
                family === "select" ? "option" : "menuitem",
              );
            if (family === "context" && method === "keyboard") {
              await key("Enter", 0);
              assert.equal(await itemClicks(), clicksBefore + 1);
            }
            return { before, returned, after };
          });

  // T02's own Select-specific case: a REAL second commit (Enter, not just
  // navigation) must survive the round trip, and the reopen's highlight
  // must be that committed value, discarding a later stale (Enter-less)
  // navigation made just before the conceal.
  for (const controlled of [true, false])
    await test(`select ${controlled ? "controlled" : "uncontrolled"} retains a real second commit and discards stale highlight on Activity reopen`, async () => {
      await load(`family=select&controlled=${controlled}`);
      await openTrigger("select", "keyboard");
      const initial = await evaluate(
        "document.querySelector('[data-slot=select-value]').textContent",
      );
      assert.equal(initial, "Option A");

      await key("ArrowDown", 0);
      await key("Enter", 0);
      await wait(
        "committed second value",
        "document.querySelector('[data-slot=select-value]').textContent==='Option B'",
      );
      const committed = await evaluate(
        "document.querySelector('[data-slot=select-value]').textContent",
      );

      await openTrigger("select", "keyboard");
      await key("ArrowUp", 0);
      const stale = await activeItem();
      assert.equal(stale.text, "Option A");

      await evaluate("window.gate.conceal(true)");
      await evaluate("document.querySelector('[data-gate-outside]').focus()");
      await delay(180);
      await evaluate("window.gate.conceal(false)");
      await delay(180);
      assert.equal(
        await evaluate("window.gatePresented('[data-gate-popup]')"),
        false,
        "the popup must not be painted on return, before it is explicitly reopened",
      );
      const returnedTriggerText = await evaluate(
        "document.querySelector('[data-slot=select-value]').textContent",
      );
      assert.equal(
        returnedTriggerText,
        committed,
        "the second committed value must survive the conceal round trip, not the item merely navigated to before it",
      );
      await openTrigger("select", "keyboard");
      const reopened = await activeItem();
      assert.equal(
        reopened.text,
        committed,
        "the reopened highlight must be the COMMITTED (second) value, discarding the stale ArrowUp navigation from before the conceal",
      );
      return { initial, committed, stale, returnedTriggerText, reopened };
    });

  for (const family of ["menu", "select"])
    for (const mode of ["tab", "outside"]) {
      // Both Root default `modal: true` (a backdrop disables outside pointer
      // interaction) - the "tab" mode is unaffected (no pointer press
      // involved), but "outside" needs `modal=false` explicitly on BOTH
      // sides, or the click never reaches [data-gate-outside] on either.
      const modalQuery = mode === "outside" ? "&modal=false" : "";
      await test(`${family} R4 parity (${mode}): a nonmodal dismissal lands focus exactly where native Base does`, async () => {
        await load(`family=${family}&native=true${modalQuery}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait(
          "native popup opens",
          "window.gatePresented('[data-gate-popup]')",
        );
        await delay(180);
        if (mode === "tab") {
          // Focus a known control inside the popup first, so Tab is a
          // genuine Tab-out - Base's roving tabindex means Tab from ANY
          // single item exits the whole composite, not just moves between
          // items, so which item this is does not matter.
          await evaluate("document.querySelector('[data-gate-item]').focus()");
          await key("Tab", 0);
        } else {
          await clickSelector("[data-gate-outside]", "left", true);
        }
        await waitClosed(
          "[data-gate-popup]",
          "[data-gate-trigger]",
          `native ${mode} popup closes and becomes unreachable`,
        );
        await delay(300);
        const nativeIsOutside = await evaluate(
          "document.activeElement?.matches('[data-gate-outside]') ?? false",
        );
        const nativeIsBody = await evaluate(
          "document.activeElement === document.body",
        );
        await assertClosed(
          "[data-gate-popup]",
          "[data-gate-trigger]",
          `${family}/${mode} native: closed popup must be unreachable`,
        );

        await load(`family=${family}&controlled=true${modalQuery}`);
        await clickSelector("[data-gate-trigger]", "left", true);
        await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
        await delay(180);
        if (mode === "tab")
          await evaluate("document.querySelector('[data-gate-item]').focus()");
        await evaluate("window.gate.focusEvents.length = 0");
        if (mode === "tab") await key("Tab", 0);
        else await clickSelector("[data-gate-outside]", "left", true);
        await waitClosed(
          "[data-gate-popup]",
          "[data-gate-trigger]",
          `${mode} popup closes and becomes unreachable`,
        );
        await delay(300);
        const after = await snapshot();
        const afterIsOutside = after.active.includes("data-gate-outside");
        const afterIsBody = after.active.startsWith("<body");
        await assertClosed(
          "[data-gate-popup]",
          "[data-gate-trigger]",
          `${family}/${mode}: closed popup must be unreachable`,
        );
        assert.equal(
          afterIsOutside,
          nativeIsOutside,
          `${family}/${mode}: must match native Base's own measured destination (native landed on outside: ${nativeIsOutside})`,
        );
        assert.equal(
          afterIsBody,
          nativeIsBody,
          `${family}/${mode}: must match native Base's own measured destination (native landed on body: ${nativeIsBody})`,
        );
        if (mode === "outside")
          // A real focusable-button click always focuses it via the
          // browser's own default mousedown-focus - the non-vacuous floor a
          // forced-broken restore-to-trigger regression fails, independent
          // of the native comparison above.
          assert.deepEqual(
            after.focusEvents.filter((event) => event !== "G"),
            ["B"],
          );
        return { nativeIsOutside, nativeIsBody, after };
      });
    }

  for (const family of ["menu", "select"])
    await test(`${family} default-modal outside press: a backdrop intercepts the press and still dismisses, matching native Base`, async () => {
      // Root's own default (`modal: true`, no override) - the outside
      // button is expected to be BEHIND the backdrop here, so this
      // deliberately does not use `clickSelector`'s hit-test: a blocked hit
      // target is the correct, expected outcome for this configuration, not
      // a failure to assert against. Native runs `controlled=true` too - the
      // SAME owner shape production uses (`onOpenChange`/
      // `onOpenChangeComplete` wired to `window.gate.events` as
      // `native-change:`/`native-complete:` markers) - so its own measured
      // change/complete counts are a fair baseline instead of a guessed "2".
      await load(`family=${family}&native=true&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait(
        "native popup opens",
        "window.gatePresented('[data-gate-popup]')",
      );
      await delay(180);
      const nativeOutside = await center("[data-gate-outside]");
      await clickAt(nativeOutside.x, nativeOutside.y, "left");
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "native popup closes on the backdrop-intercepted press",
      );
      await delay(300);
      const nativeIsTrigger = await evaluate(
        "document.activeElement?.matches('[data-gate-trigger]') ?? false",
      );
      const nativeEvents = await evaluate("window.gate.events");
      const nativeChanges = nativeEvents.filter((event) =>
        event.startsWith("native-change:"),
      ).length;
      const nativeCloseCompletes = nativeEvents.filter(
        (event) => event === "native-complete:false",
      ).length;
      const nativeCompletes = nativeEvents.filter((event) =>
        event.startsWith("native-complete:"),
      ).length;
      // Sanity floor on the measurement itself, independent of production:
      // native must show at least one open and one close change, and exactly
      // one close completion - a broken/no-op measurement (e.g. all zero)
      // would otherwise make ANY production count "match".
      assert(
        nativeEvents.some((event) => event.startsWith("native-change:true:")),
        `${family} native: expected at least one open change, saw ${JSON.stringify(nativeEvents)}`,
      );
      assert(
        nativeEvents.some((event) => event.startsWith("native-change:false:")),
        `${family} native: expected at least one close change, saw ${JSON.stringify(nativeEvents)}`,
      );
      assert.equal(
        nativeCloseCompletes,
        1,
        `${family} native: expected exactly one close completion, saw ${JSON.stringify(nativeEvents)}`,
      );
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family} native: closed popup must be unreachable after a backdrop-intercepted press`,
      );

      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      const outside = await center("[data-gate-outside]");
      await clickAt(outside.x, outside.y, "left");
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "popup closes on the backdrop-intercepted press",
      );
      await delay(300);
      const after = await snapshot();
      const afterIsTrigger = after.active.includes("data-gate-trigger");
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family}: closed popup must be unreachable after a backdrop-intercepted press`,
      );
      const closeCompletes = after.events.filter(
        (event) => event === "complete:false",
      ).length;
      // Same positive floor on production's own measurement, then the real
      // comparison: production's counts against native's MEASURED counts,
      // not a hardcoded "2". A genuine divergence (e.g. an extra
      // "cancel-open" change production fires that native's controlled path
      // does not) must fail here, not be masked.
      assert(
        after.events.some((event) => event.startsWith("change:true:")),
        `${family}: expected at least one open change, saw ${JSON.stringify(after.events)}`,
      );
      assert(
        after.events.some((event) => event.startsWith("change:false:")),
        `${family}: expected at least one close change, saw ${JSON.stringify(after.events)}`,
      );
      assert.equal(
        closeCompletes,
        1,
        `${family}: expected exactly one close completion, saw ${JSON.stringify(after.events)}`,
      );
      assert.equal(
        after.state.changes,
        String(nativeChanges),
        `${family}: the default-modal backdrop press change count (${after.state.changes}) must match native Base's measured count (${nativeChanges}); production events: ${JSON.stringify(after.events)}`,
      );
      assert.equal(
        after.state.completes,
        String(nativeCompletes),
        `${family}: the default-modal backdrop press complete count (${after.state.completes}) must match native Base's measured count (${nativeCompletes}); production events: ${JSON.stringify(after.events)}`,
      );
      assert.equal(
        afterIsTrigger,
        nativeIsTrigger,
        `${family}: a default-modal backdrop press must land focus exactly where native Base does (native landed on trigger: ${nativeIsTrigger})`,
      );
      return { nativeIsTrigger, nativeChanges, nativeCompletes, after };
    });

  for (const family of ["menu", "select"])
    await test(`${family} item click parity: selecting an item fires its handler and lands focus exactly where native Base does`, async () => {
      await load(`family=${family}&native=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait(
        "native popup opens",
        "window.gatePresented('[data-gate-popup]')",
      );
      await delay(180);
      await evaluate("window.gate.events.length = 0");
      await clickSelector("[data-gate-item]", "left", true);
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "native popup closes and becomes unreachable on item selection",
      );
      await delay(250);
      const nativeClicks = await evaluate(
        "window.gate.events.filter((e) => e === 'item:click').length",
      );
      const nativeIsTrigger = await evaluate(
        "document.activeElement?.matches('[data-gate-trigger]') ?? false",
      );
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family} native: closed popup must be unreachable after item selection`,
      );

      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      await evaluate("window.gate.events.length = 0");
      await clickSelector("[data-gate-item]", "left", true);
      await waitClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        "popup closes and becomes unreachable on item selection",
      );
      await delay(250);
      const after = await snapshot();
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family}: closed popup must be unreachable after item selection`,
      );
      const productionClicks = after.events.filter(
        (event) => event === "item:click",
      ).length;
      assert.equal(
        nativeClicks,
        1,
        "native Base's own item click handler must fire exactly once - if this isn't 1, the comparison below is meaningless",
      );
      assert.equal(
        productionClicks,
        nativeClicks,
        "the item's own click handler must fire the same number of times as native Base",
      );
      const afterIsTrigger = after.active.includes("data-gate-trigger");
      assert.equal(
        afterIsTrigger,
        nativeIsTrigger,
        `${family}: selecting an item must land focus exactly where native Base does (native landed on trigger: ${nativeIsTrigger})`,
      );
      assert.equal(after.state.changes, "2");
      assert.equal(after.state.completes, "2");
      return { nativeClicks, nativeIsTrigger, after };
    });

  await test("menu hover-submenu-close parity: moving off the subtrigger closes only the submenu and lands focus exactly where native Base does", async () => {
    await load("family=menu&native=true");
    await clickSelector("[data-gate-trigger]", "left", true);
    await wait(
      "native popup opens",
      "window.gatePresented('[data-gate-popup]')",
    );
    await delay(180);
    const nativeSub = await center("[data-gate-subtrigger]");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nativeSub.x,
      y: nativeSub.y,
    });
    await wait(
      "native submenu opens on hover",
      "window.gatePresented('[data-gate-subpopup]')",
    );
    await delay(180);
    const nativeItem = await center("[data-gate-item]");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nativeItem.x,
      y: nativeItem.y,
    });
    await waitClosed(
      "[data-gate-subpopup]",
      "[data-gate-subtrigger]",
      "native submenu closes and becomes unreachable on hover-away",
    );
    await delay(300);
    const nativeParentOpen = await evaluate(
      "!!document.querySelector('[data-gate-popup]')",
    );
    const nativeFocusInItem = await evaluate(
      "document.activeElement?.matches('[data-gate-item]') ?? false",
    );
    const nativeFocusInSubtrigger = await evaluate(
      "document.activeElement?.matches('[data-gate-subtrigger]') ?? false",
    );
    await assertClosed(
      "[data-gate-subpopup]",
      "[data-gate-subtrigger]",
      "native: closed submenu must be unreachable",
    );

    await load("family=menu&controlled=true");
    await clickSelector("[data-gate-trigger]", "left", true);
    await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
    await delay(180);
    const subtrigger = await center("[data-gate-subtrigger]");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: subtrigger.x,
      y: subtrigger.y,
    });
    await wait(
      "submenu opens on hover",
      "window.gatePresented('[data-gate-subpopup]')",
    );
    await delay(180);
    const item = await center("[data-gate-item]");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: item.x,
      y: item.y,
    });
    await waitClosed(
      "[data-gate-subpopup]",
      "[data-gate-subtrigger]",
      "submenu closes and becomes unreachable on hover-away",
    );
    await delay(300);
    const parentOpen = await evaluate(
      "!!document.querySelector('[data-gate-popup]')",
    );
    const focusInItem = await evaluate(
      "document.activeElement?.matches('[data-gate-item]') ?? false",
    );
    const focusInSubtrigger = await evaluate(
      "document.activeElement?.matches('[data-gate-subtrigger]') ?? false",
    );
    await assertClosed(
      "[data-gate-subpopup]",
      "[data-gate-subtrigger]",
      "closed submenu must be unreachable",
    );
    assert(
      nativeParentOpen,
      "the parent must actually still be open in native Base for this comparison to mean anything",
    );
    assert.equal(
      parentOpen,
      nativeParentOpen,
      "hovering off the subtrigger must match native Base on whether the parent menu stays open",
    );
    assert.equal(
      focusInItem,
      nativeFocusInItem,
      `hovering off the subtrigger must land focus exactly where native Base does (native on the hovered item: ${nativeFocusInItem})`,
    );
    assert.equal(
      focusInSubtrigger,
      nativeFocusInSubtrigger,
      `hovering off the subtrigger must land focus exactly where native Base does (native on the subtrigger: ${nativeFocusInSubtrigger})`,
    );
    return {
      nativeParentOpen,
      nativeFocusInItem,
      nativeFocusInSubtrigger,
      parentOpen,
      focusInItem,
      focusInSubtrigger,
    };
  });

  for (const family of ["menu", "select"])
    await test(`${family} R1: a genuine pane transfer during Escape close must not be stolen back by the queued final-focus restore`, async () => {
      await load(`family=${family}&controlled=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      await evaluate("window.gate.focusEvents.length = 0");
      // `childList` alone never fires for Select: SelectPositioner.js keeps
      // the popup mounted (hidden via the `hidden` attribute, not removal)
      // once the trigger has been focused, so the DOM never actually loses this
      // node - `attributes: true` plus a real presentation/mounted-state
      // predicate (not `!document.querySelector(...)`) is what actually
      // observes the ending transition for every family. Uses
      // `gateClosedPure`, NOT `gateUnreachable` - the latter's focus-attempt
      // probe would itself move focus mid-race and contaminate the exact
      // thing this test is trying to observe neutrally; unreachability is
      // proven separately, after the race, below.
      await evaluate(`
        window.__gateRaceFired = false;
        window.__gateRace = new MutationObserver(() => {
          if (window.gateClosedPure('[data-gate-popup]')) {
            window.__gateRace.disconnect();
            window.__gateRaceFired = true;
            window.gate.focusPane(false);
          }
        });
        window.__gateRace.observe(document.body, { childList: true, subtree: true, attributes: true });
      `);
      await key("Escape", 0);
      await delay(300);
      // The race is only meaningful if the hook actually fired - otherwise
      // this test proves nothing at all, regardless of what focusEvents
      // happens to read.
      assert(
        await evaluate("window.__gateRaceFired === true"),
        `${family}: the race hook itself never fired - this test proves nothing without it`,
      );
      const after = await snapshot();
      assert.deepEqual(
        after.focusEvents,
        ["B"],
        `${family}: a stale queued restore reactivated the unfocused pane after B already took focus`,
      );
      assert(after.active.includes("data-gate-outside"));
      // Unreachability proven separately, now that the race itself is over
      // and this can no longer disturb it.
      await assertClosed(
        "[data-gate-popup]",
        "[data-gate-trigger]",
        `${family}: closed popup must be unreachable after the race`,
      );
      return after;
    });

  for (const family of ["menu", "select"])
    await test(`${family} R5: Escape restores the connected opener even when a child self-focused in its own mount effect`, async () => {
      await load(`family=${family}&controlled=true&autofocus=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait(
        "the self-focusing child lands focus inside the popup",
        "document.querySelector('[data-gate-popup]')?.contains(document.activeElement)",
      );
      await delay(180);
      await key("Escape", 0);
      await delay(300);
      const after = await snapshot();
      assert(
        after.active.includes("data-gate-trigger"),
        `${family}: a child that self-focused before Base's own setup ran must not leave Escape with no return target`,
      );
      return after;
    });

  for (const family of ["menu", "select"])
    await test(`${family} R2: a genuine owner-subtree unmount while the popup owns focus still restores the external return target`, async () => {
      // Neither wrapper's Positioner exposes an `anchor` prop, so this
      // family's conditionalRoot keeps a real Trigger inside the Root and
      // points `finalFocus` at a persistent button OUTSIDE it instead -
      // `closeOwner()` unmounts Trigger+Content together, proving the
      // root-unmount adapter path without needing a Positioner anchor.
      await load(`family=${family}&conditionalRoot=true`);
      await clickSelector("[data-gate-trigger]", "left", true);
      await wait("popup opens", "window.gatePresented('[data-gate-popup]')");
      await delay(180);
      assert(
        await evaluate(
          "document.querySelector('[data-gate-popup]').contains(document.activeElement)",
        ),
        `${family}: the popup must actually own focus before the unmount race is meaningful`,
      );
      await evaluate("window.gate.closeOwner()");
      await wait(
        "the whole subtree actually unmounts, not just closes",
        "!document.querySelector('[data-gate-trigger]')",
      );
      await delay(300);
      assert(
        await evaluate(
          "document.activeElement?.matches('[data-gate-return]') ?? false",
        ),
        `${family}: focus must return to the persistent external target when the whole Root+Trigger unmounts while the popup owned focus`,
      );
      return snapshot();
    });

  assert(
    report.cases.every((c) => c.pass),
    report.cases
      .filter((c) => !c.pass)
      .map((c) => c.name)
      .join("\n"),
  );
} finally {
  const reportPath =
    process.env.GATE_OUT ??
    path.join(
      await mkdtemp(path.join(tmpdir(), "portal-lifecycle-gate-")),
      "result.json",
    );
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  client?.close();
  await terminateProcessTree(chrome.chrome);
  await rm(chrome.profilePath, { recursive: true, force: true });
  await server.close();
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
// Waits for the popup to reach its final closed boundary using
// `window.gateClosedPure` (a `hidden` ancestor, or removed from the DOM
// entirely) - NEVER `gateUnreachable`, whose focus-attempt probe would
// otherwise fire on every 20ms poll tick WHILE the exit is still painted,
// repeatedly focusing/restoring and contaminating `focusEvents` with
// spurious noise that has nothing to do with the real interaction under
// test. `gateUnreachable`'s full check (including that probe) runs exactly
// once in `assertClosed`, only after this has already confirmed the pure
// boundary is reached.
async function waitClosed(popupSelector, triggerSelector, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exceptions.length) throw new Error(exceptions.join("\n"));
    if (
      await evaluate(`window.gateClosedPure(${JSON.stringify(popupSelector)})`)
    )
      return;
    await delay(20);
  }
  const detail = await evaluate(
    `JSON.stringify(window.gateUnreachable(${JSON.stringify(popupSelector)}, ${JSON.stringify(triggerSelector)}))`,
  );
  throw new Error(`Timed out: ${label}; gateUnreachable=${detail}`);
}
// Callers must read any focus destination they care about BEFORE calling
// this - the real Tab press below deliberately moves focus, and it is not
// restored, since the whole point is to genuinely traverse away.
async function assertClosed(popupSelector, triggerSelector, label) {
  const detail = await evaluate(
    `window.gateUnreachable(${JSON.stringify(popupSelector)}, ${JSON.stringify(triggerSelector)})`,
  );
  assert(detail.closed, `${label}: ${JSON.stringify(detail)}`);
  const stillExists = await evaluate(
    `!!document.querySelector(${JSON.stringify(popupSelector)})`,
  );
  if (!stillExists) return;
  // Real proof, not inferred from `hidden`/a11y state alone: a genuine
  // hit-test at the retained popup's own rect, and a genuine dispatched Tab
  // press, neither of which reaches it.
  const rect = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(popupSelector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`,
  );
  if (rect.w > 0 && rect.h > 0) {
    const hitInside = await evaluate(
      `document.querySelector(${JSON.stringify(popupSelector)}).contains(document.elementFromPoint(${rect.x}, ${rect.y}))`,
    );
    assert(
      !hitInside,
      `${label}: a real hit-test at the retained popup's own rect must not resolve inside it`,
    );
  }
  await key("Tab", 0);
  const landedInside = await evaluate(
    `document.querySelector(${JSON.stringify(popupSelector)})?.contains(document.activeElement) ?? false`,
  );
  assert(
    !landedInside,
    `${label}: a real Tab press must never land focus inside the closed/retained popup`,
  );
}
async function center(selector) {
  return evaluate(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Not presented '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
}
async function clickSelector(selector, button, hitTest) {
  const p = await center(selector);
  if (hitTest)
    assert(
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${p.x},${p.y}))`,
      ),
      `Hit target blocked: ${selector}`,
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
async function key(key, modifiers) {
  const codes = { Escape: 27 };
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: "",
    key,
    code: key,
    windowsVirtualKeyCode: codes[key],
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: key,
    windowsVirtualKeyCode: codes[key],
    modifiers,
  });
}
