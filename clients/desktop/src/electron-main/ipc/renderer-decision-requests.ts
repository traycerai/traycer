import { randomUUID } from "node:crypto";

/**
 * One renderer-answered decision main is waiting on. The `requestId` lets a
 * late acknowledgement or answer from a previous attempt be told apart from
 * the current one.
 */
export interface RendererDecisionWaiter<TDecision> {
  readonly requestId: string;
  readonly windowId: string;
  readonly resolve: (decision: TDecision) => void;
  readonly reject: (error: Error) => void;
  readonly serviceTimer: NodeJS.Timeout;
}

/**
 * The rejection texts of one kind of decision. Kept per kind so each failure
 * still names the prompt it belongs to in the log (the unsynced-edits prompt's
 * texts are pinned by its existing tests).
 */
export interface RendererDecisionMessages {
  readonly noWindow: string;
  readonly notReady: string;
  readonly superseded: string;
  readonly notAcknowledged: string;
  readonly cannotReceive: string;
  readonly rendererReset: string;
  readonly windowClosed: string;
  readonly disposed: string;
}

export interface RendererDecisionTarget {
  readonly windowId: string;
}

/**
 * The machinery behind every quit-time question main asks a renderer: the
 * unsynced-edits intercept (`requestQuitDecision`) and the host quit modal
 * (`requestHostQuitDecision`). One implementation, so the two cannot drift:
 *
 * - MRU targeting: the caller passes the target; it must be in
 *   `readyWindowIds` (a window that advertised it can answer), or the request
 *   fails closed at once.
 * - One request per window: a newer request rejects the window's older one.
 * - A servicing ack within `serviceAckTimeoutMs`, or the request fails - a
 *   renderer that received the request but is frozen, or has no handler,
 *   never answers.
 * - Rejection when the window's renderer resets, the window closes, or the
 *   bridge is disposed, so no caller waits on a renderer that is gone.
 *
 * A rejection always means "this renderer could not answer"; a renderer that
 * answered - including with a refusal - resolves.
 */
export class RendererDecisionRequests<TDecision> {
  readonly waiters: RendererDecisionWaiter<TDecision>[] = [];
  private readonly readyWindowIds: ReadonlySet<string>;
  private readonly serviceAckTimeoutMs: number;
  private readonly messages: RendererDecisionMessages;
  private readonly onAbandoned:
    | ((waiter: RendererDecisionWaiter<TDecision>) => void)
    | null;

  constructor(options: {
    readonly readyWindowIds: ReadonlySet<string>;
    readonly serviceAckTimeoutMs: number;
    readonly messages: RendererDecisionMessages;
    /**
     * Called for every request main gives up on (ack timeout, superseded,
     * window reset or closed, disposed, withdrawn) before its caller hears,
     * so a renderer that did receive it can close what it showed. `null` when
     * the prompt needs no such notice.
     */
    readonly onAbandoned:
      | ((waiter: RendererDecisionWaiter<TDecision>) => void)
      | null;
  }) {
    this.readyWindowIds = options.readyWindowIds;
    this.serviceAckTimeoutMs = options.serviceAckTimeoutMs;
    this.messages = options.messages;
    this.onAbandoned = options.onAbandoned;
  }

  /**
   * Ask `target` for a decision. `send` delivers the request carrying the
   * minted `requestId` and reports whether it could be sent.
   */
  request(
    target: RendererDecisionTarget | null,
    send: (windowId: string, requestId: string) => boolean,
  ): Promise<TDecision> {
    if (target === null) {
      return Promise.reject(new Error(this.messages.noWindow));
    }
    if (!this.readyWindowIds.has(target.windowId)) {
      return Promise.reject(new Error(this.messages.notReady));
    }
    this.rejectWhere(
      (waiter) => waiter.windowId === target.windowId,
      new Error(this.messages.superseded),
    );
    const requestId = randomUUID();
    return new Promise<TDecision>((resolve, reject) => {
      const serviceTimer = setTimeout(() => {
        const waiter = this.remove(requestId);
        if (waiter === null) {
          return;
        }
        this.onAbandoned?.(waiter);
        waiter.reject(new Error(this.messages.notAcknowledged));
      }, this.serviceAckTimeoutMs);
      this.waiters.push({
        requestId,
        windowId: target.windowId,
        resolve,
        reject,
        serviceTimer,
      });
      if (send(target.windowId, requestId)) {
        return;
      }
      const waiter = this.remove(requestId);
      if (waiter !== null) {
        waiter.reject(new Error(this.messages.cannotReceive));
      }
    });
  }

  /**
   * The window started servicing `requestId`: the ack timer stops, and the
   * decision may now take as long as the person needs. `false` when no
   * pending request of that window has that id.
   */
  acknowledge(windowId: string, requestId: string): boolean {
    const waiter = this.waiters.find(
      (entry) => entry.windowId === windowId && entry.requestId === requestId,
    );
    if (waiter === undefined) {
      return false;
    }
    clearTimeout(waiter.serviceTimer);
    return true;
  }

  /**
   * Remove and return the waiter an answer from `windowId` settles: the one
   * with `requestId`, or - for a legacy answer that carries no id - that
   * window's first. `null` for an unknown or stale answer, which the caller
   * ignores.
   */
  take(
    windowId: string,
    requestId: string | null,
    legacy: boolean,
  ): RendererDecisionWaiter<TDecision> | null {
    const waiterIndex = legacy
      ? this.waiters.findIndex((entry) => entry.windowId === windowId)
      : this.waiters.findIndex(
          (entry) =>
            entry.windowId === windowId && entry.requestId === requestId,
        );
    if (waiterIndex === -1) {
      return null;
    }
    const waiter = this.waiters.splice(waiterIndex, 1)[0];
    clearTimeout(waiter.serviceTimer);
    return waiter;
  }

  remove(requestId: string): RendererDecisionWaiter<TDecision> | null {
    const waiterIndex = this.waiters.findIndex(
      (entry) => entry.requestId === requestId,
    );
    if (waiterIndex === -1) {
      return null;
    }
    const waiter = this.waiters.splice(waiterIndex, 1)[0];
    clearTimeout(waiter.serviceTimer);
    return waiter;
  }

  /** Reject `windowId`'s pending request with `error`. */
  rejectWindow(windowId: string, error: Error): void {
    this.rejectWhere((waiter) => waiter.windowId === windowId, error);
  }

  rejectRendererReset(windowId: string): void {
    this.rejectWhere(
      (waiter) => waiter.windowId === windowId,
      new Error(this.messages.rendererReset),
    );
  }

  rejectClosedWindows(liveWindowIds: ReadonlySet<string>): void {
    this.rejectWhere(
      (waiter) => !liveWindowIds.has(waiter.windowId),
      new Error(this.messages.windowClosed),
    );
  }

  rejectAll(): void {
    this.rejectWhere(() => true, new Error(this.messages.disposed));
  }

  /** Reject every pending request with `error`; for a caller withdrawing its question. */
  rejectAllWith(error: Error): void {
    this.rejectWhere(() => true, error);
  }

  private rejectWhere(
    predicate: (waiter: RendererDecisionWaiter<TDecision>) => boolean,
    error: Error,
  ): void {
    const retained: RendererDecisionWaiter<TDecision>[] = [];
    for (const waiter of this.waiters) {
      if (!predicate(waiter)) {
        retained.push(waiter);
        continue;
      }
      clearTimeout(waiter.serviceTimer);
      this.onAbandoned?.(waiter);
      waiter.reject(error);
    }
    this.waiters.length = 0;
    this.waiters.push(...retained);
  }
}
