import type {
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileResponse,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { fileContentRevision } from "@/lib/workspace/file-content-revision";

export const FILE_EDIT_AUTOSAVE_DELAY_MS = 750;
export const FILE_EDIT_RECOVERY_DELAY_MS = 100;

export interface FileEditIdentity {
  /** Immutable authenticated subject. `null` is an isolated signed-out scope. */
  readonly userId: string | null;
  readonly hostId: string;
  /** Canonical workspace or repository root supplied by the host-backed surface. */
  readonly workspacePath: string;
  /** Normalized path relative to `workspacePath`. */
  readonly filePath: string;
}

export interface FileEditDiskSnapshot {
  readonly content: string;
  readonly revision: string;
}

export interface FileEditRecoveryEntry {
  readonly version: 2;
  readonly identity: FileEditIdentity;
  readonly baselineRevision: string;
  readonly draftContent: string;
  readonly contentRevision: number;
}

export interface FileEditRecoveryJournal {
  readonly load: (identityKey: string) => Promise<FileEditRecoveryEntry | null>;
  readonly save: (
    identityKey: string,
    entry: FileEditRecoveryEntry,
  ) => Promise<void>;
  readonly remove: (identityKey: string) => Promise<void>;
}

export type FileEditWriter = (
  request: WorkspaceWriteFileRequest,
) => Promise<WorkspaceWriteFileResponse>;

export type FileEditStatus =
  | "recovering"
  | "clean"
  | "dirty"
  | "saving"
  | "offline"
  | "error"
  | "conflict";

export type FileEditRecoveryStatus =
  | "loading"
  | "idle"
  | "pending"
  | "persisting"
  | "persisted"
  | "unavailable";

export interface FileEditConflict {
  readonly currentRevision: string;
  /** Present for recovery conflicts; RPC conflicts require a fresh read. */
  readonly diskContent: string | null;
  readonly error: string;
}

export interface FileEditRuntimeState {
  readonly identity: FileEditIdentity;
  readonly baselineContent: string;
  readonly baselineRevision: string;
  readonly draftContent: string;
  readonly contentRevision: number;
  readonly status: FileEditStatus;
  readonly isDirty: boolean;
  readonly ownerSurfaceId: string | null;
  readonly conflict: FileEditConflict | null;
  readonly error: string | null;
  readonly recoveryStatus: FileEditRecoveryStatus;
  readonly lastSavedAt: number | null;
}

export interface FileEditRuntimeOptions {
  readonly autosaveDelayMs: number;
  readonly recoveryDelayMs: number;
  readonly now: () => number;
}

export interface FileEditRuntimeDependencies {
  readonly journal: FileEditRecoveryJournal;
  readonly options: FileEditRuntimeOptions;
  readonly onDisposable: () => void;
}

interface FileEditAttachmentRecord {
  readonly lease: symbol;
  readonly writer: FileEditWriter | null;
}

interface FileEditSaveAttempt {
  readonly content: string;
  readonly contentRevision: number;
  readonly expectedRevision: string;
  readonly writer: FileEditWriter;
}

/** Stable, delimiter-safe identity for the renderer-local registry and journal. */
export function fileEditIdentityKey(identity: FileEditIdentity): string {
  return JSON.stringify([
    identity.userId,
    identity.hostId,
    identity.workspacePath,
    identity.filePath,
  ]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The non-React authority for one editable file in one renderer window.
 *
 * Host writes are injected by an attached surface. That keeps every RPC on the
 * app's TanStack Query mutation path while the save queue remains alive when a
 * tile unmounts or another duplicate surface becomes visible.
 */
export class FileEditRuntime {
  readonly store: StoreApi<FileEditRuntimeState>;

  private readonly identityKey: string;
  private readonly attachments = new Map<string, FileEditAttachmentRecord>();
  private readonly recovered: Promise<void>;
  private autosaveTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private pendingRecovery: FileEditRecoveryEntry | null = null;
  private recoveryTail: Promise<void> = Promise.resolve();
  private recoveryGeneration = 0;
  private drainPromise: Promise<void> | null = null;
  private detachedOwnerWriter: FileEditWriter | null = null;
  private disposed = false;
  private readonly journal: FileEditRecoveryJournal;
  private readonly options: FileEditRuntimeOptions;
  private readonly onDisposable: () => void;

  constructor(
    identity: FileEditIdentity,
    initialDisk: FileEditDiskSnapshot,
    dependencies: FileEditRuntimeDependencies,
  ) {
    this.journal = dependencies.journal;
    this.options = dependencies.options;
    this.onDisposable = dependencies.onDisposable;
    this.identityKey = fileEditIdentityKey(identity);
    this.store = createStore<FileEditRuntimeState>(() => ({
      identity,
      baselineContent: initialDisk.content,
      baselineRevision: initialDisk.revision,
      draftContent: initialDisk.content,
      contentRevision: 0,
      status: "recovering",
      isDirty: false,
      ownerSurfaceId: null,
      conflict: null,
      error: null,
      recoveryStatus: "loading",
      lastSavedAt: null,
    }));
    this.recovered = this.restore(initialDisk);
  }

  whenRecovered(): Promise<void> {
    return this.recovered;
  }

  attachSurface(surfaceId: string, writer: FileEditWriter | null): symbol {
    const lease = Symbol(surfaceId);
    this.attachments.set(surfaceId, { lease, writer });
    return lease;
  }

  updateWriter(
    surfaceId: string,
    lease: symbol,
    writer: FileEditWriter | null,
  ): boolean {
    const attachment = this.attachments.get(surfaceId);
    if (attachment?.lease !== lease) return false;
    this.attachments.set(surfaceId, { lease, writer });
    return true;
  }

  detachSurface(surfaceId: string, lease: symbol): void {
    const attachment = this.attachments.get(surfaceId);
    if (attachment?.lease !== lease) return;

    if (this.store.getState().ownerSurfaceId === surfaceId) {
      // Retain the Query-backed writer while recovery persistence is awaited.
      // The tile may disappear immediately, but its mutation function remains
      // safe to invoke and lets this renderer-owned runtime finish the flush.
      // Null-safe like `releaseOwnership` below: a `null` attachment writer
      // (surface detached before ever gaining one) must not clobber a writer
      // already retained from an earlier detach of the same owner.
      this.detachedOwnerWriter = attachment.writer ?? this.detachedOwnerWriter;
      void this.flush();
      this.store.setState({ ownerSurfaceId: null });
    }
    this.attachments.delete(surfaceId);
    this.notifyIfDisposable();
  }

  claimOwnership(surfaceId: string): boolean {
    const attachment = this.attachments.get(surfaceId);
    if (attachment?.writer === null || attachment === undefined) return false;
    const ownerSurfaceId = this.store.getState().ownerSurfaceId;
    if (ownerSurfaceId !== null && ownerSurfaceId !== surfaceId) return false;
    this.detachedOwnerWriter = null;
    this.store.setState({ ownerSurfaceId: surfaceId });
    this.scheduleAutosaveIfNeeded();
    return true;
  }

  releaseOwnership(surfaceId: string): boolean {
    if (this.store.getState().ownerSurfaceId !== surfaceId) return false;
    this.detachedOwnerWriter =
      this.attachments.get(surfaceId)?.writer ?? this.detachedOwnerWriter;
    void this.flush();
    this.store.setState({ ownerSurfaceId: null });
    return true;
  }

  setDraft(surfaceId: string, content: string): boolean {
    const current = this.store.getState();
    if (
      this.disposed ||
      current.status === "recovering" ||
      current.ownerSurfaceId !== surfaceId
    ) {
      return false;
    }
    if (current.draftContent === content) return true;

    const contentRevision = current.contentRevision + 1;
    // "offline" means the write attempt threw instead of getting a definite
    // response (network drop, host unreachable) - the host may have already
    // committed it. `baselineContent` still reflects the pre-attempt read, so
    // it cannot be trusted to decide "nothing to save": if the user edits the
    // draft back to match it, that's not proof the disk matches too. Stay
    // dirty so `retry()` sends a real round-trip (idempotent per the write
    // contract) instead of silently discarding the recovery journal while the
    // outcome is still ambiguous.
    const isDirty =
      current.status === "offline" || content !== current.baselineContent;
    const blockedStatus =
      current.status === "conflict" ||
      current.status === "offline" ||
      current.status === "error";
    let status: FileEditStatus = current.status;
    if (current.status !== "saving" && !blockedStatus) {
      status = isDirty ? "dirty" : "clean";
    }

    this.store.setState({
      draftContent: content,
      contentRevision,
      status,
      isDirty,
      error: blockedStatus ? current.error : null,
    });

    if (isDirty || current.status === "conflict") {
      this.queueRecoveryWrite();
    } else if (this.drainPromise === null) {
      this.cancelAutosave();
      this.queueRecoveryDelete();
    }

    if (!blockedStatus) this.scheduleAutosaveIfNeeded();
    return true;
  }

  /** Blur and Cmd-S both call this; repeated calls join the same save drain. */
  flush(): Promise<void> {
    this.cancelAutosave();
    return this.recovered.then(async () => {
      await this.flushRecovery();
      if (this.drainPromise !== null) return this.drainPromise;
      if (!this.canStartSave()) return;
      const drain = this.drainSaves().finally(() => {
        if (this.drainPromise === drain) this.drainPromise = null;
        this.notifyIfDisposable();
      });
      this.drainPromise = drain;
      return drain;
    });
  }

  retry(): Promise<void> {
    const current = this.store.getState();
    if (current.status !== "offline" && current.status !== "error") {
      return this.flush();
    }
    this.store.setState({ status: "dirty", error: null });
    return this.flush();
  }

  resolveKeepMine(disk: FileEditDiskSnapshot): Promise<void> {
    const current = this.store.getState();
    if (current.status !== "conflict") return Promise.resolve();
    const isDirty = current.draftContent !== disk.content;
    this.store.setState({
      baselineContent: disk.content,
      baselineRevision: disk.revision,
      status: isDirty ? "dirty" : "clean",
      isDirty,
      conflict: null,
      error: null,
    });
    if (!isDirty) {
      this.queueRecoveryDelete();
      return Promise.resolve();
    }
    this.queueRecoveryWrite();
    return this.flush();
  }

  resolveUseDisk(disk: FileEditDiskSnapshot): void {
    const current = this.store.getState();
    if (current.status !== "conflict") return;
    const contentRevision = current.contentRevision + 1;
    this.cancelAutosave();
    this.store.setState({
      baselineContent: disk.content,
      baselineRevision: disk.revision,
      draftContent: disk.content,
      contentRevision,
      status: "clean",
      isDirty: false,
      conflict: null,
      error: null,
    });
    this.queueRecoveryDelete();
  }

  refreshCleanDisk(disk: FileEditDiskSnapshot): boolean {
    const current = this.store.getState();
    if (
      current.status !== "clean" ||
      current.isDirty ||
      this.drainPromise !== null
    ) {
      return false;
    }
    if (
      current.baselineRevision === disk.revision &&
      current.draftContent === disk.content
    ) {
      return true;
    }
    const contentRevision = current.contentRevision + 1;
    this.store.setState({
      baselineContent: disk.content,
      baselineRevision: disk.revision,
      draftContent: disk.content,
      contentRevision,
    });
    return true;
  }

  setConflictResolutionError(error: string): void {
    const current = this.store.getState();
    if (current.status !== "conflict" || current.conflict === null) return;
    this.store.setState({
      conflict: { ...current.conflict, error },
      error,
    });
    this.queueRecoveryWrite();
  }

  flushRecovery(): Promise<void> {
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const pending = this.pendingRecovery;
    if (pending === null) return this.recoveryTail;
    this.pendingRecovery = null;
    const generation = this.recoveryGeneration;
    const operation = this.recoveryTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.disposed && generation === this.recoveryGeneration) {
          this.store.setState({ recoveryStatus: "persisting" });
        }
        await this.journal.save(this.identityKey, pending);
        if (!this.disposed && generation === this.recoveryGeneration) {
          this.store.setState({
            recoveryStatus: "persisted",
          });
        }
      })
      .catch(() => {
        if (!this.disposed && generation === this.recoveryGeneration) {
          this.store.setState({
            recoveryStatus: "unavailable",
          });
        }
      });
    this.recoveryTail = operation;
    return operation;
  }

  canDispose(): boolean {
    const state = this.store.getState();
    return (
      this.attachments.size === 0 &&
      this.drainPromise === null &&
      !state.isDirty &&
      state.status !== "conflict" &&
      state.status !== "recovering"
    );
  }

  teardown(): Promise<void> {
    this.cancelAutosave();
    const recovery = this.flushRecovery();
    this.disposed = true;
    this.attachments.clear();
    this.detachedOwnerWriter = null;
    return recovery;
  }

  private async restore(initialDisk: FileEditDiskSnapshot): Promise<void> {
    try {
      const recovered = await this.journal.load(this.identityKey);
      if (this.isDisposed()) return;
      if (recovered === null) {
        this.store.setState({ status: "clean", recoveryStatus: "idle" });
        return;
      }
      if (fileEditIdentityKey(recovered.identity) !== this.identityKey) {
        this.store.setState({ status: "clean", recoveryStatus: "idle" });
        this.queueRecoveryDelete();
        return;
      }

      const draftRevision = await fileContentRevision(recovered.draftContent);
      if (this.isDisposed()) return;
      if (initialDisk.revision === draftRevision) {
        const contentRevision = Math.max(0, recovered.contentRevision);
        this.store.setState({
          baselineContent: initialDisk.content,
          baselineRevision: initialDisk.revision,
          draftContent: initialDisk.content,
          contentRevision,
          status: "clean",
          isDirty: false,
          recoveryStatus: "persisted",
        });
        this.queueRecoveryDelete();
        return;
      }

      const contentRevision = Math.max(1, recovered.contentRevision);
      if (initialDisk.revision === recovered.baselineRevision) {
        this.store.setState({
          baselineContent: initialDisk.content,
          baselineRevision: initialDisk.revision,
          draftContent: recovered.draftContent,
          contentRevision,
          status: "dirty",
          isDirty: recovered.draftContent !== initialDisk.content,
          recoveryStatus: "persisted",
        });
        if (recovered.draftContent === initialDisk.content) {
          this.store.setState({ status: "clean", isDirty: false });
          this.queueRecoveryDelete();
          return;
        }
        this.scheduleAutosaveIfNeeded();
        return;
      }

      this.store.setState({
        baselineContent: initialDisk.content,
        baselineRevision: recovered.baselineRevision,
        draftContent: recovered.draftContent,
        contentRevision,
        status: "conflict",
        isDirty: true,
        conflict: {
          currentRevision: initialDisk.revision,
          diskContent: initialDisk.content,
          error:
            "The file changed on disk while an unsaved draft was retained.",
        },
        recoveryStatus: "persisted",
      });
    } catch {
      if (this.isDisposed()) return;
      this.store.setState({
        status: "clean",
        recoveryStatus: "unavailable",
      });
    }
  }

  private scheduleAutosaveIfNeeded(): void {
    const current = this.store.getState();
    if (
      this.disposed ||
      !current.isDirty ||
      current.status === "recovering" ||
      current.status === "saving" ||
      current.status === "offline" ||
      current.status === "error" ||
      current.status === "conflict" ||
      current.ownerSurfaceId === null ||
      this.autosaveTimer !== null
    ) {
      return;
    }
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.flush();
    }, this.options.autosaveDelayMs);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer === null) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  private queueRecoveryWrite(): void {
    const current = this.store.getState();
    this.recoveryGeneration += 1;
    this.pendingRecovery = {
      version: 2,
      identity: current.identity,
      baselineRevision: current.baselineRevision,
      draftContent: current.draftContent,
      contentRevision: current.contentRevision,
    };
    this.store.setState({ recoveryStatus: "pending" });
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      void this.flushRecovery();
    }, this.options.recoveryDelayMs);
  }

  private queueRecoveryDelete(): void {
    this.recoveryGeneration += 1;
    const generation = this.recoveryGeneration;
    this.pendingRecovery = null;
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const operation = this.recoveryTail
      .catch(() => undefined)
      .then(() => this.journal.remove(this.identityKey))
      .then(() => {
        if (!this.disposed && generation === this.recoveryGeneration) {
          this.store.setState({
            recoveryStatus: "idle",
          });
        }
      })
      .catch(() => {
        if (!this.disposed && generation === this.recoveryGeneration) {
          this.store.setState({
            recoveryStatus: "unavailable",
          });
        }
      });
    this.recoveryTail = operation;
  }

  private canStartSave(): boolean {
    const current = this.store.getState();
    return (
      !this.disposed &&
      current.isDirty &&
      current.status !== "conflict" &&
      current.status !== "offline" &&
      current.status !== "error" &&
      this.ownerWriter() !== null
    );
  }

  private ownerWriter(): FileEditWriter | null {
    const ownerSurfaceId = this.store.getState().ownerSurfaceId;
    if (ownerSurfaceId === null) return this.detachedOwnerWriter;
    return (
      this.attachments.get(ownerSurfaceId)?.writer ?? this.detachedOwnerWriter
    );
  }

  private nextAttempt(): FileEditSaveAttempt | null {
    const current = this.store.getState();
    const writer = this.ownerWriter();
    if (!current.isDirty || writer === null) return null;
    return {
      content: current.draftContent,
      contentRevision: current.contentRevision,
      expectedRevision: current.baselineRevision,
      writer,
    };
  }

  private async drainSaves(): Promise<void> {
    while (!this.isDisposed()) {
      const attempt = this.nextAttempt();
      if (attempt === null) return;
      await this.flushRecovery();
      if (this.isDisposed()) return;

      this.store.setState({
        status: "saving",
        error: null,
      });

      let response: WorkspaceWriteFileResponse;
      try {
        const identity = this.store.getState().identity;
        response = await attempt.writer({
          workspacePath: identity.workspacePath,
          filePath: identity.filePath,
          expectedRevision: attempt.expectedRevision,
          content: attempt.content,
        });
      } catch (error) {
        if (this.isDisposed()) return;
        this.store.setState({
          status: "offline",
          isDirty: true,
          error: describeError(error),
        });
        this.queueRecoveryWrite();
        return;
      }
      if (this.isDisposed()) return;

      if (response.status === "conflict") {
        this.store.setState({
          status: "conflict",
          isDirty: true,
          conflict: {
            currentRevision: response.currentRevision,
            diskContent: null,
            error: response.error,
          },
          error: response.error,
        });
        this.queueRecoveryWrite();
        return;
      }

      if (response.status === "error") {
        this.store.setState({
          status: "error",
          isDirty: true,
          error: response.error,
        });
        this.queueRecoveryWrite();
        return;
      }

      const current = this.store.getState();
      const latestAcknowledged = current.draftContent === attempt.content;
      this.store.setState({
        baselineContent: attempt.content,
        baselineRevision: response.revision,
        status: latestAcknowledged ? "clean" : "dirty",
        isDirty: !latestAcknowledged,
        conflict: null,
        error: null,
        lastSavedAt: this.options.now(),
      });

      if (latestAcknowledged) {
        this.detachedOwnerWriter = null;
        this.queueRecoveryDelete();
        return;
      }
      this.queueRecoveryWrite();
      // Loop immediately: the newest coalesced draft uses the acknowledged
      // snapshot above as its expected baseline, never the original read.
    }
  }

  private notifyIfDisposable(): void {
    if (this.canDispose()) this.onDisposable();
  }

  private isDisposed(): boolean {
    return this.disposed;
  }
}
