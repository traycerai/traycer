import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  SlackAppRegisterRequest,
  SlackAppView,
} from "@traycer/protocol/host/slack-app";
import {
  disconnectSlackAppViaHttp,
  fetchSlackAppManifestViaHttp,
  mintSlackAppInstallUrlViaHttp,
  readSlackAppViaHttp,
  registerSlackAppViaHttp,
} from "../slack-app";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** `SLACK_APP_READ_TIMEOUT_MS`, which the module under test keeps private. */
const READ_TIMEOUT_MS = 10_000;

const APP: SlackAppView = {
  botId: BOT_ID,
  appId: "A07K2M9QX4T",
  clientId: "123.456",
  installState: "installed",
  teamId: "T01",
  teamName: "Acme",
  botUserId: "U01",
  installedAt: 1_791_000_000_000,
};

const REGISTER_REQUEST: SlackAppRegisterRequest = {
  botId: BOT_ID,
  appId: APP.appId,
  clientId: APP.clientId,
  clientSecret: "client-secret-value",
  signingSecret: "signing-secret-value",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack app transport requests", () => {
  it.each([
    {
      route: "read",
      call: () => readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
      body: { app: null },
      sent: { botId: BOT_ID },
    },
    {
      route: "manifest",
      call: () => fetchSlackAppManifestViaHttp(BASE, BEARER, null, BOT_ID),
      body: { manifest: "{}" },
      sent: { botId: BOT_ID },
    },
    {
      route: "install-url",
      call: () => mintSlackAppInstallUrlViaHttp(BASE, BEARER, null, BOT_ID),
      body: { url: "https://slack.example.test/consent", expiresAt: 1 },
      sent: { botId: BOT_ID },
    },
    {
      route: "disconnect",
      call: () => disconnectSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
      body: { app: APP },
      sent: { botId: BOT_ID },
    },
    {
      route: "register",
      call: () => registerSlackAppViaHttp(BASE, BEARER, null, REGISTER_REQUEST),
      body: { app: APP },
      sent: REGISTER_REQUEST,
    },
  ])(
    "POSTs $route to its own path with the bearer and the JSON body",
    async ({ route, call, body, sent }) => {
      const fetchMock = stubFetch(async () => jsonResponse(200, body));

      await call();

      const { url, init } = onlyCall(fetchMock);
      expect(url).toBe(`${BASE}/api/slack/apps/${route}`);
      expect(init.method).toBe("POST");
      expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
      expect(headerOf(init, "Content-Type")).toBe("application/json");
      expect(headerOf(init, "Proxy-Authorization")).toBeNull();
      expect(JSON.parse(String(init.body))).toEqual(sent);
    },
  );

  it("sends Proxy-Authorization only when a proxy token is passed", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { app: null }));

    await readSlackAppViaHttp(BASE, BEARER, "iap-token", BOT_ID);

    const { init } = onlyCall(fetchMock);
    expect(headerOf(init, "Proxy-Authorization")).toBe("Bearer iap-token");
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${BEARER}`);
  });

  it("resolves a base URL with a trailing slash to the same path", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { app: null }));

    await readSlackAppViaHttp(`${BASE}/`, BEARER, null, BOT_ID);

    expect(onlyCall(fetchMock).url).toBe(`${BASE}/api/slack/apps/read`);
  });
});

describe("Slack app transport results", () => {
  it("reads no app as ok with null", async () => {
    stubFetch(async () => jsonResponse(200, { app: null }));

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({ kind: "ok", app: null });
  });

  it("reads a registered app as ok with the app", async () => {
    stubFetch(async () => jsonResponse(200, { app: APP }));

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({ kind: "ok", app: APP });
  });

  it("returns the app a registration left", async () => {
    stubFetch(async () => jsonResponse(200, { app: APP }));

    await expect(
      registerSlackAppViaHttp(BASE, BEARER, null, REGISTER_REQUEST),
    ).resolves.toEqual({ kind: "ok", app: APP });
  });

  it.each([401, 403])("maps HTTP %i to unauthorized", async (status) => {
    stubFetch(async () => jsonResponse(status, { code: "ANYTHING" }));

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("maps the server's typed 404 to a refusal with status and code", async () => {
    stubFetch(async () =>
      jsonResponse(404, {
        statusCode: 404,
        error: "Not found",
        code: "NOT_FOUND",
      }),
    );

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({ kind: "refused", status: 404, code: "NOT_FOUND" });
  });

  it("maps a 503 slack_not_configured to a refusal with its code", async () => {
    stubFetch(async () =>
      jsonResponse(503, {
        statusCode: 503,
        error: "Service Unavailable",
        code: "slack_not_configured",
      }),
    );

    await expect(
      fetchSlackAppManifestViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({
      kind: "refused",
      status: 503,
      code: "slack_not_configured",
    });
  });

  it("maps a non-2xx without a typed body to a network error that names only the status", async () => {
    stubFetch(
      async () =>
        new Response("<html>Bad gateway from proxy</html>", { status: 502 }),
    );

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the server answered HTTP 502 without a typed refusal",
    });
  });

  it("maps a transport throw to a network error", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it("maps a 2xx body that breaks the contract to a network error", async () => {
    stubFetch(async () =>
      jsonResponse(200, { app: { ...APP, installState: "exploded" } }),
    );

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the Slack app read answer did not match the contract",
    });
  });

  it.each([
    { field: "an empty appId", app: { ...APP, appId: "" } },
    { field: "a lowercase teamId", app: { ...APP, teamId: "t0abc" } },
  ])("maps a 2xx app with $field to a network error", async ({ app }) => {
    stubFetch(async () => jsonResponse(200, { app }));

    await expect(
      readSlackAppViaHttp(BASE, BEARER, null, BOT_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the Slack app read answer did not match the contract",
    });
  });

  it("never echoes the register request's secrets in a failure", async () => {
    stubFetch(
      async () =>
        new Response(
          `boom ${REGISTER_REQUEST.clientSecret} ${REGISTER_REQUEST.signingSecret}`,
          { status: 500 },
        ),
    );

    const result = await registerSlackAppViaHttp(
      BASE,
      BEARER,
      null,
      REGISTER_REQUEST,
    );

    expect(result.kind).toBe("network-error");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(REGISTER_REQUEST.clientSecret);
    expect(serialized).not.toContain(REGISTER_REQUEST.signingSecret);
  });
});

describe("Slack app transport on a fetch that ignores its signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a read at the deadline as a network error, and a late answer does not change it", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // test can settle the request.
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;

    const pending = readSlackAppViaHttp(BASE, BEARER, null, BOT_ID);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const timedOut = {
      kind: "network-error",
      detail: "the request never completed (TimeoutError)",
    };
    expect(await pending).toEqual(timedOut);

    answer(jsonResponse(200, { app: APP }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual(timedOut);
  });
});
