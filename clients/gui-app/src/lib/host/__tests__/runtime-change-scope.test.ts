import { describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostClient,
  type HostQueryInvalidationOptions,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RpcSchedulingPolicy } from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import { buildRuntimeChangeScopeHandler } from "../runtime-change-scope";

/**
 * Pins the production runtime-messenger reset filter: availability recovery must not reset the messenger.
 * Does not pin that `HostRuntimeProvider` installs it.
 */

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: () => "latest",
  joinResponseTimeoutMs: () => null,
};

class NoopInvalidator implements IHostQueryInvalidator {
  invalidateHostScope(
    _hostId: string | null,
    _options: HostQueryInvalidationOptions,
  ): void {
    return;
  }
}

function buildSubject(): {
  readonly client: HostClient<typeof registry>;
  readonly resetMessenger: Mock<() => void>;
  readonly sweepRetiredSessions: Mock<() => void>;
} {
  const client = new HostClient({
    registry,
    messenger: new MockHostMessenger<typeof registry>({
      registry,
      handlers: { "host.ping": () => ({ pong: true }) },
      requestId: () => "req-1",
    }),
    invalidator: new NoopInvalidator(),
    schedulingPolicy,
    requestCoordinator: null,
  });
  const resetMessenger = vi.fn();
  const sweepRetiredSessions = vi.fn();
  // The PRODUCTION handler, on the PRODUCTION channel.
  client.onChange(
    buildRuntimeChangeScopeHandler({ resetMessenger, sweepRetiredSessions }),
  );
  return { client, resetMessenger, sweepRetiredSessions };
}

describe("runtime messenger reset is scoped to auth-changed", () => {
  it("resets the messenger and sweeps retired sessions on an identity transition", () => {
    const { client, resetMessenger, sweepRetiredSessions } = buildSubject();

    // null -> context IS an identity transition (it is what signing in does),
    // which is the emission this reset exists for.
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer" }),
    );

    // LIVENESS CONTROL for the case below: both spies are reachable from a real emission through the real subscription.
    // Without this, "neither fired" there would pass just as well against spies wired to nothing.
    expect(resetMessenger).toHaveBeenCalledTimes(1);
    expect(sweepRetiredSessions).toHaveBeenCalledTimes(1);
  });

  it("does NOT reset on an availability recovery, whichever host recovered", async () => {
    const { client, resetMessenger, sweepRetiredSessions } = buildSubject();

    // The announcing entry point, named-host form - what the app-wide stream's recovery wiring and every durable per-tab transport call.
    // Post-P4.2 this announces for ANY host, so an unfiltered listener would reset here.
    client.notifyHostAvailabilityRecovered(mockLocalHostEntry.hostId);
    // Delivery is coalesced onto a microtask; flush before asserting absence,
    // or "did not fire" is just "has not fired yet".
    await Promise.resolve();

    expect(resetMessenger).not.toHaveBeenCalled();
    expect(sweepRetiredSessions).not.toHaveBeenCalled();
  });
});
