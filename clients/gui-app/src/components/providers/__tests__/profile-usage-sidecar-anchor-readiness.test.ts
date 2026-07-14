import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  waitForAnchorEntranceAnimations,
  waitForAnchorPlacement,
  waitForAnchorReady,
} from "../profile-usage-sidecar-anchor-readiness";

const OFFSCREEN_RECT = new DOMRect(0, -9999, 240, 32);
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
  let placed: boolean;

  function mountWrapperAndAnchor(): { wrapper: HTMLElement; anchor: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    wrapper.style.transform = "translate(0, -200%)";
    const anchor = document.createElement("button");
    wrapper.append(anchor);
    document.body.append(wrapper);
    return { wrapper, anchor };
  }

  beforeEach(() => {
    placed = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function mockRect(this: HTMLElement) {
        if (this.tagName === "BUTTON") {
          return placed ? ONSCREEN_RECT : OFFSCREEN_RECT;
        }
        return new DOMRect(0, 0, 0, 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("resolves immediately for a static anchor with no Radix popper wrapper", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    // Off-screen per the mock above, and never placed - a non-Radix anchor
    // must never be gated on placement at all.
    await expect(
      waitForAnchorPlacement(anchor, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("resolves immediately when the anchor is already on-screen (re-anchoring in an already-placed menu)", async () => {
    const { anchor } = mountWrapperAndAnchor();
    placed = true;
    await expect(
      waitForAnchorPlacement(anchor, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("waits for the wrapper's style mutation that lands the real placement", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();

    let resolved = false;
    const wait = waitForAnchorPlacement(anchor, new AbortController().signal).then(
      () => {
        resolved = true;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Simulate Floating UI landing its first real placement: the wrapper's
    // inline style changes, and the anchor's rect - measured live, exactly
    // like the production `update()` - now reports on-screen.
    placed = true;
    wrapper.style.transform = "translate(228px, 100px)";

    await wait;
    expect(resolved).toBe(true);
  });

  it("ignores a style mutation that doesn't yet bring the anchor on-screen", async () => {
    const { wrapper, anchor } = mountWrapperAndAnchor();

    let resolved = false;
    const wait = waitForAnchorPlacement(anchor, new AbortController().signal).then(
      () => {
        resolved = true;
      },
    );

    // A mutation that isn't the real placement yet (still off-screen).
    wrapper.style.transform = "translate(0, -180%)";
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    placed = true;
    wrapper.style.transform = "translate(228px, 100px)";
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
    placed = true;
    expect(() => {
      wrapper.style.transform = "translate(228px, 100px)";
    }).not.toThrow();
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
