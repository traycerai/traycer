import { describe, expect, it } from "vitest";
import {
  defineRpcContract,
  defineUpgradePath,
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  getLatestContract,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  hostNotificationHooksSave,
  hostNotificationHooksSaveV20,
  hostNotificationHooksSaveV30,
  hostNotificationHooksSaveV40,
  type NotificationHookConfig,
  type NotificationHooksStatusResponse,
} from "@traycer/protocol/host/notifications/contracts";

const HTTP_HOOK: NotificationHookConfig = {
  id: "hook-2",
  name: "Webhook",
  enabled: true,
  severities: ["failure"],
  action: {
    type: "http",
    url: "https://hooks.example.com/a",
    headers: { "X-Tag": "t" },
  },
};

function latestStatus(): NotificationHooksStatusResponse {
  return {
    configPath: "/home/me/.traycer/notification-hooks.json",
    configError: null,
    hooks: [{ ...HTTP_HOOK, lastResult: null, localOnly: null }],
    configurationRevision: "rev-7",
    pendingRemovalNotices: [],
  };
}

function requireDowngradeValue<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) {
    throw new Error("expected the downgrade to succeed");
  }
  return result.value;
}

const saveRequestV4 = {
  hooks: [HTTP_HOOK],
  configurationRevision: "rev-7",
};

const saveRequestV3 = { ...saveRequestV4 };
const saveRequestV2 = {
  hooks: [HTTP_HOOK],
  executableWriteGrant: "grant-token",
};

describe("notification hook save account part @4.0", () => {
  it("uses a strict grantless @4.0 request schema", () => {
    expect(
      hostNotificationHooksSaveV40.requestSchema.parse(saveRequestV4),
    ).toEqual(saveRequestV4);

    const requestWithRetiredGrant = {
      ...saveRequestV4,
      executableWriteGrant: null,
    };
    expect(
      hostNotificationHooksSaveV40.requestSchema.safeParse(
        requestWithRetiredGrant,
      ).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV40.requestSchema.safeParse({
        hooks: [HTTP_HOOK],
      }).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV30.requestSchema.safeParse(saveRequestV3)
        .success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV20.requestSchema.safeParse(saveRequestV2)
        .success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV30.requestSchema.safeParse({
        hooks: [HTTP_HOOK],
        configurationRevision: "rev-7",
        executableWriteGrant: "grant-token",
      }).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV20.requestSchema.safeParse({
        hooks: [HTTP_HOOK],
      }).success,
    ).toBe(false);
  });

  it("bounds the strict accountHooks response field", () => {
    const status = latestStatus();
    const responseWith = (accountHooks: NotificationHookConfig[] | null) => ({
      ...status,
      accountHooks,
    });

    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(responseWith([]))
        .success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(responseWith(null))
        .success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(
        responseWith(Array.from({ length: 64 }, () => HTTP_HOOK)),
      ).success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(
        responseWith(Array.from({ length: 65 }, () => HTTP_HOOK)),
      ).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse({
        ...responseWith([]),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(status).success,
    ).toBe(false);
  });

  it("upgrades the registered @3.0 request and response into @4.0", () => {
    const status = latestStatus();
    const saveRegistry = hostRpcRegistry["host.notificationHooks.save"];
    const latest = getLatestContract(saveRegistry, undefined);
    expect(latest.schemaVersion).toEqual({ major: 4, minor: 0 });

    const upgradedRequest = upgradeRequestToVersion(
      saveRegistry,
      { major: 3, minor: 0 },
      { major: 4, minor: 0 },
      saveRequestV3,
    );
    expect(upgradedRequest).toEqual(saveRequestV4);

    const upgradedResponse = upgradeResponseToVersion(
      saveRegistry,
      { major: 3, minor: 0 },
      { major: 4, minor: 0 },
      status,
    );

    expect(upgradedResponse).toEqual({ ...status, accountHooks: null });
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(upgradedResponse)
        .success,
    ).toBe(true);
  });

  it("keeps grant and revision mappings for released request majors during upgrades and downgrades", () => {
    const saveRegistry = hostRpcRegistry["host.notificationHooks.save"];
    const requestFromV1 = upgradeRequestToVersion(
      saveRegistry,
      { major: 1, minor: 0 },
      { major: 4, minor: 0 },
      { hooks: [HTTP_HOOK] },
    );
    const requestFromV2 = upgradeRequestToVersion(
      saveRegistry,
      { major: 2, minor: 0 },
      { major: 4, minor: 0 },
      saveRequestV2,
    );
    expect(requestFromV1).toEqual({
      hooks: [HTTP_HOOK],
      configurationRevision: null,
    });
    expect(requestFromV2).toEqual(requestFromV1);

    const downgradedRequestV3 = requireDowngradeValue(
      downgradeRequestAcrossMajors(saveRegistry, 4, 3, saveRequestV4),
    );
    const downgradedRequestV2 = requireDowngradeValue(
      downgradeRequestAcrossMajors(saveRegistry, 4, 2, saveRequestV4),
    );
    expect(downgradedRequestV3).toEqual(saveRequestV4);
    expect(
      hostNotificationHooksSaveV30.requestSchema.safeParse(downgradedRequestV3)
        .success,
    ).toBe(true);
    expect(downgradedRequestV2).toEqual({
      hooks: [HTTP_HOOK],
      executableWriteGrant: null,
    });
    expect(
      hostNotificationHooksSaveV20.requestSchema.safeParse(downgradedRequestV2)
        .success,
    ).toBe(true);
    expect(
      downgradeRequestAcrossMajors(saveRegistry, 4, 1, saveRequestV4),
    ).toEqual({ ok: true, value: { hooks: [HTTP_HOOK] } });
    expect(
      downgradeRequestAcrossMajors(saveRegistry, 3, 2, saveRequestV3),
    ).toEqual({
      ok: true,
      value: { hooks: [HTTP_HOOK], executableWriteGrant: null },
    });
  });

  it("drops account hooks across major downgrades", () => {
    const saveRegistry = hostRpcRegistry["host.notificationHooks.save"];
    const response = { ...latestStatus(), accountHooks: [HTTP_HOOK] };
    const toV30 = downgradeResponseAcrossMajors(saveRegistry, 4, 3, response);
    const toV20 = downgradeResponseAcrossMajors(saveRegistry, 4, 2, response);
    const toV10 = downgradeResponseAcrossMajors(saveRegistry, 4, 1, response);
    const valueV30 = requireDowngradeValue(toV30);
    const valueV20 = requireDowngradeValue(toV20);
    const valueV10 = requireDowngradeValue(toV10);

    expect("accountHooks" in valueV30).toBe(false);
    expect(
      hostNotificationHooksSaveV30.responseSchema.safeParse(valueV30).success,
    ).toBe(true);
    expect("accountHooks" in valueV20).toBe(false);
    expect(
      hostNotificationHooksSaveV20.responseSchema.safeParse(valueV20).success,
    ).toBe(true);
    expect("accountHooks" in valueV10).toBe(false);
    expect(
      hostNotificationHooksSave.responseSchema.safeParse(valueV10).success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveV30.responseSchema.safeParse(response).success,
    ).toBe(false);
  });

  it("rejects the new response field as a minor version", () => {
    const hypotheticalV31 = defineRpcContract({
      method: "host.notificationHooks.save",
      schemaVersion: { major: 3, minor: 1 },
      requestSchema: hostNotificationHooksSaveV30.requestSchema,
      responseSchema: hostNotificationHooksSaveV40.responseSchema,
    });
    const upgradeV30ToV31 = defineUpgradePath<
      typeof hostNotificationHooksSaveV30,
      typeof hypotheticalV31
    >({
      from: { major: 3, minor: 0 },
      to: { major: 3, minor: 1 },
      upgradeRequest: (request) => request,
      upgradeResponse: (response) => ({ ...response, accountHooks: null }),
    });
    const minorRegistry = {
      "host.notificationHooks.save": {
        3: {
          latestMinor: 1,
          versions: {
            0: {
              contract: hostNotificationHooksSaveV30,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: hypotheticalV31,
              upgradeFromPreviousVersion: upgradeV30ToV31,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };
    expect(() => validateVersionedRpcRegistry(minorRegistry)).toThrow(
      /Minor 3\.1 for method 'host\.notificationHooks\.save' response /,
    );
  });
});
