import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../../config";
import type {
  OwnershipEntry,
  PerWindowSnapshot,
} from "../../ipc-contracts/window-types";
import {
  parseJsonRecord,
  parseLandingDrafts,
} from "../../ipc-contracts/window-state-parsers";
import { environmentSubdir } from "../host/host-paths";

const DESKTOP_STATE_VERSION = 1;

interface DesktopStateStoreLogger {
  warn(message: string, meta: unknown): void;
  error(message: string, meta: unknown): void;
}

export interface DesktopStateStoreOptions {
  readonly filePath: string;
  readonly logger: DesktopStateStoreLogger;
}

export interface RestorableWindowEntry {
  readonly windowId: string;
  readonly snapshot: PerWindowSnapshot;
}

export interface DesktopStateRestoredWindowsReconciliation {
  readonly liveWindowIds: readonly string[];
}

export interface DesktopStateRestoredWindowsReconciliationResult {
  readonly changed: boolean;
  readonly restoredWindowIds: readonly string[];
  readonly restoredEpicIds: readonly string[];
  readonly prunedOwnershipCount: number;
  readonly removedDuplicateTabCount: number;
}

interface DesktopStatePayload {
  readonly version: number;
  readonly windows: Readonly<Record<string, PerWindowSnapshot>>;
  readonly ownership: readonly OwnershipEntry[];
}

export function resolveDesktopStateFilePath(): string {
  // Environment-scoped: each environment keeps its own set of open windows/tabs
  // so a staging/dev window never auto-restores a tab opened in another
  // environment's session. Such a foreign-environment epic tab would have the
  // host connect collab for an epic whose credential context this environment
  // can't establish, and tearing it down crashes the connecting socket. The
  // epic data under ~/.traycer/epics stays shared - only the window/tab state
  // is per-environment. production → ~/.traycer/desktop-windows.json;
  // dev/staging nest under their name.
  const base = environmentSubdir(
    join(homedir(), ".traycer"),
    config.environment,
  );
  return join(base, "desktop-windows.json");
}

export class DesktopStateStore {
  private readonly filePath: string;
  private readonly logger: DesktopStateStoreLogger;
  private payload: DesktopStatePayload = {
    version: DESKTOP_STATE_VERSION,
    windows: {},
    ownership: [],
  };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: DesktopStateStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.error("[desktop-state] failed to read state file", { err });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn("[desktop-state] JSON parse failed; using empty state", {
        err,
      });
      return;
    }

    this.payload = parseDesktopStatePayload(parsed);
  }

  getWindowSnapshots(): Readonly<Record<string, PerWindowSnapshot>> {
    return this.payload.windows;
  }

  getRestorableWindowEntries(): readonly RestorableWindowEntry[] {
    return Object.entries(this.payload.windows)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([windowId, snapshot]) => ({ windowId, snapshot }));
  }

  getOwnershipEntries(): readonly OwnershipEntry[] {
    return this.payload.ownership;
  }

  reconcileRestoredWindows(
    reconciliation: DesktopStateRestoredWindowsReconciliation,
  ): DesktopStateRestoredWindowsReconciliationResult {
    const liveWindowIds = new Set(reconciliation.liveWindowIds);
    const sortedWindowEntries = Object.entries(this.payload.windows).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const liveWindowEntries = sortedWindowEntries.filter(([windowId]) =>
      liveWindowIds.has(windowId),
    );
    const repairedWindows = repairDuplicateTabsAcrossWindows(
      Object.fromEntries(liveWindowEntries),
    );
    const nextOwnership = ownershipFromWindowSnapshots(repairedWindows.windows);
    const nextPayload = {
      version: DESKTOP_STATE_VERSION,
      windows: repairedWindows.windows,
      ownership: nextOwnership,
    };
    const prunedOwnershipCount = Math.max(
      this.payload.ownership.length - nextOwnership.length,
      0,
    );
    const changed =
      JSON.stringify(this.payload) !== JSON.stringify(nextPayload);
    if (changed) {
      this.payload = nextPayload;
      this.scheduleWrite();
    }

    return {
      changed,
      restoredWindowIds: liveWindowEntries.map(([windowId]) => windowId),
      restoredEpicIds: Object.values(repairedWindows.windows).flatMap(
        (snapshot) => snapshot.epicTabs.map((entry) => entry.epicId),
      ),
      prunedOwnershipCount,
      removedDuplicateTabCount: repairedWindows.removedDuplicateTabCount,
    };
  }

  setWindowSnapshot(windowId: string, snapshot: PerWindowSnapshot): void {
    this.payload = {
      ...this.payload,
      windows: { ...this.payload.windows, [windowId]: snapshot },
    };
    this.scheduleWrite();
  }

  deleteWindowSnapshot(windowId: string): void {
    const windows: Record<string, PerWindowSnapshot> = {
      ...this.payload.windows,
    };
    delete windows[windowId];
    this.payload = { ...this.payload, windows };
    this.scheduleWrite();
  }

  setOwnershipEntries(entries: readonly OwnershipEntry[]): void {
    this.payload = { ...this.payload, ownership: entries };
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private scheduleWrite(): void {
    this.writeChain = this.writeChain.then(() => this.persistWithRetry());
  }

  // Persist policy: one immediate retry, then surrender with an error-level
  // log. The chain itself never rejects - `flush()` resolving is what
  // authorizes a quit, and a failed state write must never block it (the
  // previous on-disk payload stays intact thanks to the tmp+rename swap; the
  // cost of surrender is stale window state on the next launch, which the
  // error log makes attributable).
  private async persistWithRetry(): Promise<void> {
    try {
      await this.persist();
      return;
    } catch (err) {
      this.logger.warn("[desktop-state] persist failed - retrying once", {
        err,
      });
    }
    try {
      await this.persist();
    } catch (err) {
      this.logger.error(
        "[desktop-state] persist retry failed - window state will be stale on next launch",
        { err, filePath: this.filePath },
      );
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.filePath);
  }
}

function parseDesktopStatePayload(value: unknown): DesktopStatePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      version: DESKTOP_STATE_VERSION,
      windows: {},
      ownership: [],
    };
  }

  const obj = value as Record<string, unknown>;
  return {
    version: DESKTOP_STATE_VERSION,
    windows: parseWindowSnapshots(obj.windows),
    ownership: parseOwnershipEntries(obj.ownership),
  };
}

function parseWindowSnapshots(
  value: unknown,
): Readonly<Record<string, PerWindowSnapshot>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, PerWindowSnapshot> = {};
  for (const [windowId, snapshot] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (windowId.length === 0) {
      continue;
    }
    out[windowId] = parsePerWindowSnapshot(snapshot);
  }
  return out;
}

function parseOwnershipEntries(value: unknown): readonly OwnershipEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.tabId !== "string" ||
      typeof obj.epicId !== "string" ||
      typeof obj.windowId !== "string"
    ) {
      return [];
    }
    return [{ tabId: obj.tabId, epicId: obj.epicId, windowId: obj.windowId }];
  });
}

function parsePerWindowSnapshot(value: unknown): PerWindowSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return emptyPerWindowSnapshot();
  }
  const obj = value as Record<string, unknown>;
  const landingDrafts = parseLandingDrafts(obj.landingDrafts);
  const activeLandingDraftId =
    typeof obj.activeLandingDraftId === "string"
      ? obj.activeLandingDraftId
      : null;
  return {
    epicTabs: parseEpicTabs(obj.epicTabs),
    activeTabId: typeof obj.activeTabId === "string" ? obj.activeTabId : null,
    canvasByTabId: parseJsonRecord(obj.canvasByTabId),
    landingDrafts,
    activeLandingDraftId,
  };
}

function emptyPerWindowSnapshot(): PerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

function ownershipFromWindowSnapshots(
  windows: Readonly<Record<string, PerWindowSnapshot>>,
): readonly OwnershipEntry[] {
  const seen = new Set<string>();
  return Object.entries(windows)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([windowId, snapshot]) =>
      snapshot.epicTabs.flatMap((tab) => {
        if (seen.has(tab.id)) {
          return [];
        }
        seen.add(tab.id);
        return [{ tabId: tab.id, epicId: tab.epicId, windowId }];
      }),
    );
}

function repairDuplicateTabsAcrossWindows(
  windows: Readonly<Record<string, PerWindowSnapshot>>,
): {
  readonly windows: Readonly<Record<string, PerWindowSnapshot>>;
  readonly removedDuplicateTabCount: number;
} {
  const seen = new Set<string>();
  let removedDuplicateTabCount = 0;
  const repaired = Object.fromEntries(
    Object.entries(windows)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([windowId, snapshot]) => {
        const epicTabs = snapshot.epicTabs.flatMap((tab) => {
          if (seen.has(tab.id)) {
            removedDuplicateTabCount += 1;
            return [];
          }
          seen.add(tab.id);
          return [tab];
        });
        const openTabIds = new Set(epicTabs.map((tab) => tab.id));
        const canvasByTabId = Object.fromEntries(
          Object.entries(snapshot.canvasByTabId).filter(([tabId]) =>
            openTabIds.has(tabId),
          ),
        );
        return [
          windowId,
          {
            ...snapshot,
            epicTabs,
            activeTabId:
              snapshot.activeTabId !== null &&
              openTabIds.has(snapshot.activeTabId)
                ? snapshot.activeTabId
                : null,
            canvasByTabId,
          },
        ];
      }),
  );
  return { windows: repaired, removedDuplicateTabCount };
}

function parseEpicTabs(value: unknown): PerWindowSnapshot["epicTabs"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      typeof obj.epicId !== "string" ||
      typeof obj.name !== "string"
    ) {
      return [];
    }
    // The tab's identity is id + epicId; an empty name is a legitimate
    // untitled tab (the renderer derives the shown title). Only drop entries
    // missing structural identity, not empty-named ones.
    if (obj.id.length === 0 || obj.epicId.length === 0) {
      return [];
    }
    if (seen.has(obj.id)) {
      return [];
    }
    seen.add(obj.id);
    return [{ id: obj.id, epicId: obj.epicId, name: obj.name }];
  });
}
