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
 * WHICH CHANGE EVENTS RESET THE RUNTIME MESSENGER (redesign P4.2).
 *
 * This filter had no coverage for its entire life, and that is why it needs
 * some now. `HostRuntimeProvider` used to run this reset on EVERY `HostClient`
 * change event without reading one - survivable only because the active slot
 * gated the announcing path, so an availability recovery on a host that was
 * not the bound one never reached it. P4.2 deleted that gate:
 * `notifyHostAvailabilityRecovered` names its host and always announces, so an
 * unfiltered listener would reset the messenger and retire sessions on every
 * durable-tab heartbeat recovery - tearing down the very binding delivering
 * the news.
 *
 * It is also the precondition the availability-entry-point collapse rests on:
 * the collapse is safe *because* recovery cannot reach this reset, which stays
 * true only while this filter does.
 *
 * MECHANISM REAL, OBSERVABLES FAKE. The subject is the PRODUCTION factory,
 * imported - not a re-typed replica, which would pin a copy and go green while
 * the provider's real filter widened underneath it. It is subscribed to a real
 * `HostClient` through the real `onChange`, and both cases drive a real
 * emission through the client's own entry points (`setRequestContext` /
 * `notifyHostAvailabilityRecovered`) - never the handler directly. Only the
 * two things the handler calls are spies.
 *
 * KNOWN LIMIT, stated where it bites: this pins the filter and both of its
 * dispositions. It does NOT pin that `HostRuntimeProvider` installs it -
 * deleting the `onChange` call there leaves this suite green. That edge is
 * uncovered because no gui-app suite gets the real provider through startup
 * (every provider-mounting harness supplies a `messengerFactory`, which skips
 * the messenger-construction branch this reset is about).
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

    // LIVENESS CONTROL for the case below: both spies are reachable from a
    // real emission through the real subscription. Without this, "neither
    // fired" there would pass just as well against spies wired to nothing.
    expect(resetMessenger).toHaveBeenCalledTimes(1);
    expect(sweepRetiredSessions).toHaveBeenCalledTimes(1);
  });

  it("does NOT reset on an availability recovery, whichever host recovered", async () => {
    const { client, resetMessenger, sweepRetiredSessions } = buildSubject();

    // The announcing entry point, named-host form - what the app-wide stream's
    // recovery wiring and every durable per-tab transport call. Post-P4.2 this
    // announces for ANY host, so an unfiltered listener would reset here.
    client.notifyHostAvailabilityRecovered(mockLocalHostEntry.hostId);
    // Delivery is coalesced onto a microtask; flush before asserting absence,
    // or "did not fire" is just "has not fired yet".
    await Promise.resolve();

    expect(resetMessenger).not.toHaveBeenCalled();
    expect(sweepRetiredSessions).not.toHaveBeenCalled();
  });
});
