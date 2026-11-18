import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRunnerHost } from "./create-fake-runner-host";

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakeRunnerHost", () => {
  // The fixture's authority retries a refused local ensure on its own clock, so
  // a timer it left on the suite's fake clock would be fired again by every
  // drain of that clock. This tests the fixture, not production.
  it("the fake runner host's authority arms no timer", async () => {
    vi.useFakeTimers();

    createFakeRunnerHost({});
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
