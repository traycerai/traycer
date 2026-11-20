import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
} from "@traycer-clients/shared/environment/environment-cloud";

/** A host settings press either began on a sign-in, or owns no account follow. */
export type SettingsSaveOrigin =
  | { readonly kind: "no_sign_in_at_press" }
  | {
      readonly kind: "sign_in_at_press";
      readonly operation: EnvironmentCloud;
    };

/** Captured before any mutation hook yields; never reclassified at dispatch. */
export function captureSettingsSaveOrigin(
  source: EnvironmentCloudSource | null,
): SettingsSaveOrigin {
  const operation = source === null ? null : source();
  return operation !== null && operation.onOriginSignIn()
    ? { kind: "sign_in_at_press", operation }
    : { kind: "no_sign_in_at_press" };
}
