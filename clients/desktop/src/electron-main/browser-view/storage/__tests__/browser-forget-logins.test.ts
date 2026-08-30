import { describe, expect, it, vi } from "vitest";
import { forgetBrowserPersistentLogins } from "../browser-forget-logins";
import type { BrowserForgetLoginsDependencies } from "../browser-forget-logins";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

describe("forgetBrowserPersistentLogins", () => {
  interface ForgetHarness {
    readonly steps: string[];
    readonly dependencies: BrowserForgetLoginsDependencies;
  }

  function makeForgetHarness(input: {
    readonly clearFails: boolean;
    readonly recreated: readonly string[];
  }): ForgetHarness {
    const steps: string[] = [];
    let suppressed = false;
    return {
      steps,
      dependencies: {
        suppressDeltas: async (action) => {
          suppressed = true;
          steps.push("suppress-enter");
          try {
            return await action();
          } finally {
            suppressed = false;
            steps.push("suppress-exit");
          }
        },
        persistentSession: {
          clearStorageData: () => {
            // Every destructive step has to happen with the cookie-delta
            // observer muted; recording the flag is how the test proves
            // it, since a real delta would only surface much later.
            steps.push(suppressed ? "clear(suppressed)" : "clear(LEAKING)");
            return input.clearFails
              ? Promise.reject(new Error("jar is busy"))
              : Promise.resolve();
          },
        },
        resetLocalStorageSnapshots: () => {
          steps.push(suppressed ? "reset(suppressed)" : "reset(LEAKING)");
        },
        recreateTabs: () => {
          steps.push(suppressed ? "recreate(suppressed)" : "recreate(LEAKING)");
          return Promise.resolve([...input.recreated]);
        },
      },
    };
  }

  it("clears the jar, drops the remembered origins, then recreates the tiles - all with deltas muted", async () => {
    const harness = makeForgetHarness({
      clearFails: false,
      recreated: ["guest-1", "guest-2"],
    });

    const result = await forgetBrowserPersistentLogins(harness.dependencies);

    expect(result).toEqual({ partitionCleared: true, tabsRecreated: 2 });
    // The order is the contract: a tile recreated before the clear would come
    // back still signed in, and one recreated before the reset would be
    // re-seeded from the localStorage just forgotten.
    expect(harness.steps).toEqual([
      "suppress-enter",
      "clear(suppressed)",
      "reset(suppressed)",
      "recreate(suppressed)",
      "suppress-exit",
    ]);
  });

  it("still recreates the tiles when the jar refuses to clear", async () => {
    const harness = makeForgetHarness({
      clearFails: true,
      recreated: ["guest-1"],
    });

    const result = await forgetBrowserPersistentLogins(harness.dependencies);

    // The host has already shredded its key; leaving live tiles on a jar it
    // can no longer read is the worse failure.
    expect(result).toEqual({ partitionCleared: false, tabsRecreated: 1 });
    expect(harness.steps).toContain("recreate(suppressed)");
  });
});
