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
}

export function emptyProfileEndpointDraft(): ProfileEndpointDraft {
  return {
    baseUrl: "",
    credential: "",
    credentialKind: "api_key",
    defaultModel: "",
  };
}
