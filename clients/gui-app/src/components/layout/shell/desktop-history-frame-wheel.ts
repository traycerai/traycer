import type { SandboxWheel } from "@/lib/sandbox/bridge-host";

// A wheel inside a sandboxed frame never reaches this document, so the
// recognizer's DOM stream is silent while the pointer is over an HTML
// artifact. The frame relays the wheels its page could not use; a frame that
// registers here hands those to the recognizer first, and the recognizer can
// ask the frame to hold its page still while a navigation pull is live.

type FrameWheelSink = (
  frame: HTMLIFrameElement,
  wheel: SandboxWheel,
) => boolean;

const holds = new Map<HTMLIFrameElement, (held: boolean) => void>();
let sink: FrameWheelSink | null = null;

/** Only a registered frame's wheels reach the recognizer. */
export function registerHistoryGestureFrame(
  frame: HTMLIFrameElement,
  hold: (held: boolean) => void,
): () => void {
  holds.set(frame, hold);
  return () => {
    holds.delete(frame);
  };
}

/** True when the recognizer took the wheel, so the app must not scroll by it. */
export function reportHistoryGestureFrameWheel(
  frame: HTMLIFrameElement,
  wheel: SandboxWheel,
): boolean {
  if (sink === null || !holds.has(frame)) return false;
  return sink(frame, wheel);
}

export function holdHistoryGestureFrame(
  frame: HTMLIFrameElement,
  held: boolean,
): void {
  holds.get(frame)?.(held);
}

/** The recognizer's end; one window has one recognizer. */
export function attachHistoryGestureFrameSink(
  next: FrameWheelSink,
): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}
