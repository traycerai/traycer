import { describe, expect, it } from "vitest";
import {
  defineRpcContract,
  defineUpgradePath,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  hostNotificationHooksSave,
  hostNotificationHooksSaveDowngradeV30ToV10,
  hostNotificationHooksSaveDowngradeV30ToV20,
  hostNotificationHooksSaveDowngradeV40ToV10,
  hostNotificationHooksSaveDowngradeV40ToV20,
  hostNotificationHooksSaveDowngradeV40ToV30,
  hostNotificationHooksSaveUpgradeV3ToV4,
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

const saveRequest = {
  hooks: [HTTP_HOOK],
  executableWriteGrant: null,
  configurationRevision: "rev-7",
};

describe("notification hook save account part @4.0", () => {
  it("uses the @3.0 request schema", () => {
    expect(
      hostNotificationHooksSaveV40.requestSchema.parse(saveRequest),
    ).toEqual(hostNotificationHooksSaveV30.requestSchema.parse(saveRequest));

    const requestWithoutRevision = {
      hooks: [HTTP_HOOK],
      executableWriteGrant: null,
    };
    expect(
      hostNotificationHooksSaveV40.requestSchema.safeParse(
        requestWithoutRevision,
      ).success,
    ).toBe(false);
    expect(
      hostNotificationHooksSaveV30.requestSchema.safeParse(
        requestWithoutRevision,
      ).success,
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

  it("upgrades @3.0 responses with no account hooks and passes requests through", () => {
    const status = latestStatus();
    const upgradedResponse =
      hostNotificationHooksSaveUpgradeV3ToV4.upgradeResponse(status);

    expect(upgradedResponse).toEqual({ ...status, accountHooks: null });
    expect(
      hostNotificationHooksSaveV40.responseSchema.safeParse(upgradedResponse)
        .success,
    ).toBe(true);
    expect(
      hostNotificationHooksSaveUpgradeV3ToV4.upgradeRequest(saveRequest),
    ).toEqual(saveRequest);
  });

  it("drops account hooks across major downgrades", () => {
    const response = { ...latestStatus(), accountHooks: [HTTP_HOOK] };
    const toV30 =
      hostNotificationHooksSaveDowngradeV40ToV30.downgradeResponse(response);
    const toV20 =
      hostNotificationHooksSaveDowngradeV40ToV20.downgradeResponse(response);
    const toV10 =
      hostNotificationHooksSaveDowngradeV40ToV10.downgradeResponse(response);
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

    expect(
      hostNotificationHooksSaveDowngradeV40ToV20.downgradeRequest(saveRequest),
    ).toEqual(
      hostNotificationHooksSaveDowngradeV30ToV20.downgradeRequest(saveRequest),
    );
    expect(
      hostNotificationHooksSaveDowngradeV40ToV10.downgradeRequest(saveRequest),
    ).toEqual(
      hostNotificationHooksSaveDowngradeV30ToV10.downgradeRequest(saveRequest),
    );
  });

  it("validates @4.0 as a major and rejects the response field as a minor", () => {
    const copiedRegistry = {
      "host.notificationHooks.save": {
        ...hostRpcRegistry["host.notificationHooks.save"],
        4: {
          latestMinor: 0,
          versions: {
            0: {
              contract: hostNotificationHooksSaveV40,
              upgradeFromPreviousVersion:
                hostNotificationHooksSaveUpgradeV3ToV4,
            },
          },
          downgradePathsFromLatest: {
            1: hostNotificationHooksSaveDowngradeV40ToV10,
            2: hostNotificationHooksSaveDowngradeV40ToV20,
            3: hostNotificationHooksSaveDowngradeV40ToV30,
          },
        },
      },
    };
    expect(() => validateVersionedRpcRegistry(copiedRegistry)).not.toThrow();

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
        ...hostRpcRegistry["host.notificationHooks.save"],
        3: {
          ...hostRpcRegistry["host.notificationHooks.save"][3],
          latestMinor: 1,
          versions: {
            ...hostRpcRegistry["host.notificationHooks.save"][3].versions,
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

  it("keeps @4.0 out of the installed registry", () => {
    expect(
      Object.hasOwn(hostRpcRegistry["host.notificationHooks.save"], 4),
    ).toBe(false);
  });
});
