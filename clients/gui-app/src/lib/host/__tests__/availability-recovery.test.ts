import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityRecoveryKind } from "@traycer-clients/shared/host-transport/availability-recovery-kind";
import { wireAvailabilityRecovery } from "../availability-recovery";

function harness(nowValue: { value: number }) {
  let listener: ((kind: AvailabilityRecoveryKind) => void) | null = null;
  const dispose = vi.fn();
  const notify = vi.fn<(kind: AvailabilityRecoveryKind) => void>();
  const unsubscribe = wireAvailabilityRecovery({
    wsStreamClient: {
      subscribeAvailabilityRecovered: (l) => {
        listener = l;
        return dispose;
      },
    },
    target: { notifyRecoveredForNamedHost: notify },
    cooldownMs: 10_000,
    now: () => nowValue.value,
  });
  return {
    notify,
    dispose,
    unsubscribe,
    emit: (kind: AvailabilityRecoveryKind): void => {
      if (listener === null) {
        throw new Error("evidence listener was never subscribed");
      }
      listener(kind);
    },
  };
}

describe("wireAvailabilityRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies on the leading edge and coalesces a burst inside the cooldown", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    // A burst: every open session observes the same recovery within ms.
    now.value = 1_050;
    h.emit("reconnect");
    now.value = 5_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    // Past the cooldown a fresh recovery notifies again immediately.
    now.value = 11_000;
    vi.runAllTimers();
    now.value = 25_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(3);
  });

  it("delivers a suppressed emission at the cooldown's trailing edge instead of dropping it", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    // A DISTINCT second recovery episode 3s later: the host stalled again
    // and came back. Its newly-stranded queries have no other automatic
    // signal, so the gate must defer this notify, not swallow it.
    now.value = 4_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    now.value = 11_000;
    vi.advanceTimersByTime(7_000);
    expect(h.notify).toHaveBeenCalledTimes(2);

    // Only ONE trailing notify however many emissions were suppressed.
    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a clock rollback resets the gate rather than suppressing under a future watermark", () => {
    const now = { value: 100_000 };
    const h = harness(now);

    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    // The wall clock steps backwards (NTP adjustment). Without the reset the
    // watermark sits in the future and suppresses real evidence.
    now.value = 50_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a leading edge taken while a catch-up is armed cancels it instead of notifying twice", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit("reconnect");
    now.value = 4_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    // The event loop stalls - this feature's own scenario. The injected clock
    // moves past the cooldown while the armed timer is still overdue, so the
    // next evidence message is dispatched BEFORE the timer it already owes.
    now.value = 20_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(2);

    // The superseded catch-up must not fire a duplicate invalidation.
    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a clock rollback with a catch-up armed notifies once, not twice", () => {
    const now = { value: 100_000 };
    const h = harness(now);

    h.emit("reconnect");
    now.value = 103_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    now.value = 50_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(2);

    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("disposing cancels an armed trailing notify and the transport subscription", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit("reconnect");
    now.value = 4_000;
    h.emit("reconnect");
    expect(h.notify).toHaveBeenCalledTimes(1);

    h.unsubscribe();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  // The sweep this feeds re-asks less after a stall than after a reconnect,
  // so the cooldown must never deliver a reconnect it held as a stall. Each
  // case below is paired: one where the answer is a reconnect, and one where
  // it has to stay a stall, so "always deliver a reconnect" fails too.
  describe("carries the recovery's kind through the cooldown", () => {
    it("the leading edge delivers the report's own kind", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("stall");
      expect(h.notify).toHaveBeenLastCalledWith("stall");

      now.value = 12_000;
      h.emit("reconnect");
      expect(h.notify).toHaveBeenLastCalledWith("reconnect");
      expect(h.notify).toHaveBeenCalledTimes(2);
    });

    it("the catch-up delivers a reconnect it deferred behind a stall that led", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("stall");
      // Inside the cooldown: first the session drops and reconnects, then a
      // later pong arrives late on the new socket. The reconnect is the one
      // the catch-up owes, however many stalls follow it.
      now.value = 3_000;
      h.emit("reconnect");
      now.value = 4_000;
      h.emit("stall");
      expect(h.notify).toHaveBeenCalledTimes(1);

      now.value = 11_000;
      vi.advanceTimersByTime(10_000);
      expect(h.notify).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenLastCalledWith("reconnect");
    });

    it("a catch-up that deferred only stalls delivers a stall", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("reconnect");
      now.value = 3_000;
      h.emit("stall");
      now.value = 4_000;
      h.emit("stall");
      expect(h.notify).toHaveBeenCalledTimes(1);

      now.value = 11_000;
      vi.advanceTimersByTime(10_000);
      expect(h.notify).toHaveBeenCalledTimes(2);
      // The reconnect already went out on the leading edge. What the window
      // held back was only stalls, and it must not be widened on the way out.
      expect(h.notify).toHaveBeenLastCalledWith("stall");
    });

    it("a leading edge that supersedes an armed catch-up delivers the reconnect the catch-up owed", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("stall");
      now.value = 4_000;
      h.emit("reconnect");
      expect(h.notify).toHaveBeenCalledTimes(1);

      // The event loop stalls past the cooldown with the catch-up still owed,
      // and a stall's evidence takes the leading edge first. It inherits the
      // catch-up's reconnect: dropping it would sweep only the failed reads of
      // a host that may have restarted.
      now.value = 20_000;
      h.emit("stall");
      expect(h.notify).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenLastCalledWith("reconnect");

      vi.runAllTimers();
      expect(h.notify).toHaveBeenCalledTimes(2);
    });

    it("a leading edge that supersedes a catch-up owing only a stall delivers its own kind", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("reconnect");
      now.value = 4_000;
      h.emit("stall");

      now.value = 20_000;
      h.emit("stall");
      expect(h.notify).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenLastCalledWith("stall");
    });

    it("a disposed wiring forgets what it deferred", () => {
      const now = { value: 1_000 };
      const h = harness(now);

      h.emit("stall");
      now.value = 4_000;
      h.emit("reconnect");
      h.unsubscribe();

      // Nothing is subscribed any more; the harness still holds the listener,
      // so drive it directly past the cooldown. A wiring that kept the owed
      // reconnect would hand it to this unrelated stall.
      now.value = 20_000;
      h.emit("stall");
      expect(h.notify).toHaveBeenLastCalledWith("stall");
    });
  });
});
