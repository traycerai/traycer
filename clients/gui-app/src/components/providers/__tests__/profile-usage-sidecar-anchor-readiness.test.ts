import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForAnchorEntranceAnimations } from "../profile-usage-sidecar-anchor-readiness";

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
