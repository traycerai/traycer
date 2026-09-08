import type { ProfileCredentialKind } from "@traycer/protocol/host/provider-profile-config-schemas";

/**
 * The typed endpoint form's draft (D06/D07), shared by the Account tab's
 * apiKey arm and the add-profile dialog's API key tab. Lives beside
 * `ProfileEndpointForm` rather than inside it because a module that exports a
 * component exports only components.
 */
export interface ProfileEndpointDraft {
  readonly baseUrl: string;
  /** Never populated from the wire (D07) - always starts, and after a save
   *  reverts to, empty. */
  readonly credential: string;
  readonly credentialKind: ProfileCredentialKind;
  readonly defaultModel: string;
  /**
   * D06's `extraFields`: rendered only when the provider's
   * `endpointCapabilities.extraFields` names `"maxContextSize"` (kimi today).
   * A STRING because it is an input's value - the submit path parses it, and
   * an empty string means "not set" (`null` on the wire).
   */
  readonly maxContextSize: string;
}

export function emptyProfileEndpointDraft(): ProfileEndpointDraft {
  return {
    baseUrl: "",
    credential: "",
    credentialKind: "api_key",
    defaultModel: "",
    maxContextSize: "",
  };
}

/**
 * D06's `extraFields` extra, parsed out of its form input. Empty (or anything
 * not a positive integer, which the wire schema rejects anyway) is `null` -
 * "not set", so kimi's projection writes no `max_context_size` key rather
 * than a fabricated one. The one string->`number | null` seam, shared by both
 * submit paths (the Account tab and the add-profile dialog).
 */
export function parseMaxContextSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
