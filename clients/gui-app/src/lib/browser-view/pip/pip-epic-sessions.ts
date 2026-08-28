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
import type {
  BrowserSessionInfo,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";
import {
  browserSessionsLifecycle,
  browserSessionsReducer,
} from "../sessions/browser-sessions-stream";
import { applyPipCaption, applyPipHostLifecycle } from "./pip-store";

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
    try {
      const openedTransport = this.openTransport(slot.hostId);
      transport = openedTransport;
      const stream = new BrowserSessionsStreamClient({
        wsStreamClient: openedTransport.wsStreamClient,
        epicId: this.epicId,
        callbacks: {
          onServerFrame: (frame) => {
            if (slot.generation !== generation) return;
            this.applyFrame(slot, frame);
          },
          onConnectionStatus: (status, reason) => {
            if (slot.generation !== generation) return;
            const lifecycle = browserSessionsLifecycle(status, reason);
            applyPipHostLifecycle(this.epicId, slot.hostId, lifecycle);
          },
        },
      });
      slot.close = () => {
        try {
          stream.close();
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
    const next = browserSessionsReducer(slot.items, frame);
    if (next === null) return;
    // The remote fan-in merges several hosts into one list, so every session
    // carries the host it arrived from rather than the one it claims.
    slot.items = next.map((session) => tagSession(slot.hostId, session));
    this.publishMergedItems();
  }

  private dropHost(slot: HostSlot): void {
    this.closeSlot(slot);
    slot.items = [];
    applyPipHostLifecycle(this.epicId, slot.hostId, "closed");
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

function tagSession(
  hostId: string,
  session: BrowserSessionInfo,
): BrowserSessionInfo {
  if (session.hostId === hostId) return session;
  return { ...session, hostId };
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
