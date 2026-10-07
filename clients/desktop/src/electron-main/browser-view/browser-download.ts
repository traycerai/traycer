import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import type { BrowserViewDownloadState } from "@traycer-clients/shared/platform/browser-view";
import type { MainConfirmation } from "../app/confirm-destructive";
import { describeLogError, log } from "../app/logger";

/**
 * Downloads from an in-app browser tab, decided without blocking main.
 *
 * Main owns every `browser.sessions` socket, including their ping and pong, so
 * nothing on the browser plane may hold its event loop: a synchronous save
 * dialog left open for 60 s dropped every task's native browser on the machine
 * (traycerai/traycer#2420), and an agent cannot answer a native dialog at all.
 * So a download is decided in the `will-download` turn from facts main already
 * has - the OS Downloads folder and a name made unique - and the one question
 * that needs a person is asked asynchronously, and only where a person is
 * looking.
 */

export interface BrowserDownloadItem {
  getURL(): string;
  getFilename(): string;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getSavePath(): string;
  setSavePath(path: string): void;
  cancel(): void;
  on(
    event: "updated",
    listener: (updatedEvent: unknown, state: string) => void,
  ): void;
  on(
    event: "done",
    listener: (doneEvent: unknown, state: string) => void,
  ): void;
}

export interface BrowserDownloadWebContents {
  readonly id: number;
  getURL(): string;
  once(event: "destroyed", listener: () => void): void;
}

export interface BrowserSessionDownloadChange {
  readonly webContentsId: number;
  readonly downloadId: string;
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly state: BrowserViewDownloadState;
  readonly savePath: string | null;
  readonly dangerType: string | null;
  readonly canCancel: boolean;
}

/** The filesystem the download decisions touch, injected so suites need none. */
export interface BrowserDownloadFiles {
  exists(path: string): boolean;
  ensureDirectory(path: string): void;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeSync(path: string): void;
}

export interface BrowserViewDownloadsOptions {
  /** Read per download: the user can move their Downloads folder. */
  readonly downloadsDirectory: () => string;
  readonly files: BrowserDownloadFiles;
  /** ASYNC by contract. A synchronous dialog here is the defect this fixes. */
  readonly confirm: (confirmation: MainConfirmation) => Promise<boolean>;
  /** Whether a person can see the tab this download came from. */
  readonly isOnScreen: (webContentsId: number) => boolean;
  readonly emit: (change: BrowserSessionDownloadChange) => void;
}

/**
 * What a dangerous download is saved as until its question is answered.
 *
 * Electron writes a download straight to its save path, and `pause()` in the
 * `will-download` turn only stops reading the network: a body that has already
 * arrived is written out and the item completes regardless (measured on
 * Electron 42.11.10: 1 KB, 200 KB and 3 MB bodies all complete on disk while
 * `isPaused()` is true, and `cancel()` afterwards removes nothing). So the file
 * waits under a name no OS hands to a runner and that never carries the real
 * extension, the pattern Chromium's own `Unconfirmed NNNN.crdownload` uses.
 */
export const HELD_DOWNLOAD_EXTENSION = ".traycer-download";

const MAX_NUMBERED_DOWNLOAD_NAMES = 1000;

type HeldAnswer = "pending" | "save" | "cancel";

interface DownloadSnapshot {
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
}

interface DownloadIdentity {
  readonly downloadId: string;
  readonly webContentsId: number;
  readonly dangerType: string | null;
}

interface HeldDownload {
  readonly item: BrowserDownloadItem;
  readonly heldPath: string;
  answer: HeldAnswer;
  /** The item's terminal state, or `null` while it is still in flight. */
  done: string | null;
  /** Set once the rename or the unlink has started; nothing acts twice. */
  settling: boolean;
}

export class BrowserViewDownloads {
  private readonly downloadsDirectory: () => string;
  private readonly files: BrowserDownloadFiles;
  private readonly confirm: (
    confirmation: MainConfirmation,
  ) => Promise<boolean>;
  private readonly isOnScreen: (webContentsId: number) => boolean;
  private readonly emit: (change: BrowserSessionDownloadChange) => void;
  private readonly cancelById = new Map<string, () => void>();
  private readonly heldById = new Map<string, HeldDownload>();
  /**
   * Save paths chosen but possibly not on disk yet, so two downloads of one
   * name started together cannot both be handed `file.txt`.
   */
  private readonly reservedPaths = new Set<string>();

  constructor(options: BrowserViewDownloadsOptions) {
    this.downloadsDirectory = options.downloadsDirectory;
    this.files = options.files;
    this.confirm = options.confirm;
    this.isOnScreen = options.isOnScreen;
    this.emit = options.emit;
  }

  /**
   * The `will-download` listener. Everything the item needs from this turn -
   * its save path, or its cancellation - is settled before it returns, which
   * is all Electron's same-turn rule for `setSavePath` requires.
   */
  handle(
    item: BrowserDownloadItem,
    webContents: BrowserDownloadWebContents,
  ): void {
    const filename = safeDownloadFilename(item.getFilename());
    const identity: DownloadIdentity = {
      downloadId: randomUUID(),
      // Read once: a download outlives its tab, and a destroyed WebContents
      // throws on every read.
      webContentsId: webContents.id,
      dangerType: dangerousDownloadType(filename),
    };
    const directory = this.readDownloadsDirectory();
    if (directory === null) {
      item.cancel();
      this.emitChange(identity, snapshotOf(item), "cancelled", null, false);
      return;
    }
    if (identity.dangerType === null) {
      this.saveDirectly(item, webContents, identity, directory, filename);
      return;
    }
    if (!this.isOnScreen(identity.webContentsId)) {
      // Nobody can answer, and an unattended agent must not save a file that
      // can run code.
      item.cancel();
      log.info("[browser-view] dangerous download refused off screen", {
        url: item.getURL(),
        filename,
        dangerType: identity.dangerType,
      });
      this.emitChange(identity, snapshotOf(item), "cancelled", null, false);
      return;
    }
    this.holdForAnswer(item, webContents, identity, directory, filename);
  }

  cancel(downloadId: string): boolean {
    const cancel = this.cancelById.get(downloadId);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

  /**
   * The app is going away: every download still under its held name is
   * discarded as if its question had been answered Cancel. Synchronous,
   * because nothing awaited here would run before the process exits.
   */
  discardHeld(): void {
    for (const [downloadId, held] of this.heldById) {
      if (held.settling) continue;
      held.answer = "cancel";
      held.settling = true;
      this.cancelById.delete(downloadId);
      try {
        if (held.done === null) held.item.cancel();
        this.files.removeSync(held.heldPath);
      } catch (error) {
        log.warn("[browser-view] held download discard failed", {
          error: describeLogError(error),
        });
      }
    }
    this.heldById.clear();
  }

  private saveDirectly(
    item: BrowserDownloadItem,
    webContents: BrowserDownloadWebContents,
    identity: DownloadIdentity,
    directory: string,
    filename: string,
  ): void {
    const savePath = this.reserveUniquePath(directory, filename);
    item.setSavePath(savePath);
    this.cancelById.set(identity.downloadId, () => {
      item.cancel();
    });
    log.info("[browser-view] download accepted", {
      url: item.getURL(),
      filename,
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      initiatedBy: webContents.getURL(),
    });
    this.emitChange(identity, snapshotOf(item), "progressing", savePath, true);
    item.on("updated", (_updatedEvent, state) => {
      this.emitChange(
        identity,
        snapshotOf(item),
        state === "interrupted" ? "interrupted" : "progressing",
        savePath,
        true,
      );
    });
    item.on("done", (_doneEvent, state) => {
      this.cancelById.delete(identity.downloadId);
      this.reservedPaths.delete(reservationKey(savePath));
      log.info("[browser-view] download finished", {
        url: item.getURL(),
        state,
        receivedBytes: item.getReceivedBytes(),
      });
      this.emitChange(
        identity,
        snapshotOf(item),
        terminalDownloadState(state),
        savePath,
        false,
      );
    });
  }

  /**
   * A dangerous type on a tab a person is looking at: saved under the held
   * name while the question is open, then renamed or removed by the answer.
   * A question that is never answered - the dialog dismissed, the tab gone,
   * the app quitting - is a Cancel.
   */
  private holdForAnswer(
    item: BrowserDownloadItem,
    webContents: BrowserDownloadWebContents,
    identity: DownloadIdentity,
    directory: string,
    filename: string,
  ): void {
    const held: HeldDownload = {
      item,
      heldPath: join(
        directory,
        `Unconfirmed ${identity.downloadId}${HELD_DOWNLOAD_EXTENSION}`,
      ),
      answer: "pending",
      done: null,
      settling: false,
    };
    item.setSavePath(held.heldPath);
    this.heldById.set(identity.downloadId, held);
    let latest = snapshotOf(item);
    const answer = (decision: "save" | "cancel"): void => {
      if (held.answer !== "pending") return;
      held.answer = decision;
      if (decision === "cancel") {
        // A no-op on an item that already completed, which is why the held
        // file is unlinked below instead of trusting this to remove it.
        if (held.done === null) item.cancel();
      } else if (held.done === null) {
        this.emitChange(identity, latest, "progressing", null, true);
      }
      void this.settleHeld(identity, held, directory, filename, latest);
    };
    this.cancelById.set(identity.downloadId, () => {
      answer("cancel");
    });
    this.emitChange(identity, latest, "prompting", null, true);
    item.on("updated", (_updatedEvent, state) => {
      latest = snapshotOf(item);
      if (held.answer === "cancel") return;
      this.emitChange(
        identity,
        latest,
        held.answer === "pending"
          ? "prompting"
          : state === "interrupted"
            ? "interrupted"
            : "progressing",
        null,
        true,
      );
    });
    item.on("done", (_doneEvent, state) => {
      latest = snapshotOf(item);
      held.done = state;
      void this.settleHeld(identity, held, directory, filename, latest);
    });
    webContents.once("destroyed", () => {
      answer("cancel");
    });
    void this.confirm({
      title: "Confirm download",
      message: `Save ${filename}?`,
      detail: `${identity.dangerType} files can run code on your machine.\n\nSource: ${latest.url}`,
      confirmLabel: "Save anyway",
    }).then(
      (confirmed) => {
        answer(confirmed ? "save" : "cancel");
      },
      (error: unknown) => {
        log.warn("[browser-view] download confirmation failed", {
          error: describeLogError(error),
        });
        answer("cancel");
      },
    );
  }

  /**
   * Runs once, when BOTH the answer and the item's terminal state are known.
   * The rename waits for `completed` so a half-written file never appears
   * under a name that can run.
   */
  private async settleHeld(
    identity: DownloadIdentity,
    held: HeldDownload,
    directory: string,
    filename: string,
    snapshot: DownloadSnapshot,
  ): Promise<void> {
    if (held.answer === "pending" || held.done === null || held.settling) {
      return;
    }
    held.settling = true;
    this.cancelById.delete(identity.downloadId);
    if (held.answer === "save" && held.done === "completed") {
      const savePath = this.reserveUniquePath(directory, filename);
      try {
        await this.files.rename(held.heldPath, savePath);
        log.info("[browser-view] download finished", {
          url: snapshot.url,
          state: held.done,
          receivedBytes: snapshot.receivedBytes,
        });
        this.emitChange(identity, snapshot, "completed", savePath, false);
      } catch (error) {
        log.warn("[browser-view] confirmed download could not be saved", {
          error: describeLogError(error),
        });
        await this.removeHeld(held);
        this.emitChange(identity, snapshot, "interrupted", null, false);
      } finally {
        this.reservedPaths.delete(reservationKey(savePath));
        this.heldById.delete(identity.downloadId);
      }
      return;
    }
    await this.removeHeld(held);
    this.heldById.delete(identity.downloadId);
    this.emitChange(
      identity,
      snapshot,
      held.answer === "cancel" ? "cancelled" : terminalDownloadState(held.done),
      null,
      false,
    );
  }

  private async removeHeld(held: HeldDownload): Promise<void> {
    try {
      await this.files.remove(held.heldPath);
    } catch (error) {
      log.warn("[browser-view] held download could not be removed", {
        error: describeLogError(error),
      });
    }
  }

  private readDownloadsDirectory(): string | null {
    try {
      const directory = this.downloadsDirectory();
      this.files.ensureDirectory(directory);
      return directory;
    } catch (error) {
      log.warn("[browser-view] download refused: no Downloads folder", {
        error: describeLogError(error),
      });
      return null;
    }
  }

  /** `name.ext`, then `name (1).ext`, `name (2).ext`, ... never an overwrite. */
  private reserveUniquePath(directory: string, filename: string): string {
    const extension = extname(filename);
    const stem =
      extension === "" ? filename : filename.slice(0, -extension.length);
    for (let index = 0; index < MAX_NUMBERED_DOWNLOAD_NAMES; index += 1) {
      const candidate = join(
        directory,
        index === 0 ? filename : `${stem} (${index})${extension}`,
      );
      if (this.reserve(candidate)) return candidate;
    }
    const fallback = join(directory, `${stem} (${randomUUID()})${extension}`);
    this.reservedPaths.add(reservationKey(fallback));
    return fallback;
  }

  private reserve(candidate: string): boolean {
    const key = reservationKey(candidate);
    if (this.reservedPaths.has(key) || this.files.exists(candidate)) {
      return false;
    }
    this.reservedPaths.add(key);
    return true;
  }

  private emitChange(
    identity: DownloadIdentity,
    snapshot: DownloadSnapshot,
    state: BrowserViewDownloadState,
    savePath: string | null,
    canCancel: boolean,
  ): void {
    this.emit({
      webContentsId: identity.webContentsId,
      downloadId: identity.downloadId,
      url: snapshot.url,
      filename: snapshot.filename,
      mimeType: snapshot.mimeType,
      totalBytes: snapshot.totalBytes,
      receivedBytes: snapshot.receivedBytes,
      state,
      savePath,
      dangerType: identity.dangerType,
      canCancel,
    });
  }
}

function snapshotOf(item: BrowserDownloadItem): DownloadSnapshot {
  return {
    url: item.getURL(),
    filename: item.getFilename(),
    mimeType: item.getMimeType(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: item.getReceivedBytes(),
  };
}

/**
 * Chromium already reduces a suggested name to one path segment; this keeps
 * that true whatever a future Electron hands over, because the result is
 * joined under the Downloads folder.
 */
function safeDownloadFilename(suggested: string): string {
  const name = basename(suggested.replaceAll("\\", "/")).trim();
  if (name === "" || name === "." || name === "..") return "download";
  return name;
}

/** Case-folded: the default macOS and Windows volumes do not tell case apart. */
function reservationKey(path: string): string {
  return path.toLowerCase();
}

function terminalDownloadState(state: string): BrowserViewDownloadState {
  if (state === "completed") return "completed";
  if (state === "cancelled") return "cancelled";
  return "interrupted";
}

function dangerousDownloadType(filename: string): string | null {
  const lower = filename.toLowerCase();
  const extension = lower.includes(".")
    ? lower.slice(lower.lastIndexOf("."))
    : "";
  if (DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)) return extension;
  return null;
}

const DANGEROUS_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ".app",
  ".applescript",
  ".bat",
  ".cmd",
  ".command",
  ".com",
  ".cpl",
  ".dmg",
  ".exe",
  ".hta",
  ".jar",
  ".js",
  ".jse",
  ".msi",
  ".pkg",
  ".ps1",
  ".reg",
  ".scr",
  ".sh",
  ".vb",
  ".vbe",
  ".vbs",
  ".wsf",
]);
