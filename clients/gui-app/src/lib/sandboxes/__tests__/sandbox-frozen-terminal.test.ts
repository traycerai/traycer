import { afterEach, describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { refreshHostListOnSandboxFrozen } from "@/lib/sandboxes/sandbox-frozen-terminal";

function fatal(code: string): FatalErrorDetails {
  return {
    code,
    reason: "a reason",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function hostList() {
  return {
    refreshDirectory: vi.fn<() => Promise<unknown>>(() => Promise.resolve()),
    invalidateRegisteredHosts: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve(),
    ),
  };
}

/** Unhandled rejections seen while a test runs, so a swallowed one is provable. */
const unhandled: unknown[] = [];
function onUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

describe("refreshHostListOnSandboxFrozen", () => {
  it("refreshes the directory once and invalidates the registered hosts once for SANDBOX_FROZEN", () => {
    const list = hostList();

    refreshHostListOnSandboxFrozen(fatal("SANDBOX_FROZEN"), list);

    expect(list.refreshDirectory).toHaveBeenCalledTimes(1);
    expect(list.invalidateRegisteredHosts).toHaveBeenCalledTimes(1);
  });

  it.each(["UNAUTHORIZED", "INCOMPATIBLE", "HOST_REVOKED"])(
    "does neither for %s",
    (code) => {
      const list = hostList();

      refreshHostListOnSandboxFrozen(fatal(code), list);

      expect(list.refreshDirectory).not.toHaveBeenCalled();
      expect(list.invalidateRegisteredHosts).not.toHaveBeenCalled();
    },
  );

  it("returns normally, and still invalidates, when the directory refresh rejects, with no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const list = hostList();
    list.refreshDirectory.mockImplementation(() =>
      Promise.reject(new Error("x")),
    );

    expect(() =>
      refreshHostListOnSandboxFrozen(fatal("SANDBOX_FROZEN"), list),
    ).not.toThrow();
    // Let the rejection settle and Node's unhandled-rejection pass run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(list.invalidateRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("returns normally, and still refreshes, when the registered-hosts invalidation rejects, with no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const list = hostList();
    list.invalidateRegisteredHosts.mockImplementation(() =>
      Promise.reject(new Error("y")),
    );

    expect(() =>
      refreshHostListOnSandboxFrozen(fatal("SANDBOX_FROZEN"), list),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(list.refreshDirectory).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("returns normally when either call throws synchronously", () => {
    const list = hostList();
    list.refreshDirectory.mockImplementation(() => {
      throw new Error("sync");
    });

    expect(() =>
      refreshHostListOnSandboxFrozen(fatal("SANDBOX_FROZEN"), list),
    ).not.toThrow();
    expect(list.invalidateRegisteredHosts).toHaveBeenCalledTimes(1);
  });
});
