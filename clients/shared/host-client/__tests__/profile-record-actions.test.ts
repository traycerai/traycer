import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nameProfileRecordViaHttp,
  readProfileRecordsViaHttp,
  removeProfileRecordViaHttp,
  signOutProfileRecordViaHttp,
} from "../profile-record-actions";

const AUTHN_BASE_URL = "https://authn.synthetic.test";
const SESSION_BEARER = "synthetic-verified-session";
const ENVIRONMENT_ID = "environment-synthetic";
const PROVIDER_ID = "claude-code";
const HARNESS_ID = "claude";
const REQUEST_PROFILE_ID = "profile-alias";
const RESPONSE_PROFILE_ID = "profile-canonical";
const CALLER_SIGNAL = null;
const FORBIDDEN_COPY = "You don't have permission to do that.";
const PRIVATE_500_CANARY = "synthetic-private-500-canary";

interface CapturedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: BodyInit | null | undefined;
  readonly authorization: string | null;
  readonly accept: string | null;
  readonly contentType: string | null;
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFakeFetch(
  respond: (request: CapturedRequest) => Promise<Response>,
) {
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const headers = new Headers(init?.headers);
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method,
      body: init?.body,
      authorization: headers.get("Authorization"),
      accept: headers.get("Accept"),
      contentType: headers.get("Content-Type"),
    };
    requests.push(request);
    return respond(request);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

function expectedPost(suffix: string, body: object): CapturedRequest {
  return {
    url: `${AUTHN_BASE_URL}/api/v3/environments/${ENVIRONMENT_ID}/profile-records/${REQUEST_PROFILE_ID}${suffix}`,
    method: "POST",
    body: JSON.stringify(body),
    authorization: `Bearer ${SESSION_BEARER}`,
    accept: "application/json",
    contentType: "application/json",
  };
}

function expectRequests(
  requests: readonly CapturedRequest[],
  expected: CapturedRequest,
  count: number,
): void {
  expect(requests).toEqual(Array.from({ length: count }, () => expected));
}

const ACTION_RESPONSE = {
  profileId: RESPONSE_PROFILE_ID,
  harnessId: HARNESS_ID,
  recordRevision: "17",
};

const ACTIONS = [
  {
    name: "sign out",
    suffix: "/sign-out",
    requestBody: { harnessId: HARNESS_ID },
    responseBody: ACTION_RESPONSE,
    expectedSuccess: {
      kind: "ok",
      ...ACTION_RESPONSE,
    },
    failureCopy: "Couldn't sign out.",
    invoke: () =>
      signOutProfileRecordViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        PROVIDER_ID,
        REQUEST_PROFILE_ID,
        CALLER_SIGNAL,
      ),
  },
  {
    name: "remove",
    suffix: "/remove",
    requestBody: { harnessId: HARNESS_ID },
    responseBody: ACTION_RESPONSE,
    expectedSuccess: {
      kind: "ok",
      ...ACTION_RESPONSE,
    },
    failureCopy: "Couldn't remove profile.",
    invoke: () =>
      removeProfileRecordViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        PROVIDER_ID,
        REQUEST_PROFILE_ID,
        CALLER_SIGNAL,
      ),
  },
  {
    name: "name",
    suffix: "/name",
    requestBody: { harnessId: HARNESS_ID, name: "Renamed profile" },
    responseBody: { ...ACTION_RESPONSE, name: "Renamed profile" },
    expectedSuccess: {
      kind: "ok",
      ...ACTION_RESPONSE,
      name: "Renamed profile",
    },
    failureCopy: "Couldn't rename profile.",
    invoke: () =>
      nameProfileRecordViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        PROVIDER_ID,
        REQUEST_PROFILE_ID,
        "Renamed profile",
        CALLER_SIGNAL,
      ),
  },
] as const;

const REFUSALS = [
  {
    status: 404,
    code: "profile_record_not_found",
    kind: "not-found",
  },
  {
    status: 409,
    code: "profile_record_alias_ambiguous",
    kind: "ambiguous",
  },
  {
    status: 403,
    code: "environment_action_forbidden",
    kind: "forbidden",
  },
  {
    status: 404,
    code: "environment_not_found",
    kind: "not-found",
  },
  {
    status: 400,
    code: "profile_record_action_invalid",
    kind: "invalid",
  },
] as const;

type ReaderLabel = "live" | "waiting" | "needs-sign-in";

function sessionRecordFields(profileId: string, name: string) {
  return {
    profileId,
    harnessId: HARNESS_ID,
    name,
    color: null,
    enabled: true,
    kind: "oauth_code",
    state: "live",
    custodyMode: "owned",
    signInNumber: "2",
    renewalNumber: "0",
    recordRevision: "5",
    personIntentNumber: "0",
    expiresAt: 1,
    renewal: { unsettledSince: 1, standing: "lost" },
    otherNames: ["Earlier name"],
  };
}

function sessionRecord(
  profileId: string,
  name: string,
  readerLabel: ReaderLabel,
) {
  return { ...sessionRecordFields(profileId, name), readerLabel };
}

function sessionEnvelope(records: readonly object[]) {
  return {
    enabled: true,
    environmentRevision: "12",
    records,
    removed: [],
    aliases: [],
    providerKeys: [],
  };
}

const LIST_URL = `${AUTHN_BASE_URL}/api/v3/environments/${ENVIRONMENT_ID}/profile-records`;

function expectedGet(): CapturedRequest {
  return {
    url: LIST_URL,
    method: "GET",
    body: null,
    authorization: `Bearer ${SESSION_BEARER}`,
    accept: "application/json",
    contentType: "application/json",
  };
}

function projectedProfile(
  profileId: string,
  label: string,
  readerLabel: ReaderLabel,
) {
  return {
    profileId,
    kind: "managed",
    label,
    accentColor: null,
    enabled: true,
    authType: "oauth",
    auth: {
      status:
        readerLabel === "needs-sign-in" ? "unauthenticated" : "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    personNotice: readerLabel === "live" ? null : readerLabel,
    otherNames: ["Earlier name"],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("profile-record action HTTP consumers", () => {
  it.each(ACTIONS)(
    "$name sends its strict request and accepts a repeated 200",
    async (action) => {
      const { requests } = installFakeFetch(async () =>
        jsonResponse(200, action.responseBody),
      );

      await expect(action.invoke()).resolves.toEqual(action.expectedSuccess);
      await expect(action.invoke()).resolves.toEqual(action.expectedSuccess);

      expectRequests(
        requests,
        expectedPost(action.suffix, action.requestBody),
        2,
      );
    },
  );

  it.each(ACTIONS)(
    "$name maps every closed refusal by code",
    async (action) => {
      for (const refusal of REFUSALS) {
        const { requests } = installFakeFetch(async () =>
          jsonResponse(refusal.status, {
            statusCode: refusal.status,
            error: "synthetic refusal",
            code: refusal.code,
          }),
        );
        const failureCopy =
          refusal.code === "environment_action_forbidden"
            ? FORBIDDEN_COPY
            : action.failureCopy;

        await expect(action.invoke()).resolves.toEqual({
          kind: refusal.kind,
          code: refusal.code,
          message: failureCopy,
        });
        expectRequests(
          requests,
          expectedPost(action.suffix, action.requestBody),
          1,
        );
      }
    },
  );

  it.each(ACTIONS)(
    "$name does not expose an untyped 500 body",
    async (action) => {
      const { requests } = installFakeFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ statusCode: 500, error: PRIVATE_500_CANARY }),
            { status: 500 },
          ),
        ),
      );

      const result = await action.invoke();

      expect(result).toEqual({ kind: "failed", message: action.failureCopy });
      expect((JSON.stringify(result) ?? "").includes(PRIVATE_500_CANARY)).toBe(
        false,
      );
      expectRequests(
        requests,
        expectedPost(action.suffix, action.requestBody),
        1,
      );
    },
  );

  it.each(ACTIONS)(
    "$name fails closed for invalid JSON and no answer",
    async (action) => {
      const malformed = installFakeFetch(
        async () => new Response("synthetic malformed JSON", { status: 200 }),
      );
      await expect(action.invoke()).resolves.toEqual({
        kind: "failed",
        message: action.failureCopy,
      });
      expectRequests(
        malformed.requests,
        expectedPost(action.suffix, action.requestBody),
        1,
      );

      const rejectedRequests: CapturedRequest[] = [];
      const rejectedFetch = vi.fn<typeof fetch>(async (input, init) => {
        const headers = new Headers(init?.headers);
        rejectedRequests.push({
          url: String(input),
          method: init?.method,
          body: init?.body,
          authorization: headers.get("Authorization"),
          accept: headers.get("Accept"),
          contentType: headers.get("Content-Type"),
        });
        throw new Error("synthetic transport unavailable");
      });
      vi.stubGlobal("fetch", rejectedFetch);

      await expect(action.invoke()).resolves.toEqual({
        kind: "failed",
        message: action.failureCopy,
      });
      expectRequests(
        rejectedRequests,
        expectedPost(action.suffix, action.requestBody),
        1,
      );
    },
  );

  it.each(ACTIONS)("$name rejects malformed 200 answers", async (action) => {
    const { requests } = installFakeFetch(async () =>
      jsonResponse(200, { ...action.responseBody, extraField: "synthetic" }),
    );

    await expect(action.invoke()).resolves.toEqual({
      kind: "failed",
      message: action.failureCopy,
    });
    expectRequests(
      requests,
      expectedPost(action.suffix, action.requestBody),
      1,
    );
  });

  it.each(ACTIONS)(
    "$name rejects a coded refusal with the wrong HTTP status",
    async (action) => {
      const { requests } = installFakeFetch(async () =>
        jsonResponse(409, {
          statusCode: 404,
          error: "synthetic refusal",
          code: "profile_record_not_found",
        }),
      );

      await expect(action.invoke()).resolves.toEqual({
        kind: "failed",
        message: action.failureCopy,
      });
      expectRequests(
        requests,
        expectedPost(action.suffix, action.requestBody),
        1,
      );
    },
  );

  it.each(ACTIONS)("$name treats an uncoded 403 as failed", async (action) => {
    const { requests } = installFakeFetch(async () =>
      jsonResponse(403, {
        statusCode: 403,
        error: "synthetic refusal",
      }),
    );

    await expect(action.invoke()).resolves.toEqual({
      kind: "failed",
      message: action.failureCopy,
    });
    expectRequests(
      requests,
      expectedPost(action.suffix, action.requestBody),
      1,
    );
  });

  it.each(ACTIONS)(
    "$name maps an untyped 401 to unauthorized",
    async (action) => {
      const { requests } = installFakeFetch(
        async () => new Response(null, { status: 401 }),
      );

      await expect(action.invoke()).resolves.toEqual({
        kind: "unauthorized",
        message: "Please sign in again.",
      });
      expectRequests(
        requests,
        expectedPost(action.suffix, action.requestBody),
        1,
      );
    },
  );
});

describe("readProfileRecordsViaHttp", () => {
  it("projects a disabled list without requiring record collections", async () => {
    const { requests } = installFakeFetch(async () =>
      jsonResponse(200, { enabled: false }),
    );

    await expect(
      readProfileRecordsViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        CALLER_SIGNAL,
      ),
    ).resolves.toEqual({
      kind: "ok",
      list: { profileSyncEnabled: false, providers: [] },
    });
    expectRequests(requests, expectedGet(), 1);
  });

  it("uses the broker readerLabel projection for all three standings", async () => {
    const body = sessionEnvelope([
      sessionRecord("profile-live", "Live profile", "live"),
      sessionRecord("profile-waiting", "Waiting profile", "waiting"),
      sessionRecord(
        "profile-needs-sign-in",
        "Needs sign-in profile",
        "needs-sign-in",
      ),
    ]);
    const { requests } = installFakeFetch(async () => jsonResponse(200, body));

    await expect(
      readProfileRecordsViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        CALLER_SIGNAL,
      ),
    ).resolves.toEqual({
      kind: "ok",
      list: {
        profileSyncEnabled: true,
        providers: [
          {
            providerId: PROVIDER_ID,
            profiles: [
              projectedProfile("profile-live", "Live profile", "live"),
              projectedProfile("profile-waiting", "Waiting profile", "waiting"),
              projectedProfile(
                "profile-needs-sign-in",
                "Needs sign-in profile",
                "needs-sign-in",
              ),
            ],
          },
        ],
      },
    });
    expectRequests(requests, expectedGet(), 1);
  });

  it.each([
    {
      name: "a record without readerLabel",
      body: sessionEnvelope([
        sessionRecordFields("profile-missing-label", "Missing label"),
      ]),
    },
    {
      name: "the computer-only account key",
      body: sessionEnvelope([
        {
          ...sessionRecord("profile-computer-key", "Computer key", "live"),
          completeAccountKey: null,
        },
      ]),
    },
    {
      name: "the computer-only joining fence",
      body: {
        ...sessionEnvelope([
          sessionRecord("profile-computer-fence", "Computer fence", "live"),
        ]),
        joiningFence: 1,
      },
    },
    {
      name: "an extra envelope field",
      body: {
        ...sessionEnvelope([
          sessionRecord("profile-extra-envelope", "Extra envelope", "live"),
        ]),
        futureField: "synthetic",
      },
    },
    {
      name: "an extra session-record field",
      body: sessionEnvelope([
        {
          ...sessionRecord("profile-extra-record", "Extra record", "live"),
          futureField: "synthetic",
        },
      ]),
    },
    {
      name: "a malformed revision field",
      body: sessionEnvelope([
        {
          ...sessionRecord(
            "profile-malformed-revision",
            "Bad revision",
            "live",
          ),
          signInNumber: 3,
        },
      ]),
    },
  ])("rejects $name in the strict session answer", async ({ body }) => {
    const { requests } = installFakeFetch(async () => jsonResponse(200, body));

    await expect(
      readProfileRecordsViaHttp(
        AUTHN_BASE_URL,
        SESSION_BEARER,
        ENVIRONMENT_ID,
        CALLER_SIGNAL,
      ),
    ).resolves.toEqual({ kind: "failed" });
    expectRequests(requests, expectedGet(), 1);
  });
});
