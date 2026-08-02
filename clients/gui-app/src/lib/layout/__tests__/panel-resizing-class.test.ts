import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  beginPanelResizeInteraction,
  registerPanelResizeParticipant,
} from "@/lib/layout/panel-resizing-class";

const PANEL_RESIZING_CLASS = "traycer-panel-resizing";

type VoidMock = Mock<() => void>;

interface ParticipantSpy {
  readonly capture: VoidMock;
  readonly clear: VoidMock;
}

function participantSpy(): ParticipantSpy {
  return {
    capture: vi.fn(),
    clear: vi.fn(),
  };
}

/**
 * This module holds global singleton state (the participant registry, and
 * the single "currently active interaction" slot). A test whose assertion
 * throws before reaching its own manual `stop()`/`unregister()` calls would
 * otherwise leak a registered participant AND an unfinished interaction into
 * every later test in this file - track every `unregister`/`stop` returned
 * during a test and sweep them unconditionally in `afterEach`, regardless of
 * how the test body exits. Calling an already-unregistered `unregister` or
 * an already-stopped `stop` a second time is a documented no-op on both, so
 * this sweep is safe even for tests that already did their own cleanup.
 */
let pendingUnregisters: Array<() => void> = [];
let pendingStops: Array<() => void> = [];

function trackedRegister(participant: {
  readonly capture: () => void;
  readonly clear: () => void;
}): () => void {
  const unregister = registerPanelResizeParticipant(participant);
  pendingUnregisters.push(unregister);
  return unregister;
}

const NOOP_ON_STOP = (): void => undefined;

function trackedBegin(pointerId: number): () => void {
  const stop = beginPanelResizeInteraction(pointerId, NOOP_ON_STOP);
  pendingStops.push(stop);
  return stop;
}

afterEach(() => {
  for (const stop of pendingStops) stop();
  pendingStops = [];
  for (const unregister of pendingUnregisters) unregister();
  pendingUnregisters = [];
  document.documentElement.classList.remove(PANEL_RESIZING_CLASS);
});

describe("panel-resizing-class participant registry", () => {
  it("invokes every registered participant's capture BEFORE the class is added", () => {
    const classPresentDuringCapture: boolean[] = [];
    trackedRegister({
      capture: () => {
        classPresentDuringCapture.push(
          document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
        );
      },
      clear: () => undefined,
    });

    trackedBegin(1);

    expect(classPresentDuringCapture).toEqual([false]);
    expect(
      document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
    ).toBe(true);
  });

  it("removes the class BEFORE invoking clear on stop", () => {
    const classPresentDuringClear: boolean[] = [];
    trackedRegister({
      capture: () => undefined,
      clear: () => {
        classPresentDuringClear.push(
          document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
        );
      },
    });

    const stop = trackedBegin(1);
    stop();

    expect(classPresentDuringClear).toEqual([false]);
  });

  it("calls capture exactly once per begin and clear exactly once per stop - no per-move re-invocation", () => {
    const spy = participantSpy();
    trackedRegister(spy);

    const stop = trackedBegin(1);
    expect(spy.capture).toHaveBeenCalledTimes(1);
    expect(spy.clear).not.toHaveBeenCalled();

    // The mechanism has no per-pointermove hook at all - there is nothing
    // here that COULD re-invoke capture no matter how long/eventful the drag
    // is. This asserts the call count stays flat across the drag's own
    // begin->stop lifecycle, matching the "no per-scroll subscription"
    // constraint.
    stop();
    expect(spy.capture).toHaveBeenCalledTimes(1);
    expect(spy.clear).toHaveBeenCalledTimes(1);

    // Calling the same stop() again is a no-op (already-stopped guard) -
    // clear must not fire twice.
    stop();
    expect(spy.clear).toHaveBeenCalledTimes(1);
  });

  it("isolates one participant's thrown capture/clear from the others and from the class lifecycle", () => {
    const good = participantSpy();
    trackedRegister(good);
    trackedRegister({
      capture: () => {
        throw new Error("capture boom");
      },
      clear: () => {
        throw new Error("clear boom");
      },
    });

    const stop = trackedBegin(1);
    expect(
      document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
    ).toBe(true);
    expect(good.capture).toHaveBeenCalledTimes(1);

    stop();
    expect(
      document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
    ).toBe(false);
    expect(good.clear).toHaveBeenCalledTimes(1);
  });

  it("stops calling a participant once it has unregistered", () => {
    const spy = participantSpy();
    const unregister = trackedRegister(spy);
    unregister();

    const stop = trackedBegin(1);
    stop();

    expect(spy.capture).not.toHaveBeenCalled();
    expect(spy.clear).not.toHaveBeenCalled();
  });

  it("captures/clears every registered participant, not just one", () => {
    const spyA = participantSpy();
    const spyB = participantSpy();
    trackedRegister(spyA);
    trackedRegister(spyB);

    const stop = trackedBegin(1);
    stop();

    expect(spyA.capture).toHaveBeenCalledTimes(1);
    expect(spyB.capture).toHaveBeenCalledTimes(1);
    expect(spyA.clear).toHaveBeenCalledTimes(1);
    expect(spyB.clear).toHaveBeenCalledTimes(1);
  });

  it("a new interaction beginning mid-drag (finishing the prior one) still captures every live participant exactly once", () => {
    const spy = participantSpy();
    trackedRegister(spy);

    trackedBegin(1);
    expect(spy.capture).toHaveBeenCalledTimes(1);

    // A second begin() without calling the first drag's stop() first -
    // `beginPanelResizeInteraction` finishes the prior interaction itself.
    const secondStop = trackedBegin(2);
    expect(spy.clear).toHaveBeenCalledTimes(1); // prior interaction's clear
    expect(spy.capture).toHaveBeenCalledTimes(2); // new interaction's capture

    secondStop();
    expect(spy.clear).toHaveBeenCalledTimes(2);
  });

  describe("termination routes (pointerup/pointercancel/blur)", () => {
    it("stops on a matching pointerup dispatched through the real window listener path", () => {
      const spy = participantSpy();
      trackedRegister(spy);
      trackedBegin(7);
      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(true);

      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(false);
      expect(spy.clear).toHaveBeenCalledTimes(1);
    });

    it("stops on a matching pointercancel dispatched through the real window listener path", () => {
      const spy = participantSpy();
      trackedRegister(spy);
      trackedBegin(3);
      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(true);

      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 3 }));

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(false);
      expect(spy.clear).toHaveBeenCalledTimes(1);
    });

    it("stops on blur regardless of pointerId", () => {
      const spy = participantSpy();
      trackedRegister(spy);
      trackedBegin(9);
      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(true);

      window.dispatchEvent(new Event("blur"));

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(false);
      expect(spy.clear).toHaveBeenCalledTimes(1);
    });

    it("ignores a pointerup from a different pointerId (foreign-pointer negative)", () => {
      const spy = participantSpy();
      trackedRegister(spy);
      trackedBegin(5);

      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 999 }));

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(true);
      expect(spy.clear).not.toHaveBeenCalled();

      // Prove the interaction is still genuinely live (not just "afterEach
      // will clean it up regardless") by stopping it with the MATCHING
      // pointerId and observing the real transition.
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 5 }));
      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(false);
      expect(spy.clear).toHaveBeenCalledTimes(1);
    });

    it("resolves a pre-registered hook-style window pointerup listener BEFORE this module's own stop", () => {
      const order: Array<string> = [];
      const hookListener = (): void => {
        order.push("hook");
      };
      // Registered BEFORE beginPanelResizeInteraction - models
      // use-pointer-drag-commit.ts's own window-level pointerup listener
      // (registered at pointerdown time, ahead of this module's, per the
      // row-1 drag fix under parallel review). DOM listeners for the same
      // target/event type fire in registration order, so the hook's own
      // commit/cancel resolves before this module's `stop()` - which is
      // exactly what makes `stop()`'s idempotent guard safe to rely on here
      // rather than a source of double-invocation bugs.
      window.addEventListener("pointerup", hookListener);

      trackedRegister({
        capture: () => undefined,
        clear: () => {
          order.push("registry-clear");
        },
      });
      trackedBegin(11);

      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11 }));

      expect(order).toEqual(["hook", "registry-clear"]);
      window.removeEventListener("pointerup", hookListener);
    });
  });
});
