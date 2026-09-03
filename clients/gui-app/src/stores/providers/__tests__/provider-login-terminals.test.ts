import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
