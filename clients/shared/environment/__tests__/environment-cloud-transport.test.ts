import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigurationRevision } from "../configuration-settings";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

const BEARER = "environment-test-bearer";
const ENVIRONMENT_ID = "team-a";

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

    await expect(
      readConfigurationRevision(createEnvironmentCloud(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "unavailable" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe(
      `Bearer ${BEARER}`,
    );
  });

  it("treats an opaque status zero as an answered refusal", async () => {
    const opaque = new Response("", { status: 200 });
    Object.defineProperty(opaque, "status", { value: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(opaque);

    await expect(
      readConfigurationRevision(createEnvironmentCloud(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "unavailable" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      readConfigurationRevision(createEnvironmentCloud(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind });
  });

  it("maps a failed fetch to no_response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("private transport detail"),
    );

    await expect(
      readConfigurationRevision(createEnvironmentCloud(BEARER), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "no_response" });
  });

  it("does not call fetch without a bearer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      readConfigurationRevision(createEnvironmentCloud(null), ENVIRONMENT_ID),
    ).rejects.toMatchObject({ kind: "no_response" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
