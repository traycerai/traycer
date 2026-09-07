import { afterEach, describe, expect, it } from "vitest";
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type {
  HostLeaseSnapshot,
  SelectionAuthorityClient,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  silentAuthorityLog,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  createInProcessSelectionAuthorityClient,
  inertLocalHostOutageSignal,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import { createFakeAuthorityClock } from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { acquireRendererSelectionKernel } from "@/lib/host/renderer-selection-kernel";
import { mountSelectionAuthorityBridge } from "@/lib/host/selection-authority-bridge";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The window's kernel must survive a StrictMode remount. Drive real StrictMode; a hand-rolled double-mount does not reproduce React's ordering.
 */

const LOCAL_HOST_ID = "L";
const REMOTE_HOST_ID = "R";

interface TestAuthority {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly client: SelectionAuthorityClient;
  dispose(): void;
}

function buildAuthority(): TestAuthority {
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: LOCAL_HOST_ID,
    hosts: [
      { hostId: LOCAL_HOST_ID, kind: "local" },
      { hostId: REMOTE_HOST_ID, kind: "remote" },
    ],
  });
  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity: new InMemoryAuthorityIdentitySource("acct-1"),
    // Provisionable local host. An unavailable port would mark it dead and
    // fail over to remote, which is not under test.
    localHostEnsure: { ensureReady: () => Promise.resolve({ ok: true }) },
    localOutage: inertLocalHostOutageSignal,
    preferredStore: new InMemoryPreferredHostStore(),
    clock: createFakeAuthorityClock(0),
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  const client = createInProcessSelectionAuthorityClient(
    engine,
    silentAuthorityLog,
  );
  return {
    engine,
    client,
    dispose: () => {
      client.dispose();
      engine.dispose();
    },
  };
}

const HOST_LABELS = { labelFor: (hostId: string): string => hostId };

/** Mount the bridge on a kernel from acquire; dispose only the bridge. acquire is the variable under test. */
function KernelHost(props: {
  readonly client: SelectionAuthorityClient;
  readonly acquire: (
    client: SelectionAuthorityClient,
  ) => SelectionEvidenceKernel;
  readonly onKernel: (kernel: SelectionEvidenceKernel) => void;
}): ReactNode {
  const { client, acquire, onKernel } = props;
  useEffect(() => {
    const kernel = acquire(client);
    onKernel(kernel);
    const bridge = mountSelectionAuthorityBridge({
      client,
      kernel,
      hostLabels: HOST_LABELS,
    });
    return () => {
      bridge.dispose();
    };
  }, [acquire, client, onKernel]);
  return null;
}

/** Flushes enough microtask turns for the attach choreography to settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
  });
}

function findLease(
  leases: readonly HostLeaseSnapshot[],
  hostId: string,
): HostLeaseSnapshot | undefined {
  return leases.find((lease) => lease.hostId === hostId);
}

describe("renderer-scoped selection kernel under StrictMode", () => {
  afterEach(() => {
    cleanup();
    useSelectionAuthorityStore.getState().reset();
  });

  it("survives StrictMode's setup-cleanup-setup: one kernel, still attached, still the relay's target", async () => {
    const authority = buildAuthority();
    const kernels: SelectionEvidenceKernel[] = [];

    render(
      <StrictMode>
        <KernelHost
          client={authority.client}
          acquire={acquireRendererSelectionKernel}
          onKernel={(kernel) => {
            kernels.push(kernel);
          }}
        />
      </StrictMode>,
    );
    await settle();

    // BOTH StrictMode setups ran - that is the point of the mode - and both
    // were handed the SAME kernel. A second instance here is a second attach
    // claim against a client that can only ever honour one.
    expect(kernels.length).toBeGreaterThan(1);
    const kernel = kernels[0];
    for (const seen of kernels) expect(seen).toBe(kernel);

    // Surviving setup must stay attached. A superseded attach leaves the
    // window on a detached snapshot with no effective host.
    const snapshot = kernel.snapshot();
    expect(snapshot.attached).toBe(true);
    expect(snapshot.effectiveHostId).toBe(LOCAL_HOST_ID);
    expect(useSelectionAuthorityStore.getState().attached).toBe(true);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      LOCAL_HOST_ID,
    );

    // Module-scoped relay must still point at the surviving kernel. Cleanup
    // must not leave warm sessions reporting into a disposed kernel.
    transportEvidenceRelay.sessionEstablished(
      REMOTE_HOST_ID,
      "session-1",
      "remote-relay",
    );
    await settle();
    expect(findLease(kernel.snapshot().leases, REMOTE_HOST_ID)?.status).toBe(
      "ready",
    );

    authority.dispose();
  });

  it("CONTROL: constructing the kernel inside the effect - the shape this replaced - leaves the surviving setup detached", async () => {
    const authority = buildAuthority();
    const kernels: SelectionEvidenceKernel[] = [];
    // Control: kernel per effect, released on cleanup. Proves attach-once is
    // what the assertions measure.
    const perEffectAcquire = (
      client: SelectionAuthorityClient,
    ): SelectionEvidenceKernel => {
      const kernel = new SelectionEvidenceKernel({
        client,
        now: () => 0,
        log: silentAuthorityLog,
      });
      void kernel.start();
      return kernel;
    };

    render(
      <StrictMode>
        <KernelHost
          client={authority.client}
          acquire={perEffectAcquire}
          onKernel={(kernel) => {
            kernels.push(kernel);
          }}
        />
      </StrictMode>,
    );
    await settle();

    expect(kernels.length).toBeGreaterThan(1);
    const surviving = kernels[kernels.length - 1];
    expect(surviving).not.toBe(kernels[0]);
    expect(surviving.snapshot().attached).toBe(false);
    expect(surviving.snapshot().effectiveHostId).toBeNull();

    for (const kernel of kernels) kernel.dispose();
    authority.dispose();
  });
});
