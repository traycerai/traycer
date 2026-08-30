import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  browserScreencastClientFrameSchema,
  type BrowserScreencastClientFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  armViaGesture,
  mountController,
  type MountedController,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";
import type { ScreencastInputTransport } from "@/lib/browser-view/sessions/screencast-controller";
import type { BrowserInputChannelLabel } from "@/lib/browser-view/tiles/webrtc-media-registry";

interface ChannelSend {
  readonly label: BrowserInputChannelLabel;
  readonly frame: BrowserScreencastClientFrame;
}

interface ChannelRecorder {
  readonly sends: ChannelSend[];
  /** Flipped to false to stand in for a closed channel mid-gesture. */
  open: boolean;
  readonly transport: ScreencastInputTransport;
}

/**
 * The DataChannel sink, recording what the host would receive. The payload is
 * parsed through the SAME schema the host parses it with, so a frame that only
 * looks right as a JS object still fails here.
 */
function channelRecorder(): ChannelRecorder {
  const recorder: ChannelRecorder = {
    sends: [],
    open: true,
    transport: (label, payload) => {
      if (!recorder.open) return false;
      recorder.sends.push({
        label,
        frame: browserScreencastClientFrameSchema.parse(JSON.parse(payload)),
      });
      return true;
    },
  };
  return recorder;
}

/** An armed tile whose plane is video and whose channels are open. */
function armedOnChannels(): MountedController & {
  readonly channels: ChannelRecorder;
} {
  const mounted = mountController();
  const channels = channelRecorder();
  mounted.controller.setCaptureMode("video");
  mounted.controller.noteViewportEpoch(4);
  mounted.controller.setInputTransport(channels.transport);
  armViaGesture(mounted, 1);
  return { ...mounted, channels };
}

function pointerMove(overlay: HTMLElement, clientY: number): void {
  fireEvent.pointerMove(overlay, {
    pointerId: 1,
    clientX: 200,
    clientY,
    button: 0,
    buttons: 0,
  });
}

function pointerDown(overlay: HTMLElement): void {
  fireEvent.pointerDown(overlay, {
    pointerId: 1,
    clientX: 200,
    clientY: 300,
    button: 0,
    buttons: 1,
    detail: 1,
  });
}

function pointerUp(overlay: HTMLElement): void {
  fireEvent.pointerUp(overlay, {
    pointerId: 1,
    clientX: 200,
    clientY: 300,
    button: 0,
    buttons: 0,
    detail: 1,
  });
}

function kinds(
  frames: readonly BrowserScreencastClientFrame[],
): readonly string[] {
  return frames.map((frame) =>
    frame.kind === "pointer" ? `pointer:${frame.type}` : frame.kind,
  );
}

describe("screencast input transport", () => {
  it("routes moves to the lossy channel and discretes to the reliable one", () => {
    const { controller, sent, overlay, imeInput, channels } = armedOnChannels();

    pointerMove(overlay, 100);
    pointerDown(overlay);
    pointerUp(overlay);
    fireEvent.keyDown(imeInput, { code: "KeyA", key: "a" });
    controller.requestNav({ kind: "reload" });

    expect(channels.sends.map((send) => send.label)).toEqual([
      "input-lossy",
      "input-reliable",
      "input-reliable",
      "input-reliable",
      "input-reliable",
    ]);
    expect(kinds(channels.sends.map((send) => send.frame))).toEqual([
      "pointer:move",
      "pointer:down",
      "pointer:up",
      "keyboard",
      "keyboard",
    ]);
    // Control stays on the mux unconditionally - nav included, even though it
    // travels the same `sendInput` path as the frames above.
    expect(kinds(sent)).toEqual(["reload"]);
  });

  it("keeps seq contiguous across the two transports", () => {
    const { sent, overlay, channels } = armedOnChannels();

    pointerMove(overlay, 100);
    pointerDown(overlay);
    pointerUp(overlay);

    expect(
      channels.sends.map((send) =>
        send.frame.kind === "pointer" ? send.frame.seq : null,
      ),
    ).toEqual([0, 1, 2]);
    expect(sent).toEqual([]);
  });

  it("falls back to the mux when no channel is installed", () => {
    const { controller, sent, overlay, channels } = armedOnChannels();
    controller.setInputTransport(null);

    pointerMove(overlay, 100);
    pointerDown(overlay);

    expect(channels.sends).toEqual([]);
    expect(kinds(sent)).toEqual(["pointer:move", "pointer:down"]);
  });

  it("falls back to the mux while the plane is not video", () => {
    const mounted = mountController();
    const channels = channelRecorder();
    mounted.controller.notePresentedSequence(7);
    mounted.controller.setInputTransport(channels.transport);
    armViaGesture(mounted, 1);

    pointerMove(mounted.overlay, 100);
    pointerDown(mounted.overlay);

    expect(channels.sends).toEqual([]);
    expect(kinds(mounted.sent)).toEqual(["pointer:move", "pointer:down"]);
  });

  it("flushes the pending move on the lossy channel before the discrete", () => {
    const { overlay, channels } = armedOnChannels();

    // Two moves coalesce into one pending frame; the press must not overtake
    // it, exactly as on the mux today.
    pointerMove(overlay, 100);
    pointerMove(overlay, 140);
    pointerDown(overlay);

    expect(kinds(channels.sends.map((send) => send.frame))).toEqual([
      "pointer:move",
      "pointer:down",
    ]);
    const [move, down] = channels.sends;
    expect(move.label).toBe("input-lossy");
    expect(down.label).toBe("input-reliable");
    expect(
      move.frame.kind === "pointer" ? move.frame.normalizedY : null,
    ).toBeCloseTo(140 / 600);
  });

  it("sends each discrete on exactly one transport across a switchover", () => {
    const { sent, overlay, channels } = armedOnChannels();

    pointerDown(overlay);
    pointerUp(overlay);
    // The channel dies between gestures: the next discrete must land on the
    // mux and nowhere else, and the ones before it must not be re-sent.
    channels.open = false;
    pointerDown(overlay);
    pointerUp(overlay);

    const everySend = [...channels.sends.map((send) => send.frame), ...sent];
    const pointerSeqs = everySend
      .filter((frame) => frame.kind === "pointer")
      .map((frame) => frame.seq);
    expect(new Set(pointerSeqs).size).toBe(pointerSeqs.length);
    expect(kinds(channels.sends.map((send) => send.frame))).toEqual([
      "pointer:down",
      "pointer:up",
    ]);
    expect(kinds(sent)).toEqual(["pointer:down", "pointer:up"]);
  });

  it("holds a mid-arm promotion until the host acks the mux", () => {
    const mounted = mountController();
    const channels = channelRecorder();
    mounted.controller.setCaptureMode("video");
    mounted.controller.noteViewportEpoch(4);
    armViaGesture(mounted, 1);

    pointerDown(mounted.overlay);
    // The channels come up mid-drag. Adopting here would let the moves and
    // the up overtake the press still in flight on the mux, and the host
    // would stale-reject it - a drag silently becomes a hover.
    mounted.controller.setInputTransport(channels.transport);
    pointerMove(mounted.overlay, 100);
    pointerUp(mounted.overlay);

    expect(channels.sends).toEqual([]);
    expect(kinds(mounted.sent)).toEqual([
      "pointer:down",
      "pointer:move",
      "pointer:up",
    ]);

    // An ack short of the last mux frame proves nothing: seq 2 is still out
    // there and a channel frame would overtake it.
    mounted.controller.noteInputAck(1, 1);
    pointerDown(mounted.overlay);
    expect(channels.sends).toEqual([]);

    // Covered now - the mux holds nothing this epoch, so the promotion lands
    // mid-arm instead of waiting for the next one.
    mounted.controller.noteInputAck(1, 3);
    pointerUp(mounted.overlay);

    expect(kinds(channels.sends.map((send) => send.frame))).toEqual([
      "pointer:up",
    ]);
  });

  it("ignores an input ack from a superseded arm epoch", () => {
    const mounted = mountController();
    const channels = channelRecorder();
    mounted.controller.setCaptureMode("video");
    mounted.controller.noteViewportEpoch(4);
    armViaGesture(mounted, 2);

    pointerDown(mounted.overlay);
    mounted.controller.setInputTransport(channels.transport);
    // The previous epoch's watermark says nothing about this epoch's mux.
    mounted.controller.noteInputAck(1, 99);
    pointerUp(mounted.overlay);

    expect(channels.sends).toEqual([]);
  });

  it("replays a buffered arming gesture through the channels", () => {
    const mounted = mountController();
    const channels = channelRecorder();
    mounted.controller.setCaptureMode("video");
    mounted.controller.noteViewportEpoch(4);
    mounted.controller.setInputTransport(channels.transport);

    pointerDown(mounted.overlay);
    pointerUp(mounted.overlay);
    // The arm itself rides the mux; the gesture it buffered replays through
    // the seam like live input.
    expect(kinds(mounted.sent)).toEqual(["arm"]);

    mounted.controller.noteArmed(1);

    expect(kinds(channels.sends.map((send) => send.frame))).toEqual([
      "pointer:down",
      "pointer:up",
    ]);
    expect(
      channels.sends.every((send) => send.label === "input-reliable"),
    ).toBe(true);
    expect(kinds(mounted.sent)).toEqual(["arm"]);
  });
});
