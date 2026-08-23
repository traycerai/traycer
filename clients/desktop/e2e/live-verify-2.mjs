// Live verification phase 2: occlusion via real in-tile overlay (viewport
// preset menu), zoom discriminator for before-input-event, and resize drag
// using the REAL handle selector. Run like live-verify.mjs.
import fs from "node:fs";

const CDP_PORT = process.env.TRAYCER_CDP_PORT ?? "28960";
const ART = "/tmp/opencode/e2e-artifacts";
fs.mkdirSync(ART, { recursive: true });

const results = [];
function report(id, name, pass, evidence) {
  results.push({ id, name, pass: !!pass });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${id}  ${name}${evidence ? `\n      ↳ ${String(evidence).slice(0, 400)}` : ""}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Target {
  static async attach(meta) {
    const t = new Target(meta);
    await t.#connect();
    return t;
  }
  constructor(meta) {
    this.meta = meta;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  #connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.meta.webSocketDebuggerUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve(this));
      ws.addEventListener("error", () =>
        reject(new Error(`ws error on ${this.meta.url}`)),
      );
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : ev.data.toString(),
        );
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message ?? "CDP error"));
          else resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "evaluate failed",
      );
    }
    return res.result?.value;
  }
  key({ key, code, keyCode, modifiers = 0, type }) {
    return this.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }
  async chord(key, code, keyCode, mods) {
    await this.key({ key, code, keyCode, modifiers: mods, type: "rawKeyDown" });
    await sleep(30);
    await this.key({ key, code, keyCode, modifiers: mods, type: "keyUp" });
  }
  mouse(type, x, y, extra = {}) {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      ...extra,
    });
  }
  async screenshot(path) {
    await this.send("Page.enable");
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
  }
  detach() {
    try {
      this.ws.close();
    } catch {}
  }
}

const list = await (
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
).json();
const pageMetas = list.filter(
  (t) =>
    t.type === "page" &&
    (/^https?:/.test(t.url) || t.url.startsWith("app://renderer")),
);
const hostMeta = pageMetas.find((t) => t.url.startsWith("app://renderer") || /localhost:\d+/.test(t.url));
const guestMetas = pageMetas.filter((t) => t !== hostMeta);
if (!hostMeta || guestMetas.length === 0) {
  console.log("ABORT: need host + ≥1 guest.");
  process.exit(1);
}
const host = await Target.attach(hostMeta);
const guests = await Promise.all(guestMetas.map((m) => Target.attach(m)));
const guest = guests[0];

const MOD = { ctrl: 2 };

try {
  // ---------- T-K1: does CDP input reach before-input-event at all? ----------
  // The zoom shortcut ALSO lives in before-input-event (zoom step for
  // ctrl/cmd +/-). If devicePixelRatio moves, the event fired; if not, CDP
  // injection bypasses it and T1-style keyboard failures are artifacts of
  // the injection method, not product behavior.
  const dpr0 = await guest.eval(`window.devicePixelRatio`);
  await guest.chord("=", "Equal", 187, MOD.ctrl);
  await sleep(250);
  const dpr1 = await guest.eval(`window.devicePixelRatio`);
  report(
    "T-K1",
    "CDP-injected chord triggers main's before-input-event (zoom moved dpr)",
    dpr1 > dpr0,
    `dpr ${dpr0} -> ${dpr1}`,
  );
  // reset zoom
  await guest.chord("0", "Digit0", 48, MOD.ctrl);
  await sleep(200);
  const dprReset = await guest.eval(`window.devicePixelRatio`);
  console.log(`      ↳ reset dpr=${dprReset}`);
} catch (err) {
  report("T-K1", "zoom discriminator errored", false, err.message);
}

// ---------- surface rect ----------
const surfRect = await host.eval(`(() => {
  const s = document.querySelector("[data-browser-view-surface]");
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, width: r.width, height: r.height };
})()`);
report("T-A0", "tile surface located", !!surfRect, JSON.stringify(surfRect));

try {
  // ---------- T-O0..O3: occlusion under a REAL in-tile overlay ----------
  if (!surfRect) throw new Error("no tile surface");
  const btnRect = await host.eval(`(() => {
    const sr = ${JSON.stringify(surfRect)};
    const buttons = Array.from(document.querySelectorAll(
      '[aria-label="Browser viewport preset"]'
    ));
    const hit = buttons.map((b) => b.getBoundingClientRect()).find((r) =>
      r.width > 0 && r.height > 0 &&
      r.right > sr.left - 40 && r.left < sr.right + 40);
    return hit ? { x: hit.x, y: hit.y, w: hit.width, h: hit.height } : null;
  })()`);
  report("T-O0", "viewport-preset trigger found in tile chrome", !!btnRect, JSON.stringify(btnRect));
  if (btnRect) {
    const cx = btnRect.x + btnRect.w / 2;
    const cy = btnRect.y + btnRect.h / 2;
    await host.mouse("mousePressed", cx, cy);
    await host.mouse("mouseReleased", cx, cy);
    await sleep(400);

    const menuOpen = await host.eval(`(() => {
      const m = document.querySelector('[data-browser-overlay="dropdown-menu"]');
      return !!m && m.getClientRects().length > 0;
    })()`);
    report("T-O1", "dropdown menu opened over tile", menuOpen);

    if (menuOpen) {
      const s1 = await host.eval(`(() => Array.from(
        document.querySelectorAll("[data-browser-view-snapshot]")
      ).map((n) => ({
        stale: n.getAttribute("data-stale"),
        imgLen: (n.querySelector("img") && n.querySelector("img").src.length) || 0,
      })))()`);
      const freshNow =
        s1.length > 0 && s1.every((s) => s.imgLen > 500);
      await sleep(1500);
      const s2 = await host.eval(`(() => Array.from(
        document.querySelectorAll("[data-browser-view-snapshot]")
      ).map((n) => ({
        stale: n.getAttribute("data-stale"),
        imgLen: (n.querySelector("img") && n.querySelector("img").src.length) || 0,
      })))()`);
      const stillFresh =
        s2.length > 0 && s2.every((s) => s.imgLen > 500);
      report(
        "T-O2",
        "occluded snapshot FRESH immediately AND after 1.5s hold (⌘K white-out fix)",
        freshNow && stillFresh,
        JSON.stringify({ initial: s1, held: s2 }),
      );
      await host.screenshot(`${ART}/t-menu-occlusion.png`);

      await host.chord("Escape", "Escape", 27, 0);
      await sleep(350);
      const menuClosed = !(await host.eval(
        `!!document.querySelector('[data-browser-overlay="dropdown-menu"]')`,
      ));
      report("T-O3", "Escape closes menu; snapshot layer released", menuClosed);
    }
  } else {
    report("T-O0", "SKIPPED (trigger button not visible)", false);
  }
} catch (err) {
  report("T-O*", "occlusion block errored", false, err.message);
}

try {
  // ---------- T-R1..R3: resize streaming via REAL handle ----------
  if (!surfRect) throw new Error("no tile surface");
  const handles = await host.eval(`(() => {
    const sr = ${JSON.stringify(surfRect)};
    return Array.from(document.querySelectorAll('[data-testid="split-resize-handle"]'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((r) => r.h > 80 && r.h < window.innerHeight &&
        Math.abs(r.y + r.h / 2 - (sr.top + sr.height / 2)) < 320 &&
        (Math.abs(r.x - sr.right) < 30 || Math.abs(r.x + r.w - sr.left) < 30));
  })()`);
  report("T-R1", "resize handle adjacent to tile located", handles.length > 0, JSON.stringify(handles));
  if (handles.length > 0) {
    const sp = handles[0];
    const cx = sp.x + sp.w / 2;
    const cy = sp.y + Math.min(sp.h / 2, 180);
    const samples = [];
    await host.mouse("mousePressed", cx, cy);
    for (let i = 1; i <= 10; i += 1) {
      await host.mouse("mouseMoved", cx + i * 12, cy);
      samples.push(await guest.eval(`window.innerWidth`));
    }
    await host.mouse("mouseReleased", cx + 120, cy);
    await sleep(300);
    const finalW = await guest.eval(`window.innerWidth`);
    const distinctMid = new Set(samples).size;
    report(
      "T-R2",
      "guest viewport STREAMS during resize drag",
      distinctMid >= 3,
      `mid=${samples.join(",")} final=${finalW}`,
    );
    const surfAfter = await host.eval(`(() => {
      const s = document.querySelector("[data-browser-view-surface]");
      return s ? s.getBoundingClientRect().width : null;
    })()`);
    const drift = surfAfter === null ? null : Math.abs(surfAfter - finalW);
    report(
      "T-R3",
      "settled guest width matches surface (±2px)",
      drift !== null && drift <= 2,
      `surface=${surfAfter} guest=${finalW} drift=${drift}`,
    );
    await host.screenshot(`${ART}/t-after-resize.png`);
  }
} catch (err) {
  report("T-R*", "resize block errored", false, err.message);
}

host.detach();
guests.forEach((g) => g.detach());

console.log("\n==== SUMMARY ====");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
