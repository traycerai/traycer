import type {
  MintedVoiceSelection,
  VoiceSelectionCapability,
  VoiceSelectionPolicy,
} from "@traycer-clients/shared/host-client/voice-sessions";

/**
 * The voice a call speaks in: the person's saved choice for calls on this
 * device, read against the voices the deployment offers.
 *
 * The saved choice is a provider voice name as the wire spells it
 * (lower-case, `isVoiceName`), or `null` when none is chosen. It is kept
 * whatever the offered list says, so a voice withdrawn for a while is the
 * choice again once it is offered; until then the deployment's default
 * speaks.
 */

/** The voices a deployment offers for calls, and the one that speaks when none is chosen. */
export type CallVoiceCatalogue = Pick<
  VoiceSelectionCapability,
  "defaultVoice" | "voices"
>;

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

/**
 * What one call asks for its voice, settled as it starts and frozen at its
 * first confirmed session, so a renewal never changes how the call sounds:
 * - `legacy`: the connection offers no choice of voice. Its mints name none,
 *   and nothing is promised about which voice speaks.
 * - `initial`: the first session asks for the saved voice (`null` for the
 *   default) under the fallback policy, read against `capability`.
 * - `frozen`: every renewal asks for exactly this voice, refused rather than
 *   replaced when it is no longer offered.
 */
export type CallVoicePlan =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "initial";
      readonly saved: string | null;
      readonly capability: VoiceSelectionCapability;
    }
  | { readonly kind: "frozen"; readonly voice: string };

/** The voice fields of a mint made under `plan`. */
export function callVoiceRequest(plan: CallVoicePlan): {
  readonly voice: string | null;
  readonly voicePolicy: VoiceSelectionPolicy | null;
} {
  switch (plan.kind) {
    case "legacy":
      return { voice: null, voicePolicy: null };
    case "initial":
      return {
        voice: plan.saved,
        voicePolicy: plan.saved === null ? null : "fallback",
      };
    case "frozen":
      return { voice: plan.voice, voicePolicy: "exact" };
  }
}

/**
 * What a minted session's answer says about the voice a mint under `plan`
 * asked for: nothing to check on a `legacy` call; the voice that speaks,
 * with the saved voice it replaced when the server fell back to its default;
 * or `unconfirmed` when the answer names no voice, one this build cannot
 * read, or not the one asked for.
 */
export type CallVoiceConfirmation =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "confirmed";
      readonly voice: string;
      readonly replaced: string | null;
    }
  | { readonly kind: "unconfirmed" };

export function confirmCallVoice(
  plan: CallVoicePlan,
  selection: MintedVoiceSelection,
): CallVoiceConfirmation {
  if (plan.kind === "legacy") return { kind: "legacy" };
  if (selection.kind !== "valid") return { kind: "unconfirmed" };
  const { requestedVoice, effectiveVoice, reason } = selection;
  if (plan.kind === "frozen") {
    return requestedVoice === plan.voice &&
      effectiveVoice === plan.voice &&
      reason === "selected"
      ? { kind: "confirmed", voice: plan.voice, replaced: null }
      : { kind: "unconfirmed" };
  }
  if (requestedVoice !== plan.saved) return { kind: "unconfirmed" };
  const defaultVoice = plan.capability.defaultVoice;
  if (plan.saved === null) {
    return reason === "default" && effectiveVoice === defaultVoice
      ? { kind: "confirmed", voice: defaultVoice, replaced: null }
      : { kind: "unconfirmed" };
  }
  if (reason === "selected" && effectiveVoice === plan.saved) {
    return { kind: "confirmed", voice: plan.saved, replaced: null };
  }
  if (reason === "unavailable" && effectiveVoice === defaultVoice) {
    return { kind: "confirmed", voice: defaultVoice, replaced: plan.saved };
  }
  return { kind: "unconfirmed" };
}
