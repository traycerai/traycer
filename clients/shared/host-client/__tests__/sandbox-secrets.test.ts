import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  SANDBOX_SECRETS_FETCH_TIMEOUT_MS,
  decideSecretRequestViaHttp,
  fetchEnvironmentProvidersViaHttp,
  fetchSandboxGrantsViaHttp,
  fetchTeamEnvironmentViaHttp,
} from "../sandbox-secrets";

const BASE = "https://auth.example.test";
const BEARER = "user-jwt";
const ENV_ID = "env_team-1";
const HOST_ID = "host_abc-123";
const REQUEST_ID = "req_01JBZ8K3M4N5P6Q7R8S9T0VWXY";

/** Ids that are not one plain path segment, so no URL is built from them. */
const UNSAFE_IDS = [
  "",
  ".",
  "..",
  "a/b",
  "../x",
  "a%2Fb",
  "odd id",
  "a?b",
  "a#b",
  "x".repeat(129),
] as const;

const INVALID_ID_RESULT = {
  kind: "network-error",
  detail: "the id is not one path segment",
};

const SUMMARY_BODY = {
  version: 3,
  grants: [
    {
      secretName: "DB_PASSWORD",
      kind: "password",
      protocol: "mysql",
      mode: "brokered",
      source: "approved",
      connectorName: null,
      rotation: null,
      routes: [
        {
          route: "route-1",
          destination: "db.example.com",
          port: 3306,
          unready: null,
        },
      ],
    },
  ],
  github: {
    linked: true,
    installations: [{ account: "traycerai", repositorySelection: "all" }],
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

/** Stubs `fetch` with a responder that builds a fresh Response per call. */
function stubFetch(respond: () => Response): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(respond()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubRejectingFetch(error: unknown): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(error));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSandboxGrantsViaHttp", () => {
  it("GETs the host's grants route with the user bearer and no body", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    await fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/v3/environments/${ENV_ID}/secrets/hosts/${HOST_ID}/grants`,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          Accept: "application/json",
        },
        body: null,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("joins the path onto a base URL that already ends in a slash", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    await fetchSandboxGrantsViaHttp(`${BASE}/`, BEARER, ENV_ID, HOST_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/v3/environments/${ENV_ID}/secrets/hosts/${HOST_ID}/grants`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps a path prefix on the base URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    await fetchSandboxGrantsViaHttp(`${BASE}/gateway`, BEARER, ENV_ID, HOST_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/gateway/api/v3/environments/${ENV_ID}/secrets/hosts/${HOST_ID}/grants`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("bounds the call with a positive timeout", () => {
    expect(SANDBOX_SECRETS_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns the parsed summary on a 200", async () => {
    stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    const result = await fetchSandboxGrantsViaHttp(
      BASE,
      BEARER,
      ENV_ID,
      HOST_ID,
    );

    expect(result).toEqual({ kind: "ok", summary: SUMMARY_BODY });
  });

  it("fills the defaults of a sparse 200 and drops fields it does not know", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        version: 1,
        grants: [
          {
            secretName: "TOKEN",
            kind: "token",
            protocol: "https",
            mode: "exposed",
            source: "default",
            futureField: true,
          },
        ],
        futureTopLevel: 1,
      }),
    );

    const result = await fetchSandboxGrantsViaHttp(
      BASE,
      BEARER,
      ENV_ID,
      HOST_ID,
    );

    expect(result).toEqual({
      kind: "ok",
      summary: {
        version: 1,
        grants: [
          {
            secretName: "TOKEN",
            kind: "token",
            protocol: "https",
            mode: "exposed",
            source: "default",
            connectorName: null,
            rotation: null,
            routes: [],
          },
        ],
        github: null,
      },
    });
  });

  it("fails a 200 whose body does not match the contract", async () => {
    stubFetch(() => jsonResponse(200, { grants: "none" }));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the grants summary did not match the contract",
    });
  });

  it("fails a 200 with a body that is not JSON", async () => {
    stubFetch(() => textResponse(200, "<html>proxy error</html>"));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the grants summary did not match the contract",
    });
  });

  it("fails a 200 with an empty body", async () => {
    stubFetch(() => textResponse(200, ""));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the grants summary did not match the contract",
    });
  });

  it.each([401, 403])("reads a %i as unauthorized", async (status) => {
    stubFetch(() => jsonResponse(status, { error: "no" }));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("reads a 404 as not-found, even with an unparsable body", async () => {
    stubFetch(() => textResponse(404, "<html>not found</html>"));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({ kind: "not-found" });
  });

  it.each([500, 502, 400, 409, 201])(
    "reads a %i as a network error naming the status",
    async (status) => {
      stubFetch(() => jsonResponse(status, SUMMARY_BODY));

      await expect(
        fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
      ).resolves.toEqual({
        kind: "network-error",
        detail: `the broker answered HTTP ${status}`,
      });
    },
  );

  it("reads a thrown fetch as a network error that names only the error class", async () => {
    stubRejectingFetch(new TypeError("connect ECONNREFUSED 10.0.0.1:443"));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it("reads a thrown non-Error as a network error", async () => {
    stubRejectingFetch("offline");

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed",
    });
  });

  it.each(UNSAFE_IDS)(
    "refuses the host id %j before any request",
    async (hostId) => {
      const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

      await expect(
        fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, hostId),
      ).resolves.toEqual(INVALID_ID_RESULT);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a 128-character id", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));
    const hostId = "h".repeat(128);

    await fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, hostId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("decideSecretRequestViaHttp", () => {
  it("POSTs the decision as JSON to the request's decide route with the user bearer", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { status: "approved" }),
    );

    await decideSecretRequestViaHttp(
      BASE,
      BEARER,
      ENV_ID,
      REQUEST_ID,
      "approve",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/v3/environments/${ENV_ID}/secrets/requests/${REQUEST_ID}/decide`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(["approve", "approve_default", "decline"] as const)(
    "sends the %s decision as the body",
    async (decision) => {
      const fetchMock = stubFetch(() =>
        jsonResponse(200, { status: "approved" }),
      );

      await decideSecretRequestViaHttp(
        BASE,
        BEARER,
        ENV_ID,
        REQUEST_ID,
        decision,
      );

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/decide"),
        expect.objectContaining({ body: JSON.stringify({ decision }) }),
      );
    },
  );

  it("returns ok with the status of a 200", async () => {
    stubFetch(() => jsonResponse(200, { status: "approved_default" }));

    await expect(
      decideSecretRequestViaHttp(
        BASE,
        BEARER,
        ENV_ID,
        REQUEST_ID,
        "approve_default",
      ),
    ).resolves.toEqual({
      kind: "ok",
      status: "approved_default",
      decidedBy: null,
    });
  });

  it("returns ok when a 200 carries a code too", async () => {
    stubFetch(() => jsonResponse(200, { status: "declined", code: null }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "decline"),
    ).resolves.toEqual({ kind: "ok", status: "declined", decidedBy: null });
  });

  it("fails a 200 whose body does not match the contract", async () => {
    stubFetch(() => jsonResponse(200, { decided: true }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it("fails a 200 with a body that is not JSON", async () => {
    stubFetch(() => textResponse(200, "ok"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it("fails a 200 with an empty status", async () => {
    stubFetch(() => jsonResponse(200, { status: "" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it("returns a conflict with the standing status and no code on a 409", async () => {
    stubFetch(() => jsonResponse(409, { status: "declined" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "declined",
      code: null,
      decidedBy: null,
    });
  });

  it("returns a conflict for an expired request", async () => {
    stubFetch(() => jsonResponse(409, { status: "expired" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "expired",
      code: null,
      decidedBy: null,
    });
  });

  it("returns a conflict carrying the secret_required code", async () => {
    stubFetch(() =>
      jsonResponse(409, { status: "pending", code: "secret_required" }),
    );

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "pending",
      code: "secret_required",
      decidedBy: null,
    });
  });

  it("returns a conflict carrying a code it does not know", async () => {
    stubFetch(() =>
      jsonResponse(409, { status: "pending", code: "some_future_code" }),
    );

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "pending",
      code: "some_future_code",
      decidedBy: null,
    });
  });

  it("fails a 409 whose body is not JSON", async () => {
    stubFetch(() => textResponse(409, "<html>conflict</html>"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it("fails a 409 with an empty body", async () => {
    stubFetch(() => textResponse(409, ""));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it("fails a 409 whose body has no status", async () => {
    stubFetch(() => jsonResponse(409, { code: "secret_required" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });

  it.each([401, 403])("reads a %i as unauthorized", async (status) => {
    stubFetch(() => jsonResponse(status, { error: "no" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("reads a 404 as not-found, even with an unparsable body", async () => {
    stubFetch(() => textResponse(404, "<html>not found</html>"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({ kind: "not-found" });
  });

  it.each([500, 502, 400, 201])(
    "reads a %i as a network error naming the status",
    async (status) => {
      stubFetch(() => jsonResponse(status, { status: "approved" }));

      await expect(
        decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
      ).resolves.toEqual({
        kind: "network-error",
        detail: `the broker answered HTTP ${status}`,
      });
    },
  );

  it("reads a thrown fetch as a network error that names only the error class", async () => {
    stubRejectingFetch(new TypeError("connect ECONNREFUSED 10.0.0.1:443"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it.each(UNSAFE_IDS)(
    "refuses the request id %j before any request",
    async (requestId) => {
      const fetchMock = stubFetch(() =>
        jsonResponse(200, { status: "approved" }),
      );

      await expect(
        decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, requestId, "approve"),
      ).resolves.toEqual(INVALID_ID_RESULT);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

const ME_URL = `${BASE}/api/v3/environments/me`;
const PERSONAL_ENV_ID = "env_personal-9";

/** Stubs `fetch` with one responder per call, in order, and records the urls. */
function stubFetchSequence(
  responders: readonly (() => Response)[],
): Mock<typeof fetch> {
  let index = 0;
  const fetchMock = vi.fn<typeof fetch>(() => {
    const respond = responders[index];
    index += 1;
    if (respond === undefined) {
      return Promise.reject(new Error("unexpected extra fetch"));
    }
    return Promise.resolve(respond());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("an environment id of null (Personal)", () => {
  it("reads environments/me first, then roots the grants call there", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse(200, { environmentId: PERSONAL_ENV_ID }),
      () => jsonResponse(200, SUMMARY_BODY),
    ]);

    const result = await fetchSandboxGrantsViaHttp(BASE, BEARER, null, HOST_ID);

    expect(result).toEqual({ kind: "ok", summary: SUMMARY_BODY });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      ME_URL,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          Accept: "application/json",
        },
        body: null,
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE}/api/v3/environments/${PERSONAL_ENV_ID}/secrets/hosts/${HOST_ID}/grants`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads environments/me first, then roots the decide call there", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse(200, { environmentId: PERSONAL_ENV_ID }),
      () => jsonResponse(200, { status: "approved" }),
    ]);

    const result = await decideSecretRequestViaHttp(
      BASE,
      BEARER,
      null,
      REQUEST_ID,
      "approve",
    );

    expect(result).toEqual({ kind: "ok", status: "approved", decidedBy: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      ME_URL,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE}/api/v3/environments/${PERSONAL_ENV_ID}/secrets/requests/${REQUEST_ID}/decide`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
  });

  it("does not read environments/me when the environment is given", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    await fetchSandboxGrantsViaHttp(BASE, BEARER, ENV_ID, HOST_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(ME_URL, expect.anything());
  });

  it.each([401, 403])(
    "returns a %i from environments/me as unauthorized, without the second call",
    async (status) => {
      const fetchMock = stubFetch(() => jsonResponse(status, { error: "no" }));

      await expect(
        fetchSandboxGrantsViaHttp(BASE, BEARER, null, HOST_ID),
      ).resolves.toEqual({ kind: "unauthorized" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a 404 from environments/me as not-found, without the second call", async () => {
    const fetchMock = stubFetch(() => textResponse(404, "<html>nope</html>"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, null, REQUEST_ID, "approve"),
    ).resolves.toEqual({ kind: "not-found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "an HTTP 500",
      () => jsonResponse(500, { environmentId: PERSONAL_ENV_ID }),
    ],
    ["a body that is not JSON", () => textResponse(200, "<html>proxy</html>")],
    ["an empty body", () => textResponse(200, "")],
    ["a body with no environmentId", () => jsonResponse(200, { id: "x" })],
    ["an empty environmentId", () => jsonResponse(200, { environmentId: "" })],
  ])(
    "returns %s from environments/me as a network error, without the second call",
    async (_name, respond) => {
      const fetchMock = stubFetch(respond);

      await expect(
        fetchSandboxGrantsViaHttp(BASE, BEARER, null, HOST_ID),
      ).resolves.toEqual({
        kind: "network-error",
        detail: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("names the contract mismatch when environments/me answers a bad body", async () => {
    stubFetch(() => jsonResponse(200, { id: "x" }));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, null, HOST_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    });
  });

  it("returns a thrown environments/me fetch as a network error, without the second call", async () => {
    const fetchMock = stubRejectingFetch(new TypeError("offline"));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, null, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an environmentId from environments/me that is not one path segment", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { environmentId: "../secrets" }),
    );

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, null, HOST_ID),
    ).resolves.toEqual(INVALID_ID_RESULT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad host id before even reading environments/me", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

    await expect(
      fetchSandboxGrantsViaHttp(BASE, BEARER, null, "a/b"),
    ).resolves.toEqual(INVALID_ID_RESULT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a bad environment id", () => {
  it.each(UNSAFE_IDS)(
    "refuses the environment id %j for the grants call before any request",
    async (environmentId) => {
      const fetchMock = stubFetch(() => jsonResponse(200, SUMMARY_BODY));

      await expect(
        fetchSandboxGrantsViaHttp(BASE, BEARER, environmentId, HOST_ID),
      ).resolves.toEqual(INVALID_ID_RESULT);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(UNSAFE_IDS)(
    "refuses the environment id %j for the decide call before any request",
    async (environmentId) => {
      const fetchMock = stubFetch(() =>
        jsonResponse(200, { status: "approved" }),
      );

      await expect(
        decideSecretRequestViaHttp(
          BASE,
          BEARER,
          environmentId,
          REQUEST_ID,
          "approve",
        ),
      ).resolves.toEqual(INVALID_ID_RESULT);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("decidedBy on the decide answer", () => {
  it("carries the name of the person whose answer settled a 200", async () => {
    stubFetch(() =>
      jsonResponse(200, { status: "approved_default", decidedBy: "Ana" }),
    );

    await expect(
      decideSecretRequestViaHttp(
        BASE,
        BEARER,
        ENV_ID,
        REQUEST_ID,
        "approve_default",
      ),
    ).resolves.toEqual({
      kind: "ok",
      status: "approved_default",
      decidedBy: "Ana",
    });
  });

  it("carries the name of the person who got there first on a 409", async () => {
    stubFetch(() =>
      jsonResponse(409, { status: "approved", decidedBy: "Ana" }),
    );

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "decline"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "approved",
      code: null,
      decidedBy: "Ana",
    });
  });

  it("reads a null decidedBy as null", async () => {
    stubFetch(() => jsonResponse(409, { status: "expired", decidedBy: null }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "conflict",
      status: "expired",
      code: null,
      decidedBy: null,
    });
  });

  it("fails an answer whose decidedBy is an empty string", async () => {
    stubFetch(() => jsonResponse(200, { status: "approved", decidedBy: "" }));

    await expect(
      decideSecretRequestViaHttp(BASE, BEARER, ENV_ID, REQUEST_ID, "approve"),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    });
  });
});

const TEAM_ID = "team-acme";

describe("fetchTeamEnvironmentViaHttp", () => {
  it("GETs the team's environment route with the user bearer and no body", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { environmentId: "env_acme" }),
    );

    await fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/v3/teams/${TEAM_ID}/environment`,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          Accept: "application/json",
        },
        body: null,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("joins the path onto a base URL that already ends in a slash", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { environmentId: "env_acme" }),
    );

    await fetchTeamEnvironmentViaHttp(`${BASE}/`, BEARER, TEAM_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/v3/teams/${TEAM_ID}/environment`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns the environment id on a 200", async () => {
    stubFetch(() => jsonResponse(200, { environmentId: "env_acme" }));

    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({ kind: "ok", environmentId: "env_acme" });
  });

  it("reads a 404 as not-a-member, even with an unparsable body", async () => {
    stubFetch(() => textResponse(404, "<html>not found</html>"));

    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({ kind: "not-a-member" });
  });

  it("reads a 401 and a 403 as unauthorized", async () => {
    stubFetch(() => jsonResponse(401, { error: "bad token" }));
    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({ kind: "unauthorized" });

    stubFetch(() => jsonResponse(403, { error: "forbidden" }));
    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("fails a 200 whose body has no environment id, is empty or is not JSON", async () => {
    const mismatch = {
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    };
    for (const respond of [
      () => jsonResponse(200, {}),
      () => jsonResponse(200, { environmentId: "" }),
      () => textResponse(200, ""),
      () => textResponse(200, "<html>proxy</html>"),
    ]) {
      stubFetch(respond);
      await expect(
        fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
      ).resolves.toEqual(mismatch);
    }
  });

  it("fails a status it has no meaning for, even with a well-formed body", async () => {
    stubFetch(() => jsonResponse(500, { environmentId: "env_acme" }));

    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    });
  });

  it("refuses an environment id the server returns that is not one path segment", async () => {
    stubFetch(() => jsonResponse(200, { environmentId: "a/b" }));

    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual(INVALID_ID_RESULT);
  });

  it("reads a thrown fetch as a network error that names only the error class", async () => {
    stubRejectingFetch(new TypeError("connect ECONNREFUSED 10.0.0.1:443"));

    await expect(
      fetchTeamEnvironmentViaHttp(BASE, BEARER, TEAM_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it("refuses a team id that is not one path segment before any request", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { environmentId: "env_acme" }),
    );

    for (const unsafe of UNSAFE_IDS) {
      await expect(
        fetchTeamEnvironmentViaHttp(BASE, BEARER, unsafe),
      ).resolves.toEqual(INVALID_ID_RESULT);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const PROVIDERS_ENV_ID = "env_acme";
const SECRETS_URL = `${BASE}/api/v3/environments/${PROVIDERS_ENV_ID}/secrets`;
const CONNECTIONS_URL = `${SECRETS_URL}/harness-connections`;

/** Stubs `fetch` with a responder per URL, so the two reads can differ. */
function stubFetchByUrl(
  respond: (url: string) => Response,
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>((input) =>
    Promise.resolve(respond(String(input))),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The two reads answering `secrets` and `connections` (each a 200 body). */
function providersResponder(
  secrets: unknown,
  connections: unknown,
): (url: string) => Response {
  return (url) =>
    url === SECRETS_URL
      ? jsonResponse(200, secrets)
      : jsonResponse(200, connections);
}

describe("fetchEnvironmentProvidersViaHttp", () => {
  it("GETs the secrets list without a trailing slash and the harness connections, each with the user bearer and no body", async () => {
    const fetchMock = stubFetchByUrl(
      providersResponder({ secrets: [] }, { connections: [] }),
    );

    await fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([input]) => String(input)).sort();
    expect(urls).toEqual([SECRETS_URL, CONNECTIONS_URL].sort());
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: `Bearer ${BEARER}`,
            Accept: "application/json",
          },
          body: null,
        }),
      );
    }
  });

  it("counts provider secrets by kind and connected plans by status, and keeps no name", async () => {
    stubFetchByUrl(
      providersResponder(
        {
          secrets: [
            { kind: "provider", name: "ANTHROPIC_API_KEY" },
            { kind: "provider", name: "OPENAI_API_KEY" },
            { kind: "password", name: "DB_PASSWORD" },
            { kind: "token", name: "GH_TOKEN" },
          ],
        },
        {
          connections: [
            { status: "connected", harness: "claude" },
            { status: "pending", harness: "codex" },
            { status: "connected", harness: "gemini" },
            { status: "disconnected", harness: "amp" },
          ],
        },
      ),
    );

    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual({
      kind: "ok",
      counts: { providerSecretCount: 2, connectedPlanCount: 2 },
    });
  });

  it("counts zero and zero for an environment with nothing", async () => {
    stubFetchByUrl(providersResponder({ secrets: [] }, { connections: [] }));

    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual({
      kind: "ok",
      counts: { providerSecretCount: 0, connectedPlanCount: 0 },
    });
  });

  it("returns the failure of the secrets read when only it fails", async () => {
    for (const [status, expected] of [
      [401, { kind: "unauthorized" }],
      [404, { kind: "not-found" }],
      [500, { kind: "network-error", detail: "the broker answered HTTP 500" }],
    ] as const) {
      stubFetchByUrl((url) =>
        url === SECRETS_URL
          ? jsonResponse(status, { error: "x" })
          : jsonResponse(200, { connections: [{ status: "connected" }] }),
      );
      await expect(
        fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
      ).resolves.toEqual(expected);
    }
  });

  it("returns the failure of the connections read when only it fails", async () => {
    for (const [status, expected] of [
      [403, { kind: "unauthorized" }],
      [404, { kind: "not-found" }],
      [502, { kind: "network-error", detail: "the broker answered HTTP 502" }],
    ] as const) {
      stubFetchByUrl((url) =>
        url === CONNECTIONS_URL
          ? jsonResponse(status, { error: "x" })
          : jsonResponse(200, { secrets: [{ kind: "provider" }] }),
      );
      await expect(
        fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
      ).resolves.toEqual(expected);
    }
  });

  it("reads one thrown fetch as a network error naming only the error class", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      String(input) === CONNECTIONS_URL
        ? Promise.reject(new TypeError("connect ECONNREFUSED 10.0.0.1:443"))
        : Promise.resolve(jsonResponse(200, { secrets: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });

  it("fails a 200 from either read whose body does not match the contract", async () => {
    const mismatch = {
      kind: "network-error",
      detail: "the providers answer did not match the contract",
    };
    stubFetchByUrl(providersResponder({ nope: true }, { connections: [] }));
    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual(mismatch);

    stubFetchByUrl(providersResponder({ secrets: [] }, { connections: 4 }));
    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual(mismatch);

    stubFetchByUrl((url) =>
      url === SECRETS_URL
        ? textResponse(200, "<html>proxy</html>")
        : jsonResponse(200, { connections: [] }),
    );
    await expect(
      fetchEnvironmentProvidersViaHttp(BASE, BEARER, PROVIDERS_ENV_ID),
    ).resolves.toEqual(mismatch);
  });

  it("refuses an environment id that is not one path segment before any request", async () => {
    const fetchMock = stubFetchByUrl(
      providersResponder({ secrets: [] }, { connections: [] }),
    );

    for (const unsafe of UNSAFE_IDS) {
      await expect(
        fetchEnvironmentProvidersViaHttp(BASE, BEARER, unsafe),
      ).resolves.toEqual(INVALID_ID_RESULT);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decideSecretRequestViaHttp on a fetch that ignores its signal", () => {
  const TIMED_OUT = {
    kind: "network-error",
    detail: "the request never completed (TimeoutError)",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at the deadline as a network error when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    let settled = false;

    const pending = decideSecretRequestViaHttp(
      BASE,
      BEARER,
      ENV_ID,
      REQUEST_ID,
      "approve",
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SANDBOX_SECRETS_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(TIMED_OUT);
  });

  it("settles at the deadline as a network error when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const text = vi
      .spyOn(response, "text")
      .mockImplementation(() => new Promise<string>(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );
    let settled = false;

    const pending = decideSecretRequestViaHttp(
      BASE,
      BEARER,
      ENV_ID,
      REQUEST_ID,
      "approve",
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SANDBOX_SECRETS_FETCH_TIMEOUT_MS - 1);
    expect(text).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(TIMED_OUT);
  });
});
