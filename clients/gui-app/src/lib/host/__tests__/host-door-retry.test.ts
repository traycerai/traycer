import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireHostConnection,
  resetHostConnectionRegistryForTest,
  type HostConnectionLease,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import type { HostTokenMintOutcome } from "@traycer-clients/shared/auth/host-token-source";
import { inertHostTokenSource } from "../../../../__tests__/create-fake-runner-host";
import { onHostDoorRetry, retryHostDoor } from "@/lib/host/host-door-retry";
import {
  hostDoorStateFor,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_ID = "user-retry";
const HOST_ID = "host-retry";
const OTHER_HOST_ID = "host-other";

const fatalClose = {
  kind: "fatalError",
  details: {
    code: "UNAUTHORIZED",
    reason: "The host refused the credential.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
} as const;

const heldLeases: HostConnectionLease[] = [];
const ownerUnsubscribers: Array<() => void> = [];

function signedInAsRetryUser(): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: USER_ID, username: USER_ID },
  });
}

function armReopenLane(hostId: string): { readonly reopenCount: () => number } {
  let reopenCount = 0;
  const lease = acquireHostConnection(hostId);
  heldLeases.push(lease);
  const lane = lease.reconnect.openReopenLane(() => {
    reopenCount += 1;
  }, isReopenableHostStreamClose);
  lane.scheduleAfterClose(fatalClose);
  return { reopenCount: () => reopenCount };
}

function tokenExpiredState(): {
  readonly hostId: string;
  readonly kind: "token-expired";
  readonly detail: { readonly code: string; readonly doorReason: string };
} {
  return {
    hostId: HOST_ID,
    kind: "token-expired",
    detail: { code: "UNAUTHORIZED", doorReason: "token_expired" },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const unsubscribe of ownerUnsubscribers.splice(0)) unsubscribe();
  for (const lease of heldLeases.splice(0)) lease.release();
  resetHostConnectionRegistryForTest();
  useHostDoorStateStore.setState({ byHost: new Map() });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  vi.useRealTimers();
});

describe("retryHostDoor", () => {
  it("waits for a fresh token before reopening a token-expired host", async () => {
    signedInAsRetryUser();
    const state = tokenExpiredState();
    noteHostDoorState(state);
    const lane = armReopenLane(HOST_ID);
    const hostTokens = inertHostTokenSource();
    const pendingObtain: {
      resolve: ((outcome: HostTokenMintOutcome) => void) | null;
    } = { resolve: null };
    const obtain = vi.spyOn(hostTokens, "obtain").mockImplementation(
      () =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          pendingObtain.resolve = resolve;
        }),
    );

    const retry = retryHostDoor(HOST_ID, hostTokens);

    expect(obtain).toHaveBeenCalledWith(USER_ID, HOST_ID, true, null);
    expect(lane.reopenCount()).toBe(0);
    if (pendingObtain.resolve === null)
      throw new Error("token obtain did not start");
    pendingObtain.resolve({ kind: "no-sign-in" });
    await retry;

    expect(lane.reopenCount()).toBe(1);
    expect(hostDoorStateFor(HOST_ID)).toEqual(state);
  });

  it("reopens a keys-unavailable host without minting a token", async () => {
    signedInAsRetryUser();
    const state = {
      hostId: HOST_ID,
      kind: "keys-unavailable",
      detail: { code: "NETWORK_ERROR", doorReason: "keys_unavailable" },
    } as const;
    noteHostDoorState(state);
    const lane = armReopenLane(HOST_ID);
    const hostTokens = inertHostTokenSource();
    const obtain = vi.spyOn(hostTokens, "obtain");

    await retryHostDoor(HOST_ID, hostTokens);

    expect(obtain).not.toHaveBeenCalled();
    expect(lane.reopenCount()).toBe(1);
    expect(hostDoorStateFor(HOST_ID)).toEqual(state);
  });

  it("reopens even when obtaining a replacement token rejects", async () => {
    signedInAsRetryUser();
    const state = tokenExpiredState();
    noteHostDoorState(state);
    const lane = armReopenLane(HOST_ID);
    const hostTokens = inertHostTokenSource();
    const failure = new Error("authn is unavailable");
    vi.spyOn(hostTokens, "obtain").mockRejectedValue(failure);

    await expect(retryHostDoor(HOST_ID, hostTokens)).rejects.toBe(failure);

    expect(lane.reopenCount()).toBe(1);
    expect(hostDoorStateFor(HOST_ID)).toEqual(state);
  });

  it("runs only the subscribed owner for the retried host", async () => {
    const lane = armReopenLane(HOST_ID);
    const hostOwner = vi.fn();
    const otherHostOwner = vi.fn();
    const removedOwner = vi.fn();
    ownerUnsubscribers.push(onHostDoorRetry(HOST_ID, hostOwner));
    ownerUnsubscribers.push(onHostDoorRetry(OTHER_HOST_ID, otherHostOwner));
    const removeOwner = onHostDoorRetry(HOST_ID, removedOwner);
    removeOwner();

    await retryHostDoor(HOST_ID, inertHostTokenSource());

    expect(hostOwner).toHaveBeenCalledTimes(1);
    expect(otherHostOwner).not.toHaveBeenCalled();
    expect(removedOwner).not.toHaveBeenCalled();
    expect(lane.reopenCount()).toBe(1);
    expect(hostDoorStateFor(HOST_ID)).toBeNull();
  });
});
