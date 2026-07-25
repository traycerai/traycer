import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

describe("released floor production module", () => {
  it("matches the guarded released method-name fixture element-for-element", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toEqual(releasedMethodNames);
  });

  it("keeps host.notifications unary methods off the released floor", () => {
    expect(
      RELEASED_FLOOR_METHOD_NAMES.filter((method) =>
        method.startsWith("host.notifications."),
      ),
    ).toEqual([]);
  });

  it("advertises every host.notifications unary method as an optional capability", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );

    // Latest advertised major for list is 2.0 (native projections); major 1
    // remains registered for the frozen all/unread bridge, but optional
    // capability manifests always advertise the method's latest major.
    expect(split.optionalManifest).toMatchObject({
      "host.notifications.list": { major: 2, minor: 0 },
      "host.notifications.markRead": { major: 1, minor: 0 },
      "host.notifications.resolve": { major: 1, minor: 0 },
      "host.notifications.markAllRead": { major: 1, minor: 0 },
      "host.notifications.clearAll": { major: 1, minor: 0 },
      "host.notifications.getConfig": { major: 1, minor: 0 },
      "host.notifications.setConfig": { major: 1, minor: 0 },
      "host.notifications.indicatorState": { major: 1, minor: 0 },
    });
    expect(
      hostRpcRegistry["host.notifications.list"][1].versions[0],
    ).toBeDefined();
    expect(
      hostRpcRegistry["host.notifications.list"][2].versions[0],
    ).toBeDefined();
  });
});
