import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBearerRevalidator,
  REJECT_REREAD_ATTEMPTS,
  rotateAndPersistBearer,
  type BearerStore,
} from "../bearer-revalidator";
import { MutableBearerLease } from "../bearer-source";
import { refreshAuthTokenViaHttp } from "../auth-validation";
import type { StoredAuthTokens } from "../../platform/runner-host";

vi.mock("../auth-validation", () => ({
  refreshAuthTokenViaHttp: vi.fn(),
}));

const refreshMock = vi.mocked(refreshAuthTokenViaHttp);

const AUTHN = "https://authn.test";

// Wrap a bearer string into the persisted `{ token, refreshToken }` pair; the
// refresh token pairs deterministically so assertions can predict it.
function tokens(token: string): StoredAuthTokens {
  return { token, refreshToken: `${token}-refresh` };
}

function makeStore(initial: string | null): BearerStore & {
  writes: string[];
  cleared: boolean;
} {
  const state = {
    current: initial === null ? null : tokens(initial),
    writes: [] as string[],
    cleared: false,
  };
  return {
    writes: state.writes,
    get cleared() {
      return state.cleared;
    },
    read: async () => state.current,
    write: async (next: StoredAuthTokens) => {
      state.current = next;
      state.writes.push(next.token);
    },
    clear: async () => {
      state.cleared = true;
      state.current = null;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("rotateAndPersistBearer", () => {
  it("persists before rotating", async () => {
    const order: string[] = [];
    await rotateAndPersistBearer({
      newTokens: tokens("next"),
      persist: async () => {
        order.push("persist");
      },
      rotate: () => {
        order.push("rotate");
      },
    });
    expect(order).toEqual(["persist", "rotate"]);
  });
});

describe("createBearerRevalidator", () => {
  it("refreshes, rotates the lease, and persists when no sibling rotated", async () => {
    refreshMock.mockResolvedValue({
      kind: "refreshed",
      token: "rotated",
      refreshToken: "rotated-refresh",
    });
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("stale");
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(refreshMock).toHaveBeenCalledWith(AUTHN, "stale", "stale-refresh");
    expect(lease.getBearerToken()).toBe("rotated");
    expect(store.writes).toEqual(["rotated"]);
  });

  it("adopts a sibling-rotated token before refreshing (no refresh call)", async () => {
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("sibling-token");
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(refreshMock).not.toHaveBeenCalled();
    expect(lease.getBearerToken()).toBe("sibling-token");
    expect(store.writes).toEqual([]);
  });

  it("adopts a token a sibling rotated to during our refresh round trip", async () => {
    refreshMock.mockResolvedValue({
      kind: "refreshed",
      token: "ours",
      refreshToken: "ours-refresh",
    });
    const lease = new MutableBearerLease("stale", "u1");
    // read() #1 returns "stale" (== current, proceed to refresh); read() #2
    // returns a sibling token that differs from both current and ours.
    let reads = 0;
    const store: BearerStore = {
      read: async () => {
        reads += 1;
        return reads === 1 ? tokens("stale") : tokens("sibling-during");
      },
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(lease.getBearerToken()).toBe("sibling-during");
    expect(store.write).not.toHaveBeenCalled();
  });

  it("ignores an empty token a concurrent writer left and keeps the refreshed one", async () => {
    refreshMock.mockResolvedValue({
      kind: "refreshed",
      token: "ours",
      refreshToken: "ours-refresh",
    });
    const lease = new MutableBearerLease("stale", "u1");
    // read() #1 returns "stale" (== current → refresh); read() #2 returns "" -
    // an empty/partial credentials write that must NOT be adopted.
    let reads = 0;
    const store: BearerStore = {
      read: async () => {
        reads += 1;
        return reads === 1 ? tokens("stale") : { token: "", refreshToken: "" };
      },
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(lease.getBearerToken()).toBe("ours");
    expect(store.write).toHaveBeenCalledWith({
      token: "ours",
      refreshToken: "ours-refresh",
    });
  });

  it("never throws - a store write failure maps to network-error and leaves the bearer", async () => {
    refreshMock.mockResolvedValue({
      kind: "refreshed",
      token: "ours",
      refreshToken: "ours-refresh",
    });
    const lease = new MutableBearerLease("stale", "u1");
    const store: BearerStore = {
      read: async () => tokens("stale"),
      write: async () => {
        throw new Error("ENOSPC");
      },
      clear: async () => undefined,
    };
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("network-error");
    // persist threw before rotate, so the lease is untouched.
    expect(lease.getBearerToken()).toBe("stale");
  });

  it("clears the store on rejection when clearOnReject is true", async () => {
    refreshMock.mockResolvedValue({ kind: "rejected" });
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("stale");
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: true,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rejected");
    expect(store.cleared).toBe(true);
    expect(lease.getBearerToken()).toBe("stale");
  });

  it("leaves the store intact on rejection when clearOnReject is false", async () => {
    refreshMock.mockResolvedValue({ kind: "rejected" });
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("stale");
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: false,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rejected");
    expect(store.cleared).toBe(false);
  });

  it("returns network-error without touching the store or lease", async () => {
    refreshMock.mockResolvedValue({ kind: "network-error" });
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("stale");
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: true,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("network-error");
    expect(store.cleared).toBe(false);
    expect(store.writes).toEqual([]);
    expect(lease.getBearerToken()).toBe("stale");
  });

  it("adopts a sibling's freshly-persisted token on reject instead of signing out", async () => {
    refreshMock.mockResolvedValue({ kind: "rejected" });
    const lease = new MutableBearerLease("stale", "u1");
    // read() #1 (pre-refresh) returns "stale" (== current → refresh); read() #2
    // (reject re-read) finds the winner's freshly-persisted token.
    let reads = 0;
    const store: BearerStore = {
      read: async () => {
        reads += 1;
        return reads === 1 ? tokens("stale") : tokens("winner");
      },
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      // Even with clearOnReject true (the GUI's sign-out posture), an adoptable
      // sibling token must win over the clear.
      clearOnReject: true,
      delay: async () => undefined,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(lease.getBearerToken()).toBe("winner");
    // Adopt-only: never write (no double-write) and never clear.
    expect(store.write).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("bounded poll on reject catches a slightly-delayed sibling write", async () => {
    refreshMock.mockResolvedValue({ kind: "rejected" });
    const lease = new MutableBearerLease("stale", "u1");
    // The store stays pinned to "stale" until the first inter-poll delay fires,
    // at which point the sibling has persisted "winner".
    const state = { token: "stale" };
    const store: BearerStore = {
      read: async () => tokens(state.token),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const delay = vi.fn(async () => {
      state.token = "winner";
    });
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: true,
      delay,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rotated");
    expect(lease.getBearerToken()).toBe("winner");
    // Pre-refresh read + first reject read both saw "stale"; one delay, then the
    // second reject read adopted "winner".
    expect(delay).toHaveBeenCalledTimes(1);
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("rejects (and clears when clearOnReject) when the store never holds a newer token", async () => {
    refreshMock.mockResolvedValue({ kind: "rejected" });
    const lease = new MutableBearerLease("stale", "u1");
    const store = makeStore("stale");
    const delay = vi.fn(async () => undefined);
    const revalidator = createBearerRevalidator({
      authnBaseUrl: AUTHN,
      lease,
      store,
      clearOnReject: true,
      delay,
    });

    const outcome = await revalidator.revalidateCurrentContext();

    expect(outcome).toBe("rejected");
    expect(store.cleared).toBe(true);
    expect(store.writes).toEqual([]);
    // Poll exhausted its budget: one delay per gap between the re-reads.
    expect(delay).toHaveBeenCalledTimes(REJECT_REREAD_ATTEMPTS - 1);
  });
});
