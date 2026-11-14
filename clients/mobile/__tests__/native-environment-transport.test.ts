import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySecret } from "@traycer-clients/shared/environment/configuration-secrets";
import { EnvironmentCloudError } from "@traycer-clients/shared/environment/environment-cloud";
import { nativeEnvironmentTransport } from "../src/native-environment-transport";

const native = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: { request: native.request },
}));

const BEARER = "bearer-never-in-an-error";
const AUTHN = "https://authn.example.invalid";

afterEach(() => {
  native.request.mockReset();
});

describe("the phone's environment transport", () => {
  it("answers a 307 on a POST as a refusal, sent once and never followed", async () => {
    native.request.mockResolvedValue({
      status: 307,
      data: "",
      headers: { Location: "https://elsewhere.example.invalid/verify" },
      url: `${AUTHN}/api/v3/environments/env-1/secrets/sec-1/verify`,
    });

    const answer = verifySecret(
      {
        authnBaseUrl: AUTHN,
        bearer: { kind: "cloud", getBearerToken: () => BEARER },
        transport: nativeEnvironmentTransport,
        onOriginSignIn: () => true,
      },
      "env-1",
      { environmentId: "env-1", target: "secret", secretId: "sec-1" },
    );

    const error: unknown = await answer.catch((caught: unknown) => caught);
    if (!(error instanceof EnvironmentCloudError)) {
      throw new Error("expected the caller's refusal");
    }
    expect(error.kind).toBe("unavailable");
    expect(error.message).not.toContain(BEARER);
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${AUTHN}/api/v3/environments/env-1/secrets/sec-1/verify`,
        method: "POST",
        disableRedirects: true,
      }),
    );
  });
});
