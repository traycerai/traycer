import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileResponse,
} from "@traycer/protocol/host/workspace/unary-schemas";

import { fileContentRevision } from "@/lib/workspace/file-content-revision";
import {
  fileEditIdentityKey,
  type FileEditDiskSnapshot,
  type FileEditIdentity,
  type FileEditRecoveryEntry,
  type FileEditRecoveryJournal,
  type FileEditWriter,
} from "@/lib/workspace/file-edit-runtime";
import { FileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

const IDENTITY: FileEditIdentity = {
  userId: "user-1",
  hostId: "host-1",
  workspacePath: "/repo",
  filePath: "src/file.ts",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("missing deferred resolve");
      resolvePromise(value);
    },
    reject: (error) => {
      if (rejectPromise === null) throw new Error("missing deferred reject");
      rejectPromise(error);
    },
  };
}

class MemoryRecoveryJournal implements FileEditRecoveryJournal {
  readonly entries = new Map<string, FileEditRecoveryEntry>();
  readonly saves: FileEditRecoveryEntry[] = [];
  failLoad = false;
  failSave = false;

  load(identityKey: string): Promise<FileEditRecoveryEntry | null> {
    return this.failLoad
      ? Promise.reject(new Error("IndexedDB read failed"))
      : Promise.resolve(this.entries.get(identityKey) ?? null);
  }

  save(identityKey: string, entry: FileEditRecoveryEntry): Promise<void> {
    if (this.failSave) {
      return Promise.reject(new Error("IndexedDB write failed"));
    }
    this.saves.push(entry);
    this.entries.set(identityKey, entry);
    return Promise.resolve();
  }

  remove(identityKey: string): Promise<void> {
    this.entries.delete(identityKey);
    return Promise.resolve();
  }
}

async function snapshot(content: string): Promise<FileEditDiskSnapshot> {
  return { content, revision: await fileContentRevision(content) };
}

function savedResponse(revision: string) {
  return {
    status: "saved" as const,
    workspacePath: IDENTITY.workspacePath,
    filePath: IDENTITY.filePath,
    revision,
  };
}

function makeRegistry(
  journal: FileEditRecoveryJournal,
): FileEditRuntimeRegistry {
  return new FileEditRuntimeRegistry(journal, {
    autosaveDelayMs: 50,
    recoveryDelayMs: 5,
    now: () => 123,
  });
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("FileEditRuntimeRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid edits and saves only the latest draft", async () => {
    const journal = new MemoryRecoveryJournal();
    const requests: WorkspaceWriteFileRequest[] = [];
    const writer: FileEditWriter = async (request) => {
      requests.push(request);
      return savedResponse(await fileContentRevision(request.content));
    };
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    expect(attachment.runtime.claimOwnership("surface-a")).toBe(true);

    attachment.runtime.setDraft("surface-a", "one");
    attachment.runtime.setDraft("surface-a", "two");
    attachment.runtime.setDraft("surface-a", "three");

    await vi.advanceTimersByTimeAsync(49);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settleMicrotasks();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.content).toBe("three");
    await attachment.runtime.flush();
    expect(attachment.runtime.store.getState()).toMatchObject({
      draftContent: "three",
      baselineContent: "three",
      status: "clean",
      isDirty: false,
    });
  });

  it("does not dirty or save when an editor re-emits identical content", async () => {
    const journal = new MemoryRecoveryJournal();
    const writer = vi.fn<FileEditWriter>(() =>
      Promise.reject(new Error("unexpected write")),
    );
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");

    expect(attachment.runtime.setDraft("surface-a", "base")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(writer).not.toHaveBeenCalled();
    expect(journal.saves).toHaveLength(0);
    expect(attachment.runtime.store.getState()).toMatchObject({
      contentRevision: 0,
      status: "clean",
      isDirty: false,
    });
  });

  it("allows one in-flight write and coalesces newer edits behind its acknowledgement", async () => {
    const journal = new MemoryRecoveryJournal();
    const first = deferred<WorkspaceWriteFileResponse>();
    const requests: WorkspaceWriteFileRequest[] = [];
    const secondRevision = await fileContentRevision("latest");
    const writer: FileEditWriter = (request) => {
      requests.push(request);
      return requests.length === 1
        ? first.promise
        : Promise.resolve(savedResponse(secondRevision));
    };
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");

    attachment.runtime.setDraft("surface-a", "first");
    const drain = attachment.runtime.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    attachment.runtime.setDraft("surface-a", "newer");
    attachment.runtime.setDraft("surface-a", "latest");
    expect(requests).toHaveLength(1);
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "saving",
      contentRevision: 3,
    });

    const firstRevision = await fileContentRevision("first");
    first.resolve(savedResponse(firstRevision));
    await drain;

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: firstRevision,
      content: "latest",
    });
    expect(attachment.runtime.store.getState()).toMatchObject({
      baselineContent: "latest",
      baselineRevision: secondRevision,
      status: "clean",
    });
  });

  it("retains a rejected write for an idempotent lost-ack retry", async () => {
    const journal = new MemoryRecoveryJournal();
    const requests: WorkspaceWriteFileRequest[] = [];
    const appliedRevision = await fileContentRevision("applied");
    const writer: FileEditWriter = (request) => {
      requests.push(request);
      return requests.length === 1
        ? Promise.reject(new Error("connection closed after write"))
        : Promise.resolve(savedResponse(appliedRevision));
    };
    const registry = makeRegistry(journal);
    const initialDisk = await snapshot("base");
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");
    attachment.runtime.setDraft("surface-a", "applied");

    await attachment.runtime.flush();
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "offline",
      isDirty: true,
      draftContent: "applied",
    });

    await attachment.runtime.retry();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.expectedRevision).toBe(initialDisk.revision);
    expect(requests[1]?.expectedRevision).toBe(initialDisk.revision);
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "clean",
      baselineRevision: appliedRevision,
    });
  });

  it("keeps an ambiguous offline write recoverable and reconciles on retry, even after the draft is edited back to the pre-attempt baseline", async () => {
    const journal = new MemoryRecoveryJournal();
    const requests: WorkspaceWriteFileRequest[] = [];
    // The host actually applied the first (ambiguous) write before the ack
    // was lost: a same-content retry is idempotent and just confirms it.
    const appliedRevision = await fileContentRevision("base");
    const writer: FileEditWriter = (request) => {
      requests.push(request);
      return requests.length === 1
        ? Promise.reject(new Error("connection closed after write"))
        : Promise.resolve(savedResponse(appliedRevision));
    };
    const registry = makeRegistry(journal);
    const initialDisk = await snapshot("base");
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");
    attachment.runtime.setDraft("surface-a", "attempted");

    await attachment.runtime.flush();
    expect(attachment.runtime.store.getState().status).toBe("offline");
    expect(journal.entries.size).toBe(1);

    // The user, seeing the offline error, edits the draft back to what they
    // read from disk before attempting the change. Without the ambiguous-
    // offline fix, this content now matches `baselineContent` again, so
    // `isDirty` would flip to false: the recovery journal would be deleted
    // and a subsequent `retry()` would no-op (`canStartSave()` requires
    // `isDirty`), silently abandoning reconciliation.
    attachment.runtime.setDraft("surface-a", "base");
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "offline",
      isDirty: true,
      draftContent: "base",
    });
    expect(journal.entries.size).toBe(1);

    await attachment.runtime.retry();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: initialDisk.revision,
      content: "base",
    });
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "clean",
      isDirty: false,
      baselineContent: "base",
      baselineRevision: appliedRevision,
    });
    expect(journal.entries.size).toBe(0);
  });

  it("adopts a freshly read baseline before Keep mine resubmits a conflict", async () => {
    const journal = new MemoryRecoveryJournal();
    const externalDisk = await snapshot("external change");
    const localRevision = await fileContentRevision("local draft");
    const requests: WorkspaceWriteFileRequest[] = [];
    const writer: FileEditWriter = (request) => {
      requests.push(request);
      return Promise.resolve(
        requests.length === 1
          ? {
              status: "conflict" as const,
              workspacePath: IDENTITY.workspacePath,
              filePath: IDENTITY.filePath,
              currentRevision: externalDisk.revision,
              error: "file changed",
            }
          : savedResponse(localRevision),
      );
    };
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");
    attachment.runtime.setDraft("surface-a", "local draft");

    await attachment.runtime.flush();
    expect(attachment.runtime.store.getState().status).toBe("conflict");

    await attachment.runtime.resolveKeepMine(externalDisk);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: externalDisk.revision,
      content: "local draft",
    });
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "clean",
      baselineContent: "local draft",
      baselineRevision: localRevision,
      conflict: null,
    });
  });

  it("flushes with the retained writer when the owning surface detaches", async () => {
    const journal = new MemoryRecoveryJournal();
    const requests: WorkspaceWriteFileRequest[] = [];
    const writer: FileEditWriter = async (request) => {
      requests.push(request);
      return savedResponse(await fileContentRevision(request.content));
    };
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");
    attachment.runtime.setDraft("surface-a", "detached draft");

    attachment.detach();
    await settleMicrotasks();
    await attachment.runtime.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.content).toBe("detached draft");
    expect(attachment.runtime.store.getState()).toMatchObject({
      ownerSurfaceId: null,
      status: "clean",
    });
  });

  it("keeps autosave working when IndexedDB persistence fails", async () => {
    const journal = new MemoryRecoveryJournal();
    journal.failSave = true;
    const writer = vi.fn<FileEditWriter>(() =>
      Promise.reject(new Error("host offline")),
    );
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();
    attachment.runtime.claimOwnership("surface-a");
    attachment.runtime.setDraft("surface-a", "not recoverable");

    await attachment.runtime.flush();
    await attachment.runtime.flushRecovery();

    expect(writer).toHaveBeenCalledTimes(1);
    expect(attachment.runtime.store.getState()).toMatchObject({
      status: "offline",
      recoveryStatus: "unavailable",
    });
  });

  it("continues from disk while exposing an IndexedDB recovery read failure", async () => {
    const journal = new MemoryRecoveryJournal();
    journal.failLoad = true;
    const writer = vi.fn<FileEditWriter>(async (request) =>
      savedResponse(await fileContentRevision(request.content)),
    );
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer,
    });
    await attachment.runtime.whenRecovered();

    expect(attachment.runtime.store.getState()).toMatchObject({
      draftContent: "base",
      status: "clean",
      recoveryStatus: "unavailable",
    });
    expect(attachment.runtime.claimOwnership("surface-a")).toBe(true);
    attachment.runtime.setDraft("surface-a", "still editable");
    await attachment.runtime.flush();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(attachment.runtime.store.getState().status).toBe("clean");
  });

  it("restores a journaled draft when disk still matches its baseline", async () => {
    const journal = new MemoryRecoveryJournal();
    const initialDisk = await snapshot("base");
    const registryOne = makeRegistry(journal);
    const first = registryOne.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer: null,
    });
    await first.runtime.whenRecovered();
    first.updateWriter(async (request) =>
      savedResponse(await fileContentRevision(request.content)),
    );
    first.runtime.claimOwnership("surface-a");
    first.runtime.setDraft("surface-a", "recovered draft");
    await first.runtime.flushRecovery();
    await registryOne.teardown();

    const registryTwo = makeRegistry(journal);
    const reopened = registryTwo.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-b",
      writer: null,
    });
    await reopened.runtime.whenRecovered();

    expect(reopened.runtime.store.getState()).toMatchObject({
      baselineContent: "base",
      draftContent: "recovered draft",
      status: "dirty",
      isDirty: true,
      recoveryStatus: "persisted",
    });
  });

  it("does not restore another authenticated user's retained draft", async () => {
    const journal = new MemoryRecoveryJournal();
    const disk = await snapshot("base");
    const firstRegistry = makeRegistry(journal);
    const first = firstRegistry.attach({
      identity: IDENTITY,
      initialDisk: disk,
      surfaceId: "surface-a",
      writer: null,
    });
    await first.runtime.whenRecovered();
    first.runtime.attachSurface("draft-owner", () =>
      Promise.resolve(savedResponse(disk.revision)),
    );
    first.runtime.claimOwnership("draft-owner");
    first.runtime.setDraft("draft-owner", "user one's private draft");
    await first.runtime.flushRecovery();
    await firstRegistry.teardown();

    const secondRegistry = makeRegistry(journal);
    const second = secondRegistry.attach({
      identity: { ...IDENTITY, userId: "user-2" },
      initialDisk: disk,
      surfaceId: "surface-b",
      writer: null,
    });
    await second.runtime.whenRecovered();

    expect(second.runtime.store.getState()).toMatchObject({
      draftContent: "base",
      status: "clean",
      isDirty: false,
    });
  });

  it("treats disk already matching the recovered draft as a lost acknowledgement", async () => {
    const journal = new MemoryRecoveryJournal();
    const baseline = await snapshot("base");
    const draft = await snapshot("draft already on disk");
    journal.entries.set(fileEditIdentityKey(IDENTITY), {
      version: 2,
      identity: IDENTITY,
      baselineRevision: baseline.revision,
      draftContent: draft.content,
      contentRevision: 4,
    });
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: draft,
      surfaceId: "surface-a",
      writer: null,
    });

    await attachment.runtime.whenRecovered();
    await attachment.runtime.flushRecovery();

    expect(attachment.runtime.store.getState()).toMatchObject({
      baselineContent: draft.content,
      draftContent: draft.content,
      status: "clean",
      isDirty: false,
    });
    expect(journal.entries).toHaveLength(0);
  });

  it("pauses in conflict when both disk and the recovered draft diverged", async () => {
    const journal = new MemoryRecoveryJournal();
    const baseline = await snapshot("base");
    const disk = await snapshot("external change");
    journal.entries.set(fileEditIdentityKey(IDENTITY), {
      version: 2,
      identity: IDENTITY,
      baselineRevision: baseline.revision,
      draftContent: "local draft",
      contentRevision: 2,
    });
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: disk,
      surfaceId: "surface-a",
      writer: null,
    });

    await attachment.runtime.whenRecovered();

    expect(attachment.runtime.store.getState()).toMatchObject({
      baselineContent: "external change",
      draftContent: "local draft",
      status: "conflict",
      conflict: {
        currentRevision: disk.revision,
        diskContent: "external change",
      },
    });

    attachment.runtime.resolveUseDisk(disk);
    await attachment.runtime.flushRecovery();

    expect(attachment.runtime.store.getState()).toMatchObject({
      baselineContent: disk.content,
      draftContent: disk.content,
      status: "clean",
      isDirty: false,
      conflict: null,
    });
    expect(journal.entries).toHaveLength(0);
  });

  it("shares one runtime while enforcing one explicit owner", async () => {
    const journal = new MemoryRecoveryJournal();
    const writerA = vi.fn<FileEditWriter>(async (request) =>
      savedResponse(await fileContentRevision(request.content)),
    );
    const writerB = vi.fn<FileEditWriter>(async (request) =>
      savedResponse(await fileContentRevision(request.content)),
    );
    const registry = makeRegistry(journal);
    const initialDisk = await snapshot("base");
    const first = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer: writerA,
    });
    const second = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-b",
      writer: writerB,
    });
    await first.runtime.whenRecovered();

    expect(second.runtime).toBe(first.runtime);
    expect(first.runtime.claimOwnership("surface-a")).toBe(true);
    expect(first.runtime.claimOwnership("surface-b")).toBe(false);
    expect(first.runtime.setDraft("surface-b", "rejected")).toBe(false);
    expect(first.runtime.releaseOwnership("surface-a")).toBe(true);
    expect(first.runtime.claimOwnership("surface-b")).toBe(true);
    expect(first.runtime.setDraft("surface-a", "rejected")).toBe(false);
    expect(first.runtime.setDraft("surface-b", "owned by b")).toBe(true);

    await first.runtime.flush();

    expect(writerA).not.toHaveBeenCalled();
    expect(writerB).toHaveBeenCalledTimes(1);
    expect(first.runtime.store.getState()).toMatchObject({
      ownerSurfaceId: "surface-b",
      status: "clean",
    });
  });

  it("does not let a stale duplicate attachment cleanup detach its replacement lease", async () => {
    const journal = new MemoryRecoveryJournal();
    const writer = vi.fn<FileEditWriter>(async (request) =>
      savedResponse(await fileContentRevision(request.content)),
    );
    const registry = makeRegistry(journal);
    const initialDisk = await snapshot("base");
    const stale = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer,
    });
    const current = registry.attach({
      identity: IDENTITY,
      initialDisk,
      surfaceId: "surface-a",
      writer,
    });
    await current.runtime.whenRecovered();

    stale.detach();

    expect(current.runtime.claimOwnership("surface-a")).toBe(true);
  });

  it("resolves registry teardown even when one runtime's own teardown rejects", async () => {
    const journal = new MemoryRecoveryJournal();
    const registry = makeRegistry(journal);
    const attachment = registry.attach({
      identity: IDENTITY,
      initialDisk: await snapshot("base"),
      surfaceId: "surface-a",
      writer: null,
    });
    await attachment.runtime.whenRecovered();

    // A single misbehaving runtime must not fail the whole aggregate: every
    // caller of `registry.teardown()` either discards the promise (`void`) or
    // awaits it without a `.catch`, so an `all`-style rejection would surface
    // as an unhandled rejection or abort an unrelated caller's flow (e.g. the
    // local-state wipe).
    vi.spyOn(attachment.runtime, "teardown").mockRejectedValue(
      new Error("teardown failed"),
    );

    await expect(registry.teardown()).resolves.toBeUndefined();
  });
});
