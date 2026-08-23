// Opens the first BROWSERS sidebar session row so a guest tile exists.
class T {
  static async attach(m) {
    const t = new T(m);
    await t.#connect();
    return t;
  }
  constructor(m) {
    this.m = m;
    this.ws = null;
    this.i = 1;
    this.p = new Map();
  }
  #connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.m.webSocketDebuggerUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve(this));
      ws.addEventListener("error", () => reject(new Error("ws")));
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : ev.data.toString(),
        );
        if (msg.id !== undefined && this.p.has(msg.id)) {
          const pp = this.p.get(msg.id);
          this.p.delete(msg.id);
          if (msg.error) pp.reject(new Error(JSON.stringify(msg.error)));
          else pp.resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = this.i++;
    const pr = new Promise((resolve, reject) =>
      this.p.set(id, { resolve, reject }),
    );
    this.ws.send(JSON.stringify({ id, method, params }));
    return pr;
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.text ?? "evaluate failed");
    return r.result?.value;
  }
  mouse(type, x, y) {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }
  detach() {
    try {
      this.ws.close();
    } catch {}
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (
  await fetch(`http://127.0.0.1:${process.env.TRAYCER_CDP_PORT ?? "28960"}/json/list`)
).json();
const hostMeta = list.find(
  (t) =>
    t.type === "page" &&
    (t.url.startsWith("app://renderer") || /localhost:\d+/.test(t.url)),
);
const host = await T.attach(hostMeta);
const hit = await host.eval(`(() => {
  const els = Array.from(document.querySelectorAll("*")).filter((el) =>
    el.children.length === 0 && /airbnb\\.co\\.in/.test(el.textContent || ""));
  const el = els[els.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
console.log("sidebar row:", JSON.stringify(hit));
if (!hit) process.exit(1);
await host.mouse("mousePressed", hit.x, hit.y);
await host.mouse("mouseReleased", hit.x, hit.y);
await sleep(500);
host.detach();
