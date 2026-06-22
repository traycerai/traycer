import { describe, expect, it } from "vitest";
import {
  createStreamFlushCoordinator,
  FRAME_TIMEOUT_FALLBACK_MS,
  HIDDEN_FLUSH_INTERVAL_MS,
  type StreamFlushCoordinator,
  type StreamFlushTimers,
} from "@/stores/chats/stream-flush-coordinator";

interface FakeTimers {
  readonly timers: StreamFlushTimers;
  readonly advance: (ms: number) => void;
  readonly fireFrame: () => void;
  readonly frameCount: () => number;
  readonly timerCount: () => number;
}

function createFakeTimers(): FakeTimers {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timeouts = new Map<number, { runAt: number; run: () => void }>();
  return {
    timers: {
      now: () => now,
      requestFrame: (run) => {
        const handle = nextHandle;
        nextHandle += 1;
        frames.set(handle, run);
        return handle;
      },
      cancelFrame: (handle) => {
        frames.delete(handle);
      },
      setTimer: (run, delayMs) => {
        const handle = nextHandle;
        nextHandle += 1;
        timeouts.set(handle, { runAt: now + delayMs, run });
        return handle;
      },
      clearTimer: (handle) => {
        timeouts.delete(handle);
      },
    },
    advance: (ms) => {
      now += ms;
      const due = Array.from(timeouts.entries())
        .filter(([, timeout]) => timeout.runAt <= now)
        .sort(([, a], [, b]) => a.runAt - b.runAt);
      for (const [handle, timeout] of due) {
        timeouts.delete(handle);
        timeout.run();
      }
    },
    fireFrame: () => {
      const runs = Array.from(frames.values());
      frames.clear();
      runs.forEach((run) => run());
    },
    frameCount: () => frames.size,
    timerCount: () => timeouts.size,
  };
}

interface FakeStore {
  readonly bufferDelta: () => void;
  readonly flushCount: () => number;
  readonly setVisible: (visible: boolean) => void;
  readonly unregister: () => void;
}

function registerFakeStore(coordinator: StreamFlushCoordinator): FakeStore {
  let pending = 0;
  let flushes = 0;
  const lease = coordinator.register({
    flush: () => {
      flushes += 1;
      pending = 0;
    },
    hasPending: () => pending > 0,
  });
  return {
    bufferDelta: () => {
      pending += 1;
      lease.requestFlush();
    },
    flushCount: () => flushes,
    setVisible: lease.setVisible,
    unregister: lease.unregister,
  };
}

describe("stream flush coordinator", () => {
  it("arms one frame and one fallback timeout regardless of store count", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const stores = [
      registerFakeStore(coordinator),
      registerFakeStore(coordinator),
      registerFakeStore(coordinator),
    ];

    stores.forEach((store) => store.bufferDelta());
    stores.forEach((store) => store.bufferDelta());

    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    fake.fireFrame();

    expect(stores.map((store) => store.flushCount())).toEqual([1, 1, 1]);
    // Nothing pending: the tick disarmed both timers instead of re-arming.
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);
  });

  it("drains buffers via the timeout fallback when rAF is starved", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    expect(store.flushCount()).toBe(0);

    // The window is hidden/minimized: the frame never fires. The fallback
    // timeout drains the buffer and cancels the stale frame.
    fake.advance(FRAME_TIMEOUT_FALLBACK_MS);

    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);
  });

  it("slow-ticks a hidden store at the hidden flush interval", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);
    store.setVisible(false);

    store.bufferDelta();
    // Hidden-only pending work arms a timer, never a frame.
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(1);

    fake.advance(HIDDEN_FLUSH_INTERVAL_MS - 1);
    expect(store.flushCount()).toBe(0);
    fake.advance(1);
    expect(store.flushCount()).toBe(1);

    // The next buffered tail waits out a full interval since the last flush.
    store.bufferDelta();
    fake.advance(HIDDEN_FLUSH_INTERVAL_MS - 1);
    expect(store.flushCount()).toBe(1);
    fake.advance(1);
    expect(store.flushCount()).toBe(2);
  });

  it("flushes visible stores every tick while hidden stores wait until due", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const visibleStore = registerFakeStore(coordinator);
    const hiddenStore = registerFakeStore(coordinator);
    hiddenStore.setVisible(false);

    visibleStore.bufferDelta();
    hiddenStore.bufferDelta();

    fake.fireFrame();
    expect(visibleStore.flushCount()).toBe(1);
    expect(hiddenStore.flushCount()).toBe(0);

    // The hidden tail re-armed a slow timer during the tick.
    expect(fake.timerCount()).toBe(1);
    fake.advance(HIDDEN_FLUSH_INTERVAL_MS);
    expect(hiddenStore.flushCount()).toBe(1);
  });

  it("paints a newly visible store on the next frame instead of the slow tier", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);
    store.setVisible(false);

    store.bufferDelta();
    expect(fake.frameCount()).toBe(0);

    store.setVisible(true);
    expect(fake.frameCount()).toBe(1);
    fake.fireFrame();
    expect(store.flushCount()).toBe(1);
  });

  it("stops flushing an unregistered store and disarms when idle", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    store.unregister();

    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);
    fake.advance(FRAME_TIMEOUT_FALLBACK_MS * 2);
    expect(store.flushCount()).toBe(0);
  });

  it("does not arm timers for stores with nothing pending", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    registerFakeStore(coordinator);

    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);
  });
});
