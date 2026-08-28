/**
 * The browser shell's wake signal: ONE resume episode per hidden -> visible
 * edge, and nothing else.
 *
 * The budget is the whole point. Everything downstream of `onSystemResumed`
 * treats an emission as "the runtime was away" - a probe on every live stream,
 * a token-refresh check, a retry sweep over closed chat sessions - so an
 * emitter that repeats while the tab is merely visible spends all of that per
 * spurious edge, and one that misses the edge leaves a frozen tab waiting out
 * a pong timeout instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WebCredentialStorage,
  WebLockManager,
} from "@traycer-clients/webapp/web-token-store";
import { WebRunnerHost } from "@traycer-clients/webapp/web-runner-host";

function inMemoryStorage(): WebCredentialStorage {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    onExternalChange: (key, handler) => {
      void key;
      void handler;
    },
  };
}

const passthroughLocks: WebLockManager = {
  runExclusive: (name, task) => {
    void name;
    return task();
  },
};

function runner(): WebRunnerHost {
  return new WebRunnerHost({
    signInUrl: "https://platform.test/sign-in",
    authnBaseUrl: "https://authn.test",
    hostLabel: "Traycer Web",
    relayBaseUrl: "wss://relay.test/attach",
    credentialStorage: inMemoryStorage(),
    locks: passthroughLocks,
  });
}

// `document.visibilityState` is a getter on jsdom's `Document.prototype`;
// shadowing it per test (and removing the shadow afterwards) is how a
// hidden <-> visible edge is driven without a real browser lifecycle.
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A `visibilitychange` that does not move the state - what a repeat looks like. */
function redispatchWithoutChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("WebRunnerHost.onSystemResumed", () => {
  it("emits nothing on subscribe - a cold load is not a resume", () => {
    const resumes: number[] = [];

    const subscription = runner().onSystemResumed(() => resumes.push(1));

    expect(resumes).toEqual([]);
    subscription.dispose();
  });

  it("emits nothing on subscribe when the tab loaded hidden", () => {
    visibility = "hidden";
    const resumes: number[] = [];

    // A tab that loads in a background window has not woken up yet: the
    // baseline is seeded from the CURRENT state, so the FIRST edge is the one
    // that carries it to visible, not the subscription.
    const subscription = runner().onSystemResumed(() => resumes.push(1));
    expect(resumes).toEqual([]);

    setVisibility("visible");
    expect(resumes).toHaveLength(1);
    subscription.dispose();
  });

  it("emits exactly one episode per hidden -> visible edge", () => {
    const resumes: number[] = [];
    const subscription = runner().onSystemResumed(() => resumes.push(1));

    setVisibility("hidden");
    expect(resumes).toEqual([]);
    setVisibility("visible");
    expect(resumes).toHaveLength(1);

    setVisibility("hidden");
    setVisibility("visible");
    expect(resumes).toHaveLength(2);

    subscription.dispose();
  });

  it("does not re-emit while the tab stays visible", () => {
    const resumes: number[] = [];
    const subscription = runner().onSystemResumed(() => resumes.push(1));

    setVisibility("hidden");
    setVisibility("visible");
    expect(resumes).toHaveLength(1);

    // The edge filter IS the dedupe: a second event with the state unmoved,
    // and a redundant "visible" set, both have to be dropped. Without this a
    // browser that fires the event liberally would open a wake episode per
    // fire, on a tab that never went anywhere.
    redispatchWithoutChange();
    setVisibility("visible");
    expect(resumes).toHaveLength(1);

    subscription.dispose();
  });

  it("stops emitting to a disposed subscriber and keeps emitting to the rest", () => {
    const kept: number[] = [];
    const dropped: number[] = [];
    const host = runner();
    const keptSubscription = host.onSystemResumed(() => kept.push(1));
    const droppedSubscription = host.onSystemResumed(() => dropped.push(1));

    droppedSubscription.dispose();
    setVisibility("hidden");
    setVisibility("visible");

    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
    keptSubscription.dispose();
  });

  it("delivers the episode to every subscriber even when one throws", () => {
    const survived: number[] = [];
    const host = runner();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = host.onSystemResumed(() => {
      throw new Error("bad resume subscriber");
    });
    const healthy = host.onSystemResumed(() => survived.push(1));

    setVisibility("hidden");
    setVisibility("visible");

    // One consumer's fault must not cost the others their wake - a stream that
    // does not learn the runtime was away waits out its pong timeout instead.
    expect(survived).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    throwing.dispose();
    healthy.dispose();
  });
});

describe("WebRunnerHost resume and auth-return signals", () => {
  it("keeps the two independent, both directions", () => {
    const resumes: number[] = [];
    const returns: number[] = [];
    const host = runner();
    const resumeSubscription = host.onSystemResumed(() => resumes.push(1));
    const returnSubscription = host.onAuthCallback(() => returns.push(1));

    // They read the same DOM edge, so a resume is also an auth return...
    setVisibility("hidden");
    setVisibility("visible");
    expect(resumes).toHaveLength(1);
    expect(returns).toHaveLength(1);

    // ...but they are separate emitters, so retiring one leaves the other
    // whole. A shared emitter would make the device flow's teardown - which
    // happens the moment sign-in completes - silently take the stream-recovery
    // signal with it.
    returnSubscription.dispose();
    setVisibility("hidden");
    setVisibility("visible");
    expect(resumes).toHaveLength(2);
    expect(returns).toHaveLength(1);

    const secondReturn = host.onAuthCallback(() => returns.push(1));
    resumeSubscription.dispose();
    setVisibility("hidden");
    setVisibility("visible");
    expect(resumes).toHaveLength(2);
    expect(returns).toHaveLength(2);

    secondReturn.dispose();
  });
});
