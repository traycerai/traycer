/**
 * The renderer wrapper's `deleteIfToken` contract: it FORWARDS the whole
 * conditional delete to the backing store as one operation (the atomicity
 * lives at the store's own authority — main's file lock — never composed
 * from `get()` + `delete()` here), and it joins the renderer's mutation
 * chain so it is ordered against this window's own `signIn`/`delete`.
 */
import { describe, expect, it } from "vitest";
import type {
  ITokenStore,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
} from "@traycer-clients/shared/platform/runner-host";
import { AuthTokenStore } from "../auth-token-store";
import { AUTH_ERROR_DISK_FULL } from "@traycer-clients/shared/auth/sign-in-storage";

const IDENTITY: StoredCredentialsIdentity = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
};

function pair(token: string): StoredCredentials {
  return {
    token,
    refreshToken: `${token}-refresh`,
    savedAt: "2024-01-01T00:00:00.000Z",
    user: IDENTITY,
  };
}

interface BackingStore {
  readonly store: ITokenStore;
  readonly publishStorageLow: (low: boolean) => void;
  readonly state: {
    current: StoredCredentials | null;
    signInResult: "saved" | "disk-full";
    /** Consumed by the NEXT `signIn`: it awaits this gate before writing. */
    nextSignInGate: Promise<void> | null;
    /** When set, `deleteIfToken` rejects with this error. */
    deleteIfTokenError: Error | null;
  };
  readonly calls: string[];
}

function makeBackingStore(initial: StoredCredentials | null): BackingStore {
  const calls: string[] = [];
  const storageListeners = new Set<(low: boolean) => void>();
  const state: BackingStore["state"] = {
    current: initial,
    signInResult: "saved",
    nextSignInGate: null,
    deleteIfTokenError: null,
  };
  const store: ITokenStore = {
    getSignInStorageLow: () => Promise.resolve(false),
    subscribeSignInStorageLow: (listener) => {
      storageListeners.add(listener);
      return { dispose: () => storageListeners.delete(listener) };
    },
    get: () => {
      calls.push("get");
      return Promise.resolve(state.current);
    },
    signIn: async (
      tokens: StoredAuthTokens,
      identity: StoredCredentialsIdentity,
    ): Promise<"saved" | "disk-full"> => {
      const gate = state.nextSignInGate;
      state.nextSignInGate = null;
      if (gate !== null) {
        await gate;
      }
      calls.push("signIn");
      if (state.signInResult === "disk-full") return state.signInResult;
      state.current = {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        savedAt: "2024-01-02T00:00:00.000Z",
        user: identity,
      };
      return state.signInResult;
    },
    rotate: () => Promise.reject(new Error("rotate is not under test")),
    delete: () => {
      calls.push("delete");
      state.current = null;
      return Promise.resolve();
    },
    // The backing store owns the atomic compare-and-delete (in production:
    // one locked FileTokenStore mutation reached over one IPC call).
    deleteIfToken: (expectedToken: string) => {
      calls.push(`deleteIfToken:${expectedToken}`);
      if (state.deleteIfTokenError !== null) {
        return Promise.reject(state.deleteIfTokenError);
      }
      if (state.current === null || state.current.token !== expectedToken) {
        return Promise.resolve("kept" as const);
      }
      state.current = null;
      return Promise.resolve("deleted" as const);
    },
    subscribe: () => ({ dispose: () => undefined }),
    migrateLegacyCredentials: () =>
      Promise.reject(new Error("migration is not under test")),
  };
  return {
    store,
    state,
    calls,
    publishStorageLow: (low) => {
      for (const listener of storageListeners) listener(low);
    },
  };
}

describe("AuthTokenStore.deleteIfToken", () => {
  it("forwards the conditional delete as ONE backing operation, never get+delete", async () => {
    const backing = makeBackingStore(pair("a-token"));
    const store = new AuthTokenStore(backing.store);
    await expect(store.deleteIfToken("other-token")).resolves.toBe("kept");
    expect(backing.state.current?.token).toBe("a-token");

    await expect(store.deleteIfToken("a-token")).resolves.toBe("deleted");
    expect(backing.state.current).toBeNull();
    // The wrapper issued only the atomic backing operation each time.
    expect(backing.calls).toEqual([
      "deleteIfToken:other-token",
      "deleteIfToken:a-token",
    ]);
  });

  it("joins the mutation chain: ordered after this window's in-flight signIn", async () => {
    const backing = makeBackingStore(null);
    const store = new AuthTokenStore(backing.store);
    let releaseSignIn: () => void = () => undefined;
    backing.state.nextSignInGate = new Promise<void>((resolve) => {
      releaseSignIn = resolve;
    });

    const write = store.signIn(
      { token: "b-token", refreshToken: "b-refresh" },
      IDENTITY,
    );
    // Dispatched while the signIn is still in flight: the chain holds it
    // back, so the conditional delete observes B's landed pair and keeps it.
    const undo = store.deleteIfToken("a-token");
    releaseSignIn();
    await write;
    await expect(undo).resolves.toBe("kept");
    expect(backing.calls).toEqual(["signIn", "deleteIfToken:a-token"]);
    expect(backing.state.current?.token).toBe("b-token");
  });

  it("a backing-store fault rejects instead of resolving", async () => {
    const backing = makeBackingStore(pair("a-token"));
    backing.state.deleteIfTokenError = new Error(
      "EIO: credentials file unwritable",
    );
    const store = new AuthTokenStore(backing.store);
    await expect(store.deleteIfToken("a-token")).rejects.toThrow(
      "EIO: credentials file unwritable",
    );
    // The pair the delete failed to remove is still there — the caller must
    // hear about it, which is exactly why the rejection is not swallowed.
    expect(backing.state.current?.token).toBe("a-token");
  });
});

describe("AuthTokenStore.signIn", () => {
  it("turns the typed disk-full answer into the renderer error sentinel", async () => {
    const backing = makeBackingStore(pair("existing-token"));
    backing.state.signInResult = "disk-full";
    const store = new AuthTokenStore(backing.store);

    await expect(
      store.signIn(
        { token: "new-token", refreshToken: "new-refresh" },
        IDENTITY,
      ),
    ).rejects.toThrow(AUTH_ERROR_DISK_FULL);
    expect(backing.state.current?.token).toBe("existing-token");
  });
});

describe("AuthTokenStore.subscribeSignInStorageLow", () => {
  it("forwards main-process storage status updates and disposes the listener", () => {
    const backing = makeBackingStore(null);
    const store = new AuthTokenStore(backing.store);
    const changes: boolean[] = [];
    const subscription = store.subscribeSignInStorageLow((low) => {
      changes.push(low);
    });

    backing.publishStorageLow(true);
    subscription.dispose();
    backing.publishStorageLow(false);

    expect(changes).toEqual([true]);
  });
});
