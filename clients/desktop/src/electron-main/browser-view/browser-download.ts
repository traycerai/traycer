import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import type { BrowserViewDownloadState } from "@traycer-clients/shared/platform/browser-view";
import type { MainConfirmation } from "../app/confirm-destructive";
import { describeLogError, log } from "../app/logger";
import { CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS } from "./chromium-download-file-types";

/**
 * Downloads from an in-app browser tab, decided without blocking main.
 *
 * Main owns every `browser.sessions` socket, including their ping and pong, so
 * nothing on the browser plane may hold its event loop: a synchronous save
 * dialog left open for 60 s dropped every task's native browser on the machine
 * (traycerai/traycer#2420), and an agent cannot answer a native dialog at all.
 * So a download is decided in the `will-download` turn from facts main already
 * has - the OS Downloads folder and the download's own id - with no question
 * to a person and none to the disk. The one question that needs a person is
 * asked asynchronously, and only where a person is looking; the file's own
 * name is taken asynchronously too, once the file is complete.
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
  removeListener(event: "destroyed", listener: () => void): void;
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

/**
 * The filesystem the download decisions touch, injected so suites need none.
 * Nothing here is synchronous except the removal at quit: the `will-download`
 * turn itself touches no file.
 */
export interface BrowserDownloadFiles {
  /**
   * Moves `from` to `to` only if nothing is at `to`. `exists` leaves both
   * files as they were; it is the filesystem's own answer, so a file another
   * process created a moment ago, or a name the volume treats as the same
   * one (case, or a composed against a decomposed character), is never
   * replaced.
   */
  publish(from: string, to: string): Promise<"published" | "exists">;
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
 * What every download is saved as until it is published under its own name.
 *
 * Two facts make this the only name the `will-download` turn can hand out.
 * Choosing the real name there means asking the disk which names are taken,
 * and a synchronous question to a Downloads folder on a stalled network share
 * holds main's event loop exactly as the dialog did; the held name is built
 * from the download's own id, so nothing is asked. And Electron writes a
 * download straight to its save path: `pause()` in the turn only stops reading
 * the network, a body that has already arrived is written out and the item
 * completes regardless (measured on Electron 42.11.10: 1 KB, 200 KB and 3 MB
 * bodies all complete on disk while `isPaused()` is true, and `cancel()`
 * afterwards removes nothing). So a file whose question is still open waits
 * under a name no OS hands to a runner and that never carries the real
 * extension, the pattern Chromium's own `Unconfirmed NNNN.crdownload` uses.
 *
 * Chromium creates a missing save directory itself, off the main thread
 * (measured on the same build, two missing levels), so the folder is not
 * prepared here either.
 */
export const HELD_DOWNLOAD_EXTENSION = ".traycer-download";

const MAX_NUMBERED_DOWNLOAD_NAMES = 1000;

/**
 * Whether the file may be published. A plain download starts at `save`. A
 * dangerous one starts at `pending` and its dialog answers ONCE (`save` or
 * `cancel`); a Cancel can still arrive after "Save anyway" while the transfer
 * runs, from the tile's own Cancel, and `cancel` is final: nothing turns it
 * back into a save.
 */
type HeldAnswer = "pending" | "save" | "cancel";

/**
 * What has been done with the held file. `publishing` and `removing` are the
 * move and the unlink in flight; once either starts, no later event acts on
 * the file again.
 */
type HeldSettlement = "open" | "publishing" | "removing";

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
  settlement: HeldSettlement;
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
   * is all Electron's same-turn rule for `setSavePath` requires, and none of
   * it waits on a person or on a disk.
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
    if (
      identity.dangerType !== null &&
      !this.isOnScreen(identity.webContentsId)
    ) {
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
    this.hold(item, webContents, identity, directory, filename);
  }

  cancel(downloadId: string): boolean {
    const cancel = this.cancelById.get(downloadId);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

  /**
   * The app is going away: every download still under its held name is
   * discarded - an unfinished transfer, and a question nobody answered, which
   * is a Cancel. Synchronous, because nothing awaited here would run before
   * the process exits - which is also why an unlink that is already in flight
   * is done again here rather than trusted to finish. Only a move to the
   * file's own name that is already under way is left alone.
   */
  discardHeld(): void {
    for (const [downloadId, held] of this.heldById) {
      if (held.settlement === "publishing") continue;
      held.answer = "cancel";
      held.settlement = "removing";
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

  /**
   * Saves under the held name, then publishes or removes. A plain file is
   * published as soon as it completes. A dangerous type on a tab a person is
   * looking at waits for the answer as well; a question that is never
   * answered - the dialog dismissed, the tab gone, the app quitting - is a
   * Cancel.
   */
  private hold(
    item: BrowserDownloadItem,
    webContents: BrowserDownloadWebContents,
    identity: DownloadIdentity,
    directory: string,
    filename: string,
  ): void {
    const asks = identity.dangerType !== null;
    const held: HeldDownload = {
      item,
      heldPath: join(
        directory,
        `Unconfirmed ${identity.downloadId}${HELD_DOWNLOAD_EXTENSION}`,
      ),
      answer: asks ? "pending" : "save",
      done: null,
      settlement: "open",
    };
    item.setSavePath(held.heldPath);
    this.heldById.set(identity.downloadId, held);
    let latest = snapshotOf(item);
    const settle = (): void => {
      void this.settleHeld(identity, held, directory, filename, latest);
    };
    // Set below for a download that asks: the tab is watched only while its
    // question is open, so a long-lived tab does not collect one listener,
    // and one retained download, per question it ever raised.
    let stopWatchingTab = (): void => {};
    // Allowed until the file is being published or removed, whatever the
    // dialog said: a download that still offers Cancel must still be
    // cancellable.
    const cancelHeld = (): void => {
      if (held.answer === "cancel" || held.settlement !== "open") return;
      stopWatchingTab();
      held.answer = "cancel";
      // A no-op on an item that already completed, which is why the held
      // file is unlinked at settlement instead of trusting this to remove it.
      if (held.done === null) item.cancel();
      settle();
    };
    this.cancelById.set(identity.downloadId, cancelHeld);
    if (!asks) {
      log.info("[browser-view] download accepted", {
        url: latest.url,
        filename,
        mimeType: latest.mimeType,
        totalBytes: latest.totalBytes,
        initiatedBy: webContents.getURL(),
      });
    }
    this.emitChange(
      identity,
      latest,
      asks ? "prompting" : "progressing",
      null,
      true,
    );
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
      settle();
    });
    if (!asks) return;
    // The dialog's answer, taken once. A late "Save anyway" after any Cancel
    // changes nothing.
    const answerQuestion = (confirmed: boolean): void => {
      if (held.answer !== "pending") return;
      stopWatchingTab();
      if (!confirmed) {
        cancelHeld();
        return;
      }
      held.answer = "save";
      if (held.done === null) {
        this.emitChange(identity, latest, "progressing", null, true);
      }
      settle();
    };
    // An unanswered question dies with its tab. A download the person already
    // confirmed carries on, as any other download outlives its tab.
    let watchingTab = true;
    const onTabDestroyed = (): void => {
      // `once` has already removed it, and a destroyed tab is not touched.
      watchingTab = false;
      if (held.answer === "pending") cancelHeld();
    };
    stopWatchingTab = (): void => {
      if (!watchingTab) return;
      watchingTab = false;
      webContents.removeListener("destroyed", onTabDestroyed);
    };
    webContents.once("destroyed", onTabDestroyed);
    void this.confirm({
      title: "Confirm download",
      message: `Save ${filename}?`,
      detail: `${identity.dangerType} files can run code or change settings on your machine.\n\nSource: ${latest.url}`,
      confirmLabel: "Save anyway",
    }).then(answerQuestion, (error: unknown) => {
      log.warn("[browser-view] download confirmation failed", {
        error: describeLogError(error),
      });
      answerQuestion(false);
    });
  }

  /**
   * Runs once, when BOTH the answer and the item's terminal state are known.
   * The file takes its own name only after `completed`, so a half-written
   * file never appears under a name that can run.
   */
  private async settleHeld(
    identity: DownloadIdentity,
    held: HeldDownload,
    directory: string,
    filename: string,
    snapshot: DownloadSnapshot,
  ): Promise<void> {
    if (
      held.answer === "pending" ||
      held.done === null ||
      held.settlement !== "open"
    ) {
      return;
    }
    this.cancelById.delete(identity.downloadId);
    if (held.answer === "save" && held.done === "completed") {
      held.settlement = "publishing";
      // Cancel stops working here, so the tile is told before the move: on a
      // volume with no hard links the move is a copy, and a Cancel button
      // left up for its whole length would be one that does nothing.
      this.emitChange(identity, snapshot, "progressing", null, false);
      try {
        const savePath = await this.publish(held.heldPath, directory, filename);
        log.info("[browser-view] download finished", {
          url: snapshot.url,
          state: held.done,
          receivedBytes: snapshot.receivedBytes,
        });
        // Under the name it was actually given: a taken name moves the file
        // to `name (1).ext`, and the tile must not point at the older file.
        this.emitChange(
          identity,
          { ...snapshot, filename: basename(savePath) },
          "completed",
          savePath,
          false,
        );
      } catch (error) {
        log.warn("[browser-view] completed download could not be saved", {
          error: describeLogError(error),
        });
        held.settlement = "removing";
        await this.removeHeld(held);
        this.emitChange(identity, snapshot, "interrupted", null, false);
      } finally {
        this.heldById.delete(identity.downloadId);
      }
      return;
    }
    held.settlement = "removing";
    await this.removeHeld(held);
    this.heldById.delete(identity.downloadId);
    log.info("[browser-view] download finished", {
      url: snapshot.url,
      state: held.answer === "cancel" ? "cancelled" : held.done,
      receivedBytes: snapshot.receivedBytes,
    });
    this.emitChange(
      identity,
      snapshot,
      held.answer === "cancel" ? "cancelled" : terminalDownloadState(held.done),
      null,
      false,
    );
  }

  /**
   * `name.ext`, then `name (1).ext`, `name (2).ext`, ... and never an
   * overwrite: each candidate is claimed by the move itself, so there is no
   * gap between finding a name free and taking it for another download, or
   * another program, to land in.
   */
  private async publish(
    heldPath: string,
    directory: string,
    filename: string,
  ): Promise<string> {
    const extension = extname(filename);
    const stem =
      extension === "" ? filename : filename.slice(0, -extension.length);
    for (let index = 0; index < MAX_NUMBERED_DOWNLOAD_NAMES; index += 1) {
      const candidate = join(
        directory,
        index === 0 ? filename : `${stem} (${index})${extension}`,
      );
      if ((await this.files.publish(heldPath, candidate)) === "published") {
        return candidate;
      }
    }
    const fallback = join(directory, `${stem} (${randomUUID()})${extension}`);
    if ((await this.files.publish(heldPath, fallback)) === "published") {
      return fallback;
    }
    throw new Error("No free name for the download in the Downloads folder");
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
      return this.downloadsDirectory();
    } catch (error) {
      log.warn("[browser-view] download refused: no Downloads folder", {
        error: describeLogError(error),
      });
      return null;
    }
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
  if (CHROMIUM_DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)) return extension;
  return null;
}
