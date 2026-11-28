import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  revalidateStream,
  type RevalidateOutcome,
  type StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostTokenSessionRevalidator } from "@traycer-clients/shared/auth/host-token-lease";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  RemoteSession as ProtocolRemoteSession,
  type IRemoteSession,
  type PoolSessionOptions as ProtocolPoolSessionOptions,
  type RemoteSessionEvidence,
  type RemoteSessionOptions as ProtocolRemoteSessionOptions,
  type SessionLivenessProbe,
} from "@traycer/protocol/host-transport/remote/session";
import type {
  PoolSessionAuth,
  RemoteSessionAuth,
  RemoteSessionAuthRecoveryOutcome,
  RemoteSessionOpenAuth,
} from "@traycer/protocol/host-transport/remote/auth";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  AttachGrantAttempt,
  AttachGrantProvision,
  AttemptGrantProvider,
} from "@traycer/protocol/host-transport/remote/grant";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import { isCredentialRefusal } from "@traycer/protocol/host-transport/door-refusal";
import {
  isReleasedHostTokenRefusal,
  processReleasedHosts,
  signInMayBeWritten,
  type HostInstance,
  type ReleasedSignOn,
  type SignInAuthority,
  type SignInWriteCheck,
} from "../released-sign-on";
import { OPEN_AUTHZ_SESSION_GRANT_VERSION } from "@traycer/protocol/host-transport/mux";
import {
  instanceDoor,
  type DoorAdmissionRelease,
  type HostDoorObserver,
} from "../host-door-state";
import type { RemoteTrafficSnapshot } from "@traycer/protocol/host-transport/remote/traffic-accounting";
import { chatSubscribeV18 } from "@traycer/protocol/host/agent/gui/subscribe";
import { extractBearerForOpenFrame } from "../ws-rpc-client";
import { recordNegotiatedHostManifest } from "../negotiated-manifest-registry";
import { recordNegotiatedStreamMethodVersions } from "../negotiated-stream-version-registry";
import { CLIENT_SERVED_STREAM_MAJORS } from "../served-stream-majors";
import { UNARY_RESPONSE_TIMEOUT_MS } from "./config";
import type { RowConfirmationAttach } from "../row-confirmation";

export type { IRemoteSession, SessionLivenessProbe };

/**
 * The desktop client's liveness probe: the method a silence candidate sends to
 * find out whether the host is still answering anything at all.
 *
 * `host.status` because it is (a) a RELEASED FLOOR method, so every host
 * negotiates it and the probe can never be refused pre-send in the field, and
 * (b) an ordinary domain resolver on the host's own event loop rather than a
 * transport-layer echo - so an answer proves the host is running, not merely
 * that its socket layer is. Its v1.0 request is `{}`.
 *
 * Lives here, in the client adapter, rather than in the protocol session: the
 * session is generic over an RPC registry it must not name, and every
 * composition root above this adapter is generic too.
 */
export const HOST_STATUS_LIVENESS_PROBE: SessionLivenessProbe = {
  method: "host.status",
  params: {},
};

/** Set to `1` in sessionStorage for reloads or localStorage for app relaunches. */
export const REMOTE_TRAFFIC_DEBUG_STORAGE_KEY = "traycer:remote-traffic-debug";

/** Backstop for live sessions; a closed session leaves on its own. */
const MAX_DEBUG_READERS = 32;

/**
 * Live sessions' readers by capture id, oldest first. An id is never reused,
 * so two samples of one capture line up even after an earlier session leaves.
 */
const debugReaders = new Map<number, () => RemoteTrafficSnapshot>();
let nextDebugCaptureSession = 0;
let droppedDebugSessions = 0;

/** Sessions that closed while registered, and what their rows had received. */
export interface RemoteTrafficDebugClosedSessions {
  readonly sessions: number;
  readonly receivedBytes: number;
  readonly receivedFrames: number;
}

/**
 * A closed session's reader leaves with it, so a session opened and closed
 * between two samples would otherwise leave no trace in either: no row, no
 * ID gap, no drop. These totals are what a capture checks for that loss.
 */
let closedDebugSessions: RemoteTrafficDebugClosedSessions = {
  sessions: 0,
  receivedBytes: 0,
  receivedFrames: 0,
};

export function readRemoteTrafficDebugClosedSessions(): RemoteTrafficDebugClosedSessions {
  return closedDebugSessions;
}

export function readRemoteTrafficDebugSnapshots(): ReadonlyArray<
  RemoteTrafficSnapshot & { readonly captureSession: number }
> {
  return Array.from(debugReaders, ([captureSession, read]) => ({
    ...read(),
    captureSession,
  }));
}

function registerRemoteTrafficDebugReader(
  read: () => RemoteTrafficSnapshot,
): number {
  const captureSession = nextDebugCaptureSession;
  nextDebugCaptureSession += 1;
  debugReaders.set(captureSession, read);
  if (debugReaders.size > MAX_DEBUG_READERS) {
    const oldest = debugReaders.keys().next();
    if (!oldest.done) debugReaders.delete(oldest.value);
    droppedDebugSessions += 1;
  }
  return captureSession;
}

function releaseRemoteTrafficDebugReader(captureSession: number): void {
  const read = debugReaders.get(captureSession);
  // Already evicted by the cap, and counted there.
  if (read === undefined) return;
  debugReaders.delete(captureSession);
  const final = read();
  closedDebugSessions = {
    sessions: closedDebugSessions.sessions + 1,
    receivedBytes: closedDebugSessions.receivedBytes + final.receivedBytes,
    receivedFrames: closedDebugSessions.receivedFrames + final.receivedFrames,
  };
}

function remoteTrafficDebugEnabled(): boolean {
  try {
    if (sessionStorage.getItem(REMOTE_TRAFFIC_DEBUG_STORAGE_KEY) === "1") {
      return true;
    }
  } catch {
    // A denied session store must not hide a persistent diagnostic opt-in.
  }
  try {
    return localStorage.getItem(REMOTE_TRAFFIC_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function installRemoteTrafficDebugSurface(): void {
  try {
    Object.defineProperty(globalThis, "__traycerRemoteTraffic", {
      configurable: true,
      value: Object.freeze({
        snapshot: readRemoteTrafficDebugSnapshots,
        droppedSessions: () => droppedDebugSessions,
        closedSessions: readRemoteTrafficDebugClosedSessions,
      }),
    });
  } catch {
    // A hardened embed may refuse globals. Keep the transport usable; the
    // exported reader remains available to a local diagnostic harness.
  }
}

export interface RemoteSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends Omit<
  ProtocolRemoteSessionOptions<RpcRegistry, StreamRegistry>,
  | "auth"
  | "grantProvider"
  | "onNegotiatedMethods"
  | "onNegotiatedStreamMethodVersions"
  | "evidence"
  | "servedStreamMajors"
  | "unaryResponseMs"
> {
  readonly grantProvider: SignInBudgetedGrantProvider;
  /**
   * The host-only token, for every host kind: `OPEN` presents it in `authz`
   * v2 with an EMPTY bearer, and a `CREDENTIAL_UPDATE` carries a renewed one
   * in `bearer`. The sign-in token reaches a host only through
   * {@link releasedSignOn}.
   */
  readonly hostToken: () => string | null;
  readonly auth: HostTokenSessionRevalidator | null;
  readonly door: HostDoorObserver | null;
  readonly evidence: TransportEvidenceReporter;
  /**
   * The person's own sign-in for their own personal computer, `null` for every
   * other row. Presented only on the dial after this host refused the host-only
   * token the released way (`isReleasedHostTokenRefusal`).
   */
  readonly releasedSignOn: RemoteReleasedSignOn | null;
}

/** A remote row's released sign-in. */
export interface RemoteReleasedSignOn extends ReleasedSignOn {
  /**
   * `opensReleasedWay` of this host's row in the in-memory directory, read on
   * every open and every credential push, never from the cloud. A row that has
   * left the person (a team's now, another person's, or gone) is sent no
   * sign-in, remembered or planned.
   */
  readonly opensReleasedWay: () => boolean;
  /**
   * Where the row {@link opensReleasedWay} reads is a cache that nothing keeps
   * current, a fresh read of it, waited on before an attach whose open would
   * carry the sign-in; it is handed that attach, bounds the wait, and starts
   * no read once the bound passes or the attach ends (`confirmRowWithin`).
   * Its answer is not read: the row then decides, and a read that failed or
   * ran past the bound leaves the row last read. `null` where the row is kept
   * current already.
   */
  readonly confirmRow:
    | ((attach: RowConfirmationAttach) => Promise<unknown>)
    | null;
}

/**
 * The client's options for a session to the server pool. The bearer source
 * serves `open` directly: there is no grant to mint and no session grant, so
 * a pool session carries the user bearer and nothing else.
 */
export interface PoolSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends Omit<
  ProtocolPoolSessionOptions<RpcRegistry, StreamRegistry>,
  | "auth"
  | "onNegotiatedMethods"
  | "onNegotiatedStreamMethodVersions"
  | "servedStreamMajors"
  | "unaryResponseMs"
  | "minimumStreamVersions"
> {
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  readonly evidence: RemoteSessionEvidence<"pool-direct">;
}

/**
 * Client compatibility adapter over the runtime-neutral protocol session.
 * It preserves the original constructor while keeping bearer/auth-service
 * coupling on the client side of the package boundary.
 */
export class RemoteSession<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends ProtocolRemoteSession<RpcRegistry, StreamRegistry> {
  constructor(
    options:
      | RemoteSessionOptions<RpcRegistry, StreamRegistry>
      | PoolSessionOptions<RpcRegistry, StreamRegistry>,
  ) {
    let closed = false;
    const closeHooks: Array<() => void> = [];
    super(
      toProtocolSessionOptions(options, {
        closed: () => closed,
        onClose: (hook) => {
          if (closed) hook();
          else closeHooks.push(hook);
        },
      }),
    );
    // Caller close and terminal fatal both end here.
    this.onClosed(() => {
      closed = true;
      for (const hook of closeHooks.splice(0)) hook();
    });
    if (remoteTrafficDebugEnabled() && this.enableTrafficAccounting()) {
      const reader = this.trafficSnapshotReader();
      if (reader !== null) {
        const captureSession = registerRemoteTrafficDebugReader(reader);
        // Caller close and terminal fatal both end here. A closed session's
        // accounting is final, so keeping its reader would only pin its rows
        // and crowd live sessions out of the cap; its totals stay counted.
        this.onClosed(() => {
          releaseRemoteTrafficDebugReader(captureSession);
        });
        installRemoteTrafficDebugSurface();
      }
    }
  }
}

function bearerReader(bearer: BearerSourceProvider): () => string | null {
  return () => {
    try {
      return extractBearerForOpenFrame(bearer());
    } catch {
      return null;
    }
  };
}

function hostTokenOpenAuth(
  readHostToken: () => string | null,
): RemoteSessionOpenAuth | null {
  const grant = readHostToken();
  if (grant === null) {
    return null;
  }
  return {
    bearer: "",
    authz: { v: OPEN_AUTHZ_SESSION_GRANT_VERSION, grant },
    fingerprint: grant,
  };
}

interface HostTokenSessionDial {
  readonly auth: RemoteSessionAuth;
  readonly grantProvider: AttemptGrantProvider;
}

/** The adapter's view of its own session's end. */
interface SessionLifetime {
  readonly closed: () => boolean;
  /** Runs once the session closes; at once if it already has. */
  readonly onClose: (hook: () => void) => void;
}

/**
 * A dial sequence: from the first attach after the session starts or a host
 * admits it, through every redial a refusal causes, to the next admission. It
 * holds the sequence's one sign-in refresh, shared by every sign-in
 * revalidation made on its behalf: the attach grant's mint and the released
 * sign-in's recovery.
 *
 * Spent only by a refresh authn answered. One that did not reach it
 * (`network-error`) leaves it unspent, so an outage keeps the session on its
 * ordinary backoff and the first answer after it still refreshes. A refresh
 * writes only to the sequence it started under, so one that answers after an
 * admission leaves the next sequence whole. The host-token lease's mint
 * recovery keeps its own.
 */
export interface DialSequence {
  /** The host instance this sequence dials. */
  readonly owner: HostInstance;
  /**
   * Runs `refresh` unless this sequence has spent its refresh (`"spent"`). A
   * refresh already running for this sequence is joined, never run twice.
   * `"adopted"` (a sibling's rotation taken from the store) spends nothing:
   * authn did not answer this sequence. Nor does an answer that finds no
   * asker still asked (`stillAsked` of the starter and of every joiner): a
   * retired attempt's answer leaves the budget to the next current one.
   */
  readonly spend: (
    refresh: () => Promise<SignInRefreshOutcome>,
    stillAsked: () => boolean,
  ) => Promise<SignInRefreshOutcome | "spent">;
}

/**
 * The relay's attach-grant mint, given the sequence whose refresh it may spend
 * and the attach it is for: once `attempt.current()` is false, its answer
 * reports nothing and spends nothing.
 */
export type SignInBudgetedGrantProvider = (
  sequence: DialSequence,
  attempt: AttachGrantAttempt,
) => Promise<AttachGrantProvision>;

type SignInRefreshOutcome = RevalidateOutcome | "adopted";

function dialSequence(owner: HostInstance): DialSequence {
  let spent = false;
  let running: Promise<SignInRefreshOutcome> | null = null;
  /** The askers of the running refresh: its starter and every joiner. */
  const askers = new Set<() => boolean>();
  return {
    owner,
    spend: (refresh, stillAsked) => {
      if (spent) return Promise.resolve("spent");
      askers.add(stillAsked);
      if (running !== null) return running;
      const own = refresh()
        .then((outcome) => {
          if (
            outcome !== "network-error" &&
            outcome !== "adopted" &&
            [...askers].some((asked) => asked())
          )
            spent = true;
          return outcome;
        })
        .finally(() => {
          if (running === own) {
            running = null;
            askers.clear();
          }
        });
      running = own;
      return own;
    },
  };
}

/** Who a session's attaches act for, and the door their admissions credit. */
interface AttachOwners {
  /** The host instance an attach starting now dials. */
  readonly current: () => HostInstance;
  /** Credits an admission by `owner`; one that is not current credits nothing. */
  readonly credit: (owner: HostInstance) => DoorAdmissionRelease;
}

/**
 * This session's dial sequence, and its place in the door's count of admitted
 * connections: held from the host's admission until the protocol session ends
 * that connection, or this session closes.
 */
interface AttachTracking {
  readonly grantProvider: AttemptGrantProvider;
  /**
   * The sequence an answer from `owner` spends: the admitted connection's own
   * for a refusal of a connection the host admitted, else the live one; either
   * begun at once where there is none, or where its instance was replaced.
   * `null` for an answer from an instance that is no longer current, which
   * spends nothing.
   */
  readonly sequence: (
    owner: HostInstance,
    ofAdmittedConnection: boolean,
  ) => DialSequence | null;
  readonly admitted: (owner: HostInstance) => DoorAdmissionRelease;
}

const NOTHING_ADMITTED: DoorAdmissionRelease = () => undefined;

function trackAttaches(
  grantProvider: SignInBudgetedGrantProvider,
  owners: AttachOwners,
  lifetime: SessionLifetime,
  beforeGrant: (attach: RowConfirmationAttach) => Promise<void>,
): AttachTracking {
  let release: DoorAdmissionRelease | null = null;
  let live: DialSequence | null = null;
  /**
   * The admitted connection's own sequence: its legs' re-attaches and
   * re-auths spend this one, never the next dial sequence's. Begun at each
   * admission.
   */
  let admittedLeg: DialSequence | null = null;
  const liveSequence = (): DialSequence => {
    const owner = owners.current();
    if (live === null || live.owner !== owner) live = dialSequence(owner);
    return live;
  };
  const legSequence = (): DialSequence => {
    const owner = owners.current();
    if (admittedLeg === null || admittedLeg.owner !== owner)
      admittedLeg = dialSequence(owner);
    return admittedLeg;
  };
  const leave = (): void => {
    const held = release;
    release = null;
    held?.();
  };
  lifetime.onClose(leave);
  return {
    grantProvider: async (attempt) => {
      // The confirmation ends with the attach: retired, or its session closed.
      await beforeGrant({
        current: () => attempt.current() && !lifetime.closed(),
      });
      // A retired attach opens no sequence: the session discards its answer.
      if (!attempt.current())
        return {
          kind: "unavailable",
          detail: "the attach was retired while the row was confirmed",
          context: "",
        };
      const sequence =
        attempt.leg === "admitted" ? legSequence() : liveSequence();
      return grantProvider(sequence, {
        current: () => attempt.current() && sequence.owner === owners.current(),
        leg: attempt.leg,
      });
    },
    sequence: (owner, ofAdmittedConnection) =>
      owner !== owners.current()
        ? null
        : ofAdmittedConnection
          ? legSequence()
          : liveSequence(),
    admitted: (owner) => {
      // An admission ends the sequence of the instance that gave it.
      if (live !== null && live.owner === owner && owner === owners.current())
        live = null;
      if (owner === owners.current()) admittedLeg = dialSequence(owner);
      leave();
      if (lifetime.closed()) return NOTHING_ADMITTED;
      const own = owners.credit(owner);
      release = own;
      return () => {
        if (release === own) release = null;
        own();
      };
    },
  };
}

// A host-token recovery is asked with the session's own liveness: one it starts
// rotates nothing once the session has closed.
function revalidateHostToken(
  auth: HostTokenSessionRevalidator,
  refusal: FatalErrorDetails | null,
  lifetime: SessionLifetime,
): Promise<RevalidateOutcome> {
  const stillWanted = (): boolean => !lifetime.closed();
  return refusal === null
    ? auth.revalidateForReconnect(stillWanted)
    : auth.revalidateRefused(refusal, stillWanted);
}

function createHostTokenRemoteSessionAuth(
  hostId: string,
  grantProvider: SignInBudgetedGrantProvider,
  readHostToken: () => string | null,
  auth: HostTokenSessionRevalidator | null,
  door: HostDoorObserver | null,
  releasedSignOn: RemoteReleasedSignOn | null,
  lifetime: SessionLifetime,
): HostTokenSessionDial {
  if (releasedSignOn !== null)
    return createReleasedSignOnSessionAuth(
      hostId,
      grantProvider,
      readHostToken,
      auth,
      door,
      releasedSignOn,
      lifetime,
    );
  /**
   * The host instance the latest open was dialed to, read with it: its
   * admission ends that instance's sequence and credits that instance alone.
   */
  let dialOwner: HostInstance = processReleasedHosts.currentInstance(hostId);
  const tracking = trackAttaches(
    grantProvider,
    {
      current: () => processReleasedHosts.currentInstance(hostId),
      credit: (owner) =>
        processReleasedHosts.isCurrent(owner)
          ? (door?.admitted() ?? NOTHING_ADMITTED)
          : NOTHING_ADMITTED,
    },
    lifetime,
    () => Promise.resolve(),
  );
  return {
    grantProvider: tracking.grantProvider,
    auth: {
      missingOpenAuthCause: "missing-host-token",
      readOpenAuth: () => {
        dialOwner = processReleasedHosts.currentInstance(hostId);
        return hostTokenOpenAuth(readHostToken);
      },
      readCredentialUpdateBearer: readHostToken,
      currentFingerprint: readHostToken,
      // A wrapper over nothing would turn "no revalidator" into an endless retry.
      revalidateForReconnect:
        auth === null || auth === undefined
          ? null
          : (refusal) => revalidateHostToken(auth, refusal, lifetime),
      // Present with no observer too: an admission ends the dial sequence.
      door: {
        refused: (details: FatalErrorDetails) => {
          door?.refused(details);
        },
        admitted: () => tracking.admitted(dialOwner),
      },
    },
  };
}

/**
 * What the next open presents, and what the open that presented the sign-in
 * was authorised by. Every frame that carries the sign-in asks
 * `signInMayBeWritten` of its authority at that write.
 */
type SignInPlan =
  | { readonly kind: "host-token" }
  | { readonly kind: "sign-in-next"; readonly owner: HostInstance }
  | { readonly kind: "sign-in"; readonly authority: SignInAuthority };

const HOST_TOKEN_PLAN: SignInPlan = { kind: "host-token" };

/**
 * A dial presents the host-only token first, unless this process remembers the
 * host as released for this person (`ReleasedHostMemory`). A released host's
 * typed refusal of the token makes the next dial present the sign-in,
 * `authz: null`, as a released app did; that connection's credential pushes
 * carry the sign-in. Every open and every push first reads the row live
 * (`RemoteReleasedSignOn.opensReleasedWay`): a row that has left the person
 * takes the host-only token's path, so a session that redials on its own never
 * carries the sign-in to it. A host that names its reason is never handed the
 * sign-in again.
 */
function createReleasedSignOnSessionAuth(
  hostId: string,
  grantProvider: SignInBudgetedGrantProvider,
  readHostToken: () => string | null,
  auth: HostTokenSessionRevalidator | null,
  door: HostDoorObserver | null,
  releasedSignOn: RemoteReleasedSignOn,
  lifetime: SessionLifetime,
): HostTokenSessionDial {
  const readSignIn = bearerReader(releasedSignOn.signIn);
  const hosts = releasedSignOn.hosts;
  // Every admission and refusal names the instance its open was dialed to; one
  // from an instance this process has since seen replaced reaches no door.
  const fencedDoor = instanceDoor(
    {
      admitted: () => door?.admitted() ?? NOTHING_ADMITTED,
      refused: (details) => {
        door?.refused(details);
      },
    },
    hosts,
  );
  /**
   * What the next open presents. A sign-in plan carries the instance it was
   * made for, and acts only while that instance is current: a plan made for
   * an instance this process has since seen replaced is dropped, and the new
   * instance answers its own open first. A host reached only through the relay
   * keeps one instance for the process's life.
   */
  let plan: SignInPlan = HOST_TOKEN_PLAN;
  const writeCheck: SignInWriteCheck = {
    hosts,
    rowAllows: releasedSignOn.opensReleasedWay,
    ownerSignInEligible: releasedSignOn.ownerSignInEligible,
  };
  /** The authority the next open's sign-in would rest on, if one is planned. */
  const plannedAuthority = (): SignInAuthority | null =>
    plan.kind === "sign-in-next"
      ? { kind: "released", owner: plan.owner }
      : null;
  const signInPlanned = (): boolean =>
    plan.kind === "sign-in-next" && hosts.isCurrent(plan.owner);
  /** Whether a frame written now may carry the sign-in, and on what authority. */
  const signInGoesNow = (): boolean => {
    const authority =
      plan.kind === "sign-in" ? plan.authority : plannedAuthority();
    return (
      authority !== null && signInMayBeWritten(writeCheck, authority, false)
    );
  };
  let openAdmitted = false;
  let signInFromMemory = false;
  /**
   * Opens read so far. A recovery that answers after the session's budget acts
   * only while no open has been read since it was asked: a later dial owns the
   * plan and the door.
   */
  let dialsStarted = 0;
  /** The person this dial's sign-in is for, while it presents one. */
  let signInUserId: string | null = null;
  /**
   * The host instance the latest open was dialed to, read with it: every
   * answer to that open acts for it alone. Nothing observes a host reached
   * only through the relay, so for it this is one instance for the process's
   * life.
   */
  let dialOwner: HostInstance = hosts.currentInstance(hostId);
  const remembered = (): string | null => {
    const lease = releasedSignOn.signIn();
    return lease !== null &&
      !signInPlanned() &&
      hosts.opensReleasedWay(lease.identity.userId, hostId)
      ? lease.identity.userId
      : null;
  };
  const named = (refusal: FatalErrorDetails): boolean =>
    readDoorReason(refusal.doorReason) !== "absent";
  // Asked at attach start, before the open is read: only an attach whose open
  // would carry the sign-in waits for the row to be read again. An attach
  // begun under a sign-in plan counts: its recovery may still answer before
  // the open is read, and plan the sign-in for it. The answer is the attach's
  // own: its open carries the sign-in only if it was asked yes here, so no
  // admission heard during the grant sends the sign-in on an unread row.
  const confirmRow = releasedSignOn.confirmRow;
  let attachMayPresentSignIn = false;
  const tracking = trackAttaches(
    grantProvider,
    {
      current: () => hosts.currentInstance(hostId),
      credit: (owner) => fencedDoor.admitted(owner),
    },
    lifetime,
    async (attach) => {
      const wouldPresentSignIn =
        releasedSignOn.opensReleasedWay() &&
        !hosts.namedReason(hostId) &&
        (plan.kind === "sign-in" || signInPlanned() || remembered() !== null);
      attachMayPresentSignIn = wouldPresentSignIn;
      if (confirmRow === null || !wouldPresentSignIn) return;
      await confirmRow(attach).catch(() => undefined);
    },
  );
  // Only a refusal of this dial's open switches to the sign-in: a current host
  // can end a session it admitted the same way. With no sign-in to present,
  // the refusal takes the host-only token's own path, and so does a row that
  // no longer allows it: the next open would present the token anyway.
  // The refusal of a sign-in already sent is its recovery's to answer, even if
  // the host named a reason or the row changed since: the next open asks both
  // again before it sends anything.
  const answersReleasedWay = (refusal: FatalErrorDetails): boolean =>
    isReleasedHostTokenRefusal(refusal) &&
    (plan.kind === "sign-in" ||
      (!hosts.namedReason(hostId) &&
        releasedSignOn.opensReleasedWay() &&
        !openAdmitted &&
        readSignIn() !== null));
  const recoverSignIn = async (
    sequence: DialSequence,
  ): Promise<RemoteSessionAuthRecoveryOutcome> => {
    const recovery = releasedSignOn.recovery;
    if (recovery === null) return "rejected";
    const askedAt = dialsStarted;
    // A later open owns the plan, and a closed session has none.
    const stillAsked = (): boolean =>
      dialsStarted === askedAt && !lifetime.closed();
    const answered = await sequence.spend(
      // The relay hands over no refusal: none of its sign-ins is identified.
      // One declined for a replaced process is answered as an outage: it
      // spends nothing, and the redial reads the current process.
      () =>
        recovery
          .revalidateForReconnect(sequence.owner, null, stillAsked)
          .then((outcome) =>
            outcome === "process-replaced"
              ? "network-error"
              : typeof outcome === "object"
                ? "rejected"
                : outcome,
          ),
      stillAsked,
    );
    // Spent: the redial presents the sign-in it holds, and the session's
    // no-progress bound ends a sequence the host keeps refusing. Adopted: a
    // sibling's rotation, presented like one of this sequence's own.
    const outcome =
      answered === "spent" || answered === "adopted" ? "rotated" : answered;
    if (!stillAsked()) return outcome;
    if (outcome === "rotated" || outcome === "network-error")
      plan = { kind: "sign-in-next", owner: sequence.owner };
    // A refusal of the person's sign-in never reaches the door: the session
    // ends on it, or redials.
    return outcome;
  };
  const recoverHostToken = (
    refusal: FatalErrorDetails,
  ): Promise<RemoteSessionAuthRecoveryOutcome> => {
    plan = HOST_TOKEN_PLAN;
    return auth === null
      ? Promise.resolve("rejected")
      : revalidateHostToken(auth, refusal, lifetime);
  };
  /**
   * The sign-in values given to frames (an `open`, a credential update) since
   * the last sealed frame was asked about, so a sealed frame can say whether it
   * carries the sign-in: a host-only token never equals one. Writes run one at
   * a time and each reads its bearer just before its seal, so the frame asked
   * about next was given its value after the last answer.
   */
  const signInsGiven = new Set<string>();
  const giveSignIn = (signIn: string): string => {
    signInsGiven.add(signIn);
    return signIn;
  };
  const sessionAuth: RemoteSessionAuth = {
    missingOpenAuthCause: "missing-host-token",
    readOpenAuth: () => {
      dialsStarted += 1;
      signInsGiven.clear();
      dialOwner = hosts.currentInstance(hostId);
      openAdmitted = false;
      const asked = attachMayPresentSignIn;
      attachMayPresentSignIn = false;
      signInFromMemory =
        asked && releasedSignOn.opensReleasedWay() && remembered() !== null;
      const authority: SignInAuthority | null = !asked
        ? null
        : signInPlanned()
          ? plannedAuthority()
          : signInFromMemory
            ? { kind: "remembered", owner: dialOwner }
            : null;
      // Asked at the write: another transport may have heard this host name a
      // reason since the refusal that planned the sign-in.
      if (
        authority !== null &&
        signInMayBeWritten(writeCheck, authority, false)
      ) {
        const lease = releasedSignOn.signIn();
        const signIn = readSignIn();
        if (lease !== null && signIn !== null) {
          plan = { kind: "sign-in", authority };
          signInUserId = lease.identity.userId;
          return {
            bearer: giveSignIn(signIn),
            authz: null,
            fingerprint: signIn,
          };
        }
      }
      signInFromMemory = false;
      signInUserId = null;
      plan = HOST_TOKEN_PLAN;
      return hostTokenOpenAuth(readHostToken);
    },
    // Asked once an open or a credential update is sealed: one carrying the
    // sign-in goes only while the row, its authority and the host still allow
    // it. A rotation within a kind is sent as sealed.
    sealedStillWritable: (bearer) => {
      const writable = !signInsGiven.has(bearer) || signInGoesNow();
      signInsGiven.clear();
      return writable;
    },
    // Once a host names a reason, no transport in this process hands it the
    // released-way sign-in again, until this process sees that host's local
    // process instance change: an admitted sign-in session's update carries
    // the host-only token then, and the fingerprint names what is sent.
    readCredentialUpdateBearer: () => {
      if (!(plan.kind === "sign-in" && signInGoesNow())) return readHostToken();
      const signIn = readSignIn();
      return signIn === null ? null : giveSignIn(signIn);
    },
    // The credential the next frame presents, so a rotated sign-in is
    // progress and the same one again is not, as in desktop-v1.5.4.
    currentFingerprint: () =>
      signInGoesNow() ? readSignIn() : readHostToken(),
    revalidateForReconnect: (refusal) => {
      // No sequence for an instance this process has since seen replaced:
      // nothing its refusal says plans, refreshes or mints for the new one,
      // which answers its own open first.
      const sequence = tracking.sequence(dialOwner, openAdmitted);
      if (sequence === null) {
        signInFromMemory = false;
        plan = HOST_TOKEN_PLAN;
        return Promise.resolve("rotated");
      }
      // Remembered as released, now updated: the next dial presents the token.
      if (signInFromMemory && named(refusal)) {
        signInFromMemory = false;
        plan = HOST_TOKEN_PLAN;
        return Promise.resolve("rotated");
      }
      if (answersReleasedWay(refusal)) {
        if (plan.kind === "sign-in") return recoverSignIn(sequence);
        plan = { kind: "sign-in-next", owner: dialOwner };
        return Promise.resolve("rotated");
      }
      return recoverHostToken(refusal);
    },
    door: {
      // Answered by the next dial, or reported once its recovery gives up.
      refused: (details) => {
        if (named(details)) hosts.refusedNamingReason(dialOwner, false);
        // Only a credential reason is answered by the token dial; any other
        // named reason shows its cover now.
        if (
          answersReleasedWay(details) ||
          (signInFromMemory && named(details) && isCredentialRefusal(details))
        )
          return;
        fencedDoor.refused(details, dialOwner);
      },
      admitted: () => {
        openAdmitted = true;
        if (plan.kind === "sign-in" && signInUserId !== null)
          hosts.signInAdmitted(signInUserId, dialOwner);
        else hosts.hostTokenAdmitted(dialOwner);
        return tracking.admitted(dialOwner);
      },
    },
  };
  return { auth: sessionAuth, grantProvider: tracking.grantProvider };
}

/**
 * The pool's `open` presents the user bearer, with nowhere to put anything
 * else: no `authz`, no session grant.
 */
function createClientPoolSessionAuth(
  bearer: BearerSourceProvider,
  auth: StreamAuthRevalidator | null,
): PoolSessionAuth {
  const readBearer = bearerReader(bearer);
  return {
    missingOpenAuthCause: "missing-bearer",
    readOpenAuth: () => {
      const token = readBearer();
      return token === null ? null : { bearer: token, fingerprint: token };
    },
    readCredentialUpdateBearer: readBearer,
    currentFingerprint: readBearer,
    revalidateForReconnect:
      auth === null ? null : (refusal) => revalidateStream(auth, refusal),
  };
}

/**
 * The protocol session's options for either client shape. The client-side
 * wiring is the same for both: BOTH transports must publish what they
 * negotiated, or every per-host gate built on those registries fails closed
 * forever for the hosts one of them serves - which for a stream-version gate
 * means every remote host, i.e. the ones the gate exists for.
 */
function toProtocolSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
>(
  options:
    | RemoteSessionOptions<RpcRegistry, StreamRegistry>
    | PoolSessionOptions<RpcRegistry, StreamRegistry>,
  lifetime: SessionLifetime,
):
  | ProtocolRemoteSessionOptions<RpcRegistry, StreamRegistry>
  | ProtocolPoolSessionOptions<RpcRegistry, StreamRegistry> {
  const clientWiring = {
    onNegotiatedMethods: recordNegotiatedHostManifest,
    onNegotiatedStreamMethodVersions: recordNegotiatedStreamMethodVersions,
    servedStreamMajors: CLIENT_SERVED_STREAM_MAJORS,
    unaryResponseMs: UNARY_RESPONSE_TIMEOUT_MS,
  };
  if ("poolUrl" in options) {
    const { bearer, auth, ...coreOptions } = options;
    return {
      ...coreOptions,
      ...clientWiring,
      // The pool streams windows. The older chat schemas carry whole snapshots.
      minimumStreamVersions: new Map([
        [chatSubscribeV18.method, chatSubscribeV18.schemaVersion],
      ]),
      auth: createClientPoolSessionAuth(bearer, auth),
    };
  }
  const { hostToken, auth, door, releasedSignOn, ...coreOptions } = options;
  const dial = createHostTokenRemoteSessionAuth(
    options.hostId,
    options.grantProvider,
    hostToken,
    auth,
    door,
    releasedSignOn,
    lifetime,
  );
  return {
    ...coreOptions,
    ...clientWiring,
    grantProvider: dial.grantProvider,
    auth: dial.auth,
  };
}
