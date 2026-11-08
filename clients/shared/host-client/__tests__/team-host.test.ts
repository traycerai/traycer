import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { mintTeamHostInstallTokenViaHttp } from "../team-host";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
const ENVIRONMENT_ID = "env_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "6f1c2a4e-3b5d-4c7e-8f90-a1b2c3d4e5f6";
const INSTALL_TOKEN = "install-token-secret-value";
const EXPIRES_AT = 1_791_000_000_000;
/** `TEAM_HOST_INSTALL_TOKEN_TIMEOUT_MS`, which the module under test keeps private. */
const TIMEOUT_MS = 70_000;

const OK_BODY = {
  hostId: HOST_ID,
  installToken: INSTALL_TOKEN,
  expiresAt: EXPIRES_AT,
};

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

/** The one request the stubbed fetch saw. */
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

function mint(proxyToken: string | null) {
  return mintTeamHostInstallTokenViaHttp(
    BASE,
    BEARER,
    proxyToken,
    ENVIRONMENT_ID,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("team host install token request", () => {
  it("POSTs an empty JSON body to the environment's route with the bearer", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, OK_BODY));

    await mint(null);

    const { url, init } = onlyCall(fetchMock);
    expect(url).toBe(
      `${BASE}/api/environments/${ENVIRONMENT_ID}/team-host/install-token`,
    );
    expect(init.method).toBe("POST");
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headerOf(init, "Content-Type")).toBe("application/json");
    expect(headerOf(init, "Proxy-Authorization")).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("encodes the environment id as one path segment", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, OK_BODY));

    await mintTeamHostInstallTokenViaHttp(BASE, BEARER, null, "env/1 ?x");

    expect(onlyCall(fetchMock).url).toBe(
      `${BASE}/api/environments/env%2F1%20%3Fx/team-host/install-token`,
    );
  });

  it("sends Proxy-Authorization only when a proxy token is passed", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, OK_BODY));

    await mint("iap-token");

    const { init } = onlyCall(fetchMock);
    expect(headerOf(init, "Proxy-Authorization")).toBe("Bearer iap-token");
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
  });

  it("resolves a base URL with a trailing slash to the same path", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, OK_BODY));

    await mintTeamHostInstallTokenViaHttp(
      `${BASE}/`,
      BEARER,
      null,
      ENVIRONMENT_ID,
    );

    expect(onlyCall(fetchMock).url).toBe(
      `${BASE}/api/environments/${ENVIRONMENT_ID}/team-host/install-token`,
    );
  });
});

describe("team host install token results", () => {
  it("returns the host, the token and its expiry on a 200", async () => {
    stubFetch(async () => jsonResponse(200, OK_BODY));

    await expect(mint(null)).resolves.toEqual({ kind: "ok", ...OK_BODY });
  });

  it("maps a 409 team_host_exists to team-host-exists", async () => {
    stubFetch(async () =>
      jsonResponse(409, {
        statusCode: 409,
        error: "Conflict",
        code: "team_host_exists",
      }),
    );

    await expect(mint(null)).resolves.toEqual({ kind: "team-host-exists" });
  });

  it("maps a 409 with any other code to a refusal", async () => {
    stubFetch(async () => jsonResponse(409, { code: "something_else" }));

    await expect(mint(null)).resolves.toEqual({
      kind: "refused",
      status: 409,
      code: "something_else",
    });
  });

  it.each([
    {
      name: "a typed body",
      respond: () => jsonResponse(404, { code: "NOT_FOUND" }),
    },
    { name: "no body", respond: () => new Response(null, { status: 404 }) },
  ])("maps a 404 with $name to not-found", async ({ respond }) => {
    stubFetch(async () => respond());

    await expect(mint(null)).resolves.toEqual({ kind: "not-found" });
  });

  it.each([401, 403])("maps HTTP %i to unauthorized", async (status) => {
    stubFetch(async () => jsonResponse(status, { code: "ANYTHING" }));

    await expect(mint(null)).resolves.toEqual({ kind: "unauthorized" });
  });

  it("maps a 503 to unavailable with the person's line", async () => {
    stubFetch(async () =>
      jsonResponse(503, {
        statusCode: 503,
        error: "Service Unavailable",
        code: "unavailable",
      }),
    );

    await expect(mint(null)).resolves.toEqual({
      kind: "unavailable",
      reason: "The service is unavailable right now. Try again shortly.",
    });
  });

  it("maps another typed non-2xx to a refusal with its status and code", async () => {
    stubFetch(async () => jsonResponse(429, { code: "rate_limited" }));

    await expect(mint(null)).resolves.toEqual({
      kind: "refused",
      status: 429,
      code: "rate_limited",
    });
  });

  it("maps a non-2xx without a typed body to a network error that names only the status", async () => {
    stubFetch(
      async () =>
        new Response("<html>Bad gateway from proxy</html>", { status: 502 }),
    );

    await expect(mint(null)).resolves.toEqual({
      kind: "network-error",
      detail: "the server answered HTTP 502 without a typed refusal",
    });
  });

  it("maps a transport throw to a network error", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(mint(null)).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it.each([
    { name: "a missing token", body: { ...OK_BODY, installToken: undefined } },
    { name: "an empty token", body: { ...OK_BODY, installToken: "" } },
    {
      name: "a host id that is not a uuid",
      body: { ...OK_BODY, hostId: "host-1" },
    },
    { name: "a fractional expiry", body: { ...OK_BODY, expiresAt: 1.5 } },
    { name: "a non-object body", body: [INSTALL_TOKEN] },
  ])("maps a 2xx with $name to a network error", async ({ body }) => {
    stubFetch(async () => jsonResponse(200, body));

    await expect(mint(null)).resolves.toEqual({
      kind: "network-error",
      detail: "the team host install token answer did not match the contract",
    });
  });

  it("never echoes the token in a failure", async () => {
    const failures = [
      new Response(`boom ${INSTALL_TOKEN}`, { status: 500 }),
      jsonResponse(500, { code: "boom", message: INSTALL_TOKEN }),
      jsonResponse(200, { ...OK_BODY, hostId: INSTALL_TOKEN }),
    ];
    for (const failure of failures) {
      stubFetch(async () => failure);

      const result = await mint(null);

      expect(result.kind, String(failure.status)).not.toBe("ok");
      expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
    }
  });
});

describe("team host install token on a fetch that ignores its signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at the deadline as a network error, and a late answer is never read", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // test can settle the request.
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    let settled = false;

    const pending = mint(null);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({
      kind: "network-error",
      detail: "the request never completed (TimeoutError)",
    });

    const late = jsonResponse(200, OK_BODY);
    const lateText = vi.spyOn(late, "text");
    answer(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateText).not.toHaveBeenCalled();
  });
});
