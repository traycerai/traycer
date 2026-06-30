import { EventEmitter } from "node:events";
import type { OwnershipEntry } from "../../ipc-contracts/window-types";
import type { DesktopStateStore } from "./desktop-state-store";

export type OwnershipClaimResult =
  { readonly ok: true } | { readonly ok: false; readonly currentOwner: string };

type OwnershipListener = (entries: readonly OwnershipEntry[]) => void;

export class EpicWindowOwnership {
  private readonly events = new EventEmitter();
  private readonly store: DesktopStateStore | null;
  private readonly ownershipByTabId = new Map<
    string,
    { readonly epicId: string; readonly windowId: string }
  >();

  constructor(store: DesktopStateStore | null) {
    this.store = store;
    if (store !== null) {
      for (const entry of store.getOwnershipEntries()) {
        this.ownershipByTabId.set(entry.tabId, {
          epicId: entry.epicId,
          windowId: entry.windowId,
        });
      }
    }
  }

  getOwner(tabId: string): string | null {
    return this.ownershipByTabId.get(tabId)?.windowId ?? null;
  }

  getOwnerForEpic(epicId: string): string | null {
    return (
      this.snapshot().find((entry) => entry.epicId === epicId)?.windowId ?? null
    );
  }

  getOwnedTabs(windowId: string): readonly string[] {
    return this.snapshot()
      .filter((entry) => entry.windowId === windowId)
      .map((entry) => entry.tabId);
  }

  claim(tabId: string, epicId: string, windowId: string): OwnershipClaimResult {
    const currentOwner = this.getOwner(tabId);
    if (currentOwner !== null && currentOwner !== windowId) {
      return { ok: false, currentOwner };
    }
    this.ownershipByTabId.set(tabId, { epicId, windowId });
    this.persistAndEmit();
    return { ok: true };
  }

  release(tabId: string, windowId: string): void {
    if (this.getOwner(tabId) !== windowId) {
      return;
    }
    this.ownershipByTabId.delete(tabId);
    this.persistAndEmit();
  }

  releaseWindow(windowId: string): void {
    const ownedTabs = this.getOwnedTabs(windowId);
    if (ownedTabs.length === 0) {
      return;
    }
    for (const tabId of ownedTabs) {
      this.ownershipByTabId.delete(tabId);
    }
    this.persistAndEmit();
  }

  transfer(tabId: string, fromWindowId: string, toWindowId: string): void {
    const current = this.ownershipByTabId.get(tabId);
    if (current?.windowId !== fromWindowId) {
      return;
    }
    this.ownershipByTabId.set(tabId, {
      epicId: current.epicId,
      windowId: toWindowId,
    });
    this.persistAndEmit();
  }

  snapshot(): readonly OwnershipEntry[] {
    return Array.from(this.ownershipByTabId.entries()).map(
      ([tabId, entry]) => ({
        tabId,
        epicId: entry.epicId,
        windowId: entry.windowId,
      }),
    );
  }

  on(event: "change", listener: OwnershipListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: OwnershipListener): void {
    this.events.off(event, listener);
  }

  private persistAndEmit(): void {
    const snapshot = this.snapshot();
    this.store?.setOwnershipEntries(snapshot);
    this.events.emit("change", snapshot);
  }
}
