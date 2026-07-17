import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  RELEASED_FLOOR_METHOD_NAMES,
  RELEASED_STREAM_FLOOR_METHOD_NAMES,
} from "@traycer/protocol/host/released-floor";
import { splitStreamManifest } from "@traycer/protocol/framework/stream-compat";
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

    expect(split.optionalManifest).toMatchObject({
      "host.notifications.list": { major: 1, minor: 0 },
      "host.notifications.markRead": { major: 1, minor: 0 },
      "host.notifications.markAllRead": { major: 1, minor: 0 },
      "host.notifications.clearAll": { major: 1, minor: 0 },
      "host.notifications.getConfig": { major: 1, minor: 0 },
      "host.notifications.setConfig": { major: 1, minor: 0 },
      "host.notifications.indicatorState": { major: 1, minor: 0 },
    });
  });

  it("keeps every existing stream method required and advertises worktree.changed optionally", () => {
    const split = splitStreamManifest(
      hostStreamRpcRegistry,
      RELEASED_STREAM_FLOOR_METHOD_NAMES,
    );

    expect(Object.keys(split.manifest).sort()).toEqual(
      [...RELEASED_STREAM_FLOOR_METHOD_NAMES].sort(),
    );
    expect(split.optionalManifest).toEqual({
      "worktree.changed": { major: 1, minor: 0 },
    });
  });
});
