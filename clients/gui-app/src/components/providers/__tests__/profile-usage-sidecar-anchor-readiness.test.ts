import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  waitForAnchorEntranceAnimations,
  waitForAnchorPlacement,
  waitForAnchorReady,
} from "../profile-usage-sidecar-anchor-readiness";

const ONSCREEN_RECT = new DOMRect(120, 160, 240, 32);

interface FakeAnimation {
  readonly effect: {
    readonly target: Node | null;
    getTiming(): { readonly iterations?: number };
  } | null;
  readonly finished: Promise<unknown>;
}

function fakeAnimation(input: {
  readonly target: Node | null;
  readonly iterations: number;
  readonly finished: Promise<unknown>;
}): FakeAnimation {
  return {
    effect: {
      target: input.target,
      getTiming: () => ({ iterations: input.iterations }),
    },
    finished: input.finished,
  };
}

function stubGetAnimations(animations: ReadonlyArray<FakeAnimation>): void {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    writable: true,
    value: () => animations,
  });
}

describe("waitForAnchorEntranceAnimations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("resolves immediately when the Web Animations API is unavailable", async () => {
    expect(typeof document.getAnimations).toBe("undefined");
    const anchor = document.createElement("button");
    await expect(
      waitForAnchorEntranceAnimations(anchor),
    ).resolves.toBeUndefined();
  });

  it("resolves immediately when no animation targets the anchor or an ancestor", async () => {
    const anchor = document.createElement("button");
    const unrelated = document.createElement("div");
    let resolved = false;
    stubGetAnimations([
      fakeAnimation({
        target: unrelated,
        iterations: 1,
        finished: new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(undefined);
          }, 0);
        }),
      }),
    ]);
    await waitForAnchorEntranceAnimations(anchor);
    expect(resolved).toBe(false);
  });

  it("waits for a finite-duration animation targeting an ancestor of the anchor", async () => {
    const wrapper = document.createElement("div");
    const anchor = document.createElement("button");
    wrapper.append(anchor);
    let settled = false;
    let releaseAnimation: () => void = () => undefined;
    stubGetAnimations([
      fakeAnimation({
        target: wrapper,
        iterations: 1,
        finished: new Promise((resolve) => {
          releaseAnimation = () => {
            settled = true;
            resolve(undefined);
          };
        }),
      }),
    ]);

    let waitResolved = false;
    const wait = waitForAnchorEntranceAnimations(anchor).then(() => {
      waitResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(waitResolved).toBe(false);

    releaseAnimation();
    await wait;
    expect(settled).toBe(true);
    expect(waitResolved).toBe(true);
  });

  it("waits for an animation targeting the anchor itself", async () => {
    const anchor = document.createElement("button");
    let releaseAnimation: (value: undefined) => void = () => undefined;
    stubGetAnimations([
      fakeAnimation({
        target: anchor,
        iterations: 1,
        finished: new Promise((resolve) => {
          releaseAnimation = resolve;
        }),
      }),
    ]);

    let waitResolved = false;
    const wait = waitForAnchorEntranceAnimations(anchor).then(() => {
      waitResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(waitResolved).toBe(false);

    releaseAnimation(undefined);
    await wait;
    expect(waitResolved).toBe(true);
  });

  it("does not wait on an infinite-duration animation targeting an ancestor", async () => {
    const wrapper = document.createElement("div");
    const anchor = document.createElement("button");
    wrapper.append(anchor);
    stubGetAnimations([
      fakeAnimation({
        target: wrapper,
        iterations: Number.POSITIVE_INFINITY,
        finished: new Promise(() => undefined),
      }),
    ]);
    await expect(
      waitForAnchorEntranceAnimations(anchor),
    ).resolves.toBeUndefined();
  });

  it("swallows a rejected finished promise (e.g. a canceled animation)", async () => {
    const anchor = document.createElement("button");
    stubGetAnimations([
      fakeAnimation({
        target: anchor,
        iterations: 1,
        finished: Promise.reject(new Error("canceled")),
      }),
    ]);
    await expect(
      waitForAnchorEntranceAnimations(anchor),
    ).resolves.toBeUndefined();
  });
});

describe("waitForAnchorPlacement", () => {
  function markUnplaced(wrapper: HTMLElement): void {
    // Base's public Positioner paints at opacity 0, with a position already
    // assigned, until its first placement lands (see
    // `isPopperWrapperPlaced`).
    wrapper.style.position = "fixed";
    wrapper.style.opacity = "0";
  }

  function markPlaced(wrapper: HTMLElement): void {
    wrapper.style.opacity = "1";
  }

  function mountWrapperAndAnchor(): {
    wrapper: HTMLElement;
    anchor: HTMLElement;
  } {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-slot", "dropdown-menu-positioner");
    markUnplaced(wrapper);
    const anchor = document.createElement("button");
    wrapper.append(anchor);
    document.body.append(wrapper);
    return { wrapper, anchor };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("resolves immediately for a static anchor with no Positioner wrapper", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await expect(
      waitForAnchorPlacement(anchor, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("resolves immediately when every wrapper is already placed", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();
    markPlaced(wrapper);
    await expect(
      waitForAnchorPlacement(anchor, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("waits for the wrapper's style mutation that lands the real placement", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();

    let resolved = false;
    const wait = waitForAnchorPlacement(
      anchor,
      new AbortController().signal,
    ).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    markPlaced(wrapper);

    await wait;
    expect(resolved).toBe(true);
  });

  it("keeps waiting while the Positioner still has position unset (pre-mount)", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();
    wrapper.style.position = "";
    wrapper.style.opacity = "1";

    let resolved = false;
    const wait = waitForAnchorPlacement(
      anchor,
      new AbortController().signal,
    ).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    wrapper.style.position = "fixed";
    markPlaced(wrapper);
    await wait;
    expect(resolved).toBe(true);
  });

  it("ignores unrelated style mutations while the wrapper keeps the sentinel", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();

    let resolved = false;
    const wait = waitForAnchorPlacement(
      anchor,
      new AbortController().signal,
    ).then(() => {
      resolved = true;
    });

    wrapper.style.setProperty("--anchor-width", "640px");
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    markPlaced(wrapper);
    await wait;
    expect(resolved).toBe(true);
  });

  it.each([
    "select-positioner",
    "context-menu-positioner",
    "menubar-positioner",
    "hover-card-positioner",
    "tooltip-positioner",
  ])(
    "waits for an unplaced %s wrapper, not only dropdown and popover",
    async (slot) => {
      const { wrapper, anchor } = mountWrapperAndAnchor();
      wrapper.setAttribute("data-slot", slot);

      let resolved = false;
      const wait = waitForAnchorPlacement(
        anchor,
        new AbortController().signal,
      ).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      markPlaced(wrapper);

      await wait;
      expect(resolved).toBe(true);
    },
  );

  it("waits for an unplaced inner wrapper nested inside a placed outer wrapper", async () => {
    const outerWrapper = document.createElement("div");
    outerWrapper.setAttribute("data-slot", "popover-positioner");
    markUnplaced(outerWrapper);
    markPlaced(outerWrapper);
    const { wrapper: innerWrapper, anchor } = mountWrapperAndAnchor();
    outerWrapper.append(innerWrapper);
    document.body.append(outerWrapper);

    let resolved = false;
    const wait = waitForAnchorPlacement(
      anchor,
      new AbortController().signal,
    ).then(() => {
      resolved = true;
    });

    innerWrapper.style.setProperty("--available-height", "480px");
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    markPlaced(innerWrapper);
    await wait;
    expect(resolved).toBe(true);
  });

  it("waits for an unplaced outer wrapper around a placed inner wrapper", async () => {
    const outerWrapper = document.createElement("div");
    outerWrapper.setAttribute("data-slot", "popover-positioner");
    markUnplaced(outerWrapper);
    const { wrapper: innerWrapper, anchor } = mountWrapperAndAnchor();
    markPlaced(innerWrapper);
    outerWrapper.append(innerWrapper);
    document.body.append(outerWrapper);

    let resolved = false;
    const wait = waitForAnchorPlacement(
      anchor,
      new AbortController().signal,
    ).then(() => {
      resolved = true;
    });

    innerWrapper.style.setProperty("--anchor-width", "640px");
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    markPlaced(outerWrapper);
    await wait;
    expect(resolved).toBe(true);
  });

  it("resolves and stops observing when the signal is aborted before placement lands", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();
    const controller = new AbortController();

    let resolved = false;
    const wait = waitForAnchorPlacement(anchor, controller.signal).then(() => {
      resolved = true;
    });

    controller.abort();
    await wait;
    expect(resolved).toBe(true);

    // A later mutation must not throw or double-resolve after abort.
    expect(() => {
      markPlaced(wrapper);
    }).not.toThrow();
  });

  it("resolves immediately for an anchor whose signal is already aborted", async () => {
    const { anchor } = mountWrapperAndAnchor();
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForAnchorPlacement(anchor, controller.signal),
    ).resolves.toBeUndefined();
  });

  describe("with no fallback timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stays unresolved indefinitely when placement never lands - no timer ever fires to show a stale rect", async () => {
      const { anchor } = mountWrapperAndAnchor();
      const controller = new AbortController();

      let resolved = false;
      void waitForAnchorPlacement(anchor, controller.signal).then(() => {
        resolved = true;
      });

      // Well past the old 2000ms fallback - and past it again, several
      // times over. Nothing internal should ever fire; only an explicit
      // placement mutation or an abort may resolve this.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolved).toBe(false);

      // Abort is still the only way out, and it still works after a long
      // pending period - proves cleanup isn't tied to a timer that no
      // longer exists.
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
    });

    it("unmount (abort) after a long pending period still disconnects the observer without throwing", async () => {
      const { wrapper, anchor } = mountWrapperAndAnchor();
      const controller = new AbortController();

      let resolved = false;
      void waitForAnchorPlacement(anchor, controller.signal).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(60_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);

      // A mutation arriving after unmount/abort must be inert.
      expect(() => {
        markPlaced(wrapper);
      }).not.toThrow();
    });
  });
});

describe("waitForAnchorReady", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "getAnimations");
    document.body.replaceChildren();
  });

  it("sequences placement before entrance animations - a static anchor with a pending animation still waits for it", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      ONSCREEN_RECT,
    );

    let releaseAnimation: (value: undefined) => void = () => undefined;
    stubGetAnimations([
      fakeAnimation({
        target: anchor,
        iterations: 1,
        finished: new Promise((resolve) => {
          releaseAnimation = resolve;
        }),
      }),
    ]);

    let resolved = false;
    const wait = waitForAnchorReady(anchor, new AbortController().signal).then(
      () => {
        resolved = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseAnimation(undefined);
    await wait;
    expect(resolved).toBe(true);
  });
});
