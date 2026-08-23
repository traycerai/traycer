// Live phase 3: resize streaming via WINDOW bounds (fallback when the canvas
// is single-pane with no splitter handles). Drives Browser.setWindowBounds in
// steps while sampling the guest viewport, then checks settle drift.
import fs from "node:fs";

const CDP_PORT = process.env.TRAYCER_CDP_PORT ?? "28961";
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
      ws.addEventListener("error", () => reject(new Error("ws error")));
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
    });
    if (res.exceptionDetails)
      throw new Error(res.exceptionDetails.text ?? "evaluate failed");
    return res.result?.value;
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
const hostMeta = list.find(
  (t) =>
    t.type === "page" &&
    (t.url.startsWith("app://renderer") || /localhost:\d+/.test(t.url)),
);
const guestMeta = list.find(
  (t) => t.type === "page" && /^https?:\/\//.test(t.url) && t !== hostMeta,
);
if (!hostMeta || !guestMeta) {
  console.log("ABORT: need host + guest");
  process.exit(1);
}
const host = await Target.attach(hostMeta);
const guest = await Target.attach(guestMeta);

// A usable splitter must sit ON the browser surface boundary; sidebar
// handles don't move the guest.
const adjacentHandle = await host.eval(`(() => {
  const s = document.querySelector("[data-browser-view-surface]");
  if (!s) return 0;
  const sr = s.getBoundingClientRect();
  return Array.from(document.querySelectorAll('[data-testid="split-resize-handle"]'))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.h > 80 &&
      Math.abs(r.y + r.h / 2 - (sr.top + sr.height / 2)) < 320 &&
      (Math.abs(r.x - sr.right) < 30 || Math.abs(r.x + r.w - sr.left) < 30)).length;
})()`);

let samples = [];
let finalW = null;
let surfaceBefore = null;
let surfaceAfter = null;

if (adjacentHandle > 0) {
  report("R0", "adjacent splitter present — using handle drag", true);
} else {
  report(
    "R0",
    "single-pane canvas: falling back to WINDOW-resize streaming",
    true,
  );
  surfaceBefore = await host.eval(`(() => {
    const s = document.querySelector("[data-browser-view-surface]");
    return s ? s.getBoundingClientRect().width : null;
  })()`);
  // Browser.* lives on the browser-level endpoint; attach a raw session.
  const version = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
  ).json();
  const browserConn = await Target.attach({
    type: "browser",
    url: "browser",
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  });
  const win = await browserConn.send("Browser.getWindowForTarget");
  const windowId = win.windowId;
  const orig = win.bounds;
  const baseW = orig.width;
  const baseX = orig.left;
  samples.push(await guest.eval(`window.innerWidth`));
  for (let i = 1; i <= 8; i += 1) {
    await browserConn.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: baseW - i * 24, left: baseX },
    });
    samples.push(await guest.eval(`window.innerWidth`));
  }
  for (let i = 8; i >= 0; i -= 1) {
    await browserConn.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: baseW - i * 24, left: baseX },
    });
    samples.push(await guest.eval(`window.innerWidth`));
  }
  await sleep(400);
  finalW = await guest.eval(`window.innerWidth`);
  surfaceAfter = await host.eval(`(() => {
    const s = document.querySelector("[data-browser-view-surface]");
    return s ? s.getBoundingClientRect().width : null;
  })()`);
  const distinctMid = new Set(samples.slice(1)).size;
  report(
    "R1",
    "guest viewport streams during continuous window resize",
    distinctMid >= 5,
    `distinct=${distinctMid} samples=${samples.join(",")}`,
  );
  const drift =
    surfaceAfter === null ? null : Math.abs(surfaceAfter - finalW);
  report(
    "R2",
    "settled guest width matches surface (±2px)",
    drift !== null && drift <= 2,
    `surface=${surfaceAfter} guest=${finalW} drift=${drift}`,
  );
  // restore exact original
  await browserConn.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: orig.width, height: orig.height, left: orig.left, top: orig.top },
  });
}

host.detach();
guest.detach();
console.log("\n==== SUMMARY ====");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
