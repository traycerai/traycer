import type { Result } from "electron";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type {
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
} from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";
import {
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewEntryFindSession,
  type BrowserViewSend,
} from "./browser-view-entry";
import type { BrowserViewEntryRegistry } from "./browser-view-entry-registry";

interface BrowserViewFindOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly send: BrowserViewSend;
}

/**
 * Find-in-page. Electron allocates its own request id per `findInPage` call
 * and reports results against it, so the app's request id is carried in a
 * per-entry session map rather than assumed to be the latest one.
 */
export class BrowserViewFind {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly send: BrowserViewSend;

  constructor(options: BrowserViewFindOptions) {
    this.entries = options.entries;
    this.send = options.send;
  }

  find(windowId: string, input: BrowserViewFindRequest): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    if (input.query.length === 0) {
      this.stop(windowId, input);
      return;
    }
    const sameAppSession =
      entry.findState.appRequestId === input.requestId &&
      entry.findState.query === input.query &&
      entry.findState.matchCase === input.matchCase;
    const sessionsByElectronRequestId = sameAppSession
      ? new Map(entry.findState.sessionsByElectronRequestId)
      : new Map<number, BrowserViewEntryFindSession>();
    entry.findState = {
      appRequestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      sessionsByElectronRequestId,
    };
    this.emit(entry, {
      appRequestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      status: "searching",
      current: 0,
      total: 0,
      errorMessage: null,
    });
    try {
      const electronRequestId = entry.view.webContents.findInPage(input.query, {
        forward: input.forward,
        findNext: input.findNext,
        matchCase: input.matchCase,
      });
      sessionsByElectronRequestId.set(electronRequestId, {
        appRequestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
      });
    } catch (err) {
      log.warn("[browser-view] findInPage failed", {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      this.emit(entry, {
        appRequestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        status: "error",
        current: 0,
        total: 0,
        errorMessage: "Browser search failed.",
      });
    }
  }

  stop(windowId: string, input: BrowserViewFindStop): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    entry.findState = {
      appRequestId: input.requestId,
      query: "",
      matchCase: entry.findState.matchCase,
      sessionsByElectronRequestId: new Map(),
    };
    entry.view.webContents.stopFindInPage("clearSelection");
    this.emit(entry, {
      appRequestId: input.requestId,
      query: "",
      matchCase: entry.findState.matchCase,
      status: "idle",
      current: 0,
      total: 0,
      errorMessage: null,
    });
  }

  handleFoundInPage(entry: BrowserViewEntry, result: Result): void {
    const session = entry.findState.sessionsByElectronRequestId.get(
      result.requestId,
    );
    if (session === undefined) return;
    this.emit(entry, {
      appRequestId: session.appRequestId,
      query: session.query,
      matchCase: session.matchCase,
      status: "ready",
      current: result.matches > 0 ? result.activeMatchOrdinal : 0,
      total: result.matches,
      errorMessage: null,
    });
  }

  private emit(
    entry: BrowserViewEntry,
    result: {
      readonly appRequestId: number;
      readonly query: string;
      readonly matchCase: boolean;
      readonly status: BrowserViewFindChange["status"];
      readonly current: number;
      readonly total: number;
      readonly errorMessage: string | null;
    },
  ): void {
    if (entry.surface === null) return;
    this.send(entry.surface.windowId, RunnerHostEvent.browserViewFindChange, {
      ...toTileKey(entry.surface),
      requestId: result.appRequestId,
      query: result.query,
      matchCase: result.matchCase,
      status: result.status,
      current: result.current,
      total: result.total,
      errorMessage: result.errorMessage,
    });
  }
}
