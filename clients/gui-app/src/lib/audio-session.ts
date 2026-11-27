/**
 * The page's audio session on WebKit (`navigator.audioSession`, Safari and the
 * iOS app's web view). Left at `"auto"`, WebKit opens a media element in the
 * playback category, which stops the person's music for a half-second chime.
 * A chime instead plays `"ambient"`, which mixes with other apps, and only
 * while the session is otherwise idle: a chime never re-types a session that
 * a voice call, dictation, the soundtrack or a media artifact is using.
 *
 * Every other audio start calls `restoreDefaultAudioSession()` first, so one
 * that begins while a chime is still sounding does not run as ambient: the
 * microphone and playback get the category WebKit would have chosen.
 */

type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record";

interface PageAudioSession {
  type: AudioSessionType;
  readonly state: "inactive" | "active" | "interrupted";
}

function isPageAudioSession(value: unknown): value is PageAudioSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "state" in value &&
    typeof value.state === "string"
  );
}

function readAudioSession(): PageAudioSession | null {
  if (typeof navigator === "undefined") return null;
  const session: unknown = Reflect.get(navigator, "audioSession");
  return isPageAudioSession(session) ? session : null;
}

let ambientHolds = 0;
let ambientGeneration = 0;

/**
 * Types the session ambient for one chime, when nothing else holds it, and
 * answers how to give it back. Releasing twice, or after
 * `restoreDefaultAudioSession()`, does nothing.
 */
export function holdAmbientAudioSession(): () => void {
  const session = readAudioSession();
  if (session === null) return () => undefined;
  if (ambientHolds === 0) {
    if (session.state !== "inactive" || session.type !== "auto") {
      return () => undefined;
    }
    session.type = "ambient";
  }
  ambientHolds += 1;
  const generation = ambientGeneration;
  let released = false;
  return () => {
    if (released || generation !== ambientGeneration) return;
    released = true;
    ambientHolds -= 1;
    if (ambientHolds === 0 && session.type === "ambient") session.type = "auto";
  };
}

/** Hands the session back to WebKit before any audio other than a chime starts. */
export function restoreDefaultAudioSession(): void {
  if (ambientHolds === 0) return;
  ambientHolds = 0;
  ambientGeneration += 1;
  const session = readAudioSession();
  if (session !== null && session.type === "ambient") session.type = "auto";
}
