import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { z } from "zod";
import {
  identityFromAuthenticatedUser,
  createRequestContext,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  providerMutationCliStateSchemaV21,
  providersBeginApiKeyChangeRequestSchema,
  providersBeginApiKeyChangeResponseSchema,
  providersSetApiKeyResponseSchema,
  providersSetApiKeyRequestSchema,
  providersSettleApiKeyChangeResponseSchema,
  providersSettleApiKeyChangeRequestSchema,
  type ProvidersBeginApiKeyChangeResponse,
  type ProvidersSettleApiKeyChangeResponse,
} from "@traycer/protocol/host/provider-schemas";
import { HostClient, type IHostQueryInvalidator } from "../host-client";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "../mock/mock-host-messenger";
import { mockLocalHostEntry } from "../mock/mock-host-directory";
import { HostRpcError } from "../../host-transport/host-messenger";
import {
  changeProviderApiKey,
  changeProviderKeyRecordViaHttp,
  type ProviderApiKeyChange,
  type ProviderKeyProviderId,
  type ProviderKeyRecordClient,
} from "../provider-api-key-change";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";

const AUTHN_BASE = "https://auth.example.test";
const BEARER = "synthetic-session-token";
const API_KEY = "synthetic-provider-key";
const ENVIRONMENT_FROM_HOST = "env_host-captured";
const RECORD_PROFILE_ID = "profile-synthetic";
const setRequestBodySchema = z.strictObject({
  key: z.string(),
  onlyIfAbsent: z.literal(false),
});
const legacyClearRequestBodySchema = z.strictObject({
  providerId: z.literal("cursor"),
});
const PROVIDERS = [
  "cursor",
  "openrouter",
  "huggingface",
  "amp",
  "kiro",
  "droid",
] as const;

const state = providerMutationCliStateSchemaV21.parse({
  ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
  profiles: [],
});
const legacyResponse = providersSetApiKeyResponseSchema.parse({ state });
const settleResponse = providersSettleApiKeyChangeResponseSchema.parse({
  result: "installed",
  state,
});

interface Rig {
  readonly client: HostClient<typeof hostRpcRegistry>;
  readonly host: HostClient<typeof hostRpcRegistry>;
  readonly messenger: MockHostMessenger<typeof hostRpcRegistry>;
  readonly context: RequestContext;
}

const rigs: Rig[] = [];

function requestContext(cloudAuthorized: boolean): RequestContext {
  return createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: BEARER,
    origin: "test",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized,
  });
}

function makeRig(
  begin: ProvidersBeginApiKeyChangeResponse | HostRpcError,
  settle:
    | Promise<ProvidersSettleApiKeyChangeResponse>
    | ProvidersSettleApiKeyChangeResponse,
): Rig {
  const handlers: MockHandlerMap<typeof hostRpcRegistry> = {
    "providers.beginApiKeyChange": () => {
      if (begin instanceof HostRpcError) throw begin;
      return begin;
    },
    "providers.setApiKey": () => legacyResponse,
    "providers.clearApiKey": () => legacyResponse,
    "providers.settleApiKeyChange": () => settle,
  };
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    handlers,
    requestId: () => "request-synthetic",
  });
  const directory = new Map([[mockLocalHostEntry.hostId, mockLocalHostEntry]]);
  const invalidator: IHostQueryInvalidator = {
    invalidateHostScope: () => undefined,
  };
  const client = new HostClient({
    registry: hostRpcRegistry,
    messenger,
    invalidator,
    requestCoordinator: null,
    findHostById: (hostId) => directory.get(hostId) ?? null,
  });
  const context = requestContext(true);
  client.setRequestContext(context);
  const rig = {
    client,
    host: client.createRequesterForHostId(mockLocalHostEntry.hostId),
    messenger,
    context,
  };
  rigs.push(rig);
  return rig;
}

function recordClient(
  calls: Array<{ readonly environmentId: string; readonly action: string }>,
): ProviderKeyRecordClient {
  return {
    changeProviderKeyRecord: (environmentId, providerId, change, signal) => {
      calls.push({ environmentId, action: change.action });
      return changeProviderKeyRecordViaHttp(
        AUTHN_BASE,
        BEARER,
        environmentId,
        providerId,
        change,
        signal,
      );
    },
  };
}

function installFetch(
  respond: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ) => Promise<Response>,
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>((input, init) => respond(input, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function recordBody(
  providerId: ProviderKeyProviderId,
  change: ProviderApiKeyChange,
): object {
  return {
    profileId: RECORD_PROFILE_ID,
    providerId,
    state: change.action === "set" ? "live" : "removed",
    signInNumber: "17",
    recordRevision: "4",
    personIntentNumber: "9",
  };
}

function callParams(rig: Rig, method: string): unknown {
  const call = rig.messenger.calls.find((entry) => entry.method === method);
  return call === undefined ? null : call.params;
}

async function failureInfo(
  operation: Promise<unknown>,
): Promise<{ readonly code: string | null; readonly message: string }> {
  try {
    await operation;
    return { code: null, message: "" };
  } catch (error) {
    return {
      code: error instanceof HostRpcError ? error.code : null,
      message: error instanceof Error ? error.message : "",
    };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const rig of rigs.splice(0)) {
    rig.context.release();
    rig.client.dispose();
  }
});

describe("changeProviderApiKey shared flow", () => {
  it.each(PROVIDERS)(
    "sets and clears %s through the captured environment record",
    async (providerId) => {
      const rig = makeRig(
        {
          mode: "record",
          changeToken: "opaque-change-token",
          environmentId: ENVIRONMENT_FROM_HOST,
        },
        settleResponse,
      );
      const recordCalls: Array<{
        readonly environmentId: string;
        readonly action: string;
      }> = [];
      const fetchMock = installFetch(async (_input, init) => {
        const method = init?.method;
        const action: ProviderApiKeyChange =
          method === "PUT"
            ? { action: "set", apiKey: API_KEY }
            : { action: "clear" };
        const stateName = action.action === "set" ? "live" : "removed";
        const record = recordBody(providerId, action);
        return new Response(JSON.stringify({ ...record, state: stateName }), {
          status: 200,
        });
      });
      const records = recordClient(recordCalls);

      const set = await changeProviderApiKey(rig.host, records, providerId, {
        action: "set",
        apiKey: API_KEY,
      });
      const clear = await changeProviderApiKey(rig.host, records, providerId, {
        action: "clear",
      });

      const requests = fetchMock.mock.calls;
      const firstInit = requests[0]?.[1];
      const secondInit = requests[1]?.[1];
      const firstBodyText = firstInit?.body;
      const parsedFirstBody: unknown =
        typeof firstBodyText === "string" ? JSON.parse(firstBodyText) : null;
      const firstBody = setRequestBodySchema.safeParse(parsedFirstBody);
      const firstUrl = requests[0]?.[0];
      const secondUrl = requests[1]?.[0];
      expect(set.result === "installed" && clear.result === "installed").toBe(
        true,
      );
      expect(fetchMock.mock.calls.length === 2).toBe(true);
      expect(
        firstInit?.method === "PUT" && secondInit?.method === "DELETE",
      ).toBe(true);
      expect(
        firstInit?.redirect === "error" && secondInit?.redirect === "error",
      ).toBe(true);
      expect(
        firstBody.success &&
          firstBody.data.key === API_KEY &&
          firstBody.data.onlyIfAbsent === false,
      ).toBe(true);
      expect(
        firstUrl !== undefined &&
          String(firstUrl).includes(
            `/environments/${ENVIRONMENT_FROM_HOST}/provider-keys/${providerId}`,
          ),
      ).toBe(true);
      expect(
        String(secondUrl).includes(
          `/environments/${ENVIRONMENT_FROM_HOST}/provider-keys/${providerId}`,
        ),
      ).toBe(true);
      expect(
        requests.every(
          ([, init]) =>
            new Headers(init?.headers).get("Authorization") ===
            `Bearer ${BEARER}`,
        ),
      ).toBe(true);
      expect(
        recordCalls.length === 2 &&
          recordCalls.every(
            (call) => call.environmentId === ENVIRONMENT_FROM_HOST,
          ),
      ).toBe(true);
      expect(
        rig.messenger.calls.map((call) => call.method).join(",") ===
          "providers.beginApiKeyChange,providers.settleApiKeyChange,providers.beginApiKeyChange,providers.settleApiKeyChange",
      ).toBe(true);
      expect(
        rig.messenger.calls
          .filter(
            (call) =>
              call.method === "providers.beginApiKeyChange" ||
              call.method === "providers.settleApiKeyChange",
          )
          .every((call) => {
            const params =
              call.method === "providers.beginApiKeyChange"
                ? providersBeginApiKeyChangeRequestSchema.safeParse(call.params)
                : providersSettleApiKeyChangeRequestSchema.safeParse(
                    call.params,
                  );
            return params.success;
          }),
      ).toBe(true);
      const settle = callParams(rig, "providers.settleApiKeyChange");
      const parsedSettle =
        providersSettleApiKeyChangeRequestSchema.safeParse(settle);
      expect(
        parsedSettle.success &&
          parsedSettle.data.recordId === RECORD_PROFILE_ID &&
          parsedSettle.data.signInNumber === "17" &&
          parsedSettle.data.recordRevision === "4",
      ).toBe(true);
    },
  );

  it("uses the legacy host call only for an explicit legacy response", async () => {
    const begin = providersBeginApiKeyChangeResponseSchema.parse({
      mode: "legacy",
      changeToken: null,
      environmentId: null,
    });
    const rig = makeRig(begin, settleResponse);
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const fetchMock = installFetch(
      async () => new Response(null, { status: 500 }),
    );

    await changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
      action: "set",
      apiKey: API_KEY,
    });

    const legacy = callParams(rig, "providers.setApiKey");
    const parsedLegacy = providersSetApiKeyRequestSchema.safeParse(legacy);
    expect(
      parsedLegacy.success &&
        parsedLegacy.data.providerId === "cursor" &&
        parsedLegacy.data.apiKey === API_KEY,
    ).toBe(true);
    expect(fetchMock.mock.calls.length === 0 && recordCalls.length === 0).toBe(
      true,
    );
    expect(
      rig.messenger.calls.some(
        (call) => call.method === "providers.settleApiKeyChange",
      ),
    ).toBe(false);
  });

  it("keeps both legacy provider-wide payloads intact for a peer that predates the flow", async () => {
    const begin = providersBeginApiKeyChangeResponseSchema.parse({
      mode: "legacy",
      changeToken: null,
      environmentId: null,
    });
    const rig = makeRig(begin, settleResponse);
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const fetchMock = installFetch(
      async () => new Response(null, { status: 500 }),
    );

    await changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
      action: "set",
      apiKey: API_KEY,
    });
    await changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
      action: "clear",
    });

    const set = callParams(rig, "providers.setApiKey");
    const clear = callParams(rig, "providers.clearApiKey");
    const parsedSet = providersSetApiKeyRequestSchema.safeParse(set);
    const parsedClear = legacyClearRequestBodySchema.safeParse(clear);
    expect(
      parsedSet.success &&
        parsedSet.data.providerId === "cursor" &&
        parsedSet.data.apiKey === API_KEY,
    ).toBe(true);
    expect(parsedClear.success).toBe(true);
    expect(fetchMock.mock.calls.length === 0 && recordCalls.length === 0).toBe(
      true,
    );
  });

  it("does not ask a non-key provider for the optional capability", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const fetchMock = installFetch(
      async () => new Response(null, { status: 500 }),
    );

    await changeProviderApiKey(rig.host, recordClient(recordCalls), "codex", {
      action: "clear",
    });

    expect(
      rig.messenger.calls.map((call) => call.method).join(",") ===
        "providers.clearApiKey",
    ).toBe(true);
    expect(fetchMock.mock.calls.length === 0 && recordCalls.length === 0).toBe(
      true,
    );
  });

  it("falls back to the released call for E_HOST_UNSUPPORTED and leaves other begin errors closed", async () => {
    const unsupported = new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: "Host does not support this method",
      requestId: "request-synthetic",
      method: "providers.beginApiKeyChange",
      fatalDetails: null,
    });
    const rig = makeRig(unsupported, settleResponse);
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const fetchMock = installFetch(
      async () => new Response(null, { status: 500 }),
    );

    await changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
      action: "clear",
    });

    expect(
      rig.messenger.calls.some(
        (call) => call.method === "providers.clearApiKey",
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls.length === 0 && recordCalls.length === 0).toBe(
      true,
    );

    const denied = new HostRpcError({
      code: "FORBIDDEN",
      message: "Request refused",
      requestId: "request-synthetic",
      method: "providers.beginApiKeyChange",
      fatalDetails: null,
    });
    const deniedRig = makeRig(denied, settleResponse);
    await expect(
      changeProviderApiKey(
        deniedRig.host,
        recordClient(recordCalls),
        "cursor",
        { action: "clear" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      deniedRig.messenger.calls.some(
        (call) => call.method === "providers.clearApiKey",
      ),
    ).toBe(false);
  });

  it("uses a keyless null-clear settle for the exact typed record-not-found response", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    installFetch(
      async () =>
        new Response(JSON.stringify({ code: "profile_record_not_found" }), {
          status: 404,
        }),
    );

    const outcome = await changeProviderApiKey(
      rig.host,
      recordClient(recordCalls),
      "cursor",
      { action: "clear" },
    );

    const settle = providersSettleApiKeyChangeRequestSchema.safeParse(
      callParams(rig, "providers.settleApiKeyChange"),
    );
    expect(outcome.result === "installed").toBe(true);
    expect(
      settle.success &&
        settle.data.action === "clear" &&
        settle.data.recordId === null &&
        settle.data.signInNumber === null &&
        settle.data.recordRevision === null,
    ).toBe(true);
  });

  it("refuses to start the record request for an unverified context", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    const unverified = requestContext(false);
    rig.client.setRequestContext(unverified);
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const fetchMock = installFetch(
      async () => new Response(null, { status: 500 }),
    );

    await expect(
      changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
        action: "clear",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetchMock.mock.calls.length === 0 && recordCalls.length === 0).toBe(
      true,
    );
    expect(
      rig.messenger.calls.some(
        (call) => call.method === "providers.settleApiKeyChange",
      ),
    ).toBe(false);
    unverified.release();
  });

  it("uses the legacy path only for a bare 404, never for a coded refusal", async () => {
    const begin = {
      mode: "record",
      changeToken: "opaque-change-token",
      environmentId: ENVIRONMENT_FROM_HOST,
    } as const;
    const bareRig = makeRig(begin, settleResponse);
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const bareFetch = installFetch(
      async () => new Response("", { status: 404 }),
    );
    await changeProviderApiKey(
      bareRig.host,
      recordClient(recordCalls),
      "cursor",
      { action: "set", apiKey: API_KEY },
    );
    expect(
      bareRig.messenger.calls.some(
        (call) => call.method === "providers.setApiKey",
      ),
    ).toBe(true);
    expect(
      bareFetch.mock.calls.length === 1 &&
        !bareRig.messenger.calls.some(
          (call) => call.method === "providers.settleApiKeyChange",
        ),
    ).toBe(true);

    const codedRig = makeRig(begin, settleResponse);
    const codedFetch = installFetch(
      async () =>
        new Response(JSON.stringify({ code: "not_found" }), { status: 404 }),
    );
    await expect(
      changeProviderApiKey(codedRig.host, recordClient(recordCalls), "cursor", {
        action: "clear",
      }),
    ).rejects.toMatchObject({ code: "RPC_ERROR" });
    expect(
      codedFetch.mock.calls.length === 1 &&
        !codedRig.messenger.calls.some(
          (call) => call.method === "providers.clearApiKey",
        ),
    ).toBe(true);
  });

  it.each([400, 401, 403, 409, 500])(
    "refuses broker HTTP %i without settling or falling back",
    async (status) => {
      const rig = makeRig(
        {
          mode: "record",
          changeToken: "opaque-change-token",
          environmentId: ENVIRONMENT_FROM_HOST,
        },
        settleResponse,
      );
      const recordCalls: Array<{
        readonly environmentId: string;
        readonly action: string;
      }> = [];
      const privateBody = "synthetic-private-response-body";
      const fetchMock = installFetch(
        async () => new Response(privateBody, { status }),
      );

      const failure = await failureInfo(
        changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
          action: "set",
          apiKey: API_KEY,
        }),
      );
      const expectedCode =
        status === 401
          ? "UNAUTHORIZED"
          : status === 403
            ? "FORBIDDEN"
            : "RPC_ERROR";
      expect(
        failure.code === expectedCode &&
          !failure.message.includes(API_KEY) &&
          !failure.message.includes(privateBody),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.length === 1 && recordCalls.length === 1,
      ).toBe(true);
      expect(
        !rig.messenger.calls.some(
          (call) => call.method === "providers.settleApiKeyChange",
        ) &&
          !rig.messenger.calls.some(
            (call) => call.method === "providers.setApiKey",
          ),
      ).toBe(true);
    },
  );

  it("contains a malformed successful response without settling or exposing the response body", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const privateBody = `synthetic-response-marker-${API_KEY}`;
    const fetchMock = installFetch(
      async () =>
        new Response(JSON.stringify({ message: privateBody }), { status: 200 }),
    );

    const failure = await failureInfo(
      changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
        action: "set",
        apiKey: API_KEY,
      }),
    );

    expect(
      failure.code === "RPC_ERROR" &&
        !failure.message.includes(API_KEY) &&
        !failure.message.includes(privateBody),
    ).toBe(true);
    expect(fetchMock.mock.calls.length === 1 && recordCalls.length === 1).toBe(
      true,
    );
    expect(
      !rig.messenger.calls.some(
        (call) => call.method === "providers.settleApiKeyChange",
      ) &&
        !rig.messenger.calls.some(
          (call) => call.method === "providers.setApiKey",
        ),
    ).toBe(true);
  });

  it("contains a rejected direct request without settling or exposing request data", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const transportMessage = "synthetic-transport-marker";
    const fetchMock = installFetch(async () =>
      Promise.reject(new Error(transportMessage)),
    );

    const failure = await failureInfo(
      changeProviderApiKey(rig.host, recordClient(recordCalls), "cursor", {
        action: "set",
        apiKey: API_KEY,
      }),
    );

    expect(
      failure.code === "RPC_ERROR" &&
        !failure.message.includes(API_KEY) &&
        !failure.message.includes(transportMessage),
    ).toBe(true);
    expect(fetchMock.mock.calls.length === 1 && recordCalls.length === 1).toBe(
      true,
    );
    expect(
      !rig.messenger.calls.some(
        (call) => call.method === "providers.settleApiKeyChange",
      ) &&
        !rig.messenger.calls.some(
          (call) => call.method === "providers.setApiKey",
        ),
    ).toBe(true);
  });

  it("refuses a changed request context before settlement after the broker returns", async () => {
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settleResponse,
    );
    let releaseFetch: (response: Response) => void = () => undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    installFetch(() => {
      fetchStarted();
      return responsePromise;
    });
    const recordCalls: Array<{
      readonly environmentId: string;
      readonly action: string;
    }> = [];
    const pending = changeProviderApiKey(
      rig.host,
      recordClient(recordCalls),
      "cursor",
      { action: "set", apiKey: API_KEY },
    );
    await started;
    const replacement = requestContext(true);
    rig.client.setRequestContext(replacement);
    releaseFetch(
      new Response(
        JSON.stringify(
          recordBody("cursor", { action: "set", apiKey: API_KEY }),
        ),
        { status: 200 },
      ),
    );

    await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      !rig.messenger.calls.some(
        (call) => call.method === "providers.settleApiKeyChange",
      ),
    ).toBe(true);
    replacement.release();
  });

  it("does not settle until the computer's settle request resolves", async () => {
    let releaseSettle: (
      response: ProvidersSettleApiKeyChangeResponse,
    ) => void = () => undefined;
    const settlePromise = new Promise<ProvidersSettleApiKeyChangeResponse>(
      (resolve) => {
        releaseSettle = resolve;
      },
    );
    const rig = makeRig(
      {
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: ENVIRONMENT_FROM_HOST,
      },
      settlePromise,
    );
    installFetch(
      async () =>
        new Response(
          JSON.stringify(
            recordBody("cursor", { action: "set", apiKey: API_KEY }),
          ),
          { status: 200 },
        ),
    );
    let completed = false;
    const operation = changeProviderApiKey(
      rig.host,
      recordClient([]),
      "cursor",
      { action: "set", apiKey: API_KEY },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => {
      expect(
        rig.messenger.calls.some(
          (call) => call.method === "providers.settleApiKeyChange",
        ),
      ).toBe(true);
    });
    expect(completed).toBe(false);
    releaseSettle(settleResponse);
    const outcome = await operation;
    expect(outcome.result === "installed" && completed).toBe(true);
  });

  it.each([
    "unchanged",
    "kept-local",
    "refused",
    "dropped",
    "unavailable",
  ] as const)(
    "returns the %s settle result through the completed flow",
    async (result) => {
      const response = providersSettleApiKeyChangeResponseSchema.parse({
        result,
        state,
      });
      const rig = makeRig(
        {
          mode: "record",
          changeToken: "opaque-change-token",
          environmentId: ENVIRONMENT_FROM_HOST,
        },
        response,
      );
      installFetch(
        async () =>
          new Response(
            JSON.stringify(
              recordBody("cursor", { action: "set", apiKey: API_KEY }),
            ),
            { status: 200 },
          ),
      );
      const outcome = await changeProviderApiKey(
        rig.host,
        recordClient([]),
        "cursor",
        { action: "set", apiKey: API_KEY },
      );
      expect(outcome.result === result).toBe(true);
    },
  );
});
