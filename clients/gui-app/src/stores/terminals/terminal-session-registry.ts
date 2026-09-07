import {
  createSessionRegistry,
  type SessionRegistry,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import {
  DESKTOP_RETENTION_PROFILE,
  getRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";

/**
 * How long a released, still-running plain terminal keeps its handle (and therefore its live
 * `terminal.subscribe` stream + warm xterm engine) before the registry evicts it.
 */
export const PLAIN_TERMINAL_RELEASE_LINGER_MS = 10 * 60 * 1000;

/** Upper bound on lease-free lingering plain terminals held at once. */
export const MAX_LINGERING_PLAIN_TERMINALS =
  DESKTOP_RETENTION_PROFILE.maxLingeringPlainTerminals;

/**
 * Owner-scoped identity for warm-presentation lookup. Terminal sessions always carry the bound
 * owner `hostId`.
 */
export type TerminalWarmSessionIdentity = {
  readonly hostId: string | null;
  readonly sessionId: string;
};

/**
 * What this registry holds per tab instance: the handle, the owner host it was acquired for, and
 * the status subscription that evicts it once the session becomes unreattachable.
 */
interface TerminalRegistrySession {
  readonly handle: TerminalSessionStoreHandle;
  /** Bound owner host. `null` is the explicit hostless path. */
  readonly hostId: string | null;
  unsubscribeStatus: () => void;
}

/** Every terminal entry shares one scope. */
const TERMINAL_SESSION_SCOPE = "terminal";

/**
 * Per-renderer registry for live `terminal.subscribe` sessions, lease-counted so the same tab
 * instance can mount in more than one place (a split-reparent transition, StrictMode double-mount)
 */
export class TerminalSessionRegistry {
  private readonly sessions: SessionRegistry<TerminalRegistrySession>;

  constructor() {
    this.sessions = createSessionRegistry<TerminalRegistrySession>({
      environment: createRendererRuntimeEnvironment(),
      policy: {
        idleTtlMs: PLAIN_TERMINAL_RELEASE_LINGER_MS,
        // The shell's retention profile (desktop:
        // `MAX_LINGERING_PLAIN_TERMINALS`), read on every cap walk.
        get maxWarm(): number {
          return getRetentionProfile().maxLingeringPlainTerminals;
        },
        warmCapScope: "demand-free",
        // "The count-bounded pool is the lingering plain terminals only ... counting them would let N
        // running agents flush every lingering shell immediately."
        busyCountsTowardWarmCap: false,
        // A running terminal-agent "is kept warm indefinitely (its tab may reopen any time while the agent
        // works)", so it is not on a clock at all - the status subscription below is what collects it.
        maxActiveDeferMs: null,
        // Ordered by release, which is what `releaseSequence` recorded.
        refreshOrderOnRelease: true,
        retainWhenIdle: ({ handle }) =>
          shouldKeepLeaseFree(handle) || shouldLingerLeaseFree(handle),
        // "Busy" here is the indefinite keep-warm class: a running terminal-agent. A lingering plain
        // terminal is not busy - it is warm on a clock.
        hasActiveWork: ({ handle }) => shouldKeepLeaseFree(handle),
        // Nothing a terminal handle holds is lost by disposing it: the PTY runs
        // host-side and a reattach replays scrollback.
        isEvictable: () => true,
        onBeforeDispose: () => "dispose",
        dispose: (session) => {
          session.unsubscribeStatus();
          session.handle.dispose();
        },
        // Attachment intent follows lease state, not session kind: a lease-free running terminal-agent
        // (indefinite keep-warm) or lingering plain terminal must not claim attention.
        onParked: ({ handle }) => {
          handle.store.getState().setViewer("cache");
        },
        // Lease-free keep-warm / linger was tagged `cache`. A tile looking
        // again is presentation; intent is open-frame-only so this reopens.
        onRevived: ({ handle }) => {
          handle.store.getState().setViewer("presentation");
        },
      },
    });
  }

  size(): number {
    return this.sessions.size();
  }

  /**
   * Subscribe to membership changes (an instance added or removed). Mirrors
   * `ChatSessionRegistry.subscribe`.
   */
  subscribe(listener: () => void): () => void {
    return this.sessions.subscribe(listener);
  }

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): TerminalSessionStoreHandle[] {
    return this.sessions.list().map((session) => session.handle);
  }

  /**
   * Live tab-instance ids bound to one host. Overview's `host.status` refresh uses this so a
   * membership change on host B does not void host A's settled busy.
   */
  membershipIdsForHost(hostId: string): string[] {
    const ids: string[] = [];
    for (const entry of this.sessions.entries()) {
      if (entry.session.hostId !== hostId) continue;
      ids.push(entry.key);
    }
    ids.sort();
    return ids;
  }

  /** Live tab-instance ids. */
  listInstanceIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  get(instanceId: string): TerminalSessionStoreHandle | null {
    // `peek`, not `get`: this plane has never refreshed recency on a read, and
    // its eviction order is the release order rather than a last-used one.
    return this.sessions.peek(instanceId)?.handle ?? null;
  }

  acquire(
    instanceId: string,
    factory: () => TerminalSessionStoreHandle,
    hostId: string | null,
  ): TerminalSessionStoreHandle {
    return this.sessions.acquire(instanceId, TERMINAL_SESSION_SCOPE, () => {
      const handle = factory();
      return {
        handle,
        hostId,
        unsubscribeStatus: this.watchDefunct(instanceId, handle),
      };
    }).handle;
  }

  /** Subscribe the handle's store for defunct-state eviction of the entry at `instanceId`. */
  private watchDefunct(
    instanceId: string,
    handle: TerminalSessionStoreHandle,
  ): () => void {
    return handle.store.subscribe((state) => {
      const defunct =
        state.status === "exited" ||
        // `TERMINAL_NOT_FOUND` only proves this handle's PTY is gone.
        state.status === "reaped" ||
        (state.status === "lost" && state.kind === "terminal");
      if (!defunct) return;
      this.evictDefunctLeaseFreeEntry(instanceId);
    });
  }

  /**
   * A lease-free warm entry for `sessionId` that a NEW tab instance may adopt ({@link
   * rekeyLeaseFreeEntry}).
   */
  findAdoptableInstanceId(
    identity: TerminalWarmSessionIdentity,
    newInstanceId: string,
  ): string | null {
    if (this.sessions.peekEntry(newInstanceId) !== null) return null;
    for (const entry of this.sessions.entries()) {
      if (entry.session.handle.sessionId !== identity.sessionId) continue;
      if (entry.session.hostId !== identity.hostId) continue;
      if (entry.demand > 0) continue;
      if (entry.session.handle.store.getState().status === "reaped") continue;
      return entry.key;
    }
    return null;
  }

  /**
   * Rekey a lease-free entry to a new tab instance id so a reopened tab revives the closed tab's
   * warm handle (live stream, current scrollback) instead of duplicating the subscription.
   */
  rekeyLeaseFreeEntry(oldInstanceId: string, newInstanceId: string): boolean {
    const entry = this.sessions.peekEntry(oldInstanceId);
    if (entry === null) return false;
    const session = entry.session;
    return this.sessions.transact(() => {
      // Re-armed under whichever key the entry ends up at, including when the move loses its race.
      session.unsubscribeStatus();
      const moved = this.sessions.rekey(oldInstanceId, newInstanceId);
      session.unsubscribeStatus = this.watchDefunct(
        moved ? newInstanceId : oldInstanceId,
        session.handle,
      );
      return moved;
    });
  }

  /**
   * Drop one lease. `transportAlive` is the acquire effect's readiness at cleanup time (directory
   * entry + signed-in user still present).
   */
  release(
    instanceId: string,
    handle: TerminalSessionStoreHandle,
    transportAlive: boolean,
  ): void {
    const entry = this.sessions.peekEntry(instanceId);
    if (entry === null) return;
    // A defunct handle may be replaced while an older consumer is still mounted.
    if (entry.session.handle !== handle) return;
    this.sessions.release(instanceId, transportAlive ? "warm" : "dispose");
  }

  forceRelease(instanceId: string): void {
    this.sessions.forceRelease(instanceId);
  }

  disposeAll(): void {
    this.sessions.disposeAll();
  }

  /**
   * Drops a lease-free entry whose session became unreattachable (exited, or a plain terminal whose
   * stream closed for good).
   */
  private evictDefunctLeaseFreeEntry(instanceId: string): void {
    const entry = this.sessions.peekEntry(instanceId);
    if (entry === null) return;
    if (entry.demand > 0) return;
    this.sessions.discard(instanceId, "unusable");
  }
}

function shouldKeepLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return (
    state.kind === "terminal-agent" &&
    state.status !== "exited" &&
    state.status !== "reaped"
  );
}

/**
 * A released plain terminal lingers for {@link PLAIN_TERMINAL_RELEASE_LINGER_MS} only while its
 * stream can still serve a reattach (creating/running).
 */
function shouldLingerLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return (
    state.kind === "terminal" &&
    state.status !== "exited" &&
    state.status !== "lost" &&
    state.status !== "reaped"
  );
}
