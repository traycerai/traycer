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

  /** The payload a browser puts on `newValue` for a peer window's write. */
  function persistedPayload(
    providerBySessionKey: Readonly<Record<string, string>>,
  ): string {
    return JSON.stringify({
      state: {
        providerBySessionKey,
        recentKeys: Object.keys(providerBySessionKey),
      },
      version: CURRENT_PERSIST_VERSION,
    });
  }

  it("a storage event for this store's persist key makes another window's record visible", () => {
    const newValue = persistedPayload({
      [`${HOST_A}:session-other-window`]: "reasonix",
    });
    // The write another window's own `record()` would have produced, landing
    // straight in storage without ever touching THIS window's in-memory copy.
    window.localStorage.setItem(PERSIST_KEY, newValue);
    // This window's in-memory copy has not seen it yet - only the raw
    // localStorage write above knows about it so far.
    expect(
      providerLoginTerminalProviderId(HOST_A, "session-other-window"),
    ).toBeNull();

    // A real `storage` event carries the written value; the listener reads it
    // rather than re-reading storage, so the fixture has to carry it too.
    window.dispatchEvent(
      new StorageEvent("storage", { key: PERSIST_KEY, newValue }),
    );

    expect(
      providerLoginTerminalProviderId(HOST_A, "session-other-window"),
    ).toBe("reasonix");
  });

  it("a storage event MERGES rather than replacing, so this window's own record survives a peer's overwriting write", () => {
    recordProviderLoginTerminal({
      hostId: HOST_A,
      sessionId: "session-this-window",
      providerId: "reasonix",
    });

    // The peer read storage before this window wrote, so ITS write does not
    // mention this window's session at all. Rehydrating from it would adopt
    // that loss; the union keeps both. An unclassified live session is one a
    // tile recreates as a bare shell, so the loss is not cosmetic.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PERSIST_KEY,
        newValue: persistedPayload({
          [`${HOST_B}:session-peer-window`]: "copilot",
        }),
      }),
    );

    expect(providerLoginTerminalProviderId(HOST_A, "session-this-window")).toBe(
      "reasonix",
    );
    expect(providerLoginTerminalProviderId(HOST_B, "session-peer-window")).toBe(
      "copilot",
    );
  });

  it("a storage event for an unrelated key is ignored", () => {
    recordProviderLoginTerminal({
      hostId: HOST_A,
      sessionId: "session-1",
      providerId: "reasonix",
    });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "traycer-gui-app:some-other-store",
        newValue: persistedPayload({}),
      }),
    );

    expect(providerLoginTerminalProviderId(HOST_A, "session-1")).toBe(
      "reasonix",
    );
  });

  it("a malformed peer payload is dropped without throwing, leaving this window's records intact", () => {
    recordProviderLoginTerminal({
      hostId: HOST_A,
      sessionId: "session-1",
      providerId: "reasonix",
    });

    expect(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PERSIST_KEY,
          newValue: JSON.stringify({ state: { providerBySessionKey: null } }),
        }),
      ),
    ).not.toThrow();

    // A merged-in `providerBySessionKey: null` would make the read below throw
    // at the very moment it is asked whether a live session is a sign-in.
    expect(providerLoginTerminalProviderId(HOST_A, "session-1")).toBe(
      "reasonix",
    );
  });

  describe("hydration validates the persisted payload", () => {
    it("a persisted providerBySessionKey of null does not replace the map", async () => {
      // Zustand's DEFAULT merge is `{...current, ...persisted}`, so this would
      // land verbatim and the read below would throw on `null[key]` - at the
      // very moment it is asked whether a live session is a sign-in. Version
      // gating does not cover it: the malformed value carries the current
      // version.
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: { providerBySessionKey: null, recentKeys: null },
          version: CURRENT_PERSIST_VERSION,
        }),
      );

      await useProviderLoginTerminalsStore.persist.rehydrate();

      expect(() =>
        providerLoginTerminalProviderId(HOST_A, "session-1"),
      ).not.toThrow();
      expect(providerLoginTerminalProviderId(HOST_A, "session-1")).toBeNull();
      expect(useProviderLoginTerminalsStore.getState().recentKeys).toEqual([]);
      // The store is still usable afterwards - the guard degraded the payload,
      // it did not leave the store in a shape `record()` cannot write to.
      recordProviderLoginTerminal({
        hostId: HOST_A,
        sessionId: "session-after",
        providerId: "reasonix",
      });
      expect(providerLoginTerminalProviderId(HOST_A, "session-after")).toBe(
        "reasonix",
      );
    });

    it("a persisted payload keeps its valid entries and drops only the invalid ones", async () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            providerBySessionKey: {
              [`${HOST_A}:session-good`]: "reasonix",
              [`${HOST_A}:session-bad`]: { nested: true },
            },
            recentKeys: [`${HOST_A}:session-good`, 7],
          },
          version: CURRENT_PERSIST_VERSION,
        }),
      );

      await useProviderLoginTerminalsStore.persist.rehydrate();

      expect(providerLoginTerminalProviderId(HOST_A, "session-good")).toBe(
        "reasonix",
      );
      expect(providerLoginTerminalProviderId(HOST_A, "session-bad")).toBeNull();
      expect(useProviderLoginTerminalsStore.getState().recentKeys).toEqual([
        `${HOST_A}:session-good`,
      ]);
    });
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
