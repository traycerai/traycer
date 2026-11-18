import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { vi } from "vitest";

const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";

export interface ProfileRecordHttpRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: BodyInit | null | undefined;
}

export interface ProfileRecordAuthFixture {
  readonly service: AuthService;
  readonly requests: ProfileRecordHttpRequest[];
}

export async function createProfileRecordAuthFixture(
  handleRequest: (request: ProfileRecordHttpRequest) => Promise<Response>,
): Promise<ProfileRecordAuthFixture> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost });
  await runnerHost.tokenStore.signIn(
    {
      token: "synthetic-person-token",
      refreshToken: "synthetic-refresh-token",
    },
    { id: "u1", email: "ada@example.com", name: "Ada" },
  );
  const requests: ProfileRecordHttpRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      if (url === VALIDATION_URL) {
        const user = userWith(
          userSubscription({
            totalPlanCredits: 0,
            consumedFromPlan: 0,
            bonusCredits: 0,
            consumedFromBonus: 0,
            bundleRemaining: 0,
          }),
          [],
        );
        return Promise.resolve(
          new Response(JSON.stringify(user), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-traycer-user-record-version": "3.0",
            },
          }),
        );
      }
      const request = {
        url,
        method: init?.method,
        body: init?.body,
      };
      requests.push(request);
      return handleRequest(request);
    }),
  );
  await service.start();
  requests.length = 0;
  return { service, requests };
}
