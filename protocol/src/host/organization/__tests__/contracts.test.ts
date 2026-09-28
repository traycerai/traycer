import { describe, expect, it } from "vitest";
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host";
import {
  organizationReadUpgradeV10ToV11,
  organizationReadV10,
  organizationReadV11,
  organizationRefreshUpgradeV10ToV11,
  organizationRefreshV10,
  organizationRefreshV11,
  organizationSubscribeV10,
  organizationSubscribeV11,
  organizationViewSchemaV10,
  organizationViewSchema,
} from "../contracts";

const VIEW = {
  catalog: [],
  groups: { version: "0", groups: [], memberships: [] },
  appearances: [],
  taskLabels: {},
  ready: true,
  authenticationRequired: false,
  pending: [],
  failures: [],
};

describe("organization metadata invalidation contract versions", () => {
  it("keeps historyInvalidation out of v1.0 while v1.1 preserves it", () => {
    const withToken = { ...VIEW, historyInvalidation: "history-1" };
    const v10 = organizationViewSchemaV10.parse(withToken);
    const v11 = organizationViewSchema.parse(withToken);

    expect(v10).not.toHaveProperty("historyInvalidation");
    expect(v11).toHaveProperty("historyInvalidation", "history-1");
  });

  it("lets v1.1 consume a v1.0-shaped view without a token", () => {
    const parsed = organizationViewSchema.parse(VIEW);
    expect(parsed).not.toHaveProperty("historyInvalidation");
  });

  it("upgrades v1.0 unary responses without fabricating a token", () => {
    const read = organizationReadUpgradeV10ToV11.upgradeResponse(
      organizationReadV10.responseSchema.parse(VIEW),
    );
    const refresh = organizationRefreshUpgradeV10ToV11.upgradeResponse(
      organizationRefreshV10.responseSchema.parse(VIEW),
    );

    expect(read).not.toHaveProperty("historyInvalidation");
    expect(refresh).not.toHaveProperty("historyInvalidation");
    expect(() => organizationReadV11.responseSchema.parse(read)).not.toThrow();
    expect(() =>
      organizationRefreshV11.responseSchema.parse(refresh),
    ).not.toThrow();
  });

  it("applies the same frozen-v1.0 versus additive-v1.1 shape to subscribe frames", () => {
    const withToken = {
      kind: "snapshot" as const,
      hasBinaryPayload: false as const,
      view: { ...VIEW, historyInvalidation: "history-2" },
    };
    const v10 = organizationSubscribeV10.serverFrameSchema.parse(withToken);
    const v11 = organizationSubscribeV11.serverFrameSchema.parse(withToken);
    const older = organizationSubscribeV11.serverFrameSchema.parse({
      ...withToken,
      view: VIEW,
    });

    expect(v10.view).not.toHaveProperty("historyInvalidation");
    expect(v11.view).toHaveProperty("historyInvalidation", "history-2");
    expect(older.view).not.toHaveProperty("historyInvalidation");
  });
});

describe("organization contract registry minors", () => {
  it("installs v1.0 and v1.1 for unary organization reads", () => {
    for (const method of [
      "organization.read",
      "organization.refresh",
    ] as const) {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(1);
      expect(line.versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(line.versions[1].contract.schemaVersion).toEqual({
        major: 1,
        minor: 1,
      });
      expect(line.versions[1].upgradeFromPreviousVersion).toBeDefined();
    }
  });

  it("installs both subscribe minors while retaining the frozen v1.0 contract", () => {
    const line = hostStreamRpcRegistry["organization.subscribe"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(organizationSubscribeV10);
    expect(line.versions[1].contract).toBe(organizationSubscribeV11);
  });
});
