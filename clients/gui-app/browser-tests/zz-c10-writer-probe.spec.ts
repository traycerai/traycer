import { expect, test } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";

test.use({ viewport: { width: 390, height: 700 } });

declare global {
  interface Window {
    __c10?: string[];
  }
}

/**
 * TEMPORARY instrumentation, not a regression test. Runs C10's "Home while
 * following, streaming" steps repeatedly with a spy on every write to the
 * scroll node, so the write that lands after the reader's Home write names
 * its own call site. Deleted once the writer is known.
 */
const ROUNDS = 12;

test("probe: name the write that lands after Home", async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const failures: string[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    await page.goto(fixture("chat-scroll-model"));
    await nextFrames(page, 30);
    await expect
      .poll(() => page.evaluate(() => window.__chatScrollProbe.mode()))
      .toBe("following-end");

    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-messages-scroll"]',
      );
      if (node === null) throw new Error("no scroll node");
      const log: string[] = [];
      window.__c10 = log;
      const t0 = performance.now();
      const at = (): string => `${(performance.now() - t0).toFixed(0)}ms`;
      const descriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      const rawSet = descriptor?.set;
      const rawGet = descriptor?.get;
      if (rawSet === undefined || rawGet === undefined) {
        throw new Error("no scrollTop descriptor");
      }
      const readTop = (): number => Reflect.apply(rawGet, node, []) as number;
      const writeTop = (value: number): void => {
        Reflect.apply(rawSet, node, [value]);
      };
      const frames = (): string =>
        (new Error("stack").stack ?? "")
          .split("\n")
          .slice(2, 10)
          .map((line) => line.trim().replace(/^at /, ""))
          .join("\n      ");
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get(): number {
          return readTop();
        },
        set(value: number): void {
          const before = readTop();
          writeTop(value);
          log.push(
            `${at()} WRITE scrollTop ${String(before)} -> ${String(value)} h=${String(node.scrollHeight)}\n      ${frames()}`,
          );
        },
      });
      const rawScrollTo = node.scrollTo.bind(node);
      node.scrollTo = (options: ScrollToOptions): void => {
        const before = readTop();
        rawScrollTo(options);
        log.push(
          `${at()} WRITE scrollTo ${String(before)} -> ${JSON.stringify(options)} h=${String(node.scrollHeight)}\n      ${frames()}`,
        );
      };
      node.addEventListener("legend-list-scroller-moved", (event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail: unknown = event.detail;
        if (typeof detail !== "object" || detail === null) return;
        const record: Record<string, unknown> = { ...detail };
        log.push(
          `${at()} ANNOUNCED from=${String(record.from)} to=${String(record.to)} endBefore=${String(record.fromEnd)}`,
        );
      });
      let last = -1;
      const tick = (): void => {
        const top = readTop();
        if (top !== last) {
          last = top;
          log.push(
            `${at()} frame top=${top.toFixed(0)} h=${String(node.scrollHeight)} mode=${String(window.__chatScrollProbe.mode())}`,
          );
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.evaluate(() => {
      window.__chatScrollProbe.startStream(40);
    });
    await page.waitForTimeout(300);
    await page.keyboard.press("Home");
    await nextFrames(page, 3);
    const after = await page.evaluate(() =>
      window.__chatScrollProbe.geometry(),
    );
    await page.waitForTimeout(400);
    const log = await page.evaluate(() => {
      window.__chatScrollProbe.stopStream();
      return window.__c10 ?? [];
    });
    const top = after?.scrollTop ?? -1;
    // eslint-disable-next-line no-console
    console.log(`round ${String(round)}: scrollTop after Home = ${String(top)}`);
    if (top > 1) {
      failures.push(
        `=== round ${String(round)} landed at ${String(top)} ===\n${log.join("\n")}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${String(failures.length)}/${String(ROUNDS)} rounds landed off the top\n\n${failures.join("\n\n")}`,
    );
  }
});
