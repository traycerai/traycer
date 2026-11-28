import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type { AttachGrantProvision } from "@traycer/protocol/host-transport/remote/grant";
import { HostRequestAbortedError } from "../../host-messenger";
import {
  acquireRemoteSession,
  redialRemoteSessionsFor,
  retireAllRemoteSessions,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";
import { RemoteSession } from "../remote-session";
import { RetryableTransportError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { emptyStreamRegistry, FakeRelayHost } from "./fake-relay-host";

const realSetImmediate = globalThis.setImmediate;
let webCryptoInFlight = 0;

function countWebCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  const decrypt = subtle.decrypt.bind(subtle);
  const digest = subtle.digest.bind(subtle);
  const encrypt = subtle.encrypt.bind(subtle);
  const importKey = subtle.importKey.bind(subtle);
  const sign = subtle.sign.bind(subtle);
  const count = <T>(operation: Promise<T>): Promise<T> => {
    webCryptoInFlight += 1;
    return operation.finally(() => {
      webCryptoInFlight -= 1;
    });
  };
  vi.spyOn(subtle, "decrypt").mockImplementation((...args) =>
    count(decrypt(...args)),
  );
  vi.spyOn(subtle, "digest").mockImplementation((...args) =>
    count(digest(...args)),
  );
  vi.spyOn(subtle, "encrypt").mockImplementation((...args) =>
    count(encrypt(...args)),
  );
  vi.spyOn(subtle, "importKey").mockImplementation((...args) =>
    count(importKey(...args)),
  );
  vi.spyOn(subtle, "sign").mockImplementation((...args) =>
    count(sign(...args)),
  );
}

async function settleNoise(): Promise<void> {
  let quietTurns = 0;
  while (quietTurns < 2) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    quietTurns = webCryptoInFlight === 0 ? quietTurns + 1 : 0;
  }
}

async function stepNoise(ms: number): Promise<void> {
  await settleNoise();
  await vi.advanceTimersByTimeAsync(ms);
  await settleNoise();
}

async function advanceNoiseUntil(
  condition: () => boolean,
  maxMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 25) {
    if (condition()) return;
    await stepNoise(25);
  }
  if (!condition()) throw new Error("condition was not reached in fake time");
}
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

/** One stream method, so an open can reopen a subscription. */
const probeStreamRegistry = defineVersionedStreamRpcRegistry({
  "probe.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineStreamRpcContract({
            method: "probe.subscribe",
            schemaVersion: { major: 1, minor: 0 },
            openRequestSchema: z.object({}),
            serverFrameSchema: z.object({
              kind: z.literal("snapshot"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("noop"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
  },
});

/** A read the app keeps asking: it parks on the session and fails with it. */
function readBinding(
  session: Session,
  abortSignal: AbortSignal | null,
): Promise<unknown> {
  return session
    .sendUnary(
      "worktree.getBinding",
      { epicId: "epic-1", ownerId: "user-1", ownerKind: "chat" },
      null,
      abortSignal,
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
  streamRegistry: VersionedStreamRpcRegistry,
): Session {
  relay.floorRpcManifest = { "worktree.getBinding": { major: 1, minor: 0 } };
  relay.unaryResult = { binding: null, missingWorktreePaths: [] };
  const lease = new MutableBearerLease("host-only-token", "user-1");
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "host-1",
    showsNobodySignedIn: false,
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
    streamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
}

/** Keeps one read parked on the session until stopped. */
function keepReading(session: Session): {
  readonly stop: () => Promise<void>;
} {
  let reading = true;
  const loop = (async (): Promise<void> => {
    while (reading) await readBinding(session, null);
  })();
  return {
    stop: async () => {
      reading = false;
      session.close();
      await loop;
    },
  };
}

/** Dial start times over 30 s of fake time, stepped 250 ms at a time. */
async function dialTimes(args: {
  readonly grant: AttachGrantProvision;
  readonly reader: boolean;
  readonly afterStep: (session: Session, dials: number) => void;
}): Promise<number[]> {
  vi.useFakeTimers();
  // A pinned draw: each rung waits its full length, and a wake's redial 1 s.
  vi.spyOn(Math, "random").mockReturnValue(1);
  const dialAt: number[] = [];
  const session = sessionAnswering(
    new FakeRelayHost(),
    args.grant,
    dialAt,
    emptyStreamRegistry,
  );
  let reading = args.reader;
  const loop = (async (): Promise<void> => {
    while (reading) await readBinding(session, null);
  })();
  try {
    session.start();
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

type DoorSession = {
  readonly relay: FakeRelayHost;
  readonly session: Session;
  readonly dialAt: number[];
  readonly openedAt: number[];
};

/** `openedAt` stamps each open the door decides, under a test-controlled clock. */
function sessionBehindDoor(args: {
  readonly decide: (openIndex: number) => FatalErrorDetails | null;
  readonly streamRegistry: VersionedStreamRpcRegistry;
}): DoorSession {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const relay = new FakeRelayHost();
  relay.streamManifest = buildStreamManifest(
    args.streamRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const openedAt: number[] = [];
  relay.decideOpen = (_bearer, openIndex) => {
    openedAt.push(Date.now());
    const refusal = args.decide(openIndex);
    return refusal === null
      ? { kind: "ack" }
      : { kind: "fatal", details: refusal };
  };
  const dialAt: number[] = [];
  const session = sessionAnswering(relay, GRANTED, dialAt, args.streamRegistry);
  return { relay, session, dialAt, openedAt };
}

/**
 * Two refused opens climb the ladder to its 4 s rung; the third open is
 * admitted, and the stream it reopens fails there, so the admitted
 * connection is lost.
 */
function admittedThenLost(): DoorSession & {
  readonly stream: { close: () => void };
} {
  const door = sessionBehindDoor({
    decide: (openIndex) => (openIndex < 2 ? OWNERSHIP_NOT_READ : null),
    streamRegistry: probeStreamRegistry,
  });
  let failed = false;
  const stream = door.session.subscribeWithParamsProvider(
    "probe.subscribe",
    () => {
      if (!failed && door.openedAt.length === 3) {
        failed = true;
        throw new Error("the stream's params cannot be read");
      }
      return {};
    },
  );
  return { ...door, stream };
}

function gapsOf(dialAt: readonly number[]): number[] {
  return dialAt.slice(1).map((at, index) => at - dialAt[index]);
}

afterEach(async () => {
  vi.useRealTimers();
  await settleNoise();
  vi.restoreAllMocks();
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

  it("keeps the read retryable and reaches ready after the door switches to success", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    const { session, dialAt, openedAt } = sessionBehindDoor({
      decide: (openIndex) => (openIndex === 0 ? OWNERSHIP_NOT_READ : null),
      streamRegistry: emptyStreamRegistry,
    });
    const read = readBinding(session, null);
    try {
      session.start();
      await advanceNoiseUntil(() => openedAt.length === 1, 5_000);
      expect(await read).toBeInstanceOf(RetryableTransportError);
      await advanceNoiseUntil(() => session.isReady(), 5_000);
      expect(openedAt).toHaveLength(2);
      expect(dialAt).toHaveLength(2);
    } finally {
      session.close();
    }
  });

  it("climbs the backoff when the door answers every attach with a retryable not_admitted", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    const { relay, session, dialAt, openedAt } = sessionBehindDoor({
      decide: () => OWNERSHIP_NOT_READ,
      streamRegistry: emptyStreamRegistry,
    });
    session.start();
    const reader = keepReading(session);
    try {
      await advanceNoiseUntil(() => dialAt.length === 4, 15_000);
      // Each earlier dial reached the door and was refused there.
      expect(relay.openBearers.length).toBeGreaterThanOrEqual(3);
      // Timed from the third refusal, so no handshake is inside the wait.
      expect(dialAt[3] - openedAt[2]).toBeGreaterThanOrEqual(3_500);
    } finally {
      await reader.stop();
    }
  });

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
    ).toBeLessThanOrEqual(1_000);
  });
});

describe("a read released by the loss of an admitted connection", () => {
  it("brings the next dial forward", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    const { session, stream, dialAt, openedAt } = admittedThenLost();
    session.start();
    const reader = keepReading(session);
    try {
      await advanceNoiseUntil(() => dialAt.length === 4, 15_000);
      // The loss armed the 4 s rung; the read it released pulled it to 1 s.
      expect(dialAt[3] - openedAt[2]).toBeLessThan(2_500);
    } finally {
      stream.close();
      await reader.stop();
    }
  });

  it("does not pull the wait forward when the read is already aborted", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    const { session, stream, dialAt, openedAt } = admittedThenLost();
    session.start();
    try {
      await advanceNoiseUntil(() => openedAt.length === 3, 15_000);
      // The admitted connection is lost on its own open; a read then parks on
      // the wait that loss armed and is abandoned.
      const controller = new AbortController();
      const read = readBinding(session, controller.signal);
      controller.abort();
      expect(await read).toBeInstanceOf(HostRequestAbortedError);
      await advanceNoiseUntil(() => dialAt.length === 4, 15_000);
      expect(dialAt[3] - openedAt[2]).toBeGreaterThanOrEqual(3_500);
    } finally {
      stream.close();
      session.close();
    }
  });

  it("does not pull the wait forward when an admitted-open loss wins before queued abort", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    const controller = new AbortController();
    const door = sessionBehindDoor({
      decide: (openIndex) => (openIndex < 2 ? OWNERSHIP_NOT_READ : null),
      streamRegistry: probeStreamRegistry,
    });
    door.relay.stallOpenIndex = 2;
    let failed = false;
    const stream = door.session.subscribeWithParamsProvider(
      "probe.subscribe",
      () => {
        if (!failed && door.openedAt.length === 3) {
          failed = true;
          queueMicrotask(() => controller.abort());
          throw new Error("the stream's params cannot be read");
        }
        return {};
      },
    );
    const { session, dialAt, openedAt } = door;
    session.start();
    try {
      await advanceNoiseUntil(() => door.relay.openBearers.length >= 3, 10_000);
      const read = readBinding(session, controller.signal);
      await settleNoise();
      await door.relay.releaseStalledOpens();
      await advanceNoiseUntil(() => openedAt.length === 3, 10_000);

      expect(await read).toBeInstanceOf(RetryableTransportError);
      await advanceNoiseUntil(() => dialAt.length === 4, 10_000);
      expect((dialAt[3] ?? 0) - (openedAt[2] ?? 0)).toBeGreaterThanOrEqual(
        3_500,
      );
    } finally {
      stream.close();
      session.close();
    }
  }, 25_000);
});

function cachedIdentity(hostId: string): RemoteSessionIdentity {
  return {
    hostId,
    userId: "user-1",
    hostPublicKey: `pubkey-${hostId}`,
    relayAttachUrl: `wss://relay.test/attach-${hostId}`,
    authRecovery: "revalidate",
    authEpoch: "lease-1",
    openAuth: "session-grant-or-sign-in",
  };
}

describe("a person's Retry on one remote computer", () => {
  afterEach(() => {
    retireAllRemoteSessions();
  });

  it("dials that computer at once after the ladder has climbed, and no other", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const shownAt: number[] = [];
    const otherAt: number[] = [];
    const shown = acquireRemoteSession(
      cachedIdentity("host-shown"),
      { proactiveWakeEligible: true },
      () =>
        sessionAnswering(
          new FakeRelayHost(),
          UNAVAILABLE,
          shownAt,
          emptyStreamRegistry,
        ),
    );
    const other = acquireRemoteSession(
      cachedIdentity("host-other"),
      { proactiveWakeEligible: true },
      () =>
        sessionAnswering(
          new FakeRelayHost(),
          UNAVAILABLE,
          otherAt,
          emptyStreamRegistry,
        ),
    );
    shown.start();
    other.start();
    let pressedAt: number | null = null;
    let otherDialsAtPress = 0;
    let selectedDialAtPress = 0;
    for (let step = 0; step < 80; step += 1) {
      await vi.advanceTimersByTimeAsync(250);
      // Four failed dials: the next rung is 8 s.
      if (pressedAt === null && shownAt.length === 4) {
        pressedAt = Date.now();
        otherDialsAtPress = otherAt.length;
        selectedDialAtPress = shownAt.length;
        redialRemoteSessionsFor("host-shown", "user-retry");
      }
      if (pressedAt !== null && shownAt.length === 5) break;
    }
    expect(pressedAt).not.toBeNull();
    expect(
      (shownAt.at(4) ?? Number.POSITIVE_INFINITY) - (pressedAt ?? 0),
    ).toBeLessThan(250);
    // The other computer keeps its own rung.
    expect(otherAt.slice(otherDialsAtPress)).toEqual([]);
    expect(shownAt.slice(selectedDialAtPress)).toHaveLength(1);
    shown.close();
    other.close();
  });

  it("dials nothing for a computer whose session is ready", async () => {
    countWebCrypto();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const relay = new FakeRelayHost();
    const dialAt: number[] = [];
    const view = acquireRemoteSession(
      cachedIdentity("host-ready"),
      { proactiveWakeEligible: true },
      () => sessionAnswering(relay, GRANTED, dialAt, emptyStreamRegistry),
    );
    view.start();
    try {
      await advanceNoiseUntil(() => view.isReady(), 10_000);
      redialRemoteSessionsFor("host-ready", "user-retry");
      await stepNoise(30_000);
      expect(view.isReady()).toBe(true);
      expect(dialAt).toHaveLength(1);
      expect(relay.openBearers).toHaveLength(1);
    } finally {
      view.close();
    }
  });
});
