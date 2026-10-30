import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures.ts";

// Why does a frame read off the end during a streaming reply? Instruments the
// page (own init script, no shared file): every write to the scroll node's
// scrollTop / scrollTo (with its caller), every ResizeObserver and
// MutationObserver callback (labelled by where it was created), and a
// diagnostic ResizeObserver on the list's content element, the rows and their
// first two descendant levels. Per rAF frame N it takes two readings:
//   A: at the start of frame N, before the rendering update (what a rAF-time
//      probe sees; tasks since the last frame, e.g. a stream token's React
//      commit, are applied but the frame's observer callbacks have not run);
//   B: in a ResizeObserver callback the rAF callback arms by resizing a
//      marker, i.e. after frame N's layout and the page's own observer
//      callbacks, right before paint. B is what the screen showed for frame
//      N. (A message task posted from the rAF callback is not: under load a
//      stream token's timer task runs first, and its commit reads as painted
//      though the next rendering update corrects it before paint.)

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

type Reply = "text" | "rich";

const INIT = `(() => {
  const log = [];
  window.__ofLog = log;
  window.__ofFrame = 0;
  window.__ofStep = "start";
  const isScroller = (el) =>
    el instanceof Element && el.getAttribute("data-testid") === "chat-messages-scroll";
  const short = (stack, from, to) =>
    String(stack)
      .split("\\n")
      .slice(from, to)
      .map((l) =>
        l
          .trim()
          .replace(/^at /, "")
          .replace(/https?:\\/\\/[^)\\s]*\\/([^/)\\s?]+)(\\?[^:)\\s]*)?:(\\d+):\\d+/g, "$1:$3"),
      )
      .join(" < ");
  const desc = (el) => {
    if (!(el instanceof Element)) return String(el);
    const id = el.getAttribute("data-message-id");
    if (id) return "row:" + id;
    const tid = el.getAttribute("data-testid");
    if (tid) return tid;
    const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const now = () => Math.round(performance.now() * 10) / 10;
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: d.get,
    set(v) {
      if (isScroller(this)) {
        log.push({ k: "scrollTop=", f: window.__ofFrame, t: now(), v: Math.round(v), was: Math.round(d.get.call(this)), who: short(new Error().stack, 2, 6) });
      }
      d.set.call(this, v);
    },
  });
  for (const name of ["scrollTo", "scrollBy"]) {
    const orig = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      if (isScroller(this)) {
        log.push({ k: name, f: window.__ofFrame, t: now(), v: JSON.stringify(args), was: Math.round(d.get.call(this)), who: short(new Error().stack, 2, 6) });
      }
      return orig.apply(this, args);
    };
  }
  const NRO = window.ResizeObserver;
  window.ResizeObserver = class extends NRO {
    constructor(cb) {
      const label = short(new Error().stack, 2, 4);
      super((entries, obs) => {
        log.push({ k: "RO", f: window.__ofFrame, t: now(), label, els: entries.map((e) => desc(e.target) + "=" + Math.round(e.contentRect.height * 10) / 10) });
        return cb(entries, obs);
      });
    }
  };
  const NMO = window.MutationObserver;
  window.MutationObserver = class extends NMO {
    constructor(cb) {
      const label = short(new Error().stack, 2, 4);
      super((records, obs) => {
        log.push({ k: "MO", f: window.__ofFrame, t: now(), label, n: records.length, els: [...new Set(records.map((r) => desc(r.target) + ":" + (r.attributeName ?? r.type)))].slice(0, 4) });
        return cb(records, obs);
      });
    }
  };
  window.__ofStart = () => {
    const frames = [];
    window.__ofFrames = frames;
    let running = true;
    window.__ofStop = () => { running = false; };
    const scroller = () => document.querySelector('[data-testid="chat-messages-scroll"]');
    const contentOf = (n) => n && n.querySelector(":scope > .legend-list-content-container");
    const read = () => {
      const n = scroller();
      if (!n) return null;
      const c = contentOf(n);
      return {
        top: n.scrollTop,
        sh: n.scrollHeight,
        ch: n.clientHeight,
        dist: n.scrollHeight - n.clientHeight - n.scrollTop,
        mode: n.dataset.scrollMode ?? null,
        content: c ? c.style.height : null,
        contentH: c ? Math.round(c.getBoundingClientRect().height * 10) / 10 : null,
        rows: [...n.querySelectorAll("[data-message-id]")].slice(-3).map((r) => r.getAttribute("data-message-id") + "=" + Math.round(r.getBoundingClientRect().height * 10) / 10),
      };
    };
    const heights = new WeakMap();
    const myRO = new NRO((entries) => {
      for (const e of entries) {
        const h = Math.round(e.contentRect.height * 10) / 10;
        const prev = heights.get(e.target);
        heights.set(e.target, h);
        log.push({ k: "diagRO", f: window.__ofFrame, t: now(), el: desc(e.target), h, dh: prev === undefined ? null : Math.round((h - prev) * 10) / 10 });
      }
    });
    const seen = new WeakSet();
    const observeNew = (el) => {
      if (!seen.has(el)) { seen.add(el); myRO.observe(el); }
    };
    const rescan = () => {
      const n = scroller();
      if (!n) return;
      const c = contentOf(n);
      if (c) observeNew(c);
      for (const row of n.querySelectorAll("[data-message-id]")) {
        observeNew(row);
        for (const a of row.children) {
          observeNew(a);
          for (const b of a.children) observeNew(b);
        }
      }
    };
    const t0 = performance.now();
    const marker = document.createElement("div");
    marker.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.append(marker);
    const pending = [];
    new NRO(() => {
      const i = pending.shift();
      if (i !== undefined) frames[i].B = read();
    }).observe(marker);
    let wide = false;
    const tick = () => {
      if (!running) return;
      window.__ofFrame += 1;
      rescan();
      frames.push({ f: window.__ofFrame, t: Math.round(performance.now() - t0), step: window.__ofStep, A: read(), B: null });
      pending.length = 0;
      pending.push(frames.length - 1);
      wide = !wide;
      marker.style.width = wide ? "2px" : "1px";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
})();`;

interface Reading {
  readonly top: number;
  readonly sh: number;
  readonly ch: number;
  readonly dist: number;
  readonly mode: string | null;
  readonly content: string | null;
  readonly contentH: number | null;
  readonly rows: readonly string[];
}

interface OfFrame {
  readonly f: number;
  readonly t: number;
  readonly step: string;
  readonly A: Reading | null;
  readonly B: Reading | null;
}

interface OfEvent {
  readonly k: string;
  readonly f: number;
  readonly t: number;
  readonly [key: string]: unknown;
}

declare global {
  interface Window {
    __ofStart?: () => void;
    __ofStop?: () => void;
    __ofStep?: string;
    __ofFrames?: OfFrame[];
    __ofLog?: OfEvent[];
  }
}

async function probeDist(page: Page): Promise<number> {
  return page.evaluate(() => {
    const n = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    return n === null ? 0 : n.scrollHeight - n.clientHeight - n.scrollTop;
  });
}

function formatEvent(e: OfEvent, where: string): string | null {
  if (e.k === "diagRO") {
    if (e.dh === 0) return null;
    return `    ${where}: resize ${String(e.el)} h=${String(e.h)} (dh ${String(e.dh)}) t=${String(e.t)}`;
  }
  if (e.k === "RO" || e.k === "MO") {
    return `    ${where}: ${e.k} callback [${String(e.label)}] ${JSON.stringify(e.els)} t=${String(e.t)}`;
  }
  return `    ${where}: ${e.k} ${String(e.v)} (was ${String(e.was)}) t=${String(e.t)} by ${String(e.who)}`;
}

/** Whether a stream frame read off the end, in its rAF-start reading (A) or
 *  in what actually painted (B). */
function readOffEnd(fr: OfFrame): boolean {
  if (fr.A === null || fr.step !== "stream") return false;
  const bDist = fr.B?.dist ?? 0;
  return fr.A.dist > 1 || bDist > 1;
}

/** "before the frame" / "in the frame" for a logged event, or null when the
 *  event belongs to neither. */
function eventWhere(e: OfEvent, frameNumber: number): string | null {
  if (e.f === frameNumber - 1) return "before the frame";
  if (e.f === frameNumber) return "in the frame";
  return null;
}

function contentGrowthLabel(prevB: Reading | null, a: Reading): string {
  if (prevB?.content === a.content) return "content style height unchanged";
  return `content style ${String(prevB?.content)} -> ${String(a.content)}`;
}

function frameSummaryLine(
  fr: OfFrame,
  prevB: Reading | null,
  a: Reading,
  grew: number,
): string {
  const bDist = fr.B?.dist ?? 0;
  const paintedOffEnd = bDist > 1 ? "PAINTED-OFF-END " : "";
  const contentGrew = contentGrowthLabel(prevB, a);
  return `FRAME ${String(fr.f)} t=${String(fr.t)}: ${paintedOffEnd}A dist=${a.dist.toFixed(1)} (sh ${String(prevB?.sh)} -> ${String(a.sh)}, +${String(grew)}; ${contentGrew}); B dist=${fr.B?.dist.toFixed(1)} mode ${String(fr.B?.mode)}`;
}

function frameHeightsLine(
  fr: OfFrame,
  prevB: Reading | null,
  a: Reading,
): string {
  return `    heights: painted-before contentH=${String(prevB?.contentH)} rows=[${String(prevB?.rows)}] | A contentH=${String(a.contentH)} rows=[${String(a.rows)}] | B contentH=${String(fr.B?.contentH)} rows=[${String(fr.B?.rows)}] sh B=${String(fr.B?.sh)}`;
}

function frameLogLines(frameNumber: number, log: readonly OfEvent[]): string[] {
  const lines: string[] = [];
  for (const e of log) {
    const where = eventWhere(e, frameNumber);
    if (where === null) continue;
    const line = formatEvent(e, where);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/** The report lines for one off-the-end frame: its A/B readings, the content
 *  heights at play, and the raw events logged around it. */
function frameLines(
  fr: OfFrame,
  prevB: Reading | null,
  log: readonly OfEvent[],
): string[] {
  const a = fr.A;
  if (a === null) return [];
  const grew = prevB === null ? 0 : a.sh - prevB.sh;
  return [
    frameSummaryLine(fr, prevB, a, grew),
    frameHeightsLine(fr, prevB, a),
    ...frameLogLines(fr.f, log),
  ];
}

function evidence(frames: readonly OfFrame[], log: readonly OfEvent[]): string {
  const lines: string[] = [];
  let prevB: Reading | null = null;
  for (const fr of frames) {
    if (readOffEnd(fr)) lines.push(...frameLines(fr, prevB, log));
    prevB = fr.B ?? prevB;
  }
  return lines.join("\n");
}

// coverage: the old code's off-the-end frame was occasional, not
// deterministic; the fix's deterministic proof lives in the vitest files.
// One run per reply shape is enough to keep the frame-reading instrumented.
for (const [reply, runs] of [
  ["rich", 1],
  ["text", 1],
] as const satisfies ReadonlyArray<readonly [Reply, number]>) {
  for (let run = 1; run <= runs; run += 1) {
    test(`${reply} reply: which frames read off the end, and what paints`, async ({
      page,
    }) => {
      await page.addInitScript(INIT);
      await page.goto(fixture("chat-send-follow"));
      await page.waitForFunction(() => window.__followDriver?.ready === true);
      await page.evaluate(() => {
        window.__followDriver?.open("idle");
      });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="chat-messages-scroll"]') !==
          null,
      );
      await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(
          '[data-testid="chat-messages-scroll"]',
        );
        node?.scrollTo({ top: node.scrollHeight });
      });
      await expect.poll(async () => probeDist(page)).toBeLessThanOrEqual(1);
      await nextFrames(page, 10);

      await page.getByRole("textbox").click();
      await page.keyboard.type("PROBE-PROMPT please continue PROBE-END");
      await page.evaluate(() => {
        window.__ofStart?.();
        window.__ofStep = "enter";
      });
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => window.__followDriver?.lastMessageId() !== null,
      );
      const messageId = await page.evaluate(
        () => window.__followDriver?.lastMessageId() ?? null,
      );
      if (messageId === null) throw new Error("the composer sent nothing");
      await nextFrames(page, 20);
      await page.evaluate((id) => {
        window.__ofStep = "accept";
        window.__followDriver?.host.accept(id);
      }, messageId);
      await nextFrames(page, 20);
      await page.evaluate((id) => {
        window.__ofStep = "turn";
        window.__followDriver?.host.turnStarted(id);
      }, messageId);
      await nextFrames(page, 20);
      await page.evaluate((kind) => {
        window.__ofStep = "stream";
        if (kind === "rich")
          window.__followDriver?.host.streamRich("reply", 5, 40);
        else window.__followDriver?.host.streamReply(100, 40);
      }, reply);
      await page.waitForTimeout(reply === "rich" ? 6000 : 2000);
      await page.evaluate(() => {
        window.__followDriver?.host.stopReply();
        window.__ofStep = "after";
      });
      await nextFrames(page, 20);
      const data = await page.evaluate(() => {
        window.__ofStop?.();
        return {
          frames: [...(window.__ofFrames ?? [])],
          log: [...(window.__ofLog ?? [])],
        };
      });
      const stream = data.frames.filter((f) => f.step === "stream");
      // A frame with no painted reading (B) or no scroller (A) measured
      // nothing, and would count as on the end below.
      expect(stream.length, "the recorder saw stream frames").toBeGreaterThan(
        0,
      );
      expect(
        stream.filter((f) => f.A === null || f.B === null).length,
        "every stream frame has both readings",
      ).toBe(0);
      const aOff = stream.filter((f) => (f.A?.dist ?? 0) > 1);
      const bOff = stream.filter((f) => (f.B?.dist ?? 0) > 1);
      // The first growth of the stream is the reply's first appearance.
      const firstGrowth = stream.findIndex(
        (f, i) => i > 0 && (f.A?.sh ?? 0) > (stream[0].A?.sh ?? 0),
      );
      const firstAppearanceOff = aOff.filter(
        (f) => stream.indexOf(f) <= firstGrowth + 1 && firstGrowth >= 0,
      ).length;
      const summary = `SUMMARY ${reply} run ${String(run)}: stream frames ${String(stream.length)}; A (rAF-start) off-end ${String(aOff.length)} (first-appearance ${String(firstAppearanceOff)}, per-token ${String(aOff.length - firstAppearanceOff)}), max ${String(Math.max(0, ...aOff.map((f) => f.A?.dist ?? 0)).toFixed(0))}px; B (after the rendering update) off-end ${String(bOff.length)}, max ${String(Math.max(0, ...bOff.map((f) => f.B?.dist ?? 0)).toFixed(0))}px; B missing ${String(stream.filter((f) => f.B === null).length)}`;
      console.warn(`${summary}\n${evidence(data.frames, data.log)}`);
      expect
        .soft(bOff.length, `frames that painted off the end\n${summary}`)
        .toBe(0);
    });
  }
}
