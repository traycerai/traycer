import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  firePointerMove,
  firePointerPress,
  mountController,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

type ArmRequestFrame = Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "arm" | "preArm" }
>;

function armFrames(
  sent: readonly BrowserScreencastClientFrame[],
): ReadonlyArray<{ readonly kind: string; readonly armEpoch: number }> {
  return sent
    .filter(
      (frame): frame is ArmRequestFrame =>
        frame.kind === "arm" || frame.kind === "preArm",
    )
    .map((frame) => ({ kind: frame.kind, armEpoch: frame.armEpoch }));
}

/** The pointer frames that actually reached the wire, in order. */
function pointerTypes(
  sent: readonly BrowserScreencastClientFrame[],
): readonly string[] {
  return sent
    .filter((frame) => frame.kind === "pointer")
    .map((frame) => frame.type);
}

function press(overlay: HTMLElement): void {
  firePointerPress(overlay, { clientX: 200, clientY: 300 });
}

describe("screencast arm path", () => {
  it("pre-arms once on hover and stays idempotent across a storm", () => {
    const { controller, overlay, sent } = mountController();
    controller.notePresentedSequence(7);

    fireEvent.pointerEnter(overlay);
    fireEvent.pointerEnter(overlay);
    fireEvent.pointerEnter(overlay);

    expect(armFrames(sent)).toEqual([{ kind: "preArm", armEpoch: 1 }]);

    // Once the claim lands, hovering has nothing left to ask for.
    controller.noteArmed(1);
    fireEvent.pointerEnter(overlay);

    expect(armFrames(sent)).toEqual([{ kind: "preArm", armEpoch: 1 }]);
  });

  it("supersedes an in-flight pre-arm with a real arm on a press", () => {
    const { controller, overlay, sent } = mountController();
    controller.notePresentedSequence(7);

    fireEvent.pointerEnter(overlay);
    press(overlay);

    // The press cannot wait on a claim that may be refused: it is itself the
    // authorization to take control.
    expect(armFrames(sent)).toEqual([
      { kind: "preArm", armEpoch: 1 },
      { kind: "arm", armEpoch: 2 },
    ]);

    controller.noteArmed(2);

    expect(pointerTypes(sent)).toEqual(["down", "up"]);
  });

  it("stops hovering from re-claiming after the host denied one", () => {
    const { controller, overlay, sent } = mountController();
    controller.notePresentedSequence(7);

    fireEvent.pointerEnter(overlay);
    controller.notePreArmDenied();
    controller.clearLocalArm(false);
    fireEvent.pointerEnter(overlay);
    fireEvent.pointerEnter(overlay);

    expect(armFrames(sent)).toEqual([{ kind: "preArm", armEpoch: 1 }]);

    // A click is a deliberate claim and still steals, exactly as before
    // pre-arm existed.
    press(overlay);

    expect(armFrames(sent)).toEqual([
      { kind: "preArm", armEpoch: 1 },
      { kind: "arm", armEpoch: 2 },
    ]);
  });

  it("holds the claim but drives nothing until a gesture engages control", () => {
    const mounted = mountController();
    const { controller, overlay, sent, engaged } = mounted;
    controller.notePresentedSequence(7);

    fireEvent.pointerEnter(overlay);
    controller.noteArmed(1);
    firePointerMove(overlay, { clientX: 200, clientY: 120 });

    // The host claim is real - that is the whole point of pre-arm - but the
    // pointer crossing the tile must not drive the remote cursor, and nothing
    // in the render may say "Controlling".
    expect(controller.activeArmEpoch()).toBe(1);
    expect(engaged).toEqual([]);
    expect(pointerTypes(sent)).toEqual([]);

    press(overlay);
    firePointerMove(overlay, { clientX: 200, clientY: 160 });

    // A move is rAF-coalesced; the next discrete flushes it.
    press(overlay);

    // The press engages control with no further round trip - the claim was
    // already granted - and moves flow from there.
    expect(engaged).toEqual([1]);
    expect(armFrames(sent)).toEqual([{ kind: "preArm", armEpoch: 1 }]);
    expect(pointerTypes(sent)).toEqual(["down", "up", "move", "down", "up"]);
  });

  it("keeps the arm across a focus exit", () => {
    const { controller, overlay, imeInput, sent } = mountController();
    controller.notePresentedSequence(7);

    fireEvent.focus(imeInput);
    controller.noteArmed(1);
    fireEvent.blur(imeInput, { relatedTarget: document.body });
    fireEvent.blur(overlay, { relatedTarget: document.body });

    expect(sent.filter((frame) => frame.kind === "disarm")).toEqual([]);
    expect(controller.activeArmEpoch()).toBe(1);
  });
});
