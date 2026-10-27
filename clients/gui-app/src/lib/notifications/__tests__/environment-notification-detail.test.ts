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
      sandbox: null,
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

  describe("team.member.joined", () => {
    const JOINED = {
      kind: "team_member_joined",
      environmentId: "env-1",
      teamName: "Acme",
      memberName: "Sam",
    };

    it("gives the newcomer's own row a welcome naming the role they were granted", () => {
      expect(
        environmentNotificationDetail("team.member.joined", {
          ...JOINED,
          toNewcomer: true,
          role: "editor",
        }),
      ).toEqual({
        kind: "team_member_welcome",
        environmentId: "env-1",
        teamName: "Acme",
        role: "editor",
      });
    });

    it.each([
      ["an admin's row", { toNewcomer: false, role: "editor" }],
      ["a newcomer's row written before the role", { toNewcomer: true }],
    ])("gives %s no welcome", (_label, extra) => {
      expect(
        environmentNotificationDetail("team.member.joined", {
          ...JOINED,
          ...extra,
        }),
      ).toBeNull();
    });
  });
});
