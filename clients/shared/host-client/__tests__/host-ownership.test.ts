import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { readHostOwnershipViaHttp } from "../host-ownership";

const AUTHN = "https://authn.example.test";
const BEARER = "member-session-token";
const HOST_ID = "host-local-a";
const OTHER_HOST_ID = "host-local-b";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(respond: () => Promise<Response>): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function localHost(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hostId: HOST_ID,
    owner: { kind: "user", id: "user-a" },
    kind: "personal",
    remoteAccess: false,
    sandboxState: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readHostOwnershipViaHttp", () => {
  it("requests the ownership projection with the user bearer and returns a local personal host", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(
        jsonResponse(200, {
          hosts: [
            localHost({
              hostId: OTHER_HOST_ID,
              owner: { kind: "user", id: "user-b" },
            }),
            localHost({}),
          ],
        }),
      ),
    );

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({
      kind: "ok",
      host: {
        hostId: HOST_ID,
        owner: { kind: "user", id: "user-a" },
        kind: "personal",
        remoteAccess: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe(
      `${AUTHN}/api/v3/hosts?include=owner%2CremoteAccess%2CsandboxState`,
    );
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${BEARER}`,
    );
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    expect(init?.body).toBeUndefined();
  });

  it("keeps a transferred host personal with remote access off and narrows extra fields", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(
        jsonResponse(200, {
          hosts: [
            localHost({
              owner: { kind: "team", id: "team-a", name: "Acme" },
              remoteAccess: false,
              sandboxState: "awake",
              futureHostField: "ignored",
            }),
          ],
        }),
      ),
    );

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({
      kind: "ok",
      host: {
        hostId: HOST_ID,
        owner: { kind: "team", id: "team-a", name: "Acme" },
        kind: "personal",
        remoteAccess: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing owner", localHost({ owner: undefined })],
    ["invalid owner", localHost({ owner: { kind: "team", id: "team-a" } })],
    [
      "malformed remote access",
      localHost({ remoteAccess: { enabled: "off", epoch: 0 } }),
    ],
    ["unknown host kind", localHost({ kind: "other" })],
  ] as const)("fails closed for %s", async (_case, host) => {
    stubFetch(() => Promise.resolve(jsonResponse(200, { hosts: [host] })));

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({ kind: "network-error" });
  });

  it("fails closed for a malformed JSON response", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("private malformed body", { status: 200 })),
    );

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({ kind: "network-error" });
  });

  it("returns only the exact requested host and reports not-found when it is absent", async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(200, {
          hosts: [localHost({ hostId: OTHER_HOST_ID })],
        }),
      ),
    );

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({ kind: "not-found" });
  });

  it("maps unauthorized responses without exposing their body", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("private account detail", { status: 401 })),
    );

    await expect(
      readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("settles a request that ignores abort at the timeout without leaking an error", async () => {
    vi.useFakeTimers();
    stubFetch(() => new Promise<Response>(() => {}));

    const pending = readHostOwnershipViaHttp(AUTHN, BEARER, HOST_ID);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ kind: "network-error" });
  });
});
