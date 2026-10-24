import { describe, expect, it } from "vitest";
import { environmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";

describe("environmentNotificationDetail", () => {
  it("keeps environmentId on environment.move.stalled", () => {
    expect(
      environmentNotificationDetail("environment.move.stalled", {
        kind: "environment_move_stalled",
        environmentId: "env-1",
        hostId: "host-1",
        hostName: "dev-box",
        remaining: 3,
        reason: "Host offline.",
      }),
    ).toEqual({
      kind: "environment_move_stalled",
      environmentId: "env-1",
      hostId: "host-1",
      hostName: "dev-box",
      remaining: 3,
      reason: "Host offline.",
    });
  });

  it("keeps environmentId on environment.apply.failed", () => {
    expect(
      environmentNotificationDetail("environment.apply.failed", {
        kind: "environment_apply_failed",
        environmentId: "env-1",
        hostId: "host-1",
        hostName: "dev-box",
        itemKey: "MCP_URL",
        reason: "Permission denied.",
      }),
    ).toEqual({
      kind: "environment_apply_failed",
      environmentId: "env-1",
      hostId: "host-1",
      hostName: "dev-box",
      itemKey: "MCP_URL",
      reason: "Permission denied.",
    });
  });

  it("drops a stalled payload that names no environment", () => {
    expect(
      environmentNotificationDetail("environment.move.stalled", {
        kind: "environment_move_stalled",
        hostId: "host-1",
        hostName: "dev-box",
        remaining: 1,
        reason: "x",
      }),
    ).toBeNull();
  });
});
