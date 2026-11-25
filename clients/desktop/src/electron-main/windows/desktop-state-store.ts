import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { traycerDataRoot } from "@traycer/protocol/config/data-root";
import { config } from "../../config";
import type {
  FlushWindowDraftTopologyResult,
  LandingDraftReference,
  MoveWindowDraftReferenceRequest,
  MoveWindowDraftReferenceResult,
  OwnershipEntry,
  PerWindowSnapshot,
  UpdateWindowDraftReferencesRequest,
  WindowDraftMoveReceipt,
  WindowDraftTopologyResult,
} from "../../ipc-contracts/window-types";
import {
  parseJsonRecord,
  parseJsonValue,
  parseLandingDrafts,
  parseWindowDraftMove,
  parseWindowDraftTopology,
  parseWindowTopologyRevision,
} from "../../ipc-contracts/window-state-parsers";
import { environmentSubdir } from "../host/host-paths";
import { movedTabLayout } from "./moved-tab-layout";

const DESKTOP_STATE_VERSION = 2;

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
  readonly draftMoves: readonly PersistedDraftMove[];
}

interface PersistedDraftMove {
  readonly sourceWindowId: string;
  readonly request: MoveWindowDraftReferenceRequest;
  readonly receipt: WindowDraftMoveReceipt;
}

interface DesktopStateChange<Result> {
  readonly next: DesktopStatePayload | null;
  readonly result: Result;
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
  const base = environmentSubdir(traycerDataRoot(), config.environment);
  return join(base, "desktop-windows.json");
}

export class DesktopStateStore {
  private readonly filePath: string;
  private readonly logger: DesktopStateStoreLogger;
  private payload: DesktopStatePayload = {
    version: DESKTOP_STATE_VERSION,
    windows: {},
    ownership: [],
    draftMoves: [],
  };
  private writeChain: Promise<void> = Promise.resolve();
  private latestWrite: Promise<void> = Promise.resolve();

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
      ...this.payload,
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
      void this.queueWrite(() => ({
        next: nextPayload,
        result: undefined,
      })).catch(() => undefined);
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

  async setWindowSnapshot(
    windowId: string,
    snapshot:
      | PerWindowSnapshot
      | ((current: PerWindowSnapshot) => PerWindowSnapshot),
  ): Promise<PerWindowSnapshot> {
    return this.queueWrite((current) => {
      const next =
        typeof snapshot === "function"
          ? snapshot(current.windows[windowId] ?? emptyPerWindowSnapshot())
          : snapshot;
      return {
        next: { ...current, windows: { ...current.windows, [windowId]: next } },
        result: next,
      };
    });
  }

  async flushDraftTopology(
    windowId: string,
    ref: LandingDraftReference,
  ): Promise<FlushWindowDraftTopologyResult> {
    await this.writeChain;
    const topology = this.payload.windows[windowId]?.draftTopology;
    if (topology?.references.some((entry) => sameDraftReference(entry, ref))) {
      return { result: "ready", revision: topology.revision };
    }
    return { result: "conflict" };
  }

  async updateDraftReferences(
    windowId: string,
    request: UpdateWindowDraftReferencesRequest,
  ): Promise<WindowDraftTopologyResult> {
    return this.queueWrite<WindowDraftTopologyResult>((current) => {
      const window = current.windows[windowId] ?? emptyPerWindowSnapshot();
      const topology = window.draftTopology;
      const conflict = { next: null, result: { result: "conflict" } } as const;
      if ((topology?.revision ?? null) !== request.expectedTopologyRevision) {
        return conflict;
      }

      const references = new Map(
        topology?.references.map((ref) => [ref.slotId, ref]),
      );
      for (const edit of request.edits) {
        const previous = references.get(edit.ref.slotId);
        if (edit.kind === "detach") {
          if (previous === undefined || !sameDraftReference(previous, edit.ref)) {
            return conflict;
          }
          references.delete(edit.ref.slotId);
        } else if (previous === undefined) {
          references.set(edit.ref.slotId, { ...edit.ref, moveToken: null });
        } else if (!sameDraftReference(previous, edit.ref)) {
          return conflict;
        }
      }

      const { activeDraftId } = request;
      if (activeDraftId !== null && !references.has(activeDraftId)) return conflict;
      const revision = (topology?.revision ?? 0) + 1;
      const nextWindow: PerWindowSnapshot = {
        ...window,
        revision: (window.revision ?? 0) + 1,
        draftTopology: {
          revision,
          references: [...references.values()],
          activeDraftId,
        },
        landingDrafts: [],
        activeLandingDraftId: null,
      };
      return {
        next: {
          ...current,
          windows: { ...current.windows, [windowId]: nextWindow },
        },
        result: { result: "committed", revision },
      };
    });
  }

  async moveDraftReference(
    sourceWindowId: string,
    request: MoveWindowDraftReferenceRequest,
    destinationRoute: string,
  ): Promise<MoveWindowDraftReferenceResult> {
    return this.queueWrite<MoveWindowDraftReferenceResult>((current) => {
      const { moveToken, ref, expectedSourceTopologyRevision } = request;
      const conflict = { next: null, result: { result: "conflict" } } as const;
      const previous = current.draftMoves.find(
        (move) =>
          move.sourceWindowId === sourceWindowId &&
          move.request.moveToken === moveToken,
      );
      if (previous !== undefined) {
        if (
          !sameDraftReference(previous.request.ref, ref) ||
          previous.request.expectedSourceTopologyRevision !==
            expectedSourceTopologyRevision
        ) {
          return conflict;
        }
        return {
          next: null,
          result: { result: "moved", replayed: true, ...previous.receipt },
        };
      }

      const source = current.windows[sourceWindowId];
      const topology = source?.draftTopology;
      if (
        source === undefined ||
        topology?.revision !== expectedSourceTopologyRevision ||
        !topology.references.some((entry) => sameDraftReference(entry, ref))
      ) {
        return conflict;
      }

      const destinationWindowId = randomUUID();
      const receipt: WindowDraftMoveReceipt = {
        destinationWindowId,
        sourceTopologyRevision: topology.revision + 1,
        destinationTopologyRevision: 1,
      };
      const sourceAfter: PerWindowSnapshot = {
        ...source,
        revision: (source.revision ?? 0) + 1,
        activeRoute:
          source.activeRoute === destinationRoute
            ? null
            : (source.activeRoute ?? null),
        draftTopology: {
          revision: receipt.sourceTopologyRevision,
          references: topology.references.filter(
            (entry) => !sameDraftReference(entry, ref),
          ),
          activeDraftId:
            topology.activeDraftId === ref.slotId ? null : topology.activeDraftId,
        },
      };
      const destination: PerWindowSnapshot = {
        ...emptyPerWindowSnapshot(),
        revision: 1,
        draftTopology: {
          revision: receipt.destinationTopologyRevision,
          references: [{ ...ref, moveToken }],
          activeDraftId: ref.slotId,
        },
        tabStripLayout: movedTabLayout(source.tabStripLayout, "draft", ref.slotId),
        activeRoute: destinationRoute,
      };
      return {
        next: {
          ...current,
          windows: {
            ...current.windows,
            [sourceWindowId]: sourceAfter,
            [destinationWindowId]: destination,
          },
          draftMoves: [...current.draftMoves, { sourceWindowId, request, receipt }],
        },
        result: { result: "moved", replayed: false, ...receipt },
      };
    });
  }

  async deleteWindowSnapshot(windowId: string): Promise<void> {
    await this.queueWrite((current) => {
      const windows = { ...current.windows };
      delete windows[windowId];
      return { next: { ...current, windows }, result: undefined };
    });
  }

  setOwnershipEntries(entries: readonly OwnershipEntry[]): void {
    void this.queueWrite((current) => ({
      next: { ...current, ownership: entries },
      result: undefined,
    })).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.latestWrite;
  }

  private queueWrite<Result>(
    change: (current: DesktopStatePayload) => DesktopStateChange<Result>,
  ): Promise<Result> {
    // Compute each pending file image from the last successful rename.
    const write = this.writeChain.then(async () => {
      const { next, result } = change(this.payload);
      if (next !== null) {
        await this.persistWithRetry(next);
        this.payload = next;
      }
      return result;
    });
    this.latestWrite = write.then(() => undefined);
    this.writeChain = this.latestWrite.catch(() => undefined);
    return write;
  }

  private async persistWithRetry(payload: DesktopStatePayload): Promise<void> {
    try {
      await this.persist(payload);
      return;
    } catch (err) {
      this.logger.warn("[desktop-state] persist failed - retrying once", {
        err,
      });
    }
    try {
      await this.persist(payload);
    } catch (err) {
      this.logger.error("[desktop-state] persist retry failed", {
        err,
        filePath: this.filePath,
      });
      throw err;
    }
  }

  private async persist(payload: DesktopStatePayload): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function sameDraftReference(
  left: LandingDraftReference,
  right: LandingDraftReference,
): boolean {
  return left.slotId === right.slotId && left.occurrenceId === right.occurrenceId;
}

function parseDraftMoves(value: unknown): readonly PersistedDraftMove[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const move = entry as Record<string, unknown>;
    if (
      typeof move.sourceWindowId !== "string" ||
      move.sourceWindowId.length === 0
    ) {
      return [];
    }
    const request = parseWindowDraftMove(move.request);
    if (
      request === null ||
      move.receipt === null ||
      typeof move.receipt !== "object"
    ) {
      return [];
    }
    const receipt = move.receipt as Record<string, unknown>;
    const { destinationWindowId } = receipt;
    const sourceTopologyRevision = parseWindowTopologyRevision(
      receipt.sourceTopologyRevision,
    );
    const destinationTopologyRevision = parseWindowTopologyRevision(
      receipt.destinationTopologyRevision,
    );
    if (
      typeof destinationWindowId !== "string" ||
      destinationWindowId.length === 0 ||
      sourceTopologyRevision === null ||
      destinationTopologyRevision === null
    ) {
      return [];
    }
    return [
      {
        sourceWindowId: move.sourceWindowId,
        request,
        receipt: {
          destinationWindowId,
          sourceTopologyRevision,
          destinationTopologyRevision,
        },
      },
    ];
  });
}

function parseDesktopStatePayload(value: unknown): DesktopStatePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      version: DESKTOP_STATE_VERSION,
      windows: {},
      ownership: [],
      draftMoves: [],
    };
  }

  const obj = value as Record<string, unknown>;
  return {
    version: DESKTOP_STATE_VERSION,
    windows: parseWindowSnapshots(obj.windows),
    ownership: parseOwnershipEntries(obj.ownership),
    draftMoves: parseDraftMoves(obj.draftMoves),
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
  const draftTopology = parseWindowDraftTopology(obj.draftTopology);
  const landingDrafts =
    draftTopology === undefined ? parseLandingDrafts(obj.landingDrafts) : [];
  const activeLandingDraftId =
    typeof obj.activeLandingDraftId === "string"
      ? obj.activeLandingDraftId
      : null;
  return {
    revision:
      typeof obj.revision === "number" &&
      Number.isSafeInteger(obj.revision) &&
      obj.revision >= 0
        ? obj.revision
        : 0,
    epicTabs: parseEpicTabs(obj.epicTabs),
    activeTabId: typeof obj.activeTabId === "string" ? obj.activeTabId : null,
    canvasByTabId: parseJsonRecord(obj.canvasByTabId),
    ...(draftTopology === undefined ? {} : { draftTopology }),
    landingDrafts,
    activeLandingDraftId: draftTopology === undefined ? activeLandingDraftId : null,
    tabStripLayout: parseJsonValue(obj.tabStripLayout) ?? null,
    activeRoute: typeof obj.activeRoute === "string" ? obj.activeRoute : null,
  };
}

function emptyPerWindowSnapshot(): PerWindowSnapshot {
  return {
    revision: 0,
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
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
    const surfaceMode = parseEpicSurfaceMode(obj.surfaceMode);
    return [
      surfaceMode === null
        ? { id: obj.id, epicId: obj.epicId, name: obj.name }
        : { id: obj.id, epicId: obj.epicId, name: obj.name, surfaceMode },
    ];
  });
}

function parseEpicSurfaceMode(
  value: unknown,
): { readonly kind: "phase-migration"; readonly phaseId: string } | null {
  if (!isPlainRecord(value)) return null;
  if (
    value.kind === "phase-migration" &&
    typeof value.phaseId === "string" &&
    value.phaseId.length > 0
  ) {
    return { kind: "phase-migration", phaseId: value.phaseId };
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
