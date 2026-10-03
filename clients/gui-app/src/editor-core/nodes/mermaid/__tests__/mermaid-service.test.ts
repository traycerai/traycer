import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = {
  initialize: vi.fn(),
  parse: vi.fn().mockResolvedValue(undefined),
  render: vi.fn(),
};

vi.mock("mermaid", () => ({ default: mermaidMock }));

const themeListeners: Array<() => void> = [];
vi.mock("@/lib/theme-applier", () => ({
  subscribeResolvedTheme: vi.fn((listener: () => void) => {
    themeListeners.push(listener);
    return () => {
      const index = themeListeners.indexOf(listener);
      if (index !== -1) themeListeners.splice(index, 1);
    };
  }),
}));

async function importFreshMermaidService() {
  vi.resetModules();
  return import("../mermaid-service");
}

/**
 * Mimics a real Mermaid SVG: root id, an internal fragment ref, an ARIA ref,
 * and a `<style>` block whose selector is compounded directly onto the root
 * id (`#id.node:hover`, no descendant space) and whose declaration also
 * references a fragment via `url(#marker)`.
 */
function svgFixture(id: string): string {
  return (
    `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-labelledby="${id}-title">` +
    `<title id="${id}-title">diagram</title>` +
    `<defs><marker id="${id}-arrow"></marker></defs>` +
    `<style>#${id}.node:hover{fill:url(#${id}-arrow);}</style>` +
    `<use href="#${id}-arrow"></use>` +
    `<path marker-end="url(#${id}-arrow)"></path>` +
    `</svg>`
  );
}

function extractIds(svg: string): string[] {
  return Array.from(svg.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);
}

function parseSvg(svg: string): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = svg;
  return wrapper;
}

/** Drains only the microtask queue - a pending macrotask (the real deferral timer) never fires from this alone. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Lets real (0ms) deferral timers actually fire, a few ticks for margin. */
async function flushTimers(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.parse.mockReset().mockResolvedValue(undefined);
  mermaidMock.render.mockReset();
  themeListeners.length = 0;
});

describe("renderMermaidSvg caching", () => {
  it("caches a settled render by (code, theme) and returns a fresh, uniquely-id'd copy on each call", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );

    const first = await svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );
    const second = await svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(first.svg).not.toBe(second.svg);

    const firstIds = extractIds(first.svg);
    const secondIds = extractIds(second.svg);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(
      firstIds.length + secondIds.length,
    );

    // Internal fragment references were rewritten to point at the NEW ids,
    // not left pointing at the id embedded in the cached source.
    const markerRef = /marker-end="url\(#([\w:.-]+)\)"/.exec(second.svg);
    expect(markerRef?.[1]).toBeDefined();
    expect(secondIds).toContain(markerRef?.[1]);
    const ariaRef = /aria-labelledby="([\w:.-]+)"/.exec(second.svg);
    expect(ariaRef?.[1]).toBeDefined();
    expect(secondIds).toContain(ariaRef?.[1]);

    // The <style> block's own url(#marker) reference is rewritten the same
    // way as an inline attribute would be.
    const secondDom = parseSvg(second.svg);
    const secondRootId = secondDom.querySelector("svg")?.id ?? "";
    const secondStyleText = secondDom.querySelector("style")?.textContent ?? "";
    // CSSOM re-serializes url(#id) as url("#id") with its own spacing - match
    // on CSS meaning (the fragment id), not the exact original punctuation.
    const styleUrlRef = /url\(\s*["']?#([\w:.-]+)["']?\s*\)/.exec(
      secondStyleText,
    );
    expect(styleUrlRef?.[1]).toBeDefined();
    expect(secondIds).toContain(styleUrlRef?.[1]);

    // The id-selector prefix (`#id.node:hover`, compounded with no space)
    // must stay tied to the SAME rewritten root id - a rule still naming the
    // old id no longer selects anything once the element's own id has moved.
    const selectorIdMatch = /^#([\w-]+)\.node/.exec(secondStyleText);
    expect(selectorIdMatch?.[1]).toBeDefined();
    expect(selectorIdMatch?.[1]).toBe(secondRootId);
  });

  it("dedupes concurrent calls for the same code into a single mermaid.render invocation", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );

    const [first, second] = await Promise.all([
      svc.renderMermaidSvg("graph TD\n  A --> B", new AbortController().signal),
      svc.renderMermaidSvg("graph TD\n  A --> B", new AbortController().signal),
    ]);

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    // Both callers still get isolated ids, even off the shared in-flight promise.
    expect(first.svg).not.toBe(second.svg);
  });

  it("defers the mermaid.render call off the caller's synchronous task", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );

    const promise = svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );
    await flushMicrotasks();
    expect(mermaidMock.render).not.toHaveBeenCalled();

    await promise;
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected render so the next call for the same code retries", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render
      .mockRejectedValueOnce(new Error("syntax error"))
      .mockImplementation((id: string) =>
        Promise.resolve({ svg: svgFixture(id) }),
      );

    await expect(
      svc.renderMermaidSvg("graph TD\n  A --> B", new AbortController().signal),
    ).rejects.toThrow("syntax error");

    const retried = await svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
    expect(retried.svg).toContain("<svg");
  });

  it("clears cached renders when the resolved theme changes", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );

    await svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(themeListeners).toHaveLength(1);

    themeListeners[0]();

    await svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      new AbortController().signal,
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
  });

  it("cancels the queued idle callback and rejects when the only consumer aborts before it fires", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );
    const controller = new AbortController();

    const promise = svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    // Give a NOT-cancelled timer a chance to fire before trusting the count.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("keeps a shared job alive for a surviving consumer, rejecting only the aborted one once the shared render settles", async () => {
    const svc = await importFreshMermaidService();
    mermaidMock.render.mockImplementation((id: string) =>
      Promise.resolve({
        svg: svgFixture(id),
      }),
    );
    const abortedController = new AbortController();
    const survivingController = new AbortController();

    const abortedPromise = svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      abortedController.signal,
    );
    const survivingPromise = svc.renderMermaidSvg(
      "graph TD\n  A --> B",
      survivingController.signal,
    );
    await flushMicrotasks();
    const assertAborted = expect(abortedPromise).rejects.toMatchObject({
      name: "AbortError",
    });
    abortedController.abort();

    const survived = await survivingPromise;
    await assertAborted;
    // One shared render, not two - the abort never interrupted it.
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(survived.svg).toContain("<svg");
  });

  it("serializes admission across distinct diagrams, and never admits a job whose only consumer aborted while queued behind another render", async () => {
    const svc = await importFreshMermaidService();
    const codeA = "graph TD\n  A1 --> B1";
    const codeB = "graph TD\n  A2 --> B2";
    let releaseFirst: (value: { svg: string }) => void = () => {};
    const firstBarrier = new Promise<{ svg: string }>((resolve) => {
      releaseFirst = resolve;
    });
    mermaidMock.render.mockImplementation(async (id: string, code: string) => {
      if (code === codeA) return firstBarrier;
      return { svg: svgFixture(id) };
    });

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const promiseA = svc.renderMermaidSvg(codeA, controllerA.signal);
    const promiseB = svc.renderMermaidSvg(codeB, controllerB.signal);

    // Let both distinct jobs clear their own idle wait and reach the
    // admission queue - A is admitted first and calls mermaid.render
    // (blocked on the barrier); B's turn is chained behind A's, not admitted.
    await flushTimers(5);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(mermaidMock.render.mock.calls[0][1]).toBe(codeA);

    // B's only consumer leaves while B is still queued, before its own turn.
    controllerB.abort();
    await flushMicrotasks();

    // A's admission settles now - exactly when B's queued turn would come up.
    releaseFirst({ svg: svgFixture("first") });

    const resolvedA = await promiseA;
    expect(typeof resolvedA.svg).toBe("string");
    await expect(promiseB).rejects.toMatchObject({ name: "AbortError" });
    // B never reached mermaid.render, even after A freed the queue.
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });
});
