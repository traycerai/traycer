import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import { checkSurfaceCompatibility } from "@traycer/protocol/framework/surface-compat";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providerMutationCliStateSchemaV21,
  providersBeginApiKeyChangeResponseSchema,
  providersSettleApiKeyChangeRequestSchema,
  providersSettleApiKeyChangeResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { hostResponseFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { resolveUnavailableMethodDegrade } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";
import {
  decodeResponsePayload,
  prepareRequestPayload,
} from "@traycer/protocol/host-transport/remote/rpc-codec";
import { hostV115MutationV20Fixtures } from "./__fixtures__/host-v1.1.5-mutation-v20";

const METHODS = [
  "providers.beginApiKeyChange",
  "providers.settleApiKeyChange",
] as const;
const V10 = { major: 1, minor: 0 } as const;
const NO_PEER_METHODS = {};

describe.each(METHODS)("%s optional v1.0 protocol", (method) => {
  const methodRegistry = hostRpcRegistry[method];

  it("negotiates away for a peer without it and refuses the call without legacy projection", async () => {
    const optional = splitConnectionManifest(
      { [method]: methodRegistry },
      [],
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(optional.optionalManifest[method]).toEqual(V10);
    expect(optional.manifest[method]).toBeUndefined();

    const ownSurface = buildProtocolSurface({
      unary: { [method]: methodRegistry },
      unaryFloorMethodNames: [],
      stream: {},
    });
    const peerSurface = buildProtocolSurface({
      unary: NO_PEER_METHODS,
      unaryFloorMethodNames: [],
      stream: {},
    });
    const compatibility = checkSurfaceCompatibility({
      mine: ownSurface,
      theirs: peerSurface,
      theirsLabel: "older peer",
      exceptions: [],
    });
    expect(compatibility.blocking).toEqual([]);

    const request =
      method === METHODS[0]
        ? methodRegistry[1].versions[0].contract.requestSchema.parse({
            providerId: "codex",
          })
        : methodRegistry[1].versions[0].contract.requestSchema.parse({
            providerId: "codex",
            changeToken: "opaque-change-token",
            action: "set",
            recordId: "record-synthetic",
            signInNumber: "17",
            recordRevision: "4",
          });
    const methodSubset = { [method]: methodRegistry };
    validateVersionedRpcRegistry(methodSubset);
    let fallbackCalled = false;
    await expect(
      resolveUnavailableMethodDegrade({
        registry: methodSubset,
        method,
        methodRegistry,
        clientCanonical: V10,
        clientManifest: { [method]: V10 },
        hostManifest: {},
        params: request,
        requestId: "request-synthetic",
        execute: () => {
          fallbackCalled = true;
          return Promise.resolve({});
        },
      }),
    ).rejects.toMatchObject({ code: "E_HOST_UNSUPPORTED", method });
    expect(fallbackCalled).toBe(false);
  });
});

describe("keyless API-key change wire contracts", () => {
  const beginRegistry = hostRpcRegistry["providers.beginApiKeyChange"];
  const beginContract = beginRegistry[1].versions[0].contract;
  const settleRegistry = hostRpcRegistry["providers.settleApiKeyChange"];
  const settleContract = settleRegistry[1].versions[0].contract;

  it("roundtrips begin's legacy null token and required opaque record token through the codec", () => {
    const prepared = prepareRequestPayload(
      beginRegistry,
      V10,
      V10,
      beginContract.requestSchema.parse({ providerId: "codex" }),
      "request-begin",
      beginContract.method,
    );
    const hostRequest = beginContract.requestSchema.parse(
      prepared.onWirePayload,
    );
    expect(hostRequest).toEqual({ providerId: "codex" });

    const legacy = beginContract.responseSchema.parse({
      mode: "legacy",
      changeToken: null,
      environmentId: null,
    });
    const record = beginContract.responseSchema.parse({
      mode: "record",
      changeToken: "opaque-change-token",
      environmentId: "environment-synthetic",
    });
    for (const value of [legacy, record]) {
      expect(
        beginContract.responseSchema.parse(
          decodeResponsePayload(
            beginRegistry,
            V10,
            V10,
            value,
            "request-begin",
            beginContract.method,
          ),
        ),
      ).toEqual(value);
    }
    expect(
      providersBeginApiKeyChangeResponseSchema.safeParse({
        mode: "record",
        changeToken: null,
        environmentId: "environment-synthetic",
      }).success,
    ).toBe(false);
    expect(
      providersBeginApiKeyChangeResponseSchema.safeParse({
        mode: "legacy",
        changeToken: null,
        environmentId: "environment-synthetic",
      }).success,
    ).toBe(false);
    expect(
      providersBeginApiKeyChangeResponseSchema.safeParse({
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: null,
      }).success,
    ).toBe(false);
    expect(
      beginContract.requestSchema.safeParse({
        providerId: "codex",
        apiKey: 7,
      }).success,
    ).toBe(false);
  });

  it("requires a nonempty environment id only for record mode", () => {
    expect(
      providersBeginApiKeyChangeResponseSchema.safeParse({
        mode: "record",
        changeToken: "opaque-change-token",
        environmentId: "",
      }).success,
    ).toBe(false);
    expect(
      providersBeginApiKeyChangeResponseSchema.safeParse({
        mode: "legacy",
        changeToken: null,
        environmentId: null,
      }).success,
    ).toBe(true);
  });

  it("accepts broker-record clear absence only as three nulls and never accepts a key field", () => {
    const clearWithoutRecord = {
      providerId: "codex",
      changeToken: "opaque-change-token",
      action: "clear",
      recordId: null,
      signInNumber: null,
      recordRevision: null,
    } as const;
    const prepared = prepareRequestPayload(
      settleRegistry,
      V10,
      V10,
      settleContract.requestSchema.parse(clearWithoutRecord),
      "request-settle",
      settleContract.method,
    );
    expect(settleContract.requestSchema.parse(prepared.onWirePayload)).toEqual(
      clearWithoutRecord,
    );
    const setWithRecord = settleContract.requestSchema.parse({
      providerId: "codex",
      changeToken: "opaque-change-token",
      action: "set",
      recordId: "record-synthetic",
      signInNumber: "17",
      recordRevision: "4",
    });
    expect(
      settleContract.requestSchema.parse(
        prepareRequestPayload(
          settleRegistry,
          V10,
          V10,
          setWithRecord,
          "request-set-settle",
          settleContract.method,
        ).onWirePayload,
      ),
    ).toEqual(setWithRecord);
    expect(
      providersSettleApiKeyChangeRequestSchema.safeParse({
        ...clearWithoutRecord,
        recordRevision: "4",
      }).success,
    ).toBe(false);
    expect(
      providersSettleApiKeyChangeRequestSchema.safeParse({
        ...clearWithoutRecord,
        action: "set",
      }).success,
    ).toBe(false);
    expect(
      providersSettleApiKeyChangeRequestSchema.safeParse({
        ...clearWithoutRecord,
        apiKey: 9,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["clear", ["recordId"]],
    ["clear", ["signInNumber"]],
    ["clear", ["recordRevision"]],
    ["clear", ["recordId", "signInNumber"]],
    ["clear", ["recordId", "recordRevision"]],
    ["clear", ["signInNumber", "recordRevision"]],
    ["set", ["recordId"]],
    ["set", ["signInNumber"]],
    ["set", ["recordRevision"]],
  ] as const)(
    "rejects %s with null %s after codec preparation",
    (action, nullFields) => {
      const invalidRequest: Record<string, string | null> = {
        providerId: "codex",
        changeToken: "opaque-change-token",
        action,
        recordId: "record-synthetic",
        signInNumber: "17",
        recordRevision: "4",
      };
      for (const field of nullFields) invalidRequest[field] = null;
      const prepared = prepareRequestPayload(
        settleRegistry,
        V10,
        V10,
        invalidRequest,
        "request-invalid-settle",
        settleContract.method,
      );
      expect(
        settleContract.requestSchema.safeParse(prepared.onWirePayload).success,
      ).toBe(false);
    },
  );

  it.each([
    "installed",
    "unchanged",
    "kept-local",
    "refused",
    "dropped",
    "unavailable",
  ] as const)(
    "decodes %s with the complete provider mutation state",
    (result) => {
      const state = providerMutationCliStateSchemaV21.parse({
        ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
        profiles: [],
      });
      const response = providersSettleApiKeyChangeResponseSchema.parse({
        result,
        state,
      });
      const decoded = settleContract.responseSchema.parse(
        decodeResponsePayload(
          settleRegistry,
          V10,
          V10,
          response,
          "request-settle",
          settleContract.method,
        ),
      );
      expect(decoded).toEqual(response);
      expect(decoded.state).toEqual(state);
    },
  );

  it("keeps legacy provider-wide set and clear requests usable through their frozen codec contracts", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("providers.setApiKey");
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("providers.clearApiKey");
    const setRegistry = hostRpcRegistry["providers.setApiKey"];
    const clearRegistry = hostRpcRegistry["providers.clearApiKey"];
    const setContract = setRegistry[1].versions[0].contract;
    const clearContract = clearRegistry[1].versions[0].contract;
    const setRequest = setContract.requestSchema.parse({
      providerId: "codex",
      apiKey: "synthetic-value",
    });
    const clearRequest = clearContract.requestSchema.parse({
      providerId: "codex",
    });
    const setWire = prepareRequestPayload(
      setRegistry,
      V10,
      V10,
      setRequest,
      "request-legacy-set",
      setContract.method,
    );
    const clearWire = prepareRequestPayload(
      clearRegistry,
      V10,
      V10,
      clearRequest,
      "request-legacy-clear",
      clearContract.method,
    );
    const setRoundtrip = setContract.requestSchema.parse(setWire.onWirePayload);
    const clearRoundtrip = clearContract.requestSchema.parse(
      clearWire.onWirePayload,
    );
    expect(Object.keys(setRoundtrip).sort()).toEqual(["apiKey", "providerId"]);
    expect(setRoundtrip.providerId).toBe("codex");
    expect(Object.keys(clearRoundtrip)).toEqual(["providerId"]);
    expect(clearRoundtrip.providerId).toBe("codex");
    expect(
      setContract.requestSchema.safeParse({ ...setRequest, extra: true })
        .success,
    ).toBe(false);
    expect(
      clearContract.requestSchema.safeParse({ ...clearRequest, apiKey: 9 })
        .success,
    ).toBe(false);
  });

  it("recognizes update-required after the response frame is decoded", () => {
    const frame = hostResponseFrameSchema.parse({
      kind: "response",
      requestId: "request-settle",
      method: "providers.settleApiKeyChange",
      schemaVersion: V10,
      result: null,
      error: { code: "update-required", message: "Update required" },
    });
    expect(frame.error).not.toBeNull();
    if (frame.error === null)
      throw new Error("Expected response error envelope");
    const error = HostRpcError.fromWireEnvelope(
      frame.error,
      frame.requestId,
      frame.method,
    );
    expect(error.code).toBe("update-required");
    expect(error.method).toBe("providers.settleApiKeyChange");
  });
});
