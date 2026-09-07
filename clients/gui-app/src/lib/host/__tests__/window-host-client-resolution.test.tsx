import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, use, type ReactNode } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

/**
 * `useHostClient()` is the app-wide host client: the SELECTION LAYER's `effectiveHostId` resolved through `createRequesterForHostId` (redesign P2.1, then P4.2 deleted the runtime client's privileged active slot entirely).
 */
const spineRef = vi.hoisted<{ value: HostClient<HostRpcRegistry> | null }>(
  () => ({ value: null }),
);

function getSpine(): HostClient<HostRpcRegistry> {
  if (spineRef.value === null) {
    throw new Error("test spine not configured");
  }
  return spineRef.value;
}

/** The APP-WIDE binding, as the provider publishes it: the spine, naming no host. */
interface ProbeBinding {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

const bindingRef = vi.hoisted<{ value: ProbeBinding | null }>(() => ({
  value: null,
}));

vi.mock("@/providers/host-runtime-provider", () => {
  // ONE context for the module's lifetime, so a test can re-provide into the same object `runtime.ts` reads from.
  // `createHostRuntime` is called once at module scope, but a fresh context per call would still break a suite that imported the export and rendered a Provider with it.
  const context = createContext<ProbeBinding | null>(null);
  return {
    createHostRuntimeState: () => ({
      context: createContext(null),
      bindingSnapshot: { value: null },
    }),
    createHostRuntime: () => ({
      HostRuntimeProvider: () => null,
      HostRuntimeContext: context,
      useHostClient: getSpine,
      useHostDirectory: () => null,
      useAuthService: () => null,
      // Context first, ambient second - the real provider's own shape.
      // A panel that re-provides is BELOW the app-wide provider, and a subtree with no re-provide sees the app-wide binding, which is exactly what `null` from `useScopedHostBinding` means at a panel's own render.
      useHostBinding: () => use(context) ?? bindingRef.value,
      getBindingSnapshot: () => null,
    }),
  };
});

import { HostRuntimeContext, useHostClient } from "@/lib/host/runtime";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const HOST_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

const directory: HostDirectoryEntry[] = [mockLocalHostEntry, HOST_B];

function applyEffectiveHostId(hostId: string | null): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

const messengerRef: { value: MockHostMessenger<HostRpcRegistry> | null } = {
  value: null,
};

beforeEach(() => {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: { "terminal.kill": () => ({ killed: true }) },
  });
  messengerRef.value = messenger;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (hostId) =>
      directory.find((entry) => entry.hostId === hostId) ?? null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  spineRef.value = spine;
  bindingRef.value = { hostClient: spine, hostId: null };
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  spineRef.value = null;
  bindingRef.value = null;
  messengerRef.value = null;
});

describe("useHostClient", () => {
  it("addresses the effective host", () => {
    // This used to also assert a CONTROL: the runtime client's own active slot stayed parked on the local host, so an implementation that read the slot instead of the selection layer would have answered `mock-local` here.
    applyEffectiveHostId(HOST_B.hostId);

    const { result } = renderHook(() => useHostClient());

    expect(result.current.getActiveHostId()).toBe(HOST_B.hostId);
    expect(result.current.getActiveHost()).toEqual(HOST_B);
  });

  it("re-points when the effective host moves, and hands back a stable client while it does not", () => {
    applyEffectiveHostId(mockLocalHostEntry.hostId);

    const { result, rerender } = renderHook(() => useHostClient());
    const first = result.current;
    rerender();
    // Stable across renders: consumers put this in effect/memo deps, and a
    // fresh identity per render would resubscribe every one of them.
    expect(result.current).toBe(first);

    applyEffectiveHostId(HOST_B.hostId);
    expect(result.current).not.toBe(first);
    expect(result.current.getActiveHostId()).toBe(HOST_B.hostId);
    // The client from the earlier paint keeps addressing the host it
    // resolved - it does not follow the app.
    expect(first.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
  });

  it("reports ∅ when no host is effective", () => {
    applyEffectiveHostId(null);

    const { result } = renderHook(() => useHostClient());

    expect(result.current.getActiveHostId()).toBe(null);
  });

  it("sends a request to the effective host", async () => {
    applyEffectiveHostId(HOST_B.hostId);

    const { result } = renderHook(() => useHostClient());
    await expect(
      result.current.request("terminal.kill", { sessionId: "session-a" }),
    ).resolves.toEqual({ killed: true });
    // Resolving is not enough: the mock answers for any host, so the ENDPOINT
    // is what says the call went to `host-b` rather than to the slot.
    expect(messengerRef.value?.calls).toHaveLength(1);
    expect(messengerRef.value?.calls[0]?.authority.endpoint.hostId).toBe(
      HOST_B.hostId,
    );
    expect(messengerRef.value?.calls[0]?.authority.endpoint.websocketUrl).toBe(
      HOST_B.websocketUrl,
    );
  });
});

/** A binding that NAMES a host wins over the app-wide effective host. */
describe("useHostClient under a re-provided binding", () => {
  /** The pinned client a scoped panel re-provides, built the way one really is. */
  function requesterForHostB(): HostClient<HostRpcRegistry> {
    return getSpine().createRequesterForHostId(HOST_B.hostId);
  }

  function scopeShowingHostB(overrides: Partial<HostScope>): HostScope {
    // `host`, not `hostId`: the fixture DERIVES `hostId` from `host` (`host?.hostId ?? null`), so passing `hostId` alone would leave `host` naming the default `host-a` and the two disagreeing inside the fixture.
    return hostScopeFixture({
      host: hostScopeOptionFixture({ hostId: HOST_B.hostId }),
      ...overrides,
    });
  }

  const seenClient: { value: HostClient<HostRpcRegistry> | null } = {
    value: null,
  };

  function HostClientProbe(): ReactNode {
    seenClient.value = useHostClient();
    return null;
  }

  /** The production arrangement, verbatim: `providers-settings-panel.tsx:336`. */
  function ScopedPanel(props: { readonly scope: HostScope }): ReactNode {
    const scopedBinding = useScopedHostBinding(props.scope);
    if (scopedBinding === null) return <HostClientProbe />;
    return (
      <HostRuntimeContext.Provider value={scopedBinding}>
        <HostClientProbe />
      </HostRuntimeContext.Provider>
    );
  }

  async function endpointHostIdOfNextRequest(): Promise<string | undefined> {
    const client = seenClient.value;
    if (client === null) throw new Error("probe never resolved a client");
    await client.request("terminal.kill", { sessionId: "session-a" });
    expect(messengerRef.value?.calls).toHaveLength(1);
    return messengerRef.value?.calls[0]?.authority.endpoint.hostId;
  }

  beforeEach(() => {
    seenClient.value = null;
    // The app is on A for every case here. Without this the two sources could
    // agree and no case below could distinguish them.
    applyEffectiveHostId(mockLocalHostEntry.hostId);
    expect(HOST_B.hostId).not.toBe(mockLocalHostEntry.hostId);
  });

  it("sends the request to the binding's host, not the effective one", async () => {
    bindingRef.value = {
      hostClient: requesterForHostB(),
      hostId: HOST_B.hostId,
    };

    render(<HostClientProbe />);

    await expect(endpointHostIdOfNextRequest()).resolves.toBe(HOST_B.hostId);
  });

  it("falls back to the effective host when the binding names none - SAME client object", async () => {
    // The control, and it is the sharp one: byte-identical binding except for `hostId`.
    // If this landed on B too, the case above would prove only that a pinned client stays pinned - which was already true - rather than that `hostId` is what decides.
    bindingRef.value = { hostClient: requesterForHostB(), hostId: null };

    render(<HostClientProbe />);

    await expect(endpointHostIdOfNextRequest()).resolves.toBe(
      mockLocalHostEntry.hostId,
    );
  });

  it("reaches the scoped host through the real useScopedHostBinding re-provide", async () => {
    // The PRODUCER, not a hand-built binding: a panel showing host B while the app is on A, arranged exactly as `providers-settings-panel` arranges it.
    render(
      <ScopedPanel
        scope={scopeShowingHostB({
          status: "ready",
          client: requesterForHostB(),
        })}
      />,
    );

    await expect(endpointHostIdOfNextRequest()).resolves.toBe(HOST_B.hostId);
  });

  it("keeps a following scope on the effective host so it can still re-point", async () => {
    // `following` means "track the app", so the binding must name NO host even though the scope names one.
    // Pinning it here would freeze the panel on whichever host was effective when it mounted - auto-follow deleted, and nothing else in the suite would notice.
    render(
      <ScopedPanel
        scope={scopeShowingHostB({
          status: "following",
          client: requesterForHostB(),
        })}
      />,
    );

    await expect(endpointHostIdOfNextRequest()).resolves.toBe(
      mockLocalHostEntry.hostId,
    );
  });
});
