import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  getFocusedComposerControls,
  registerFocusedComposerControls,
  resetFocusedComposerControlsForTests,
  subscribeFocusedComposerControls,
} from "@/lib/commands/composer-controls-registry";
import type { HostRpcRegistry } from "@/lib/host";

function noopControls() {
  return {
    setSelection: () => undefined,
    setReasoning: () => undefined,
    setServiceTier: () => undefined,
    setPermission: () => undefined,
    switchHarness: () => undefined,
    selectModel: () => undefined,
  };
}

/**
 * A real, distinct `HostClient` instance (never a cast) so identity
 * assertions on `FocusedComposerEntry.hostClient` compare the exact object a
 * test registered. Never actually dispatched - nothing in this file issues a
 * real RPC through it.
 */
function buildTestHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = {
    hostId,
    label: hostId,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

describe("focused composer controls registry", () => {
  afterEach(() => {
    resetFocusedComposerControlsForTests();
  });

  it("starts empty", () => {
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("registers an entry and exposes it via getter", () => {
    const controls = noopControls();
    const dispose = registerFocusedComposerControls("landing", controls, null);
    const entry = getFocusedComposerControls();
    expect(entry?.kind).toBe("landing");
    expect(entry?.controls).toBe(controls);
    dispose();
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("the latest registration wins; disposing the winner clears the slot", () => {
    const first = noopControls();
    const second = noopControls();
    registerFocusedComposerControls("landing", first, null);
    const disposeSecond = registerFocusedComposerControls(
      "chat-tile",
      second,
      null,
    );
    expect(getFocusedComposerControls()?.controls).toBe(second);
    disposeSecond();
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("disposing a non-winner is a no-op (slot keeps the winner)", () => {
    const first = noopControls();
    const second = noopControls();
    const disposeFirst = registerFocusedComposerControls(
      "landing",
      first,
      null,
    );
    registerFocusedComposerControls("chat-tile", second, null);
    disposeFirst();
    expect(getFocusedComposerControls()?.controls).toBe(second);
  });

  it("notifies subscribers on register and on dispose", () => {
    let calls = 0;
    const dispose = subscribeFocusedComposerControls(() => {
      calls += 1;
    });
    const disposeRegister = registerFocusedComposerControls(
      "landing",
      noopControls(),
      null,
    );
    expect(calls).toBe(1);
    disposeRegister();
    expect(calls).toBe(2);
    dispose();
  });

  it("exposes the hostClient passed in; re-registering the same kind with a different client replaces it (last wins)", () => {
    const clientA = buildTestHostClient("host-a");
    const clientB = buildTestHostClient("host-b");

    registerFocusedComposerControls("landing", noopControls(), clientA);
    expect(getFocusedComposerControls()?.hostClient).toBe(clientA);

    registerFocusedComposerControls("landing", noopControls(), clientB);
    expect(getFocusedComposerControls()?.hostClient).toBe(clientB);
  });
});
