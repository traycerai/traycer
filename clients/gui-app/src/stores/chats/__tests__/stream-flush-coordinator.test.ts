import { describe, expect, it } from "vitest";
import {
  createStreamFlushCoordinator,
  FRAME_TIMEOUT_FALLBACK_MS,
  HIDDEN_FLUSH_INTERVAL_MS,
  VISIBLE_FLUSH_MIN_INTERVAL_MS,
  type StreamFlushCoordinator,
  type StreamFlushLease,
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

  it("arms a timer at the visible floor when a delta arrives before it elapses, not a frame", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    fake.fireFrame();
    expect(store.flushCount()).toBe(1); // lastFlushAt = 0

    const deltaAt = 10;
    fake.advance(deltaAt);
    store.bufferDelta();
    // Still inside the 32ms floor since the last flush: a timer, not a frame.
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(1);

    fake.advance(VISIBLE_FLUSH_MIN_INTERVAL_MS - deltaAt - 1);
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(0);

    fake.advance(1);
    // The deadline elapsed, but a visible store is never flushed by the
    // timer itself - it hands off to a frame (see `tick`'s
    // `source === "deadline" && entry.visible` skip).
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    fake.fireFrame();
    expect(store.flushCount()).toBe(2);
  });

  it("arms a frame once the visible floor has elapsed since the last flush", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    fake.fireFrame();
    expect(store.flushCount()).toBe(1); // lastFlushAt = 0

    fake.advance(VISIBLE_FLUSH_MIN_INTERVAL_MS + 8);
    store.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    // A frame arm also arms the fallback timeout - the same pairing as the
    // very first flush.
    expect(fake.timerCount()).toBe(1);
  });

  it("arms a timer, not a frame, when setVisible(true) fires inside the visible floor", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    fake.fireFrame();
    expect(store.flushCount()).toBe(1); // lastFlushAt = 0

    store.setVisible(false);
    fake.advance(10); // still inside the 32ms floor since the last visible flush
    store.bufferDelta(); // buffered while hidden

    store.setVisible(true);
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(1);

    fake.advance(VISIBLE_FLUSH_MIN_INTERVAL_MS - 10 - 1);
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(0);

    fake.advance(1);
    // The deadline elapsed, but hands off to a frame instead of flushing
    // the now-visible store directly.
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    fake.fireFrame();
    expect(store.flushCount()).toBe(2);
  });

  it("keeps a starved rAF's visible store at the fallback cadence, never flushing directly on a bare timer inside the floor (Codex P1 regression: a minimized visible chat must stay near 2Hz, not 30Hz)", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const store = registerFakeStore(coordinator);

    store.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // rAF never fires: the fallback drains the first flush.
    fake.advance(FRAME_TIMEOUT_FALLBACK_MS);
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);

    // A delta inside the floor arms a deadline timer, not a frame.
    fake.advance(10);
    store.bufferDelta();
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(1);

    // The floor elapses: the deadline hands off to a frame instead of
    // flushing directly - a starved rAF must not turn this into a bare
    // 32ms-cadence timer flush.
    fake.advance(VISIBLE_FLUSH_MIN_INTERVAL_MS - 10);
    expect(store.flushCount()).toBe(1);
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // rAF is still starved: the fallback armed alongside that frame is what
    // finally drains it, 500ms after the handoff.
    fake.advance(FRAME_TIMEOUT_FALLBACK_MS);
    // Exactly two flushes over the whole span - never a direct timer flush
    // inside the floor.
    expect(store.flushCount()).toBe(2);
  });

  it("arms a hidden store's first-flush deadline from its registration time, not from when the first delta arrives", () => {
    // Scenario 1: registered at t=0. A delta arriving well after registration
    // must still be due at registeredAt + interval, not at (delta time) +
    // interval and not immediately.
    const fakeA = createFakeTimers();
    const coordinatorA = createStreamFlushCoordinator(fakeA.timers);
    const storeA = registerFakeStore(coordinatorA);
    storeA.setVisible(false);

    fakeA.advance(100);
    storeA.bufferDelta();
    expect(fakeA.frameCount()).toBe(0);
    expect(fakeA.timerCount()).toBe(1);

    fakeA.advance(HIDDEN_FLUSH_INTERVAL_MS - 100 - 1);
    expect(storeA.flushCount()).toBe(0);
    fakeA.advance(1);
    // Due at registeredAt (0) + HIDDEN_FLUSH_INTERVAL_MS = 500 - not at the
    // delta's own arrival (100) and not at delta + interval (600).
    expect(storeA.flushCount()).toBe(1);

    // Scenario 2: registration itself happens after time has already passed
    // on the clock. Using `0` instead of `registeredAt` would put the
    // deadline in the past the instant the delta arrives, flushing far too
    // early; the fix is due = registeredAt (1000) + interval.
    const fakeB = createFakeTimers();
    fakeB.advance(1000);
    const coordinatorB = createStreamFlushCoordinator(fakeB.timers);
    const storeB = registerFakeStore(coordinatorB);
    storeB.setVisible(false);

    fakeB.advance(100);
    storeB.bufferDelta();
    expect(fakeB.timerCount()).toBe(1);

    fakeB.advance(HIDDEN_FLUSH_INTERVAL_MS - 100 - 1);
    expect(storeB.flushCount()).toBe(0);
    fakeB.advance(1);
    // Due at registeredAt (1000) + HIDDEN_FLUSH_INTERVAL_MS = 1500, not at
    // the delta's own arrival (1100).
    expect(storeB.flushCount()).toBe(1);
  });

  it("arms a hidden store's own deadline beside an already-armed frame for a different store, replacing a later timer with the earlier one", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);

    // B flushes once via a frame at t=0, then goes hidden.
    const storeB = registerFakeStore(coordinator);
    storeB.bufferDelta();
    fake.fireFrame();
    expect(storeB.flushCount()).toBe(1); // B.lastFlushAt = 0
    storeB.setVisible(false);

    // A (visible) buffers at t=300: arms a frame plus a fallback due at
    // 300 + FRAME_TIMEOUT_FALLBACK_MS = 800.
    const storeA = registerFakeStore(coordinator);
    fake.advance(300);
    storeA.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // B (hidden) buffers at t=310. B's own deadline - its last flush (0)
    // plus HIDDEN_FLUSH_INTERVAL_MS = 500 - is earlier than A's armed
    // fallback (800), so the single shared timer must be replaced with B's
    // earlier deadline rather than staying parked on A's later one.
    fake.advance(10);
    storeB.bufferDelta();
    expect(fake.frameCount()).toBe(1); // A's frame is untouched
    expect(fake.timerCount()).toBe(1); // replaced: now due at 500, not 800

    // Advancing to B's deadline (500) without ever firing a frame still
    // flushes B - proving the shared timer really moved to 500 instead of
    // staying parked at A's later fallback.
    fake.advance(500 - 310);
    expect(storeB.flushCount()).toBe(2);
    // A is visible: the deadline tick must not flush it directly, only
    // hand it back off to a (re-armed) frame.
    expect(storeA.flushCount()).toBe(0);
    expect(fake.frameCount()).toBe(1);
  });

  it("keeps a starved visible store's fallback due time across staggered hidden-store deadlines (Codex P1 regression, second round)", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);

    /**
     * A store that immediately re-buffers a fresh delta the instant its own
     * flush lands, so it keeps re-arming its hidden deadline forever - a
     * continuously streaming hidden chat, unlike `registerFakeStore`'s
     * one-shot buffers.
     */
    function registerContinuouslyStreamingStore(): {
      readonly bufferDelta: () => void;
      readonly flushCount: () => number;
      readonly setVisible: (visible: boolean) => void;
    } {
      let pending = 0;
      let flushes = 0;
      let leaseRef: StreamFlushLease | null = null;
      const lease = coordinator.register({
        flush: () => {
          flushes += 1;
          pending = 0;
          pending += 1;
          leaseRef?.requestFlush();
        },
        hasPending: () => pending > 0,
      });
      leaseRef = lease;
      return {
        bufferDelta: () => {
          pending += 1;
          lease.requestFlush();
        },
        flushCount: () => flushes,
        setVisible: lease.setVisible,
      };
    }

    // t=0: H1 flushes once via a frame, then goes hidden and immediately
    // re-buffers - its next hidden deadline is due at 0 + 500 = 500.
    const h1 = registerContinuouslyStreamingStore();
    h1.bufferDelta();
    fake.fireFrame();
    expect(h1.flushCount()).toBe(1);
    h1.setVisible(false);
    h1.bufferDelta();

    // t=250: H2 flushes once via a frame, then goes hidden and immediately
    // re-buffers - its next hidden deadline is due at 250 + 500 = 750,
    // staggered 250ms away from H1's.
    fake.advance(250);
    const h2 = registerContinuouslyStreamingStore();
    h2.bufferDelta();
    fake.fireFrame();
    expect(h2.flushCount()).toBe(1);
    h2.setVisible(false);
    h2.bufferDelta();

    // t=300: V (visible) buffers - arms a frame plus a fallback due at
    // 300 + FRAME_TIMEOUT_FALLBACK_MS = 800. From here on, rAF never fires
    // again: H1's and H2's hidden deadlines (500, 750, ...) each cancel and
    // re-arm V's frame before V's own fallback is due, and must NOT push
    // that fallback out by another 500ms every time they do.
    fake.advance(50);
    const v = registerFakeStore(coordinator);
    v.bufferDelta();

    // H1's deadline (500) hands off to a frame; V has not flushed yet.
    fake.advance(500 - 300);
    expect(v.flushCount()).toBe(0);
    expect(h1.flushCount()).toBe(2);

    // H2's deadline (750) hands off to a frame too; V still has not
    // flushed - if the fallback were reset on every hand-off it would now
    // be due at 750 + 500 = 1250, not the original 800.
    fake.advance(750 - 500);
    expect(v.flushCount()).toBe(0);
    expect(h2.flushCount()).toBe(2);

    // V flushes exactly once, at its ORIGINAL fallback due time (800) - not
    // pushed later by either hand-off.
    fake.advance(799 - 750);
    expect(v.flushCount()).toBe(0);
    fake.advance(1);
    expect(v.flushCount()).toBe(1);

    // A further V delta at t=810, inside its 32ms floor since the 800
    // flush, hands off through the same deadline -> frame -> fallback
    // sequence: due at 800 + 32 = 832, then a fresh fallback at
    // 832 + 500 = 1332. H1's (1000) and H2's (1250) hidden deadlines land
    // in between and must not disturb it either.
    fake.advance(10);
    v.bufferDelta();

    fake.advance(832 - 810);
    expect(v.flushCount()).toBe(1);

    fake.advance(1000 - 832);
    expect(v.flushCount()).toBe(1);
    expect(h1.flushCount()).toBe(3);

    fake.advance(1250 - 1000);
    expect(v.flushCount()).toBe(1);
    expect(h2.flushCount()).toBe(3);

    fake.advance(1331 - 1250);
    expect(v.flushCount()).toBe(1);
    fake.advance(1);
    expect(v.flushCount()).toBe(2);
  });

  it("flushes a store that turns visible under a starved rAF at its fallback, not at the stale hidden deadline", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const h = registerFakeStore(coordinator);

    // H flushes once via a frame at t=0, then goes hidden.
    h.bufferDelta();
    fake.fireFrame();
    expect(h.flushCount()).toBe(1);
    h.setVisible(false);

    // A delta at t=50, still hidden: due at lastFlushAt(0) + 500 = 500.
    fake.advance(50);
    h.bufferDelta();
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(1);

    // At t=100, H turns visible while still pending: a frame plus a fallback
    // due at 100 + 500 = 600 are armed. The earlier hidden deadline (500) is
    // still the earliest known timer, so it stays the physically scheduled
    // one (armTimer keeps an earlier timer over a later one) - that stale
    // deadline is exactly what must not flush H early. Never fire a frame
    // from here on (rAF starved).
    fake.advance(50);
    h.setVisible(true);

    // t=500: the stale hidden-tier deadline fires. H is visible now, so the
    // "deadline" tick must skip it (not flush directly) and hand off to a
    // frame instead - with the ORIGINAL fallback due time (600) preserved,
    // not pushed to 500 + 500 = 1000.
    fake.advance(500 - 100);
    expect(h.flushCount()).toBe(1);

    fake.advance(599 - 500);
    expect(h.flushCount()).toBe(1);

    // t=600: H flushes at its preserved fallback time - not at the stale
    // 500 deadline, and not pushed out to 1000.
    fake.advance(1);
    expect(h.flushCount()).toBe(2);
  });

  it("re-arms a hidden deadline when a pending visible store turns hidden, instead of riding the visible frame's fallback", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);
    const v = registerFakeStore(coordinator);

    // V's first-ever delta at t=1 arms a frame plus a fallback due at
    // 1 + 500 = 501 (dueAt is -Infinity for a store that has never flushed,
    // so this is due immediately regardless of the visible floor).
    fake.advance(1);
    v.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // At t=5, V turns hidden while still pending: its hidden deadline -
    // registeredAt(0) + HIDDEN_FLUSH_INTERVAL_MS(500) = 500 - is EARLIER
    // than the already-armed visible fallback (501), so it must replace
    // that timer instead of leaving V to ride the stale visible fallback
    // out to 501. Never fire a frame from here on.
    fake.advance(4);
    v.setVisible(false);

    // V flushes at its own hidden deadline (500), not at the stale visible
    // fallback (501).
    fake.advance(499 - 5);
    expect(v.flushCount()).toBe(0);
    fake.advance(1);
    expect(v.flushCount()).toBe(1);
  });

  it("a store registered after the last one unregistered gets a fresh fallback, not the stale one", () => {
    const fake = createFakeTimers();
    const coordinator = createStreamFlushCoordinator(fake.timers);

    // V registers and buffers at t=0: a frame plus a fallback due at
    // 0 + 500 = 500.
    const v = registerFakeStore(coordinator);
    v.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // At t=100, V unregisters - it was the only entry, so the coordinator
    // disarms entirely. Advancing all the way to t=2000 with no frames ever
    // fired must flush nothing: V is gone, and nothing else is registered.
    fake.advance(100);
    v.unregister();

    fake.advance(2000 - 100);
    expect(fake.frameCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);

    // W registers fresh at t=2000 and buffers: a frame plus a NEW fallback
    // due at 2000 + 500 = 2500 - not the stale 500 left over from V.
    const w = registerFakeStore(coordinator);
    w.bufferDelta();
    expect(fake.frameCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    // A stale fallback due at 500 would be clamped to "now" and fire
    // immediately (0ms delay) the moment W arms it; the fresh 2500 due time
    // must NOT flush W until then.
    fake.advance(499);
    expect(w.flushCount()).toBe(0);
    fake.advance(1);
    expect(w.flushCount()).toBe(1);
  });
});
