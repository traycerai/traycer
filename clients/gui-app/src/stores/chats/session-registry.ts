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

/** How long a chat session is kept warm after its last tile unmounts. */
export const DEFAULT_CHAT_IDLE_TTL_MS = 10 * 60 * 1_000;
export const MAX_ACTIVE_CHAT_IDLE_DEFER_MS = 60 * 60 * 1_000;

/** Upper bound on inactive lease-free warm sessions held at once. */
export const DEFAULT_MAX_WARM_CHAT_SESSIONS =
  DESKTOP_RETENTION_PROFILE.maxWarmChatSessions;

/**
 * Everything `acquire` needs to name ONE session: its identity - (epic, chat, host), see the class
 * doc on why the host is part of it - plus the scope key that discriminates rebuilds within that
 */
export interface ChatSessionTarget {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly scopeKey: string;
}

export interface ChatSessionRegistryOptions {
  readonly idleTtlMs: number;
  /** The warm-pool cap. */
  readonly maxWarmSessions: number | (() => number);
}

/**
 * Session identity is (epic, chat, host); chatId is host-minted and not globally unique.
 * Host belongs in the entry key, not only the scope key.
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
        // "Lease-free sessions with active chat work are never evicted by the cap, but they still
        // contribute to overflow and can crowd out older inactive warm sessions."
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
    // Read the scope BEFORE touching: a mismatch here is not the rebuild `acquire` performs, it is
    // "this caller is asking about a session that no longer exists on its terms", and a touch would
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

  /** The live sessions of ONE host in one epic. */
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
   * Live session keys bound to one host, across every epic. Overview's `host.status` refresh uses
   * this so a membership change on host B does not void host A's settled busy.
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

/** The host a key was built for. */
function chatSessionKeyHostId(key: SessionKey): string {
  return sessionKeyPartsOf(key)[2] ?? "";
}
function hasActiveChatWork(handle: ChatSessionStoreHandle): boolean {
  const state = handle.store.getState();
  // A chat parked on a human gate (interview / command approval / file-edit approval) is in progress
  // - the turn is blocked on the user, not finished.
  return (
    state.activeTurn !== null ||
    isChatRunInProgress(state.runStatus) ||
    state.pendingApprovals.length > 0 ||
    state.pendingFileEditApprovals.length > 0 ||
    state.pendingInterviews.length > 0
  );
}
