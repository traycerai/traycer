import type {
  ModelProviderAuthErrorCode,
  ModelProviderListErrorCode,
} from "@traycer/protocol/host/provider-native-schemas";

const LIST_ERROR_COPY: Readonly<Record<ModelProviderListErrorCode, string>> = {
  capability_unavailable:
    "Model providers aren't available for this provider on this host.",
  // Also the answer for a config the provider cannot parse: a config it rejects
  // is a server that never boots, so the condition is not separately observable
  // here. The `detail` carries the redacted parse error - file, line, column -
  // and the rule below prefers it, which is why this generic sentence is only
  // ever the fallback for a bare code.
  server_unavailable:
    "The provider's local server couldn't be started, so its catalog is unavailable.",
};

const AUTH_ERROR_COPY: Readonly<Record<ModelProviderAuthErrorCode, string>> = {
  server_unavailable:
    "The provider's local server couldn't be started. Nothing is wrong with your credential — try again in a moment.",
  provider_not_found:
    "That provider is no longer in the catalog. Refresh the list and try again.",
  attempt_not_found: "That sign-in is no longer in progress. Start it again.",
  attempt_superseded: "A newer sign-in for this provider replaced this one.",
  attempt_expired: "This sign-in timed out. Start it again.",
  code_rejected: "That code wasn't accepted. Check it and paste it again.",
  invalid_input: "Those details were rejected. Check them and try again.",
  provider_auth_failed: "The provider refused the sign-in.",
};

/**
 * The host's `detail` wins whenever it has one, and it usually does: it is the
 * provider's own wording for a flow Traycer does not otherwise understand
 * (which env var it expected, which field it did not recognise), already
 * redacted host-side. The tables above are the fallback for a bare code.
 */
export function modelProviderListErrorMessage(
  code: ModelProviderListErrorCode,
  detail: string | null,
): string {
  if (detail !== null && detail.trim().length > 0) return detail.trim();
  return LIST_ERROR_COPY[code];
}

export function modelProviderAuthErrorMessage(
  code: ModelProviderAuthErrorCode,
  detail: string | null,
): string {
  if (detail !== null && detail.trim().length > 0) return detail.trim();
  return AUTH_ERROR_COPY[code];
}

/**
 * What a client DOES about a failed auth call. Every member of the wire enum
 * earns its place by mapping to a different move here - so this is the enum's
 * contract restated as behaviour, in one place, instead of a switch per call
 * site that quietly handles four of the eight.
 *
 * - `stand-down` — a NEWER attempt owns this provider's surface. Drop this
 *   attempt's panel without a word: an error here would accuse the user of
 *   breaking the flow they just restarted.
 * - `restart` — the attempt is gone (expired, or never minted). Offer a fresh
 *   start; there is nothing left to resume.
 * - `reprompt` — the code was refused and the attempt is STILL LIVE. Ask again
 *   rather than tearing down a usable authorization.
 * - `report` — show the message and let the user decide.
 */
export type ModelProviderAuthErrorDisposition =
  "stand-down" | "restart" | "reprompt" | "report";

export function modelProviderAuthErrorDisposition(
  code: ModelProviderAuthErrorCode,
): ModelProviderAuthErrorDisposition {
  switch (code) {
    case "attempt_superseded":
      return "stand-down";
    case "attempt_expired":
    case "attempt_not_found":
      return "restart";
    case "code_rejected":
      return "reprompt";
    case "server_unavailable":
    case "provider_not_found":
    case "invalid_input":
    case "provider_auth_failed":
      return "report";
  }
}
