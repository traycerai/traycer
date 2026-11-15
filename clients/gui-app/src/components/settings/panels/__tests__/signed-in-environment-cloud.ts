import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";

/**
 * What a signed-in window's `AuthService.environmentCloud()` hands a followed
 * save at the press: its sign-in is the current one, and authn answers
 * nothing, so the save is sent to the host with nothing remembered.
 */
export function signedInEnvironmentCloud(): EnvironmentCloud {
  return {
    authnBaseUrl: "https://authn.test/",
    bearer: { kind: "cloud", getBearerToken: () => "t1" },
    onOriginSignIn: () => true,
    transport: () => Promise.resolve({ status: 503, text: "" }),
  };
}
