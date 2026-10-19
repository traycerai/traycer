import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anyAbortSignal, composeRequestAbort } from "../request-abort";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("composeRequestAbort", () => {
  it("aborts once the timeout elapses, with a TimeoutError reason", () => {
    const { signal } = composeRequestAbort(null, 1_000);

    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("aborts when the caller's signal aborts, before the timeout", () => {
    const caller = new AbortController();
    const { signal } = composeRequestAbort(caller.signal, 60_000);
    expect(signal.aborted).toBe(false);

    caller.abort();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "AbortError" });
  });

  it("returns an already-aborted signal for an already-aborted caller", () => {
    const caller = new AbortController();
    caller.abort();

    const { signal } = composeRequestAbort(caller.signal, 60_000);

    expect(signal.aborted).toBe(true);
  });

  it("clear() stops the timer: advancing past the timeout aborts nothing", () => {
    const { signal, clear } = composeRequestAbort(null, 1_000);

    clear();
    vi.advanceTimersByTime(10_000);

    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clear() detaches from the caller: aborting the caller afterwards leaves the composed signal alone", () => {
    const caller = new AbortController();
    const { signal, clear } = composeRequestAbort(caller.signal, 60_000);

    clear();
    caller.abort();

    expect(signal.aborted).toBe(false);
  });
});

describe("anyAbortSignal", () => {
  it("aborts when the first source aborts, with that source's reason", () => {
    const first = new AbortController();
    const second = new AbortController();
    const signal = anyAbortSignal([first.signal, second.signal]);
    expect(signal.aborted).toBe(false);

    const reason = new Error("first went away");
    first.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("aborts when the second source aborts, with that source's reason", () => {
    const first = new AbortController();
    const second = new AbortController();
    const signal = anyAbortSignal([first.signal, second.signal]);

    const reason = new Error("second went away");
    second.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("returns an already-aborted signal carrying the reason of an already-aborted source", () => {
    const live = new AbortController();
    const dead = new AbortController();
    const reason = new Error("already gone");
    dead.abort(reason);

    const signal = anyAbortSignal([live.signal, dead.signal]);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("keeps the first reason when the other source aborts afterwards", () => {
    const first = new AbortController();
    const second = new AbortController();
    const signal = anyAbortSignal([first.signal, second.signal]);

    const firstReason = new Error("first");
    first.abort(firstReason);
    second.abort(new Error("second"));

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(firstReason);
  });

  it("stays pending while no source has aborted", () => {
    const first = new AbortController();
    const second = new AbortController();

    const signal = anyAbortSignal([first.signal, second.signal]);

    expect(signal.aborted).toBe(false);
  });
});
