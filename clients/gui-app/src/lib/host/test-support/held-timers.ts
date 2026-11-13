import { vi } from "vitest";
import {
  defaultScheduler,
  notifyManager,
  timeoutManager,
  type TimeoutProvider,
} from "@tanstack/react-query";

/** A timer TanStack set, held until the test fires it. */
export interface HeldTimer {
  readonly id: number;
  readonly delay: number;
  readonly callback: () => void;
  /** `timeout` or `interval`. */
  readonly kind: "timeout" | "interval";
  /** Where it was set, to tell which TanStack module set it. */
  readonly stack: string;
  cleared: boolean;
  fired: boolean;
}

/**
 * Switches TanStack's timer provider. TanStack logs a console error when the
 * previous provider was used; that notice is the intended switch here, so it
 * alone is swallowed while the switch runs, and every other console error
 * passes through.
 */
function switchProvider(provider: TimeoutProvider): void {
  const report = console.error.bind(console);
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      const [first] = args;
      if (
        typeof first === "string" &&
        first.startsWith("[timeoutManager]: Switching provider")
      ) {
        return;
      }
      report(...args);
    });
  try {
    timeoutManager.setTimeoutProvider(provider);
  } finally {
    spy.mockRestore();
  }
}

/**
 * Holds every timer TanStack sets (gc, observer staleness, retry backoff) and
 * fails on anything it hands to `notifyManager`'s scheduler, so a test fires
 * a timer only by naming it. `restore` puts back an equivalent of the default
 * provider and the default scheduler: files share a worker.
 */
export class HeldTimers {
  readonly timers: HeldTimer[] = [];
  readonly scheduled: string[] = [];
  private nextId = 1;

  install(): void {
    switchProvider({
      setTimeout: (callback, delay) => this.hold("timeout", callback, delay),
      clearTimeout: (id) => this.clear(id),
      setInterval: (callback, delay) => this.hold("interval", callback, delay),
      clearInterval: (id) => this.clear(id),
    });
    notifyManager.setScheduler(() => {
      this.scheduled.push("notifyManager");
    });
  }

  restore(): void {
    switchProvider({
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      // TanStack types a timer id as a number or an object that converts to
      // one (Node's `Timeout`); Node clears a timer by its primitive id.
      clearTimeout: (id) => {
        clearTimeout(id === undefined ? undefined : Number(id));
      },
      setInterval: (callback, delay) => setInterval(callback, delay),
      clearInterval: (id) => {
        clearInterval(id === undefined ? undefined : Number(id));
      },
    });
    notifyManager.setScheduler(defaultScheduler);
  }

  /** Forgets every timer and scheduled callback, for the next run. */
  reset(): void {
    this.timers.length = 0;
    this.scheduled.length = 0;
  }

  /** Timers set and neither cleared nor fired. */
  pending(): HeldTimer[] {
    return this.timers.filter((timer) => !timer.cleared && !timer.fired);
  }

  /** Fires `timer` once, as a named event. */
  fire(timer: HeldTimer): void {
    if (timer.cleared || timer.fired) {
      throw new Error(`timer ${timer.id} is not pending`);
    }
    if (timer.kind === "timeout") timer.fired = true;
    timer.callback();
  }

  private hold(
    kind: HeldTimer["kind"],
    callback: () => void,
    delay: number,
  ): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({
      id,
      delay,
      callback,
      kind,
      stack: new Error().stack ?? "",
      cleared: false,
      fired: false,
    });
    return id;
  }

  private clear(id: unknown): void {
    const timer = this.timers.find((candidate) => candidate.id === id);
    if (timer !== undefined) timer.cleared = true;
  }
}
