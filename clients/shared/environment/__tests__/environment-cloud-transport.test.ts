import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudBearerSource } from "../../auth/bearer-source";
import { readConfigurationRevision } from "../configuration-settings";
import {
  sendEnvironmentRequest,
  settingsRefusal,
  type EnvironmentCloud,
} from "../environment-cloud";

const AUTHN_BASE_URL = "https://authn.example.test";
const BEARER = "environment-test-bearer";
const ENVIRONMENT_ID = "team-a";

function cloudWithBearer(token: string | null): EnvironmentCloud {
  const bearer: CloudBearerSource = {
    kind: "cloud",
    getBearerToken: () => token,
  };
  return { authnBaseUrl: AUTHN_BASE_URL, bearer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("environment authn transport", () => {
  it("sends the current bearer with manual redirects and never follows a refusal", async () => {
    const responses = [
      new Response("redirect", {
        status: 302,
        headers: { Location: "https://elsewhere.example.test/collect" },
      }),
    ];
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      if (init !== undefined) requests.push(init);
      const response = responses.shift();
      if (response === undefined) {
        return Promise.reject(new Error("Unexpected follow-up request"));
      }
      return Promise.resolve(response);
    });

    const answer = await sendEnvironmentRequest(
      cloudWithBearer(BEARER),
      "settings",
      "GET",
      "api/v3/environments/team-a/items",
      null,
    );

    expect(answer.status).toBe(302);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe(
      `Bearer ${BEARER}`,
    );
    expect(settingsRefusal(answer).kind).toBe("invalid");
  });

  it("treats an opaque status zero as an answered refusal", async () => {
    const opaque = new Response("", { status: 200 });
    Object.defineProperty(opaque, "status", { value: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(opaque);

    const answer = await sendEnvironmentRequest(
      cloudWithBearer(BEARER),
      "settings",
      "GET",
      "api/v3/environments/team-a/items",
      null,
    );

    expect(answer.status).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settingsRefusal(answer).kind).toBe("invalid");
  });

  it.each([
    { status: 401, kind: "unauthorized" },
    { status: 403, kind: "forbidden" },
    { status: 400, kind: "invalid" },
    { status: 503, kind: "unavailable" },
  ] as const)("maps HTTP $status to $kind", async ({ status, kind }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status }),
    );

    await expect(
      readConfigurationRevision(cloudWithBearer(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind });
  });

  it("maps a failed fetch to no_response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private transport detail"),
    );

    await expect(
      readConfigurationRevision(cloudWithBearer(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "no_response" });
  });

  it("does not call fetch without a bearer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      readConfigurationRevision(cloudWithBearer(null), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "no_response" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
