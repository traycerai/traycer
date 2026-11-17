/**
 * The voice a call speaks in: the person's saved choice for calls on this
 * device, read against the voices the deployment offers.
 *
 * The saved choice is a provider voice name as the wire spells it
 * (lower-case), or `null` when none is chosen. It is kept whatever the
 * offered list says, so a voice withdrawn for a while is the choice again
 * once it is offered; until then the deployment's default speaks.
 */

/** A provider voice name: lower-case letters, digits, `_` and `-`, at most 64. */
const CALL_VOICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isCallVoiceName(value: unknown): value is string {
  return typeof value === "string" && CALL_VOICE_NAME.test(value);
}

/** The voices a deployment offers for calls, and the one that speaks when none is chosen. */
export interface CallVoiceCatalogue {
  readonly defaultVoice: string;
  readonly voices: ReadonlyArray<string>;
}

/** What is known about the offered voices now. */
export type CallVoiceCatalogueState =
  | { readonly kind: "loading" }
  /** The connection offers no choice of voice: calls use its default. */
  | { readonly kind: "unsupported" }
  /** The offered voices could not be read. */
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly catalogue: CallVoiceCatalogue };

/** The voice a call speaks in, and why. */
export type CallVoiceResolution =
  /** Nothing is chosen: the deployment's default. */
  | { readonly kind: "default"; readonly voice: string }
  | { readonly kind: "selected"; readonly voice: string }
  /** The saved voice is not offered now: the default speaks instead. */
  | {
      readonly kind: "unavailable";
      readonly saved: string;
      readonly voice: string;
    };

export function resolveCallVoice(
  saved: string | null,
  catalogue: CallVoiceCatalogue,
): CallVoiceResolution {
  if (saved === null) return { kind: "default", voice: catalogue.defaultVoice };
  if (catalogue.voices.includes(saved))
    return { kind: "selected", voice: saved };
  return { kind: "unavailable", saved, voice: catalogue.defaultVoice };
}

/** A voice as the person reads it: the provider's name, capitalised. */
export function callVoiceLabel(voice: string): string {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}
