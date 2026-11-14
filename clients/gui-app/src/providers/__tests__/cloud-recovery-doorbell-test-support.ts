import { act } from "@testing-library/react";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";

const DOORBELL_METHOD = "cloud.recovered.subscribe";

/** The stream clients the doorbell dialed, per host, and the hosts whose manifest lacks the doorbell method. */
export const doorbellHosts: {
  readonly clients: Map<string, FakeStreamClient>;
  readonly unsupportedHosts: Set<string>;
} = {
  clients: new Map(),
  unsupportedHosts: new Set(),
};

/** The directory entry of the host whose read failed, for the suite's `vi.mock` of `use-host-directory-entry`. */
export const doorbellHostDirectoryEntryMock = {
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null ? null : { ...mockRemoteHostEntry, hostId },
};

/** No stream-auth revalidation, for the suite's `vi.mock` of `stream-auth-revalidator`. */
export const doorbellStreamAuthRevalidatorMock = {
  useStreamAuthRevalidator: () => null,
};

/** One fake stream client per host, for the suite's `vi.mock` of `use-host-stream-client-for`. */
export const doorbellStreamClientForMock = {
  useHostStreamClientFor: (target: { readonly hostId: string } | null) => {
    if (target === null) return null;
    const existing = doorbellHosts.clients.get(target.hostId);
    if (existing !== undefined) return existing;
    const created = new FakeStreamClient(true);
    if (doorbellHosts.unsupportedHosts.has(target.hostId)) {
      created.methodSupport = "unsupported";
    }
    doorbellHosts.clients.set(target.hostId, created);
    return created;
  },
};

/** Every doorbell subscription opened to `hostId` so far. */
export function doorbellsOf(hostId: string): FakeStreamSession[] {
  const client = doorbellHosts.clients.get(hostId);
  if (client === undefined) return [];
  return client.sessions.filter(
    (_session, index) => client.subscribes[index]?.method === DOORBELL_METHOD,
  );
}

/** The doorbell subscriptions to `hostId` that are still open. */
export function liveDoorbellsOf(hostId: string): FakeStreamSession[] {
  return doorbellsOf(hostId).filter((session) => !session.closed);
}

/** Has `hostId`'s open doorbell ring `recovered`; fails when none is open. */
export function ringDoorbell(hostId: string): void {
  const session = liveDoorbellsOf(hostId).at(-1);
  if (session === undefined) throw new Error(`no doorbell open to ${hostId}`);
  act(() => {
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
  });
}

/** Forgets every host's stream client; call it from each suite's `afterEach`. */
export function resetDoorbellHosts(): void {
  doorbellHosts.clients.clear();
  doorbellHosts.unsupportedHosts.clear();
}
