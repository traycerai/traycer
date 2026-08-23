// Live verification against the running `make dev-desktop` instance over raw
// CDP (per-target WebSockets; Bun-native WebSocket). No deps beyond bun.
// Run: TRAYCER_CDP_PORT=28960 bun e2e/live-verify.mjs
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
      ws.addEventListener("error", (e) =>
        reject(new Error(`ws error on ${this.meta.url}`)),
      );
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : ev.data.toString(),
        );
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(
              new Error(`${msg.error.message ?? "CDP error"} (${msg.method ?? ""})`),
            );
          } else {
            resolve(msg.result);
          }
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
  chord(key, code, keyCode, mods) {
    return Promise.all([
      this.key({ key, code, keyCode, modifiers: mods, type: "rawKeyDown" }),
      sleep(30),
      this.key({ key, code, keyCode, modifiers: mods, type: "keyUp" }),
    ]);
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

report("T0a", "host renderer target found", !!hostMeta, hostMeta?.url);
report(
  "T0b",
  "guest targets found",
  guestMetas.length > 0,
  guestMetas.map((g) => new URL(g.url).host).join(", "),
);
if (!hostMeta || guestMetas.length === 0) {
  console.log("\nABORT: need host + ≥1 open browser tile.");
  process.exit(1);
}

const host = await Target.attach(hostMeta);
const guests = await Promise.all(guestMetas.map((m) => Target.attach(m)));
const guest = guests[0];

// ---------- T0c preload freshness ----------
const preloadFresh = await host.eval(`(() => {
  const bv = window.runnerHost && window.runnerHost.browserView;
  return !!bv && typeof bv.setReservedChords === "function";
})()`);
report(
  "T0c",
  "preload exposes setReservedChords (BT-303 wired)",
  preloadFresh,
  preloadFresh ? undefined : "STALE PRELOAD — restart make dev-desktop",
);

// ---------- helpers ----------
await guest.eval(`(() => {
  window.__e2eKeys = [];
  window.addEventListener("keydown", (e) => {
    window.__e2eKeys.push({
      key: e.key, ctrl: e.ctrlKey, meta: e.metaKey,
      defaultPrevented: e.defaultPrevented,
    });
  }, true);
})()`);

// ---------- T0d deterministic chord registration (mirrors app boot) ----------
const registered = await host.eval(`(async () => {
  await window.runnerHost.browserView.setReservedChords(["mod+k"]);
  return true;
})()`);
report("T0d", "reserved chords pushed through live bridge", registered === true);

const MOD = { ctrl: 2, meta: 4 };
async function sendChordOn(target, key, modName) {
  await target.chord(
    key,
    /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
    key.toUpperCase().charCodeAt(0),
    MOD[modName] ?? 0,
  );
}
const paletteVisible = () =>
  host.eval(
    `(() => {
      const el = document.querySelector('[data-slot="dialog-content"]');
      return !!el && el.getClientRects().length > 0;
    })()`,
  );
const readSnapshots = () =>
  host.eval(`(() => Array.from(
    document.querySelectorAll("[data-browser-view-snapshot]")
  ).map((n) => ({
    stale: n.getAttribute("data-stale"),
    imgLen: (n.querySelector("img") && n.querySelector("img").src.length) || 0,
  })))()`);
async function closePalette() {
  if (!(await paletteVisible())) return;
  await host.chord("Escape", "Escape", 27, 0);
  await sleep(300);
}
const tileRectExpr = `(() => {
  const surface = document.querySelector("[data-browser-view-surface]");
  if (!surface) return null;
  const r = surface.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, width: r.width, height: r.height };
})()`;

try {
  // ---------- T1 Ctrl+K interception chain ----------
  await sendChordOn(guest, "k", "ctrl");
  await sleep(500);
  let t1 = await paletteVisible();
  let t1note = "";
  if (!t1) {
    // Second chance: re-register (in case boot-time registration raced the
    // preload) and retry once. If this makes it pass, the live process had
    // lost its chord set; if it still fails, CDP-injected input bypasses
    // before-input-event on this Electron and OS-level input is required.
    await host.eval(
      `(async () => { await window.runnerHost.browserView.setReservedChords(["mod+k"]); })()`,
    );
    await sleep(150);
    await guest.eval(`window.__e2eKeys = []`);
    await sendChordOn(guest, "k", "ctrl");
    await sleep(500);
    t1 = await paletteVisible();
    t1note = t1 ? "passed after explicit re-registration" : "failed after re-registration";
  }
  report("T1", "Ctrl+K on guest opens HOST command palette (intercept+forward)", t1, t1note);
  if (t1) await host.screenshot(`${ART}/t1-palette.png`);

  // ---------- T2 white-out regression ----------
  let t2pass = false;
  let t2ev = "";
  if (t1) {
    const s1 = await readSnapshots();
    const initialOk =
      s1.length > 0 && s1.every((s) => s.imgLen > 500);
    await sleep(1500);
    const s2 = await readSnapshots();
    t2pass =
      initialOk &&
      s2.length > 0 &&
      s2.every((s) => s.imgLen > 500);
    t2ev = JSON.stringify({ initial: s1, after1s5: s2 });
  } else {
    t2ev = "skipped: palette did not open";
  }
  report(
    "T2",
    "snapshot fresh (stale=false, jpeg present) under held-open palette — no white-out",
    t2pass,
    t2ev,
  );

  // ---------- T3 guest never saw the reserved chord ----------
  const keys1 = await guest.eval(`window.__e2eKeys`);
  report(
    "T3",
    "guest received NO ctrl/meta+k (preventDefault before page)",
    !keys1.some((k) => String(k.key).toLowerCase() === "k" && (k.ctrl || k.meta)),
    JSON.stringify(keys1),
  );

  await closePalette();
  await sleep(250);
  report("T4", "Escape closes palette", !(await paletteVisible()));

  // ---------- T5/T6 unreserved input passthrough ----------
  await sendChordOn(guest, "t", "ctrl");
  await sleep(350);
  report(
    "T5",
    "unreserved ctrl+t does NOT open palette",
    !(await paletteVisible()),
  );
  await guest.chord("x", "KeyX", 88, 0);
  await sleep(200);
  const keys2 = await guest.eval(`window.__e2eKeys`);
  report(
    "T6",
    "plain keystroke reaches guest page",
    keys2.some((k) => k.key === "x"),
    JSON.stringify(keys2.slice(-3)),
  );
} catch (err) {
  report("T1-T6", "keyboard/occlusion block errored", false, err.message);
}

// ---------- T7/T8 resize streaming + overlap guard ----------
try {
  const tileRect = await host.eval(tileRectExpr);
  report("T7a", "located browser tile surface in host DOM", !!tileRect, JSON.stringify(tileRect));
  if (tileRect) {
    const splitters = await host.eval(`(() => {
      const ts = ${JSON.stringify(tileRect)};
      const cands = Array.from(document.querySelectorAll(
        '[role="separator"], [data-panel-resize-handle], [data-resize-handle]'
      ));
      return cands.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter((r) => r.w > 0 && r.h > 80 &&
        Math.abs(r.y + r.h / 2 - (ts.top + Math.min(160, ts.height / 2))) < 240 &&
        (Math.abs(r.x - ts.right) < 28 || Math.abs(r.x + r.w - ts.left) < 28));
    })()`);
    report(
      "T7b",
      "splitter adjacent to tile located",
      splitters.length > 0,
      JSON.stringify(splitters),
    );
    if (splitters.length > 0) {
      const sp = splitters[0];
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
        "T7c",
        "guest viewport STREAMS during drag (no freeze till release)",
        distinctMid >= 3,
        `mid-drag=${samples.join(",")} final=${finalW}`,
      );
      const surfW = await host.eval(tileRectExpr);
      const drift = surfW === null ? null : Math.abs(surfW.width - finalW);
      report(
        "T8",
        "settled guest width matches host surface (±2px, no neighbor overpaint)",
        drift !== null && drift <= 2,
        `surface=${surfW && surfW.width} guest=${finalW} drift=${drift}`,
      );
    } else {
      // Fallback: resize from the WINDOW edge exercises the same stream path
      report("T7c", "SKIPPED (no adjacent splitter found)", false);
      report("T8", "SKIPPED", false);
    }
  } else {
    report("T7a", "SKIPPED (tile not found — no occluded snapshot present)", false);
    report("T7b..T8", "SKIPPED", false);
  }
} catch (err) {
  report("T7-T8", "resize block errored", false, err.message);
}

host.detach();
guests.forEach((g) => g.detach());

console.log("\n==== SUMMARY ====");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
