import type { RecordingSaveChannel } from "./recording";

function isSaveChannel(value: unknown): value is RecordingSaveChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "open") === "function" &&
    typeof Reflect.get(value, "append") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "reveal") === "function" &&
    typeof Reflect.get(value, "onFinishRequested") === "function"
  );
}

/**
 * Where a recording is saved: the desktop bridge's `soundtrackRecording`
 * member, which only a desktop build that is not production carries. A web or
 * mobile build has no bridge, a production desktop answers null for the
 * member, and an older desktop has none, so each answers null and nothing to
 * record with is drawn. Read from the global, at render, as the track set's
 * bridge is (`desktop-set.ts`).
 */
export function desktopRecordingChannel(): RecordingSaveChannel | null {
  const host: unknown = Reflect.get(globalThis, "runnerHost");
  if (typeof host !== "object" || host === null) return null;
  const member: unknown = Reflect.get(host, "soundtrackRecording");
  return isSaveChannel(member) ? member : null;
}
