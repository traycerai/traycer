import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import { decodeResponsePayload } from "@traycer/protocol/host-transport/remote/rpc-codec";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  providerMutationCliStateSchemaV21,
  providersListResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { hostV115MutationV20Fixtures } from "./__fixtures__/host-v1.1.5-mutation-v20";

const PROVIDERS_LIST = hostRpcRegistry["providers.list"];
const PROVIDERS_LIST_MAJOR_10 = PROVIDERS_LIST[10];
const PROVIDERS_LIST_V12 = PROVIDERS_LIST_MAJOR_10.versions[12].contract;
const PROVIDERS_LIST_V13 = PROVIDERS_LIST_MAJOR_10.versions[13].contract;
const V12 = { major: 10, minor: 12 } as const;
const V13 = { major: 10, minor: 13 } as const;
const MUTATION_V21 = { major: 2, minor: 1 } as const;
const ENVIRONMENT_ID = "environment-synthetic";

function keysAtAnyDepth(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAtAnyDepth);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysAtAnyDepth(child),
  ]);
}

function latestListResponse(recordEnvironmentId: string | null) {
  const fixture = hostV115MutationV20Fixtures.minimalStatesByProviderId.cursor;
  return providersListResponseSchema.parse({
    providers: [
      {
        ...fixture,
        apiKey: {
          ...fixture.apiKey,
          supported: true,
          configured: true,
          source: "stored",
          recordEnvironmentId,
        },
      },
    ],
    native: null,
    offersSignIns: true,
  });
}

function expectRecordEnvironmentIdAbsent(value: unknown): void {
  const keys = keysAtAnyDepth(value);
  expect(keys).not.toContain("recordEnvironmentId");
}

describe("providers.list@10.13 key-record environment", () => {
  it("roundtrips the live record environment through the codec", () => {
    const live = latestListResponse(ENVIRONMENT_ID);
    const wire = PROVIDERS_LIST_V13.responseSchema.parse(live);
    const decoded = decodeResponsePayload<unknown>(
      PROVIDERS_LIST,
      V13,
      V13,
      wire,
      "request-provider-list",
      "providers.list",
    );
    const received = PROVIDERS_LIST_V13.responseSchema.parse(decoded);

    expect(received.providers[0]?.apiKey.recordEnvironmentId).toBe(
      ENVIRONMENT_ID,
    );
    expect(received.offersSignIns).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const)(
    "strips the list-only record environment for the 10.%s response schema",
    (minor) => {
      const live = latestListResponse(ENVIRONMENT_ID);
      const received =
        PROVIDERS_LIST_MAJOR_10.versions[minor].contract.responseSchema.parse(
          live,
        );

      expectRecordEnvironmentIdAbsent(received);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9] as const)(
    "strips the list-only record environment through the major-%s bridge",
    (major) => {
      const live = latestListResponse(ENVIRONMENT_ID);
      const downgraded = downgradeResponseAcrossMajors(
        PROVIDERS_LIST,
        10,
        major,
        live,
      );

      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expectRecordEnvironmentIdAbsent(downgraded.value);
    },
  );

  it("adds the documented defaults when the codec upgrades a 10.12 answer", () => {
    const v12Wire = PROVIDERS_LIST_V12.responseSchema.parse(
      latestListResponse(ENVIRONMENT_ID),
    );
    const decoded = decodeResponsePayload<unknown>(
      PROVIDERS_LIST,
      V13,
      V12,
      v12Wire,
      "request-provider-list",
      "providers.list",
    );
    const received = PROVIDERS_LIST_V13.responseSchema.parse(decoded);

    expect(received.providers[0]?.apiKey.recordEnvironmentId).toBeNull();
    expect(received.offersSignIns).toBe(true);
  });

  it("preserves an explicit null record environment on the 10.13 contract", () => {
    const live = latestListResponse(null);
    const received = PROVIDERS_LIST_V13.responseSchema.parse(
      decodeResponsePayload<unknown>(
        PROVIDERS_LIST,
        V13,
        V13,
        live,
        "request-provider-list",
        "providers.list",
      ),
    );

    expect(received.providers[0]?.apiKey.recordEnvironmentId).toBeNull();
  });

  it.each(["providers.setApiKey", "providers.clearApiKey"] as const)(
    "does not widen the %s mutation response with the list-only record environment",
    (method) => {
      const mutationState = providerMutationCliStateSchemaV21.parse(
        hostV115MutationV20Fixtures.minimalStatesByProviderId.cursor,
      );
      const registry = hostRpcRegistry[method];
      const contract = registry[2].versions[1].contract;
      const decoded = decodeResponsePayload<unknown>(
        registry,
        MUTATION_V21,
        MUTATION_V21,
        {
          state: {
            ...mutationState,
            apiKey: {
              ...mutationState.apiKey,
              recordEnvironmentId: ENVIRONMENT_ID,
            },
          },
        },
        "request-provider-mutation",
        method,
      );
      const received = contract.responseSchema.parse(decoded);

      expectRecordEnvironmentIdAbsent(received);
    },
  );
});
