import { randomUUID } from "node:crypto";
import type { BrowserViewGuestDrawHoldApplied } from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type { BrowserViewEntry, BrowserViewSend } from "./browser-view-entry";

/**
 * How long a read waits for the renderer to draw a held guest. The renderer
 * answers within two of the window's frames; a window that draws no frame
 * (asleep display, a renderer mid-reload) never answers, and the read then
 * goes ahead and fares as it would have without the hold.
 */
const DRAW_HOLD_READY_DEADLINE_MS = 1_000;

/** One reader's claim that the guest stays drawn until it releases. */
export interface BrowserViewDrawHold {
  /** Settles once the guest is drawn, or the deadline passed. Never rejects. */
  readonly ready: Promise<void>;
  /** Idempotent. The last release lets an unshown guest stop drawing. */
  release(): void;
}

interface EntryHold {
  readonly holdId: string;
  readonly windowId: string;
  readonly registrationId: string;
  count: number;
  readonly ready: Promise<void>;
  readonly settle: () => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * The renderer parks an unshown guest where the compositor does not draw it,
 * so a parked page with a spinner or an animation loop costs no CPU. Every
 * main-side read of a guest's pixels needs a drawn frame, so each one holds
 * the guest drawn for the read. Holds are counted per guest: overlapping
 * reads share one renderer request, and the last release ends it.
 */
export class BrowserViewDrawHolds {
  private readonly holds = new Map<BrowserViewEntry, EntryHold>();

  constructor(private readonly send: BrowserViewSend) {}

  hold(entry: BrowserViewEntry): BrowserViewDrawHold {
    const current = this.holds.get(entry) ?? this.open(entry);
    current.count += 1;
    let released = false;
    return {
      ready: current.ready,
      release: () => {
        if (released) return;
        released = true;
        this.releaseOne(entry, current);
      },
    };
  }

  /** Runs one read with the guest held drawn, released however it ends. */
  async withHold<T>(
    entry: BrowserViewEntry,
    read: () => Promise<T>,
  ): Promise<T> {
    const hold = this.hold(entry);
    try {
      await hold.ready;
      return await read();
    } finally {
      hold.release();
    }
  }

  reportApplied(
    windowId: string,
    result: BrowserViewGuestDrawHoldApplied,
  ): void {
    for (const current of this.holds.values()) {
      if (
        current.holdId === result.holdId &&
        current.windowId === windowId &&
        current.registrationId === result.registrationId
      ) {
        current.settle();
        return;
      }
    }
  }

  /** The guest is gone: waiters go ahead, and no release is sent for it. */
  forget(entry: BrowserViewEntry): void {
    const current = this.holds.get(entry);
    if (current === undefined) return;
    this.holds.delete(entry);
    current.settle();
  }

  private open(entry: BrowserViewEntry): EntryHold {
    const holdId = randomUUID();
    const { lifecycleWindowId: windowId, registrationId } = entry.identity;
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const timer = setTimeout(() => settle(), DRAW_HOLD_READY_DEADLINE_MS);
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const current: EntryHold = {
      holdId,
      windowId,
      registrationId,
      count: 0,
      ready: promise,
      settle,
      timer,
    };
    this.holds.set(entry, current);
    const sent = this.send(
      windowId,
      RunnerHostEvent.browserViewGuestDrawHoldRequested,
      { holdId, registrationId },
    );
    if (!sent) settle();
    return current;
  }

  private releaseOne(entry: BrowserViewEntry, current: EntryHold): void {
    current.count -= 1;
    if (current.count > 0 || this.holds.get(entry) !== current) return;
    this.holds.delete(entry);
    current.settle();
    this.send(
      current.windowId,
      RunnerHostEvent.browserViewGuestDrawHoldReleased,
      { holdId: current.holdId, registrationId: current.registrationId },
    );
  }
}
