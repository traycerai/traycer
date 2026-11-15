import type { SignInRequestClient } from "@traycer-clients/shared/host-client/provider-sign-in-request";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { vi } from "vitest";

export const unavailableSignInRequestClient: SignInRequestClient = {
  recordSignInRequest: () => Promise.resolve({ kind: "failed" }),
};

/** A real AuthService instance whose record port uses the shared fake fetch. */
export function signInRequestAuthService(
  client: SignInRequestClient,
): AuthService {
  const runnerHost = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "https://authn.example.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost });
  vi.spyOn(service, "recordSignInRequest").mockImplementation(
    (request, signal) => client.recordSignInRequest(request, signal),
  );
  return service;
}

export function unavailableSignInRequestAuthService(): AuthService {
  return signInRequestAuthService(unavailableSignInRequestClient);
}
