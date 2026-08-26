/**
 * Remote-host `browser.sessions` fan-in for manual browser PiP.
 *
 * `BrowserSessionsProvider` is the sole primary-host authority. This manager
 * subscribes only to the non-primary hosts named by the current or pending
 * PiP target and forwards their inventory and selected-tab captions to PiP.
 *
 * Plain object (not a hook-per-host) so the host set can be data-driven.
 * Dispose closes every subscription; there is no retained detached state.
 */
import {
  browserSessionsServerFrameSchema,
  type BrowserSessionInfo,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { appLogger } from "@/lib/logger";
import {
  applyPipCaption,
  applyPipHostLifecycle,
  markPipHostUnavailable,
  type PipHostLifecycle,
} from "./pip-store";

const BROWSER_SESSIONS_METHOD = "browser.sessions";

interface HostSlot {
  readonly hostId: string;
  close: (() => void) | null;
  items: readonly BrowserSessionInfo[];
  generation: number;
}

export class RemotePipSessionsManager {
  private readonly epicId: string;
  private readonly openTransport: (hostId: string) => DurableStreamTransport;
  private readonly onItems: (items: readonly BrowserSessionInfo[]) => void;
  private readonly hosts = new Map<string, HostSlot>();
  private desiredHostIds: readonly string[] = [];
  private attached = false;
  private disposed = false;

  constructor(
    epicId: string,
    openTransport: (hostId: string) => DurableStreamTransport,
    onItems: (items: readonly BrowserSessionInfo[]) => void,
  ) {
    this.epicId = epicId;
    this.openTransport = openTransport;
    this.onItems = onItems;
  }

  setHostIds(hostIds: readonly string[]): void {
    if (this.disposed) return;
    const changed = !sameHostIds(this.desiredHostIds, hostIds);
    if (changed) this.desiredHostIds = [...hostIds];
    this.reconcile(changed);
  }

  attach(): void {
    if (this.disposed || this.attached) return;
    this.attached = true;
    this.reconcile(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attached = false;
    this.closeEveryHost();
    this.hosts.clear();
    this.onItems([]);
  }

  private reconcile(publish: boolean): void {
    if (!this.attached || this.disposed) return;
    const desired = new Set(this.desiredHostIds);
    for (const [hostId, slot] of Array.from(this.hosts.entries())) {
      if (desired.has(hostId)) continue;
      this.dropHost(slot);
      this.hosts.delete(hostId);
    }
    for (const hostId of desired) {
      let slot = this.hosts.get(hostId);
      if (slot === undefined) {
        slot = {
          hostId,
          close: null,
          items: [],
          generation: 0,
        };
        this.hosts.set(hostId, slot);
      }
      if (slot.close === null) this.openHost(slot);
    }
    if (publish) this.publishMergedItems();
  }

  private openHost(slot: HostSlot): void {
    slot.generation += 1;
    const generation = slot.generation;
    let transport: DurableStreamTransport | null = null;
    let closed = false;
    try {
      const openedTransport = this.openTransport(slot.hostId);
      transport = openedTransport;
      const session = openedTransport.wsStreamClient.subscribe(
        BROWSER_SESSIONS_METHOD,
        { epicId: this.epicId },
      );
      session.onServerFrame((envelope, binaryPayload) => {
        if (closed || slot.generation !== generation) return;
        if (binaryPayload !== null) {
          appLogger.error(
            "[pip] rejected binary browser.sessions frame",
            { hostId: slot.hostId, byteLength: binaryPayload.byteLength },
            new Error("browser.sessions does not accept binary server frames."),
          );
          return;
        }
        const parsed = browserSessionsServerFrameSchema.safeParse(envelope);
        if (!parsed.success) {
          appLogger.error(
            "[pip] rejected invalid browser.sessions frame",
            { hostId: slot.hostId, issues: parsed.error.message },
            parsed.error,
          );
          return;
        }
        this.applyFrame(slot, parsed.data);
      });
      session.onStatusChange((status, reason) => {
        if (closed || slot.generation !== generation) return;
        const lifecycle = pipHostLifecycle(status, reason);
        applyPipHostLifecycle(this.epicId, slot.hostId, lifecycle);
      });
      slot.close = () => {
        if (closed) return;
        closed = true;
        try {
          session.close();
        } finally {
          openedTransport.close();
        }
      };
    } catch (cause) {
      transport?.close();
      slot.close = null;
      appLogger.warn("[pip] remote target sessions subscribe failed", {
        epicId: this.epicId,
        hostId: slot.hostId,
        error: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }

  private applyFrame(slot: HostSlot, frame: BrowserSessionsServerFrame): void {
    if (frame.kind === "burstStarted" || frame.kind === "burstEnded") {
      return;
    }
    if (frame.kind === "caption") {
      applyPipCaption({
        epicId: this.epicId,
        hostId: slot.hostId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        cellTitle: frame.cellTitle,
      });
      return;
    }
    if (frame.kind === "snapshot") {
      slot.items = frame.sessions.map((session) =>
        tagSession(slot.hostId, session),
      );
      this.publishMergedItems();
      return;
    }
    if (frame.kind === "sessionCreated" || frame.kind === "sessionUpdated") {
      slot.items = upsertSession(
        slot.items,
        tagSession(slot.hostId, frame.session),
      );
      this.publishMergedItems();
      return;
    }
    if (frame.kind === "sessionClosed") {
      slot.items = slot.items.filter(
        (session) => session.sessionId !== frame.sessionId,
      );
      this.publishMergedItems();
    }
  }

  private dropHost(slot: HostSlot): void {
    this.closeSlot(slot);
    slot.items = [];
    markPipHostUnavailable(this.epicId, slot.hostId);
  }

  private closeEveryHost(): void {
    for (const slot of this.hosts.values()) {
      this.closeSlot(slot);
      slot.items = [];
    }
  }

  private closeSlot(slot: HostSlot): void {
    slot.generation += 1;
    const close = slot.close;
    slot.close = null;
    close?.();
  }

  private publishMergedItems(): void {
    const merged: BrowserSessionInfo[] = [];
    for (const hostId of this.desiredHostIds) {
      const slot = this.hosts.get(hostId);
      if (slot === undefined) continue;
      for (const item of slot.items) merged.push(item);
    }
    this.onItems(merged);
  }
}

function pipHostLifecycle(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): PipHostLifecycle {
  if (status === "open") return "live";
  if (status === "reconnecting") return "reconnecting";
  if (status === "connecting") return "connecting";
  if (reason !== null && reason.kind !== "caller") return "failed";
  return "closed";
}

function tagSession(
  hostId: string,
  session: BrowserSessionInfo,
): BrowserSessionInfo {
  if (session.hostId === hostId) return session;
  return { ...session, hostId };
}

function upsertSession(
  current: readonly BrowserSessionInfo[],
  next: BrowserSessionInfo,
): readonly BrowserSessionInfo[] {
  const existing = current.findIndex(
    (session) => session.sessionId === next.sessionId,
  );
  if (existing === -1) return [...current, next];
  return current.map((session, index) => (index === existing ? next : session));
}

function sameHostIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].toSorted((a, b) => a.localeCompare(b));
  const sortedRight = [...right].toSorted((a, b) => a.localeCompare(b));
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}
