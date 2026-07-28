import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireAvailabilityRecovery } from "../availability-recovery";

function harness(nowValue: { value: number }) {
  let listener: (() => void) | null = null;
  const dispose = vi.fn();
  const notify = vi.fn();
  const unsubscribe = wireAvailabilityRecovery({
    wsStreamClient: {
      subscribeAvailabilityRecovered: (l) => {
        listener = l;
        return dispose;
      },
    },
    target: { notifyAvailabilityRecovered: notify },
    cooldownMs: 10_000,
    now: () => nowValue.value,
  });
  return {
    notify,
    dispose,
    unsubscribe,
    emit: (): void => {
      if (listener === null) {
        throw new Error("evidence listener was never subscribed");
      }
      listener();
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

    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    // A burst: every open session observes the same recovery within ms.
    now.value = 1_050;
    h.emit();
    now.value = 5_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    // Past the cooldown a fresh recovery notifies again immediately.
    now.value = 11_000;
    vi.runAllTimers();
    now.value = 25_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(3);
  });

  it("delivers a suppressed emission at the cooldown's trailing edge instead of dropping it", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    // A DISTINCT second recovery episode 3s later: the host stalled again
    // and came back. Its newly-stranded queries have no other automatic
    // signal, so the gate must defer this notify, not swallow it.
    now.value = 4_000;
    h.emit();
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

    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    // The wall clock steps backwards (NTP adjustment). Without the reset the
    // watermark sits in the future and suppresses real evidence.
    now.value = 50_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a leading edge taken while a catch-up is armed cancels it instead of notifying twice", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit();
    now.value = 4_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    // The event loop stalls - this feature's own scenario. The injected clock
    // moves past the cooldown while the armed timer is still overdue, so the
    // next evidence message is dispatched BEFORE the timer it already owes.
    now.value = 20_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(2);

    // The superseded catch-up must not fire a duplicate invalidation.
    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a clock rollback with a catch-up armed notifies once, not twice", () => {
    const now = { value: 100_000 };
    const h = harness(now);

    h.emit();
    now.value = 103_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    now.value = 50_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(2);

    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("disposing cancels an armed trailing notify and the transport subscription", () => {
    const now = { value: 1_000 };
    const h = harness(now);

    h.emit();
    now.value = 4_000;
    h.emit();
    expect(h.notify).toHaveBeenCalledTimes(1);

    h.unsubscribe();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});
