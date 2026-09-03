import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION } from "@/lib/persist";
import {
  providerLoginTerminalProviderId,
  recordProviderLoginTerminal,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";

const PERSIST_KEY = "traycer-gui-app:provider-login-terminals";
const HOST_A = "host-a";
const HOST_B = "host-b";

function resetProviderLoginTerminalsStore(): void {
  window.localStorage.clear();
  useProviderLoginTerminalsStore.setState({
    providerBySessionKey: {},
    recentKeys: [],
  });
}

describe("useProviderLoginTerminalsStore", () => {
  beforeEach(resetProviderLoginTerminalsStore);
  afterEach(resetProviderLoginTerminalsStore);

  it("persists under the expected localStorage key", () => {
    expect(PERSIST_KEY).toBe("traycer-gui-app:provider-login-terminals");
  });

  it("record() makes the provider readable by providerLoginTerminalProviderId", () => {
    recordProviderLoginTerminal({
      hostId: HOST_A,
      sessionId: "session-1",
      providerId: "reasonix",
    });

    expect(providerLoginTerminalProviderId(HOST_A, "session-1")).toBe(
      "reasonix",
    );
  });

  it("returns null for a session that was never recorded", () => {
    expect(
      providerLoginTerminalProviderId(HOST_A, "unknown-session"),
    ).toBeNull();
  });

  it("is keyed by host + session, not session alone", () => {
    recordProviderLoginTerminal({
      hostId: HOST_A,
      sessionId: "session-1",
      providerId: "reasonix",
    });

    // Same session id, different host: an unrelated host's independent
    // terminal must never be misread as this host's sign-in.
    expect(providerLoginTerminalProviderId(HOST_B, "session-1")).toBeNull();
  });

  it("a storage event for this store's persist key rehydrates the store, making another window's record visible", async () => {
    // The write another window's own `record()` would have produced,
    // landing straight in storage without ever touching THIS window's
    // in-memory copy - the same shape `feature-announcements-store`'s
    // equivalent test uses for the identical `storage`-listener pattern.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          providerBySessionKey: {
            [`${HOST_A}:session-other-window`]: "reasonix",
          },
          recentKeys: [`${HOST_A}:session-other-window`],
        },
        version: 1,
      }),
    );
    // This window's in-memory copy has not seen it yet - only the raw
    // localStorage write above knows about it so far.
    expect(
      providerLoginTerminalProviderId(HOST_A, "session-other-window"),
    ).toBeNull();

    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    // The listener's rehydrate() is asynchronous.
    await Promise.resolve();
    await Promise.resolve();

    expect(
      providerLoginTerminalProviderId(HOST_A, "session-other-window"),
    ).toBe("reasonix");
  });

  describe("record() merges against what is on disk before writing", () => {
    it("keeps a concurrent window's on-disk session instead of dropping it", () => {
      // Window A's write, landing straight in storage exactly as it would if
      // this window completed its OWN sign-in before ever seeing window A's
      // `storage` event - no rehydrate, nothing routed through this store's
      // own actions.
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            providerBySessionKey: {
              [`${HOST_A}:session-window-a`]: "reasonix",
            },
            recentKeys: [`${HOST_A}:session-window-a`],
          },
          version: CURRENT_PERSIST_VERSION,
        }),
      );
      // This window's in-memory copy has not seen it yet.
      expect(
        providerLoginTerminalProviderId(HOST_A, "session-window-a"),
      ).toBeNull();

      // This window completes its own sign-in, for a DIFFERENT session, while
      // window A's write above is still unseen.
      recordProviderLoginTerminal({
        hostId: HOST_B,
        sessionId: "session-window-b",
        providerId: "copilot",
      });

      // Both sessions are readable afterwards - window A's origin was merged
      // in, not overwritten.
      expect(providerLoginTerminalProviderId(HOST_A, "session-window-a")).toBe(
        "reasonix",
      );
      expect(providerLoginTerminalProviderId(HOST_B, "session-window-b")).toBe(
        "copilot",
      );
      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          providerBySessionKey: {
            [`${HOST_B}:session-window-b`]: "copilot",
            [`${HOST_A}:session-window-a`]: "reasonix",
          },
          recentKeys: [
            `${HOST_B}:session-window-b`,
            `${HOST_A}:session-window-a`,
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("a non-JSON persisted payload degrades to no shared records, without throwing", () => {
      window.localStorage.setItem(PERSIST_KEY, "not valid json{");

      expect(() =>
        recordProviderLoginTerminal({
          hostId: HOST_A,
          sessionId: "session-garbage",
          providerId: "reasonix",
        }),
      ).not.toThrow();

      expect(providerLoginTerminalProviderId(HOST_A, "session-garbage")).toBe(
        "reasonix",
      );
      // The write is not corrupted by the garbage it replaced.
      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          providerBySessionKey: {
            [`${HOST_A}:session-garbage`]: "reasonix",
          },
          recentKeys: [`${HOST_A}:session-garbage`],
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("valid JSON of the wrong shape degrades to no shared records, without throwing", () => {
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify({ state: 5 }));

      expect(() =>
        recordProviderLoginTerminal({
          hostId: HOST_A,
          sessionId: "session-wrong-shape",
          providerId: "reasonix",
        }),
      ).not.toThrow();

      expect(
        providerLoginTerminalProviderId(HOST_A, "session-wrong-shape"),
      ).toBe("reasonix");
      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          providerBySessionKey: {
            [`${HOST_A}:session-wrong-shape`]: "reasonix",
          },
          recentKeys: [`${HOST_A}:session-wrong-shape`],
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("a providerBySessionKey entry whose value is not a valid provider id is dropped, without throwing", () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            providerBySessionKey: {
              [`${HOST_A}:session-bad-provider`]: "not-a-real-provider",
            },
            recentKeys: [`${HOST_A}:session-bad-provider`],
          },
          version: CURRENT_PERSIST_VERSION,
        }),
      );

      expect(() =>
        recordProviderLoginTerminal({
          hostId: HOST_B,
          sessionId: "session-ok",
          providerId: "copilot",
        }),
      ).not.toThrow();

      expect(providerLoginTerminalProviderId(HOST_B, "session-ok")).toBe(
        "copilot",
      );
      // The malformed entry never comes back as a provider - dropped, not
      // smuggled through as some truthy placeholder. Its eviction-order key
      // is preserved (that array is not schema-validated against provider
      // ids), but nothing maps it to a provider any more.
      expect(
        providerLoginTerminalProviderId(HOST_A, "session-bad-provider"),
      ).toBeNull();
      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          providerBySessionKey: {
            [`${HOST_B}:session-ok`]: "copilot",
          },
          recentKeys: [
            `${HOST_B}:session-ok`,
            `${HOST_A}:session-bad-provider`,
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("keeps the MAX_TRACKED_SESSIONS (32) bound after a merge, and the newly recorded key survives eviction", () => {
      const sharedProviderBySessionKey: Record<string, string> = {};
      const sharedRecentKeys: string[] = [];
      for (let i = 0; i < 32; i++) {
        const key = `${HOST_A}:session-${i}`;
        sharedProviderBySessionKey[key] = "reasonix";
        sharedRecentKeys.push(key);
      }
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            providerBySessionKey: sharedProviderBySessionKey,
            recentKeys: sharedRecentKeys,
          },
          version: CURRENT_PERSIST_VERSION,
        }),
      );

      recordProviderLoginTerminal({
        hostId: HOST_B,
        sessionId: "session-new",
        providerId: "copilot",
      });

      const state = useProviderLoginTerminalsStore.getState();
      expect(state.recentKeys).toHaveLength(32);
      expect(providerLoginTerminalProviderId(HOST_B, "session-new")).toBe(
        "copilot",
      );
      // The globally least-recently-seen shared entry (the last of the 32
      // already on disk) is the one evicted to hold the bound.
      expect(providerLoginTerminalProviderId(HOST_A, "session-31")).toBeNull();
      // The rest of the shared entries, and the new key, survive the merge.
      expect(providerLoginTerminalProviderId(HOST_A, "session-0")).toBe(
        "reasonix",
      );
      expect(providerLoginTerminalProviderId(HOST_A, "session-30")).toBe(
        "reasonix",
      );
    });
  });
});
