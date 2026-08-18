/**
 * The seam through which a window's TRANSPORTS feed the selection authority's
 * evidence kernel (connection registry §1b, redesign P1.3).
 *
 * P1.1 landed the kernel with its producers deliberately unwired, so that the
 * failover engine could never be built on an evidence vacuum by accident: with
 * nothing reporting, every lease reads `connecting`, derivation returns
 * preferred-or-local, and nothing ever moves. This module is the wiring, and it
 * exists as its own narrow interface rather than passing the kernel itself so
 * that `host-transport` never depends on the authority's client/IPC surface.
 *
 * ## The classification rule (do not soften it)
 *
 * `confirmed-refusal` requires evidence from the HOST's transport plane -
 * connection refused, a Noise/relay handshake rejection, a relay attach
 * refusal. Credential- and authn-plane failures are `indeterminate`, however
 * terminal they look: an attach-grant mint that fails because the user is
 * signed out, because the bearer was rejected, or because authn returned 500
 * says nothing about whether the HOST is alive - it was never dialed. Counting
 * those would let one cloud outage reach the confirmed-death streak on every
 * remote host at once and fail the whole fleet over, which is the false-Offline
 * class invariant 5 exists to prevent.
 *
 * The one entitlement exception is `plan-restricted`, which stays a refusal: it
 * is a stable PER-HOST verdict rather than a transient fleet-correlated
 * outage, it is the sole provenance of `dead("plan-restricted")`, and it is
 * what routes the ∅ modal to "upgrade" instead of "retry".
 *
 * That rule is enforced structurally, not by review: this interface exposes
 * positive outcomes only. There is no "classify this error" entry point, so
 * `isConfirmedTransportRefusal` (the PRE-DIAL directory gate that folds cloud
 * -DTO verdicts into its answer) cannot be fed to it by any argument a caller
 * could pass. Callers state the outcome they observed, from the error the
 * attempt itself produced.
 */
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "./selection-authority-contract";

/**
 * What a transport reports. Structurally identical to the matching methods of
 * `SelectionEvidenceKernel`, which declares `implements` against it so a
 * signature drift is a compile error rather than a silently dead producer.
 */
export interface TransportEvidenceReporter {
  /**
   * A transport session for `hostId` is now live. A live session anywhere in
   * the app is the strongest evidence class there is (invariant 5): it
   * suppresses death accumulation entirely and pins the lease `ready`, so a
   * session announced here MUST be retracted through {@link sessionLost} on
   * every teardown path, or the host can never be declared dead again.
   */
  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** A dial that reached the host. Clears the host's death streak. */
  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /**
   * A dial the HOST's transport plane terminally refused. `refusalDetail` is
   * `"plan-restricted"` only when this attempt's own error carried the
   * entitlement denial - see the module header.
   */
  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void;
  /** A dial that ran out of time without an answer. Death evidence. */
  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** An attempt that says nothing about the host. Inert by contract. */
  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void;
  /**
   * A restart tombstone this transport observed the HOST publish on its way
   * down (P1.4 / D5 / M1). Unlike every other member here it is not an
   * outcome of an attempt: it is the host stating that the outage about to
   * happen is deliberate, which is the one thing no renderer-local signal can
   * know when the restart was issued by somebody else - another machine, a
   * CLI on the box, an update install.
   *
   * Report it and keep going. It does NOT replace the ordinary teardown
   * evidence that follows on the same connection: the refusal/`sessionLost`
   * reports still fire, and the authority's derivation order is what puts the
   * expected-outage HOLD above the death streak they feed.
   *
   * `expiresAt` is the host's clock, carried for display only - the authority
   * bounds the episode with its own ceiling.
   */
  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void;
}

/**
 * For shells that have no selection authority to feed - the CLI, and every
 * test that builds a transport to exercise something else. Named rather than
 * defaulted: the transports take their reporter as a required option, so a new
 * construction site has to say which of the two it means.
 */
export const NO_TRANSPORT_EVIDENCE: TransportEvidenceReporter = {
  sessionEstablished: () => undefined,
  sessionLost: () => undefined,
  reportDialSuccess: () => undefined,
  reportDialRefusal: () => undefined,
  reportDialTimeout: () => undefined,
  reportDialIndeterminate: () => undefined,
  reportCompatVerdict: () => undefined,
  reportRestartIntent: () => undefined,
};

/**
 * A stable reporter whose target can be swapped underneath live transports.
 *
 * THE INVARIANT: the relay's scope must equal the pooled transports' scope.
 *
 * Remote sessions are shared through a MODULE-scoped cache
 * (`host-transport/remote/active-remote-sessions.ts`), so on a cache hit the
 * session-building factory never runs and whatever reporter the FIRST acquirer
 * wired is the one that session keeps for life. Handing transports the kernel
 * directly would therefore bind them to one kernel instance permanently: a
 * host-runtime remount builds a new kernel while cached sessions go on
 * reporting into the disposed one, whose evidence the engine drops at the
 * incarnation gate - silent evidence loss in exactly the window (a re-mount,
 * an account switch) where the engine most needs to be told what the sockets
 * are seeing.
 *
 * Holding one relay for as long as the session pool lives closes that: the
 * composition root binds the current kernel and unbinds on teardown, and every
 * transport - cached or fresh - reports into whichever kernel is live now.
 *
 * This is not ambient authority in `shared`: nothing here is a module
 * singleton. The relay is an ordinary constructor argument; it is the CLIENT
 * that holds one at the scope its own session pool lives at.
 */
export class TransportEvidenceRelay implements TransportEvidenceReporter {
  private target: TransportEvidenceReporter | null = null;
  /**
   * The live sessions this relay has been told about, and the reason it holds
   * state at all (redesign P1.3, review finding F2 half B).
   *
   * An attach carries the window's live-session inventory ATOMICALLY - that is
   * why the kernel keeps its own session map instead of asking the transports
   * at attach time (P1.1 decision 8: a re-announce step after the claim leaves
   * an observable empty-session window in which concurrent refusals count
   * against sockets that survived). But a kernel only learns about a session
   * when one is ANNOUNCED, and a pooled remote session announces exactly once,
   * at its own ready boundary: on a cache hit the session-building factory
   * never runs. So a kernel that starts life after the sessions already exist
   * attaches with an EMPTY inventory while live sockets are up - the
   * phantom-ABSENCE direction of P1.1's blocker 6, where refusals accumulate
   * against a host that is answering and the lease can reach `dead`.
   *
   * The relay is the one object whose lifetime already equals the session
   * pool's - that is this module's stated invariant - so it is where
   * pool-scoped state belongs. Deliberately NOT a queryable API: nothing reads
   * this map from outside, it exists only to be replayed at {@link bind}. A
   * getter would make it a second source of truth about liveness, competing
   * with the kernel's, and the whole point is that there is one.
   *
   * That prohibition is about LIVENESS, and it still stands - see
   * {@link currentSessionIdFor}, which is a read of a different map answering
   * a different question (what is this host's session CALLED), and which no
   * caller may turn into a liveness test.
   */
  private readonly liveSessions = new Map<
    string,
    { readonly hostId: string; readonly transportKind: SelectionTransportKind }
  >();
  /**
   * Per host, the id of the session most recently established through it.
   *
   * NAMES THE CURRENT SESSION FOR ANCHOR-BINDING; NEVER CONSULTED FOR
   * LIVENESS - THE KERNEL OWNS THAT. The distinction is what keeps this from
   * being the second opinion {@link liveSessions} refuses to become: a
   * consumer asks "what should I call the session my verdict was produced on",
   * never "is this host up". A caller that branches on `!== null` to decide
   * reachability has reintroduced exactly the competing source of truth the
   * map above exists to deny, whatever this one is named.
   *
   * Its consumer is the compat probe, which must stamp each verdict with the
   * session it actually ran on so the authority can order two verdicts by
   * session recency instead of by arrival (`rankForCompatAnchor`). A verdict
   * that names a session the authority no longer tracks is precisely what that
   * ordering is built to rank correctly, so a stale-looking answer here is
   * useful data, not a bug to paper over.
   *
   * SEPARATE from `liveSessions` rather than derived from it, because the two
   * hold different invariants: that one is keyed by session and holds EVERY
   * live session for replay, this one is keyed by host and holds ONE - the
   * newest. Deriving would mean re-deciding "which is newest" on every read
   * from a map whose ordering exists for another purpose entirely, and would
   * put one maintenance bug where it could be mistaken for the other's.
   */
  private readonly currentSessionIds = new Map<string, string>();
  /**
   * Restart tombstones observed while no kernel was bound, keyed by host.
   *
   * A tombstone looks like an EVENT, and replaying events is where
   * phantom-liveness bugs come from - so it is worth being exact about why
   * this one is STATE. The host is not reporting that something happened; it
   * is announcing an ONGOING condition - going down deliberately, coming back
   * - and that condition stops being true at a knowable moment. The two
   * retention rules below are what convert it back into state, and neither
   * needs a clock this relay does not have.
   *
   * `expiresAt` is retained for the report but NEVER consulted here: the
   * contract is explicit that it is the HOST's clock and display-only, and the
   * authority bounds episodes with its own ceiling. Reading it would be the
   * second opinion the contract forbids.
   */
  private readonly retainedRestartIntents = new Map<
    string,
    { readonly tombstoneId: string; readonly expiresAt: number | null }
  >();

  /**
   * Points the relay at `target`, REPLAYS what it already knows, and returns
   * the unbind. A second bind replaces the first outright rather than
   * stacking - two live kernels for one window is not a state this design has,
   * and silently fanning out to both would double every streak the authority
   * counts.
   *
   * The replay happens BEFORE this returns, so a bound target is never
   * live-but-empty: there is no window in which the kernel is receiving fresh
   * reports while still believing the pool is idle. In the composition that
   * matters, `acquireRendererSelectionKernel` binds before it calls
   * `start()`, so the replay lands in the kernel's session map before the
   * attach reads its inventory - which is what makes this fix the ATTACH
   * inventory rather than merely steady-state reporting.
   *
   * Sessions replay first, then tombstones. That order is the engine's own arm
   * order: an expected outage OUTRANKS a live session (a host that has
   * announced it is going down must not flash `ready` a moment before the
   * socket dies), so a host that legitimately holds both reproduces the same
   * verdict it would have reached live.
   */
  bind(target: TransportEvidenceReporter): () => void {
    this.target = target;
    for (const [sessionId, session] of this.liveSessions) {
      target.sessionEstablished(
        session.hostId,
        sessionId,
        session.transportKind,
      );
    }
    // CONSUMED, not re-announced. The semantics are "this was dropped on the
    // floor; hand it to whoever binds next", not "re-open an episode on every
    // bind". A redundant delivery would be inert anyway - the engine dedups on
    // (hostId, tombstoneId) and a duplicate can never extend an episode - but
    // relying on the consumer's dedup to bound our own re-announcement would
    // be the relay asserting something it does not know.
    const intents = Array.from(this.retainedRestartIntents);
    this.retainedRestartIntents.clear();
    for (const [hostId, intent] of intents) {
      target.reportRestartIntent(hostId, intent.tombstoneId, intent.expiresAt);
    }
    return () => {
      if (this.target === target) {
        this.target = null;
      }
    };
  }

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.liveSessions.set(sessionId, { hostId, transportKind });
    // Newest established wins outright: a host that opens a second session
    // while the first is still up is a host whose CURRENT session is the new
    // one, and a verdict produced from here on names it.
    this.currentSessionIds.set(hostId, sessionId);
    // RETENTION RULE 1: the host is back, so the restart it announced is over.
    // This agrees with the engine by construction rather than by coincidence -
    // the same evidence drives `onHostProvedAlive`, which closes the episode
    // there - which is what makes this copy incapable of disagreeing with the
    // authority's.
    this.retainedRestartIntents.delete(hostId);
    this.target?.sessionEstablished(hostId, sessionId, transportKind);
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    // Dropped from the inventory whether or not a target is bound. A session
    // lost during an unbound window must never be replayed as live - that is
    // the phantom-LIVENESS direction of blocker 6, and it is worse than the
    // absence this fix exists to close: a phantom session suppresses the death
    // streak for its host indefinitely.
    this.liveSessions.delete(sessionId);
    // CLEARED ONLY BY ITS OWN ID. Teardown and setup interleave - an old
    // session's `lost` routinely arrives AFTER the replacement's
    // `established`, which is the whole reason reconnection looks seamless -
    // and an unconditional delete here would blank the newer session's name on
    // the strength of the older one's departure, leaving verdicts produced
    // over a live connection anchored to nothing.
    if (this.currentSessionIds.get(hostId) === sessionId) {
      // FALL BACK TO A SURVIVING SESSION FOR THE SAME HOST before blanking the
      // name. The unary transport announces one session per connectivity
      // episode and retracts it when its last socket closes, and a fresh
      // socket per RPC means non-overlapping RPCs open and close an episode
      // EACH. So the compat probe's own `host.status` established
      // `local-ws:s<n>` (newest wins, above), its socket closed in the
      // caller's `finally` before the response was mapped, and this delete
      // ran - while `/stream`'s `local-stream:s1` was live the whole time.
      // `currentSessionIdFor(localHostId)` then read null at the one moment
      // the probe reads it, so every local-host compat verdict was UNANCHORED
      // and both D13 guards in `ingestCompat` were inert. A live session is a
      // live session; the newest one leaving does not make the older one gone.
      const survivor = this.latestLiveSessionFor(hostId);
      if (survivor === null) {
        this.currentSessionIds.delete(hostId);
      } else {
        this.currentSessionIds.set(hostId, survivor);
      }
    }
    this.target?.sessionLost(hostId, sessionId, transportKind);
  }

  /**
   * The most recently established session still live for `hostId`, or `null`.
   * `liveSessions` is a `Map`, so iteration is insertion order and the last
   * match is the newest.
   */
  private latestLiveSessionFor(hostId: string): string | null {
    let latest: string | null = null;
    for (const [sessionId, session] of this.liveSessions) {
      if (session.hostId === hostId) latest = sessionId;
    }
    return latest;
  }

  /**
   * What to call the session `hostId` is currently connected through, or
   * `null` when this relay knows of none.
   *
   * READ IT TO NAME A SESSION, NEVER TO TEST ONE. See
   * {@link currentSessionIds} for why that line is where it is: `null` here
   * means "I have no name to give you", which is emphatically not "the host is
   * down" - a relay that has never been told about a session answers `null`
   * for a host that is up and serving.
   */
  currentSessionIdFor(hostId: string): string | null {
    return this.currentSessionIds.get(hostId) ?? null;
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialSuccess(hostId, attemptId, transportKind);
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.target?.reportDialRefusal(
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    );
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialTimeout(hostId, attemptId, transportKind);
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialIndeterminate(hostId, attemptId, transportKind);
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.target?.reportCompatVerdict(input);
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    // RETAINED ONLY WHILE UNBOUND. With a kernel bound the report reaches it
    // now and there is nothing to hold; retaining anyway would mean replaying
    // it again at the next bind, re-opening an episode the authority already
    // knows about. The unbound window is precisely a host-runtime remount or
    // an account switch - and a restart observed during one is the case a
    // tombstone exists for, so dropping it there (the `?.` this replaces) is
    // the one loss that costs the exemption its whole purpose.
    if (this.target === null) {
      // Last write wins per host: a newer tombstone describes the restart that
      // is actually in progress, and the engine would ignore the older id as a
      // duplicate episode anyway.
      this.retainedRestartIntents.set(hostId, { tombstoneId, expiresAt });
      return;
    }
    this.target.reportRestartIntent(hostId, tombstoneId, expiresAt);
  }
}
