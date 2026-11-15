import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { listTeamComputersViaHttp, type TeamComputer } from "../team-computers";

const BASE = "https://authn.example.test";
const BEARER = "member-session-token";
const HOST_ID = "6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6";
const ENVIRONMENT_ID = "env_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SHARING_GENERATION = 8;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  respond: (url: string, init: RequestInit) => Promise<Response>,
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    respond(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function onlyCall(fetchMock: Mock<typeof fetch>): {
  readonly url: string;
  readonly init: RequestInit;
} {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  if (init === undefined) throw new Error("fetch was called without init");
  return { url: String(input), init };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function computer(overrides: Partial<TeamComputer>): TeamComputer {
  return {
    hostId: HOST_ID,
    environmentId: ENVIRONMENT_ID,
    hostName: "Studio",
    hostKind: "personal",
    sharingGeneration: SHARING_GENERATION,
    purgePending: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listTeamComputersViaHttp", () => {
  it("GETs hosts with include=binding and normalizes missing optional fields", async () => {
    const legacyHost = {
      hostId: HOST_ID,
      environmentId: ENVIRONMENT_ID,
      hostName: "Studio",
      hostKind: "personal",
      sharingGeneration: SHARING_GENERATION,
      purgePending: false,
      futureProjectionField: "ignored",
    };
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { hosts: [legacyHost] }),
    );

    await expect(
      listTeamComputersViaHttp(`${BASE}/`, BEARER, ENVIRONMENT_ID),
    ).resolves.toEqual({ kind: "ok", hosts: [computer({})] });

    const { url, init } = onlyCall(fetchMock);
    expect(url).toBe(
      `${BASE}/api/v3/environments/${ENVIRONMENT_ID}/hosts?include=binding`,
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headerOf(init, "Accept")).toBe("application/json");
    expect(headerOf(init, "Content-Type")).toBe("application/json");
  });

  it("rejects a host projection for a different environment", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        hosts: [computer({ environmentId: "env-other" })],
      }),
    );

    await expect(
      listTeamComputersViaHttp(BASE, BEARER, ENVIRONMENT_ID),
    ).resolves.toEqual({ kind: "network-error" });
  });

  it.each([
    [401, { kind: "unauthorized" }],
    [403, { kind: "forbidden" }],
    [404, { kind: "not-found" }],
    [409, { kind: "conflict" }],
    [502, { kind: "network-error" }],
  ] as const)(
    "maps HTTP %i to the structured result",
    async (status, result) => {
      stubFetch(
        async () => new Response("private response detail", { status }),
      );

      await expect(
        listTeamComputersViaHttp(BASE, BEARER, ENVIRONMENT_ID),
      ).resolves.toEqual(result);
    },
  );

  it("collapses malformed JSON to network-error", async () => {
    stubFetch(
      async () => new Response("private malformed response", { status: 200 }),
    );
    await expect(
      listTeamComputersViaHttp(BASE, BEARER, ENVIRONMENT_ID),
    ).resolves.toEqual({ kind: "network-error" });
  });

  it("collapses a transport error to network-error", async () => {
    stubFetch(async () => {
      throw new Error("private transport detail");
    });
    await expect(
      listTeamComputersViaHttp(BASE, BEARER, ENVIRONMENT_ID),
    ).resolves.toEqual({ kind: "network-error" });
  });
});
