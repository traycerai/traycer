import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type HostFleetEntry,
} from "../selection-authority-contract";
import type { SelectionAuthorityEngineImpl } from "../selection-authority-engine";
import {
  createFakeAuthorityClock,
  createTestAuthority,
} from "./selection-authority-harness";

const REPORTER_ID = "local-team-selection-window";
const IDENTITY_KEY = "local-team-selection-user";
const LOCAL_HOST_ID = "physical-local-team-host";
const REMOTE_TEAM_HOST_ID = "remote-team-host";
const SANDBOX_HOST_ID = "team-sandbox-host";

function localTeamHost(): HostFleetEntry {
  return { hostId: LOCAL_HOST_ID, kind: "local", teamOwned: true };
}

function remoteTeamHost(): HostFleetEntry {
  return { hostId: REMOTE_TEAM_HOST_ID, kind: "remote", teamOwned: true };
}

function attachReporter(engine: SelectionAuthorityEngineImpl): string {
  const attachSeq = engine.allocateAttachSeq(REPORTER_ID);
  const result = engine.attach(REPORTER_ID, {
    attachSeq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!result.ok) throw new Error("expected selection reporter to attach");
  return result.incarnationId;
}

describe("SelectionAuthorityEngine local team host selection", () => {
  it("allows manual selection of the physical local team host and persists it", async () => {
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: LOCAL_HOST_ID,
        hosts: [localTeamHost()],
      },
      initialIdentityKey: IDENTITY_KEY,
      clock: createFakeAuthorityClock(0),
    });
    const incarnationId = attachReporter(authority.engine);

    await expect(
      authority.engine.activate(REPORTER_ID, incarnationId, LOCAL_HOST_ID),
    ).resolves.toEqual({ ok: true });
    expect(authority.engine.snapshot().preferredHostId).toBe(LOCAL_HOST_ID);
    expect(authority.preferredStore.load(IDENTITY_KEY)).toBe(LOCAL_HOST_ID);

    authority.dispose();
  });

  it("retains its stored preference through construction and fleet refresh", () => {
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: LOCAL_HOST_ID,
        hosts: [localTeamHost()],
      },
      initialIdentityKey: IDENTITY_KEY,
      clock: createFakeAuthorityClock(0),
      seedPreferred: LOCAL_HOST_ID,
    });

    expect(authority.engine.snapshot().preferredHostId).toBe(LOCAL_HOST_ID);
    expect(authority.preferredStore.load(IDENTITY_KEY)).toBe(LOCAL_HOST_ID);

    authority.fleet.publish(0, LOCAL_HOST_ID, [localTeamHost()]);

    expect(authority.engine.snapshot().preferredHostId).toBe(LOCAL_HOST_ID);
    expect(authority.preferredStore.load(IDENTITY_KEY)).toBe(LOCAL_HOST_ID);
    authority.dispose();
  });

  it("continues to refuse a remote team host", async () => {
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: LOCAL_HOST_ID,
        hosts: [localTeamHost(), remoteTeamHost()],
      },
      initialIdentityKey: IDENTITY_KEY,
      clock: createFakeAuthorityClock(0),
    });
    const incarnationId = attachReporter(authority.engine);

    await expect(
      authority.engine.activate(
        REPORTER_ID,
        incarnationId,
        REMOTE_TEAM_HOST_ID,
      ),
    ).resolves.toEqual({ ok: false, reason: "team-host" });
    expect(authority.preferredStore.load(IDENTITY_KEY)).toBeNull();
    authority.dispose();
  });

  it("does not apply the local-host exception to a team sandbox", async () => {
    const sandbox: HostFleetEntry = {
      hostId: SANDBOX_HOST_ID,
      kind: "sandbox",
      teamOwned: true,
    };
    const authority = createTestAuthority({
      initialFleet: {
        identityGeneration: 0,
        localHostId: LOCAL_HOST_ID,
        hosts: [localTeamHost(), sandbox],
      },
      initialIdentityKey: IDENTITY_KEY,
      clock: createFakeAuthorityClock(0),
    });
    const incarnationId = attachReporter(authority.engine);

    await expect(
      authority.engine.activate(REPORTER_ID, incarnationId, SANDBOX_HOST_ID),
    ).resolves.toEqual({ ok: false, reason: "team-host" });
    expect(authority.preferredStore.load(IDENTITY_KEY)).toBeNull();
    authority.dispose();
  });
});
