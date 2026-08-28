import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationEndReason,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartInput,
  BrowserAnnotationStartResult,
} from "../../../ipc-contracts/browser-annotation-types";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { BrowserAnnotationSession } from "../annotation/browser-annotation-session";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import {
  requireSurface,
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import type { BrowserViewEntryRegistry } from "./browser-view-entry-registry";

const ANNOTATION_ATTACH_ACK_TIMEOUT_MS = 4000;

interface PendingAnnotationAttachResult {
  readonly windowId: string;
  readonly registrationId: string;
  readonly resolve: (delivered: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

interface BrowserViewAnnotationHostOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly send: BrowserViewSend;
  readonly debugSessions: BrowserViewDebugSessions;
}

/**
 * Owns the manager side of an annotation session: which entry has one, the
 * renderer round trip that acknowledges an attach, and the single teardown
 * every other subsystem calls when the page underneath changes.
 */
export class BrowserViewAnnotationHost {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly send: BrowserViewSend;
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly pendingAttachResults = new Map<
    string,
    PendingAnnotationAttachResult
  >();

  constructor(options: BrowserViewAnnotationHostOptions) {
    this.entries = options.entries;
    this.send = options.send;
    this.debugSessions = options.debugSessions;
  }

  setTargetChatLabel(
    windowId: string,
    input: BrowserAnnotationSetTargetChatLabelInput,
  ): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    const session = entry.annotationSession;
    if (session === null || !session.isActive()) return;
    void session.setTargetChatLabel(input.targets, input.defaultChatId);
  }

  start(
    windowId: string,
    input: BrowserAnnotationStartInput,
  ): Promise<BrowserAnnotationStartResult> {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) {
      return Promise.resolve({ ok: false, reason: "tile-not-found" });
    }
    if (entry.status !== "ready") {
      return Promise.resolve({ ok: false, reason: "page-not-ready" });
    }
    this.end(entry, "replaced");
    const surface = requireSurface(entry);
    const session = new BrowserAnnotationSession({
      webContents: entry.view.webContents,
      debugSession: this.debugSessions.ensure(entry),
      theme: input.theme,
      identity: {
        tabId: entry.identity.key.tabId,
        sessionId: entry.identity.key.sessionId,
      },
      onEvent: (event) => {
        if (entry.annotationSession !== session) return;
        if (event.type === "attachRequested") return;
        this.send(
          surface.windowId,
          RunnerHostEvent.browserViewAnnotationEvent,
          { ...toTileKey(surface), event },
        );
      },
      onAttached: (result) => {
        if (entry.annotationSession !== session) {
          return Promise.resolve(false);
        }
        this.send(
          surface.windowId,
          RunnerHostEvent.browserViewAnnotationAttached,
          {
            ...toTileKey(surface),
            targetChatId: result.targetChatId,
            payload: result.payload,
            pngBytes: new Uint8Array(result.pngBytes),
          },
        );
        return this.waitForAttachResult({
          windowId: surface.windowId,
          registrationId: entry.identity.registrationId,
          annotationId: result.payload.annotationId,
        });
      },
    });
    entry.annotationSession = session;
    return session.start().then((result) => {
      if (!result.ok && entry.annotationSession === session) {
        entry.annotationSession = null;
      }
      return result;
    });
  }

  cancel(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    this.end(entry, "cancelled");
  }

  reportAttachResult(
    windowId: string,
    input: BrowserAnnotationAttachResultInput,
  ): void {
    const pending = this.pendingAttachResults.get(input.annotationId);
    if (pending === undefined) return;
    if (pending.windowId !== windowId) return;
    this.finishAttachResult(input.annotationId, input.status === "attached");
  }

  end(entry: BrowserViewEntry, reason: BrowserAnnotationEndReason): void {
    const session = entry.annotationSession;
    if (session === null) return;
    this.failPendingForEntry(entry);
    session.dispose(reason);
    if (entry.annotationSession === session) {
      entry.annotationSession = null;
    }
  }

  failPendingForEntry(entry: BrowserViewEntry): void {
    const annotationIds: string[] = [];
    for (const [annotationId, pending] of this.pendingAttachResults) {
      if (pending.registrationId === entry.identity.registrationId) {
        annotationIds.push(annotationId);
      }
    }
    for (const annotationId of annotationIds) {
      this.finishAttachResult(annotationId, false);
    }
  }

  dispose(): void {
    for (const annotationId of Array.from(this.pendingAttachResults.keys())) {
      this.finishAttachResult(annotationId, false);
    }
  }

  private waitForAttachResult(input: {
    readonly windowId: string;
    readonly registrationId: string;
    readonly annotationId: string;
  }): Promise<boolean> {
    this.finishAttachResult(input.annotationId, false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishAttachResult(input.annotationId, false);
      }, ANNOTATION_ATTACH_ACK_TIMEOUT_MS);
      this.pendingAttachResults.set(input.annotationId, {
        windowId: input.windowId,
        registrationId: input.registrationId,
        resolve,
        timer,
      });
    });
  }

  private finishAttachResult(annotationId: string, delivered: boolean): void {
    const pending = this.pendingAttachResults.get(annotationId);
    if (pending === undefined) return;
    this.pendingAttachResults.delete(annotationId);
    clearTimeout(pending.timer);
    pending.resolve(delivered);
  }
}
