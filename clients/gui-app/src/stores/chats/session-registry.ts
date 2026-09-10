import {
  createSessionRegistry,
  sessionKeyOf,
  sessionKeyPartsOf,
  type SessionKey,
  type SessionRegistry,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { DESKTOP_RETENTION_PROFILE } from "@/stores/replica-memory/retention-profile";
import {
  isChatRunInProgress,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { acceptedActionIsUnsettled } from "@/stores/chats/chat-queue-reconciler";

/**
 * How long a chat session is kept warm after its last tile unmounts. A chat
 * not re-opened within this window has its `chat.subscribe` websocket closed
 * and its snapshot dropped; re-opening it later re-subscribes (and shows the
 * usual loading state once). Switching back inside the window is instant.
 */
export const DEFAULT_CHAT_IDLE_TTL_MS = 10 * 60 * 1_000;
export const MAX_ACTIVE_CHAT_IDLE_DEFER_MS = 60 * 60 * 1_000;

/**
 * Upper bound on inactive lease-free warm sessions held at once. The idle TTL
 * bounds retention in time; this bounds it in count, so cycling through many
 * chats inside one TTL window cannot pin an unbounded set of finished
 * transcripts and open websockets. Oldest-released inactive sessions are
 * disposed first. Leased sessions are outside the warm pool. Lease-free
 * sessions with active chat work are never evicted by the cap, but they still
 * contribute to overflow and can crowd out older inactive warm sessions.
 */
export const DEFAULT_MAX_WARM_CHAT_SESSIONS =
  DESKTOP_RETENTION_PROFILE.maxWarmChatSessions;

/**
 * Everything `acquire` needs to name ONE session: its identity - (epic, chat,
 * host), see the class doc on why the host is part of it - plus the scope key
 * that discriminates rebuilds within that identity.
 */
export interface ChatSessionTarget {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly scopeKey: string;
}

export interface ChatSessionRegistryOptions {
  readonly idleTtlMs: number;
  /**
   * The warm-pool cap. A function is resolved on every cap walk, which is
   * how the production singleton follows the shell's retention profile
   * without having to be constructed after the shell selected it.
   */
  readonly maxWarmSessions: number | (() => number);
}

/**
 * Small per-renderer registry for live `chat.subscribe` sessions. It mirrors
 * the open-Epic registry shape, but chat tiles are lease-counted because the
 * same chat can be rendered by more than one surface in a window.
 *
 * The warm-pool MECHANISM - the lease count, the idle clock, the cap, the one
 * teardown path - is the shared {@link createSessionRegistry}, which the
 * terminal twin and the open-epic registry also run on. What is left here is
 * this plane's identity (below), its policy VALUES, and its own answer to what
 * "busy" means. Nothing about any of those changed when the three
 * implementations became one.
 *
 * ## Session identity is (epic, chat, HOST)
 *
 * `chatId` is HOST-MINTED, so it is unique per host, not globally: two
 * different hosts can legitimately own a chat with the same id under the same
 * epic (post-fork twins in production, `--adopt-store` copies of one identity
 * store in dev). Keying sessions on `epic:chat` alone made those two chats
 * ONE entry, and since the scope key does carry the host, a second tile's
 * `acquire` read the first host's entry, saw a scope mismatch, and DISPOSED
 * it - closing the live websocket out from under a mounted tile that was
 * still holding the handle. The host therefore belongs in the entry key, not
 * only in the scope key: a different host is a DIFFERENT session, never a
 * rebuild of the same one.
 *
 * The scope key keeps its own (narrower) job: within one (epic, chat, host)
 * it still discriminates user, transport dialability and owner identity, and
 * a mismatch there is still a legitimate in-place rebuild.
 *
 * Time-based keep-alive: when a chat's last lease is dropped (its tile
 * unmounts - no longer on a mere tab switch, since pane chat retention keeps
 * the tile mounted, but still on eviction or close) the session is NOT torn
 * down. Its websocket stays
 * open and its loaded snapshot is retained so switching back paints instantly
 * - no reconnect, no loading spinner. A lease-free ("idle") session is held
 * until it goes untouched for `idleTtlMs`, at which point it is disposed.
 * Re-opening or otherwise touching the session resets that window. Leased
 * sessions (a currently-rendered tile) never expire - only the idle clock
 * runs - so a window with many open chat tiles keeps them all. Inactive idle
 * sessions are additionally count-bounded by `maxWarmSessions`
 * (oldest-released evicted first) so the TTL window alone cannot accumulate an
 * unbounded set. Idle sessions with active work are retained until the work
 * settles or the active defer cap elapses, though they still contribute to the
 * overflow count while selecting inactive eviction candidates.
 */
export class ChatSessionRegistry {
  private readonly sessions: SessionRegistry<ChatSessionStoreHandle>;

  constructor(options: ChatSessionRegistryOptions) {
    this.sessions = createSessionRegistry<ChatSessionStoreHandle>({
      environment: createRendererRuntimeEnvironment(),
      policy: {
        idleTtlMs: options.idleTtlMs,
        // A getter, read on every cap walk - see `maxWarmSessions`.
        get maxWarm(): number {
          return typeof options.maxWarmSessions === "function"
            ? options.maxWarmSessions()
            : options.maxWarmSessions;
        },
        // The cap bounds the WARM pool: "Leased sessions are outside the warm
        // pool."
        warmCapScope: "demand-free",
        // "Lease-free sessions with active chat work are never evicted by the
        // cap, but they still contribute to overflow and can crowd out older
        // inactive warm sessions."
        busyCountsTowardWarmCap: true,
        maxActiveDeferMs: MAX_ACTIVE_CHAT_IDLE_DEFER_MS,
        // A release stamps `lastUsedAt`, which is what the overflow sort reads.
        refreshOrderOnRelease: true,
        // Every chat session is worth keeping warm; this plane has no
        // unreattachable state.
        retainWhenIdle: () => true,
        hasActiveWork: hasActiveChatWork,
        // Nothing a chat session holds is lost by disposing it: the transcript
        // is the host's, and a re-open re-subscribes.
        isEvictable: () => true,
        onBeforeDispose: () => "dispose",
        dispose: (handle) => {
          handle.dispose();
        },
        onParked: () => {},
        onRevived: () => {},
      },
    });
  }

  size(): number {
    return this.sessions.size();
  }

  get(
    epicId: string,
    chatId: string,
    hostId: string,
    scopeKey: string,
  ): ChatSessionStoreHandle | null {
    const key = chatSessionKey(epicId, chatId, hostId);
    // Read the scope BEFORE touching: a mismatch here is not the rebuild
    // `acquire` performs, it is "this caller is asking about a session that no
    // longer exists on its terms", and a touch would extend the life of an
    // entry the caller is not going to use.
    const entry = this.sessions.peekEntry(key);
    if (entry === null || entry.scopeKey !== scopeKey) return null;
    return this.sessions.get(key);
  }

  peek(
    epicId: string,
    chatId: string,
    hostId: string,
  ): ChatSessionStoreHandle | null {
    return this.sessions.peek(chatSessionKey(epicId, chatId, hostId));
  }

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): ChatSessionStoreHandle[] {
    return Array.from(this.sessions.list());
  }

  /**
   * The live sessions of ONE host in one epic. The host is part of a session's
   * identity, so a surface bound to a host - a tab, a card - must read through
   * this rather than filtering `listHandles` on the chat id alone: chat ids are
   * host-minted, and a cross-host clone carries the source's ids verbatim.
   */
  listHandlesForHost(epicId: string, hostId: string): ChatSessionStoreHandle[] {
    const handles: ChatSessionStoreHandle[] = [];
    for (const entry of this.sessions.entries()) {
      if (chatSessionKeyHostId(entry.key) !== hostId) continue;
      if (entry.session.epicId !== epicId) continue;
      handles.push(entry.session);
    }
    return handles;
  }

  /**
   * Live session keys bound to one host, across every epic. Overview's
   * `host.status` refresh uses this so a membership change on host B does
   * not void host A's settled busy. Reads the acquire-time identity out of
   * the key, not the WeakMap the React hook stamps.
   */
  membershipIdsForHost(hostId: string): string[] {
    const ids: string[] = [];
    for (const key of this.sessions.keys()) {
      if (chatSessionKeyHostId(key) !== hostId) continue;
      ids.push(key);
    }
    ids.sort();
    return ids;
  }

  /**
   * The chat plane's half of a park verdict for one Epic: whether any of its
   * chats still holds work, and which hosts those chats are served from.
   *
   * Parking decides ONCE, at the epic, and then force-disposes every chat under
   * it through {@link disposeForEpic}. Before this existed the epic-side gates
   * read the epic store and the agent-activity plane and nothing else, so a
   * chat holding an unacknowledged queue action was destroyed by a decision
   * that never looked at it. The hosts come back with the answer because the
   * activity plane's COVERAGE is per host, and a chat can be served from a host
   * the epic's own session is not - so an epic-only coverage check can be
   * satisfied while the plane is blind to exactly the host whose chat is about
   * to be thrown away.
   */
  unsettledWorkForEpic(epicId: string): {
    readonly unsettled: boolean;
    readonly hostIds: readonly string[];
  } {
    const hostIds = new Set<string>();
    let unsettled = false;
    for (const entry of this.sessions.entries()) {
      const handle = entry.session;
      if (handle.epicId !== epicId) continue;
      // Off the KEY, not the handle: the host is part of a chat session's
      // identity rather than a field on it, which is why `listHandlesForHost`
      // reads it the same way.
      hostIds.add(chatSessionKeyHostId(entry.key));
      if (hasUnsettledChatWork(handle)) unsettled = true;
    }
    return { unsettled, hostIds: Array.from(hostIds) };
  }

  subscribe(listener: () => void): () => void {
    return this.sessions.subscribe(listener);
  }

  acquire(
    target: ChatSessionTarget,
    factory: (epicId: string, chatId: string) => ChatSessionStoreHandle,
  ): ChatSessionStoreHandle {
    const { epicId, chatId, hostId, scopeKey } = target;
    return this.sessions.acquire(
      chatSessionKey(epicId, chatId, hostId),
      scopeKey,
      () => factory(epicId, chatId),
    );
  }

  release(epicId: string, chatId: string, hostId: string): void {
    this.sessions.release(chatSessionKey(epicId, chatId, hostId), "warm");
  }

  releaseHandle(
    epicId: string,
    chatId: string,
    hostId: string,
    handle: ChatSessionStoreHandle,
  ): void {
    this.sessions.releaseHandle(
      chatSessionKey(epicId, chatId, hostId),
      handle,
      "warm",
    );
  }

  forceRelease(epicId: string, chatId: string, hostId: string): void {
    this.sessions.forceRelease(chatSessionKey(epicId, chatId, hostId));
  }

  /**
   * End every live session of one epic - leased, warm, on any host.
   *
   * Renderer parking's half of this plane (plan C, decision C1). A chat session
   * claims a VISIBLE lease on its epic through the host's chat session, so one
   * surviving `chat.subscribe` keeps the epic pinned and the whole park buys
   * nothing. Dropping the tiles' leases is not enough on its own: this plane's
   * whole design is that a lease-free session stays warm with its websocket
   * open for `idleTtlMs`, so a park that only released leases would leave the
   * epic pinned for another ten minutes - past the host's own idle window, and
   * past the "an epic with no agent activity sheds in about seven minutes"
   * the plan is sized around.
   *
   * Leased sessions go too, and that is not a violation of the lease contract
   * so much as the reason this method exists: parking is the caller stating
   * that no surface of this epic is visible, so a lease still held is one from
   * a tile that is about to unmount with the epic's own React subtree. The
   * shared `discard` tears down regardless of demand and the later
   * `releaseHandle` from that unmount is a no-op against a gone entry, so the
   * order the two happen in does not matter.
   *
   * Deliberately NOT `hasActiveChatWork`-gated. That predicate governs whether
   * the TTL and the cap may reclaim a session on their own schedule; this is a
   * caller with a fact neither of them has. Eligibility for a park is decided
   * once, at the epic, through the open-epic registry's own gates - and an epic
   * whose agents are working never reaches this call.
   */
  disposeForEpic(epicId: string): void {
    this.sessions.transact(() => {
      for (const entry of this.sessions.entries()) {
        if (entry.session.epicId !== epicId) continue;
        this.sessions.discard(entry.key, "released");
      }
    });
  }

  disposeAll(): void {
    this.sessions.disposeAll();
  }
}

function chatSessionKey(
  epicId: string,
  chatId: string,
  hostId: string,
): SessionKey {
  return sessionKeyOf([epicId, chatId, hostId]);
}

/**
 * The host a key was built for.
 *
 * Reading the identity back out of the key rather than mirroring it on the
 * entry, so there is one record of which host a session belongs to and it
 * cannot disagree with the key the session is filed under.
 *
 * Decoded with the ENCODER's own reader. This used to keep a private copy of
 * the separator and `split` on it - a duplication that survives only until the
 * encoding changes. When `sessionKeyOf` moved to a length-prefixed form (a NUL
 * is no more excluded from an id than a `:` is), a local split would have gone
 * on parsing a shape nobody writes, and answered a confidently wrong host id
 * rather than failing to compile.
 */
function chatSessionKeyHostId(key: SessionKey): string {
  return sessionKeyPartsOf(key)[2] ?? "";
}
/**
 * {@link hasActiveChatWork} plus everything the user has issued that has not
 * reached its OWN end - a pause, a queue edit, an approval response, a
 * checkpoint restore still running, an accepted send the host has not confirmed,
 * and a rejected send's prompt still waiting for the composer to take it.
 *
 * The unit is the lifecycle, not the acknowledgement. `pendingActions` empties
 * when the host says it heard the frame, which is the START of the interesting
 * part for a send: an ack moves the record to `acceptedActions` with its
 * recovery fields, and a rejection moves the prompt to `failedSendRestoration`
 * where it is the only copy until a mounted driver persists it. Both are read
 * here, because a park that fires between the ack and the end destroys the
 * state that would have recovered.
 *
 * SEPARATE from `hasActiveChatWork`, and deliberately so. That predicate
 * governs whether the idle TTL and the warm-overflow cap may reclaim a session
 * on their own schedule, and those two are allowed to reclaim a chat whose only
 * outstanding item is an unacknowledged action: re-opening re-subscribes and
 * the reconciler replays from the host's answer. A PARK is not that. It is a
 * decision taken at the epic that force-disposes every chat beneath it at once,
 * so it has to see the action that a TTL is entitled to ignore. Widening
 * `hasActiveChatWork` itself would silently change the TTL and cap behaviour
 * for a reason that belongs only to parking.
 */
function hasUnsettledChatWork(handle: ChatSessionStoreHandle): boolean {
  if (hasActiveChatWork(handle)) return true;
  const state = handle.store.getState();
  if (Object.keys(state.pendingActions).length > 0) return true;
  // AN ACTION LEAVING `pendingActions` IS AN ACKNOWLEDGEMENT, NOT A
  // SETTLEMENT, and reading it as one destroyed user text.
  //
  // A send rejected after a deferred deadline does not simply vanish: it moves
  // the prompt into `failedSendRestoration`, where it is the ONLY copy until
  // the initial-chat-handoff driver's effect writes it into the composer draft
  // store. Parking on the acknowledgement disposes both planes, the gate
  // unmounts that driver, and the effect never runs - so the prompt is gone.
  // Held until the slot is consumed, which is what `ackFailedSendRestoration`
  // marks.
  if (state.failedSendRestoration !== null) return true;
  // An accepted action is not finished at its ACK - but what "finished" means
  // is the action's own, so `acceptedActionIsUnsettled` decides per kind
  // against the live queue (a `restoreCheckpoint` record is retired by its
  // own frames instead, so for it existence is the hold). Reading
  // `confirmedByHost` here instead was wrong twice over: it is a send-only
  // fact that no other kind ever gains, so a session that once paused a queue
  // never parked again; and the records it judged were free to be pruned by
  // age or by the cap while the hold was still needed, which is why the
  // pruner now locks exactly the records this asks about.
  const settlement = { queue: state.queue };
  for (const action of Object.values(state.acceptedActions)) {
    if (acceptedActionIsUnsettled(action, settlement)) return true;
  }
  // A checkpoint restore that is still running. `completed` persists in this
  // slot for toast and dialog consumers, so it is finished and does not hold.
  const restoreKind = state.restore?.kind;
  if (restoreKind === "in-flight" || restoreKind === "progressing") return true;
  return false;
}

function hasActiveChatWork(handle: ChatSessionStoreHandle): boolean {
  const state = handle.store.getState();
  // A chat parked on a human gate (interview / command approval / file-edit
  // approval) is in progress - the turn is blocked on the user, not finished.
  // Count it as active work so the warm-chat idle TTL and the warm-overflow cap
  // do not dispose its `chat.subscribe` stream while the user is still expected
  // to answer (the host holds its session alive in the same situation).
  return (
    state.activeTurn !== null ||
    isChatRunInProgress(state.runStatus) ||
    state.pendingApprovals.length > 0 ||
    state.pendingFileEditApprovals.length > 0 ||
    state.pendingInterviews.length > 0
  );
}
