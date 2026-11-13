import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type HostFleetEntry,
} from "../selection-authority-contract";
import {
  createFakeAuthorityClock,
  createTestAuthority,
  fleetHost,
  type TestAuthority,
} from "./selection-authority-harness";

const reporterId = "local-team-fallback-window";
const identityKey = "local-team-fallback-user";

function remoteHost(hostId: string, teamOwned: boolean): HostFleetEntry {
  return { hostId, kind: "remote", teamOwned };
}

function attachReporter(engine: TestAuthority["engine"]): string {
  const attachSeq = engine.allocateAttachSeq(reporterId);
  const result = engine.attach(reporterId, {
    attachSeq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!result.ok) throw new Error("expected the selection reporter to attach");
  return result.incarnationId;
}

function proveReady(
  authority: TestAuthority,
  incarnationId: string,
  hostId: string,
): void {
  authority.engine.ingestEvidence(reporterId, incarnationId, {
    kind: "session",
    hostId,
    sessionId: `${hostId}-ready-session`,
    transition: "established",
    transportKind: "remote-relay",
    at: 0,
  });
}

describe("SelectionAuthorityEngine local team fallback", () => {
  it("skips a previously effective remote team host in MRU order", async () => {
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [remoteHost("team", false), fleetHost("personal", "remote")],
      },
      initialIdentityKey: identityKey,
      clock: createFakeAuthorityClock(0),
    });
    const { engine, fleet, preferredStore } = authority;
    const incarnationId = attachReporter(engine);

    await expect(
      engine.activate(reporterId, incarnationId, "team"),
    ).resolves.toEqual({ ok: true });
    expect(engine.snapshot().effectiveHostId).toBe("team");
    proveReady(authority, incarnationId, "team");
    proveReady(authority, incarnationId, "personal");

    fleet.publish(0, null, [
      remoteHost("team", true),
      fleetHost("personal", "remote"),
    ]);

    expect(engine.snapshot().preferredHostId).toBeNull();
    expect(preferredStore.load(identityKey)).toBeNull();
    expect(engine.snapshot().effectiveHostId).toBe("personal");
    authority.dispose();
  });

  it("skips a ready remote team host in fleet order without MRU history", () => {
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: null,
        hosts: [],
      },
      initialIdentityKey: identityKey,
      clock: createFakeAuthorityClock(0),
    });
    const incarnationId = attachReporter(authority.engine);
    authority.fleet.publish(0, null, [remoteHost("team-first", true)]);
    proveReady(authority, incarnationId, "team-first");
    authority.fleet.publish(0, null, [
      remoteHost("team-first", true),
      fleetHost("personal-second", "remote"),
    ]);

    expect(authority.engine.snapshot().preferredHostId).toBeNull();
    expect(
      authority.engine
        .snapshot()
        .leases.find((lease) => lease.hostId === "team-first")?.status,
    ).toBe("ready");
    expect(authority.engine.snapshot().effectiveHostId).toBe("personal-second");
    authority.dispose();
  });
});
