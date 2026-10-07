import { EventEmitter } from "node:events";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MainConfirmation } from "../../app/confirm-destructive";
import {
  BrowserViewDownloads,
  HELD_DOWNLOAD_EXTENSION,
  type BrowserDownloadFiles,
  type BrowserDownloadItem,
  type BrowserDownloadWebContents,
  type BrowserSessionDownloadChange,
} from "../browser-download";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (error: unknown): string => String(error),
}));

const DIRECTORY = join("downloads-root", "Downloads");

class FakeItem implements BrowserDownloadItem {
  readonly emitter = new EventEmitter();
  savePath = "";
  cancelCalls = 0;
  receivedBytes = 0;

  constructor(
    readonly filename: string,
    readonly totalBytes: number,
  ) {}

  getURL(): string {
    return `https://app.test/${this.filename}`;
  }

  getFilename(): string {
    return this.filename;
  }

  getMimeType(): string {
    return "application/octet-stream";
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  getReceivedBytes(): number {
    return this.receivedBytes;
  }

  getSavePath(): string {
    return this.savePath;
  }

  setSavePath(path: string): void {
    this.savePath = path;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  on(
    event: "updated" | "done",
    listener: (downloadEvent: unknown, state: string) => void,
  ): void {
    this.emitter.on(event, listener);
  }

  emitUpdated(state: string, receivedBytes: number): void {
    this.receivedBytes = receivedBytes;
    this.emitter.emit("updated", {}, state);
  }

  emitDone(state: string): void {
    if (state === "completed") this.receivedBytes = this.totalBytes;
    this.emitter.emit("done", {}, state);
  }
}

class FakeWebContents implements BrowserDownloadWebContents {
  private readonly emitter = new EventEmitter();

  constructor(readonly id: number) {}

  getURL(): string {
    return "https://app.test/";
  }

  once(event: "destroyed", listener: () => void): void {
    this.emitter.once(event, listener);
  }

  fireDestroyed(): void {
    this.emitter.emit("destroyed");
  }
}

interface Harness {
  readonly downloads: BrowserViewDownloads;
  readonly existing: Set<string>;
  readonly changes: BrowserSessionDownloadChange[];
  readonly confirmations: Array<PromiseWithResolvers<boolean>>;
  readonly confirmCalls: MainConfirmation[];
  readonly renameCalls: Array<{ readonly from: string; readonly to: string }>;
  readonly removeCalls: string[];
  readonly removeSyncCalls: string[];
  readonly state: {
    failRename: boolean;
    onScreen: boolean;
    /** When set, `rename` waits for it after recording the call. */
    renameGate: PromiseWithResolvers<void> | null;
    /** When set, `remove` waits for it after recording the call. */
    removeGate: PromiseWithResolvers<void> | null;
  };
}

function createHarness(directory: () => string): Harness {
  const existing = new Set<string>();
  const changes: BrowserSessionDownloadChange[] = [];
  const confirmations: Array<PromiseWithResolvers<boolean>> = [];
  const confirmCalls: MainConfirmation[] = [];
  const renameCalls: Array<{ readonly from: string; readonly to: string }> = [];
  const removeCalls: string[] = [];
  const removeSyncCalls: string[] = [];
  const state: Harness["state"] = {
    failRename: false,
    onScreen: true,
    renameGate: null,
    removeGate: null,
  };
  const files: BrowserDownloadFiles = {
    exists: (path) => existing.has(path),
    ensureDirectory: () => undefined,
    rename: async (from, to) => {
      renameCalls.push({ from, to });
      if (state.renameGate !== null) await state.renameGate.promise;
      if (state.failRename) throw new Error("rename failed");
      existing.delete(from);
      existing.add(to);
    },
    remove: async (path) => {
      removeCalls.push(path);
      if (state.removeGate !== null) await state.removeGate.promise;
      existing.delete(path);
    },
    removeSync: (path) => {
      removeSyncCalls.push(path);
      existing.delete(path);
    },
  };
  const downloads = new BrowserViewDownloads({
    downloadsDirectory: directory,
    files,
    confirm: (confirmation) => {
      confirmCalls.push(confirmation);
      const pending = Promise.withResolvers<boolean>();
      confirmations.push(pending);
      return pending.promise;
    },
    isOnScreen: () => state.onScreen,
    emit: (change) => {
      changes.push(change);
    },
  });
  return {
    downloads,
    existing,
    changes,
    confirmations,
    confirmCalls,
    renameCalls,
    removeCalls,
    removeSyncCalls,
    state,
  };
}

function harness(): Harness {
  return createHarness(() => DIRECTORY);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function pendingConfirmation(
  h: Harness,
  index: number,
): PromiseWithResolvers<boolean> {
  const pending = h.confirmations[index];
  if (pending === undefined) throw new Error("confirmation missing");
  return pending;
}

function lastChange(h: Harness): BrowserSessionDownloadChange {
  const change = h.changes.at(-1);
  if (change === undefined) throw new Error("no change emitted");
  return change;
}

function promptingDownloadId(h: Harness): string {
  const prompting = h.changes.find((change) => change.state === "prompting");
  if (prompting === undefined) throw new Error("prompting change missing");
  return prompting.downloadId;
}

/** Starts a dangerous download on a tab a person is looking at. */
function startHeld(
  h: Harness,
  webContents: FakeWebContents,
  filename: string,
): FakeItem {
  const item = new FakeItem(filename, 10);
  h.downloads.handle(item, webContents);
  return item;
}

/** The file reaches disk under its held name, as Electron writes it. */
function complete(h: Harness, item: FakeItem): void {
  h.existing.add(item.savePath);
  item.emitDone("completed");
}

describe("BrowserViewDownloads", () => {
  it("saves a plain file into Downloads without asking", () => {
    const h = harness();
    const item = new FakeItem("file.txt", 100);

    h.downloads.handle(item, new FakeWebContents(1));

    expect(h.confirmCalls).toHaveLength(0);
    expect(item.savePath).toBe(join(DIRECTORY, "file.txt"));
    expect(h.changes.map((change) => change.state)).toEqual(["progressing"]);
    expect(lastChange(h)).toMatchObject({
      savePath: join(DIRECTORY, "file.txt"),
      canCancel: true,
      dangerType: null,
    });
    item.emitDone("completed");
    expect(lastChange(h)).toMatchObject({
      state: "completed",
      savePath: join(DIRECTORY, "file.txt"),
      canCancel: false,
    });
  });

  it("numbers a name that exists on disk", () => {
    const h = harness();
    h.existing.add(join(DIRECTORY, "file.txt"));
    h.existing.add(join(DIRECTORY, "file (1).txt"));
    const item = new FakeItem("file.txt", 100);

    h.downloads.handle(item, new FakeWebContents(1));

    expect(item.savePath).toBe(join(DIRECTORY, "file (2).txt"));
  });

  it("reserves a name against a download that has not reached disk yet", () => {
    const h = harness();
    const first = new FakeItem("file.txt", 100);
    const second = new FakeItem("file.txt", 100);
    const webContents = new FakeWebContents(1);

    h.downloads.handle(first, webContents);
    h.downloads.handle(second, webContents);

    expect(first.savePath).toBe(join(DIRECTORY, "file.txt"));
    expect(second.savePath).toBe(join(DIRECTORY, "file (1).txt"));

    // The first finishes and its file was removed again: the name is free.
    first.emitDone("completed");
    const third = new FakeItem("file.txt", 100);
    h.downloads.handle(third, webContents);
    expect(third.savePath).toBe(join(DIRECTORY, "file.txt"));
  });

  it("does not hand out a finished download's name while it exists on disk", () => {
    const h = harness();
    const first = new FakeItem("file.txt", 100);
    const webContents = new FakeWebContents(1);
    h.downloads.handle(first, webContents);

    h.existing.add(first.savePath);
    first.emitDone("completed");
    const second = new FakeItem("file.txt", 100);
    h.downloads.handle(second, webContents);

    expect(second.savePath).toBe(join(DIRECTORY, "file (1).txt"));
  });

  it("refuses a dangerous type on a tab nobody can see", () => {
    const h = harness();
    h.state.onScreen = false;
    const item = new FakeItem("install.sh", 10);

    h.downloads.handle(item, new FakeWebContents(1));

    expect(item.cancelCalls).toBe(1);
    expect(item.savePath).toBe("");
    expect(h.confirmCalls).toHaveLength(0);
    expect(h.changes).toHaveLength(1);
    expect(lastChange(h)).toMatchObject({
      state: "cancelled",
      dangerType: ".sh",
    });
  });

  it("holds a dangerous type on screen under a name that never runs", () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");

    expect(dirname(item.savePath)).toBe(DIRECTORY);
    expect(basename(item.savePath).startsWith("Unconfirmed ")).toBe(true);
    expect(item.savePath.endsWith(HELD_DOWNLOAD_EXTENSION)).toBe(true);
    expect(item.savePath.endsWith(".sh")).toBe(false);
    expect(item.savePath).not.toContain("install.sh");
    expect(h.changes[0]).toMatchObject({
      state: "prompting",
      savePath: null,
      dangerType: ".sh",
    });
    expect(h.confirmCalls).toHaveLength(1);
  });

  it("renames a confirmed download only after it completed", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    pendingConfirmation(h, 0).resolve(true);
    await flush();

    expect(h.renameCalls).toHaveLength(0);
    expect(lastChange(h)).toMatchObject({ state: "progressing" });

    complete(h, item);
    await flush();

    expect(h.renameCalls).toEqual([
      { from: heldPath, to: join(DIRECTORY, "install.sh") },
    ]);
    expect(lastChange(h)).toMatchObject({
      state: "completed",
      savePath: join(DIRECTORY, "install.sh"),
      canCancel: false,
    });
  });

  it("renames once when the download completed before the answer", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    complete(h, item);
    await flush();
    expect(h.renameCalls).toHaveLength(0);

    pendingConfirmation(h, 0).resolve(true);
    await flush();

    expect(h.renameCalls).toEqual([
      { from: heldPath, to: join(DIRECTORY, "install.sh") },
    ]);
    expect(lastChange(h)).toMatchObject({
      state: "completed",
      savePath: join(DIRECTORY, "install.sh"),
    });
  });

  it("unlinks a completed download answered Cancel", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    complete(h, item);
    pendingConfirmation(h, 0).resolve(false);
    await flush();

    expect(item.cancelCalls).toBe(0);
    expect(h.removeCalls).toEqual([heldPath]);
    expect(h.existing.has(heldPath)).toBe(false);
    expect(lastChange(h)).toMatchObject({
      state: "cancelled",
      savePath: null,
    });
  });

  it("cancels an in-flight download answered Cancel and unlinks on done", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    pendingConfirmation(h, 0).resolve(false);
    await flush();

    expect(item.cancelCalls).toBe(1);
    expect(h.removeCalls).toHaveLength(0);

    item.emitDone("cancelled");
    await flush();

    expect(h.removeCalls).toEqual([heldPath]);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });

  it("treats the tab being destroyed as a Cancel", async () => {
    const h = harness();
    const webContents = new FakeWebContents(1);
    const item = startHeld(h, webContents, "install.sh");
    const heldPath = item.savePath;

    complete(h, item);
    webContents.fireDestroyed();
    await flush();

    expect(h.removeCalls).toEqual([heldPath]);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });

    pendingConfirmation(h, 0).resolve(true);
    await flush();
    expect(h.renameCalls).toHaveLength(0);
  });

  it("discards every held download when the app goes away", async () => {
    const h = harness();
    const webContents = new FakeWebContents(1);
    const completed = startHeld(h, webContents, "one.sh");
    const inFlight = startHeld(h, webContents, "two.sh");
    const completedPath = completed.savePath;
    const inFlightPath = inFlight.savePath;
    complete(h, completed);

    h.downloads.discardHeld();

    expect(h.removeSyncCalls).toEqual([completedPath, inFlightPath]);
    expect(inFlight.cancelCalls).toBe(1);
    expect(completed.cancelCalls).toBe(0);

    pendingConfirmation(h, 0).resolve(true);
    pendingConfirmation(h, 1).resolve(true);
    await flush();
    expect(h.renameCalls).toHaveLength(0);
  });

  it("answers Cancel through cancel(downloadId) for a held download", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const prompting = h.changes[0];
    if (prompting === undefined) throw new Error("prompting change missing");
    expect(prompting.state).toBe("prompting");

    expect(h.downloads.cancel(prompting.downloadId)).toBe(true);
    expect(item.cancelCalls).toBe(1);
    expect(h.downloads.cancel("no-such-download")).toBe(false);

    item.emitDone("cancelled");
    await flush();
    expect(h.removeCalls).toEqual([item.savePath]);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });

  it("reports interrupted and removes the held file when the rename fails", async () => {
    const h = harness();
    h.state.failRename = true;
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    complete(h, item);
    pendingConfirmation(h, 0).resolve(true);
    await flush();

    expect(h.renameCalls).toHaveLength(1);
    expect(h.removeCalls).toEqual([heldPath]);
    expect(lastChange(h)).toMatchObject({
      state: "interrupted",
      savePath: null,
    });
  });

  it("treats a rejected confirmation as a Cancel", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");

    pendingConfirmation(h, 0).reject(new Error("dialog failed"));
    await flush();

    expect(item.cancelCalls).toBe(1);
    item.emitDone("cancelled");
    await flush();
    expect(h.removeCalls).toEqual([item.savePath]);
    expect(h.renameCalls).toHaveLength(0);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });

  it("cancels when there is no Downloads folder", () => {
    const h = createHarness(() => {
      throw new Error("no downloads folder");
    });
    const item = new FakeItem("file.txt", 100);

    h.downloads.handle(item, new FakeWebContents(1));

    expect(item.cancelCalls).toBe(1);
    expect(item.savePath).toBe("");
    expect(h.changes).toHaveLength(1);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });
  it("refuses .pif off screen and holds it on screen", () => {
    const off = harness();
    off.state.onScreen = false;
    const offItem = new FakeItem("setup.pif", 10);
    off.downloads.handle(offItem, new FakeWebContents(1));
    expect(offItem.cancelCalls).toBe(1);
    expect(offItem.savePath).toBe("");
    expect(off.confirmCalls).toHaveLength(0);
    expect(lastChange(off)).toMatchObject({
      state: "cancelled",
      dangerType: ".pif",
    });

    const on = harness();
    const onItem = startHeld(on, new FakeWebContents(1), "setup.pif");
    expect(onItem.savePath.endsWith(HELD_DOWNLOAD_EXTENSION)).toBe(true);
    expect(on.confirmCalls).toHaveLength(1);
    expect(on.changes[0]).toMatchObject({
      state: "prompting",
      dangerType: ".pif",
    });
  });

  it("cancels in flight after Save anyway through the tile", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;
    const downloadId = promptingDownloadId(h);

    pendingConfirmation(h, 0).resolve(true);
    await flush();
    expect(h.downloads.cancel(downloadId)).toBe(true);
    expect(item.cancelCalls).toBe(1);

    item.emitDone("cancelled");
    await flush();

    expect(h.removeCalls).toEqual([heldPath]);
    expect(h.renameCalls).toHaveLength(0);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });

  it("keeps the person's save once the rename has started", async () => {
    const h = harness();
    h.state.renameGate = Promise.withResolvers<void>();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const downloadId = promptingDownloadId(h);

    complete(h, item);
    pendingConfirmation(h, 0).resolve(true);
    await flush();
    expect(h.renameCalls).toHaveLength(1);

    expect(h.downloads.cancel(downloadId)).toBe(false);
    expect(item.cancelCalls).toBe(0);

    h.state.renameGate.resolve();
    await flush();
    expect(lastChange(h)).toMatchObject({
      state: "completed",
      savePath: join(DIRECTORY, "install.sh"),
    });
    expect(h.removeCalls).toHaveLength(0);
  });

  it("takes the dialog's answer once: a late Save anyway after Cancel renames nothing", async () => {
    const h = harness();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const downloadId = promptingDownloadId(h);

    expect(h.downloads.cancel(downloadId)).toBe(true);
    expect(item.cancelCalls).toBe(1);
    pendingConfirmation(h, 0).resolve(true);
    await flush();
    item.emitDone("cancelled");
    await flush();

    expect(h.renameCalls).toHaveLength(0);
    expect(h.removeCalls).toEqual([item.savePath]);
    expect(lastChange(h)).toMatchObject({ state: "cancelled" });
  });

  it("does not cancel a confirmed download when its tab is destroyed", async () => {
    const h = harness();
    const webContents = new FakeWebContents(1);
    const item = startHeld(h, webContents, "install.sh");
    const heldPath = item.savePath;

    pendingConfirmation(h, 0).resolve(true);
    await flush();
    webContents.fireDestroyed();
    expect(item.cancelCalls).toBe(0);

    complete(h, item);
    await flush();

    expect(h.renameCalls).toEqual([
      { from: heldPath, to: join(DIRECTORY, "install.sh") },
    ]);
    expect(lastChange(h)).toMatchObject({ state: "completed" });
  });

  it("removes synchronously a held file whose async unlink is still in flight", async () => {
    const h = harness();
    h.state.removeGate = Promise.withResolvers<void>();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");
    const heldPath = item.savePath;

    complete(h, item);
    pendingConfirmation(h, 0).resolve(false);
    await flush();
    expect(h.removeCalls).toEqual([heldPath]);
    expect(h.removeSyncCalls).toHaveLength(0);

    h.downloads.discardHeld();

    expect(h.removeSyncCalls).toEqual([heldPath]);
    h.state.removeGate.resolve();
    await flush();
  });

  it("leaves a rename in flight alone when the app goes away", async () => {
    const h = harness();
    h.state.renameGate = Promise.withResolvers<void>();
    const item = startHeld(h, new FakeWebContents(1), "install.sh");

    complete(h, item);
    pendingConfirmation(h, 0).resolve(true);
    await flush();
    expect(h.renameCalls).toHaveLength(1);

    h.downloads.discardHeld();

    expect(h.removeSyncCalls).toEqual([]);
    expect(item.cancelCalls).toBe(0);
    h.state.renameGate.resolve();
    await flush();
    expect(lastChange(h)).toMatchObject({ state: "completed" });
  });

  it("tells canonically equivalent names apart while both are in flight", () => {
    const h = harness();
    const composed = new FakeItem("caf\u00e9.txt", 10);
    const decomposed = new FakeItem("cafe\u0301.txt", 10);
    const webContents = new FakeWebContents(1);

    h.downloads.handle(composed, webContents);
    h.downloads.handle(decomposed, webContents);

    expect(composed.savePath).toBe(join(DIRECTORY, "caf\u00e9.txt"));
    expect(decomposed.savePath).toBe(join(DIRECTORY, "cafe\u0301 (1).txt"));
  });

  it("publishes two confirmed downloads of equivalent names to different paths", async () => {
    const h = harness();
    const webContents = new FakeWebContents(1);
    const first = startHeld(h, webContents, "caf\u00e9.sh");
    const second = startHeld(h, webContents, "cafe\u0301.sh");
    complete(h, first);
    complete(h, second);

    pendingConfirmation(h, 0).resolve(true);
    pendingConfirmation(h, 1).resolve(true);
    await flush();

    expect(h.renameCalls).toHaveLength(2);
    const [one, two] = h.renameCalls;
    if (one === undefined || two === undefined) throw new Error("renames");
    expect(one.to).not.toBe(two.to);
    const fold = (path: string): string => path.normalize("NFC").toLowerCase();
    expect(fold(one.to)).not.toBe(fold(two.to));
  });
});
