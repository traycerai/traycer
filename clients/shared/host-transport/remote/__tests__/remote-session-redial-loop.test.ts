import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type { AttachGrantProvision } from "@traycer/protocol/host-transport/remote/grant";
import { RemoteSession } from "../remote-session";
import { emptyStreamRegistry, FakeRelayHost } from "./fake-relay-host";

const WORKTREE_GET_BINDING_CONTRACT = defineRpcContract({
  method: "worktree.getBinding",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({
    epicId: z.string(),
    ownerId: z.string(),
    ownerKind: z.enum(["chat", "terminal-agent"]),
  }),
  responseSchema: z.object({
    binding: z.null(),
    missingWorktreePaths: z.array(z.string()),
  }),
});

function bindingOnlyRegistry(): VersionedRpcRegistry {
  return defineFloorAwareVersionedRpcRegistry(
    ["worktree.getBinding"] as const,
    {
      "worktree.getBinding": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: WORKTREE_GET_BINDING_CONTRACT,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    },
  );
}

type Session = RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>;

const UNAVAILABLE: AttachGrantProvision = {
  kind: "unavailable",
  detail: "the mint request never completed (network)",
  context: "",
};

const GRANTED: AttachGrantProvision = {
  kind: "ok",
  grant: { grant: "grant-jws", expiresInSeconds: 300 },
};

/** The door's answer to a token naming an ownership the host has not read yet. */
const OWNERSHIP_NOT_READ: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "Host-only token names an ownership this host has not read yet",
  incompatibleMethods: null,
  upgradeGuidance: null,
  retryable: true,
  doorReason: "not_admitted",
};

/** A read the app keeps asking: it parks on the session and fails with it. */
function readBinding(session: Session): Promise<unknown> {
  return session
    .sendUnary(
      "worktree.getBinding",
      { epicId: "epic-1", ownerId: "user-1", ownerKind: "chat" },
      null,
      null,
      null,
      undefined,
      false,
      null,
    )
    .then(
      () => null,
      (reason: unknown) => reason,
    );
}

/** Records when each dial starts: its grant ask, which comes before any socket work. */
function sessionAnswering(
  relay: FakeRelayHost,
  grant: AttachGrantProvision,
  dialAt: number[],
): Session {
  relay.floorRpcManifest = { "worktree.getBinding": { major: 1, minor: 0 } };
  const lease = new MutableBearerLease("host-only-token", "user-1");
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () => {
      dialAt.push(Date.now());
      return Promise.resolve(grant);
    },
    releasedSignOn: null,
    hostToken: () => lease.getBearerToken(),
    auth: null,
    door: null,
    clock: null,
    rpcRegistry: bindingOnlyRegistry(),
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
}

/** Dial start times over 30 s of fake time, stepped 250 ms at a time. */
async function dialTimes(args: {
  readonly grant: AttachGrantProvision;
  readonly reader: boolean;
  readonly afterStep: (session: Session, dials: number) => void;
}): Promise<number[]> {
  vi.useFakeTimers();
  const dialAt: number[] = [];
  const session = sessionAnswering(new FakeRelayHost(), args.grant, dialAt);
  let reading = args.reader;
  const keepReading = async (): Promise<void> => {
    while (reading) await readBinding(session);
  };
  try {
    session.start();
    const loop = keepReading();
    for (let step = 0; step < 120; step += 1) {
      await vi.advanceTimersByTimeAsync(250);
      args.afterStep(session, dialAt.length);
    }
    reading = false;
    session.close();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
    return dialAt;
  } finally {
    reading = false;
    session.close();
  }
}

function gapsOf(dialAt: readonly number[]): number[] {
  return dialAt.slice(1).map((at, index) => at - dialAt[index]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a remote session that keeps failing to be admitted while a read waits", () => {
  it("climbs the backoff when every grant ask fails", async () => {
    const dialAt = await dialTimes({
      grant: UNAVAILABLE,
      reader: true,
      afterStep: () => undefined,
    });
    // 1 s, 2 s, 4 s, 8 s ... as with no read waiting.
    expect(dialAt.length).toBeLessThanOrEqual(6);
    expect(gapsOf(dialAt).at(3) ?? 0).toBeGreaterThanOrEqual(4_000);
  });

  it("climbs the backoff when the door answers every attach with a retryable not_admitted", async () => {
    // Real time: the handshake that reaches the door runs on real crypto.
    // Jitter at its ceiling makes the waits exact, 1 s, 2 s, 4 s; a redial
    // pulled forward would wait 1 s at most.
    const jitterPin = vi.spyOn(Math, "random").mockReturnValue(1);
    const relay = new FakeRelayHost();
    relay.decideOpen = () => ({ kind: "fatal", details: OWNERSHIP_NOT_READ });
    const dialAt: number[] = [];
    const session = sessionAnswering(relay, GRANTED, dialAt);
    let reading = true;
    const keepReading = async (): Promise<void> => {
      while (reading) await readBinding(session);
    };
    try {
      session.start();
      const loop = keepReading();
      await vi.waitFor(() => expect(dialAt).toHaveLength(4), {
        timeout: 12_000,
        interval: 20,
      });
      // Each earlier dial reached the door and was refused there.
      expect(relay.openBearers.length).toBeGreaterThanOrEqual(3);
      expect(gapsOf(dialAt).at(2) ?? 0).toBeGreaterThanOrEqual(3_500);
      reading = false;
      session.close();
      await loop;
    } finally {
      reading = false;
      session.close();
      jitterPin.mockRestore();
    }
  }, 20_000);

  it("still brings the next dial forward when news from outside the session arrives", async () => {
    let wokenAt: number | null = null;
    const dialAt = await dialTimes({
      grant: UNAVAILABLE,
      reader: false,
      afterStep: (session, dials) => {
        // The fourth dial has failed and armed its climbed rung; the network
        // coming back then wakes the session.
        if (dials !== 4 || wokenAt !== null) return;
        wokenAt = Date.now();
        session.wake("wake-online", null);
      },
    });
    expect(wokenAt).not.toBeNull();
    expect(
      (dialAt.at(4) ?? Number.POSITIVE_INFINITY) - (wokenAt ?? 0),
    ).toBeLessThan(1_000);
  });
});
