import { afterEach, describe, expect, it } from "vitest";
import {
  recordSignInRequestOnce,
  recordSignInRequestViaHttp,
  type SignInRecording,
  type SignInRequestRecordAnswer,
} from "@traycer-clients/shared/host-client/provider-sign-in-request";
import {
  installSignInRequestFetchHarness,
  BROKER_UNAVAILABLE_SIGN_IN_REQUEST_REPLY,
  ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
  FORBIDDEN_SIGN_IN_REQUEST_REPLY,
  HOST_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
  MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
  noAnswerReply,
  OPERATION_ACCEPTANCE_INVALID_SIGN_IN_REQUEST_REPLY,
  RECORDED_SIGN_IN_REQUEST_REPLY,
  responseReply,
  SIGN_IN_REQUEST_AUTHN_URL,
  SIGN_IN_REQUEST_BEARER,
  SIGN_IN_REQUEST_FIXTURE,
  UNAUTHORIZED_SIGN_IN_REQUEST_REPLY,
  unreadableBodyReply,
  type SignInRequestFetchHarness,
  type SignInRequestFetchReply,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";

let activeHarness: SignInRequestFetchHarness | null = null;

afterEach(() => {
  activeHarness?.restore();
  activeHarness = null;
});

function harness(): SignInRequestFetchHarness {
  activeHarness = installSignInRequestFetchHarness();
  return activeHarness;
}

const RECORD_ANSWER_CASES = [
  {
    name: "a matching 200 answer",
    reply: RECORDED_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "recorded" },
  },
  {
    name: "a different operation id in a 200 answer",
    reply: responseReply(200, {
      operationId: "c2f73144-f1a0-4c9e-bf74-53c5c22c1542",
      endsAt: 1_800_000_000,
    }),
    expected: { kind: "failed" },
  },
  {
    name: "an unreadable 200 body",
    reply: { kind: "response", status: 200, body: "not-json" },
    expected: { kind: "failed" },
  },
  {
    name: "a 401 answer",
    reply: UNAUTHORIZED_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "unauthorized" },
  },
  {
    name: "a 401 answer with an unreadable body",
    reply: unreadableBodyReply(401),
    expected: { kind: "unauthorized" },
  },
  {
    name: "a 403 answer",
    reply: FORBIDDEN_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "forbidden" },
  },
  {
    name: "a 403 answer with an unreadable body",
    reply: unreadableBodyReply(403),
    expected: { kind: "forbidden" },
  },
  {
    name: "the duplicate operation code in a 409 answer",
    reply: MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "duplicate" },
  },
  {
    name: "an operation acceptance invalid 409 answer",
    reply: OPERATION_ACCEPTANCE_INVALID_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "failed" },
  },
  {
    name: "an environment not found 404 answer",
    reply: ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "failed" },
  },
  {
    name: "a host not found 404 answer",
    reply: HOST_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "failed" },
  },
  {
    name: "a broker unavailable 503 answer",
    reply: BROKER_UNAVAILABLE_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "failed" },
  },
  { name: "no answer", reply: noAnswerReply(), expected: { kind: "failed" } },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly reply: SignInRequestFetchReply;
  readonly expected: SignInRequestRecordAnswer;
}>;

const RECORD_ONCE_CASES = [
  {
    name: "a matching 200 receipt",
    reply: RECORDED_SIGN_IN_REQUEST_REPLY,
    expected: {
      kind: "recorded",
      recordedOperationId: SIGN_IN_REQUEST_FIXTURE.operationId,
    },
  },
  {
    name: "duplicate",
    reply: MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "ended", reason: "already-recorded" },
  },
  {
    name: "unauthorized",
    reply: UNAUTHORIZED_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "ended", reason: "session-ended" },
  },
  {
    name: "forbidden",
    reply: FORBIDDEN_SIGN_IN_REQUEST_REPLY,
    expected: { kind: "ended", reason: "forbidden" },
  },
  {
    name: "failed",
    reply: noAnswerReply(),
    expected: { kind: "ended", reason: "unavailable" },
  },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly reply: SignInRequestFetchReply;
  readonly expected: SignInRecording;
}>;

describe("provider sign-in request recording HTTP contract", () => {
  it("sends the exact authenticated record request", async () => {
    const fetchHarness = harness();
    fetchHarness.enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);

    await expect(
      recordSignInRequestViaHttp(
        SIGN_IN_REQUEST_AUTHN_URL,
        SIGN_IN_REQUEST_BEARER,
        SIGN_IN_REQUEST_FIXTURE,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "recorded" });

    expect(fetchHarness.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchHarness.fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${SIGN_IN_REQUEST_AUTHN_URL}/api/v3/environments/${SIGN_IN_REQUEST_FIXTURE.environmentId}/profile-records/intents`,
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        Authorization: `Bearer ${SIGN_IN_REQUEST_BEARER}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
    );
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      operationId: SIGN_IN_REQUEST_FIXTURE.operationId,
      kind: "provider_sign_in",
      sourceHostId: SIGN_IN_REQUEST_FIXTURE.sourceHostId,
      sourceSharingGeneration: SIGN_IN_REQUEST_FIXTURE.sourceSharingGeneration,
      harnessId: SIGN_IN_REQUEST_FIXTURE.harnessId,
    });
  });

  it("accepts an exact repeated 200 receipt", async () => {
    const fetchHarness = harness();
    fetchHarness.enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    fetchHarness.enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    const signal = new AbortController().signal;

    await expect(
      recordSignInRequestViaHttp(
        SIGN_IN_REQUEST_AUTHN_URL,
        SIGN_IN_REQUEST_BEARER,
        SIGN_IN_REQUEST_FIXTURE,
        signal,
      ),
    ).resolves.toEqual({ kind: "recorded" });
    await expect(
      recordSignInRequestViaHttp(
        SIGN_IN_REQUEST_AUTHN_URL,
        SIGN_IN_REQUEST_BEARER,
        SIGN_IN_REQUEST_FIXTURE,
        signal,
      ),
    ).resolves.toEqual({ kind: "recorded" });
    expect(fetchHarness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(RECORD_ANSWER_CASES)("maps $name", async (testCase) => {
    const fetchHarness = harness();
    fetchHarness.enqueue(testCase.reply);

    await expect(
      recordSignInRequestViaHttp(
        SIGN_IN_REQUEST_AUTHN_URL,
        SIGN_IN_REQUEST_BEARER,
        SIGN_IN_REQUEST_FIXTURE,
        new AbortController().signal,
      ),
    ).resolves.toEqual(testCase.expected);
    expect(fetchHarness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an environment id with a slash",
      request: { ...SIGN_IN_REQUEST_FIXTURE, environmentId: "unsafe/id" },
    },
    {
      name: "an operation id with a slash",
      request: { ...SIGN_IN_REQUEST_FIXTURE, operationId: "unsafe/id" },
    },
  ])("does not fetch for $name", async (testCase) => {
    const fetchHarness = harness();

    await expect(
      recordSignInRequestViaHttp(
        SIGN_IN_REQUEST_AUTHN_URL,
        SIGN_IN_REQUEST_BEARER,
        testCase.request,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "failed" });
    expect(fetchHarness.fetchMock).not.toHaveBeenCalled();
  });
});

describe("recordSignInRequestOnce", () => {
  it.each(RECORD_ONCE_CASES)("maps a $name answer", async (testCase) => {
    const fetchHarness = harness();
    fetchHarness.enqueue(testCase.reply);

    await expect(
      recordSignInRequestOnce(
        fetchHarness.client,
        new Set<string>(),
        SIGN_IN_REQUEST_FIXTURE,
        new AbortController().signal,
      ),
    ).resolves.toEqual(testCase.expected);
    expect(fetchHarness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not record an operation id twice", async () => {
    const fetchHarness = harness();
    fetchHarness.enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    const recorded = new Set<string>();
    const signal = new AbortController().signal;

    await expect(
      recordSignInRequestOnce(
        fetchHarness.client,
        recorded,
        SIGN_IN_REQUEST_FIXTURE,
        signal,
      ),
    ).resolves.toEqual({
      kind: "recorded",
      recordedOperationId: SIGN_IN_REQUEST_FIXTURE.operationId,
    });
    await expect(
      recordSignInRequestOnce(
        fetchHarness.client,
        recorded,
        SIGN_IN_REQUEST_FIXTURE,
        signal,
      ),
    ).resolves.toEqual({ kind: "ended", reason: "already-recorded" });
    expect(fetchHarness.fetchMock).toHaveBeenCalledTimes(1);
  });
});
