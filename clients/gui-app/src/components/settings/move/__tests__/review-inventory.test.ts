import { describe, expect, it } from "vitest";
import type { EnvironmentItemStatus } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import {
  appliedOnHostNames,
  roomSharedLine,
  sharedInUseFromItems,
} from "@/components/settings/move/review-inventory";
import type { EnvironmentPlanes } from "@/components/settings/move/cohort-rows";

function item(
  kind: string,
  key: string,
  status: string,
): EnvironmentItemStatus {
  return {
    kind,
    key,
    os: "macos",
    desiredRevision: 1,
    status,
    code: "ok",
    args: { exitStatus: null, stage: null, durationMs: null, kind: null },
    brokerEnforced: null,
    minimumHostVersion: null,
    appliedAs: null,
  };
}

function host(
  hostId: string,
  hostLabel: string | null,
  applied: EnvironmentHostRecordV11["applied"],
): EnvironmentHostRecordV11 {
  return {
    hostId,
    hostLabel,
    hostPlatform: "darwin",
    enrolledByUserId: "user-1",
    kind: "personal",
    boundAt: 1,
    reachable: true,
    lastReportedAt: 1,
    applied,
  };
}

describe("sharedInUseFromItems", () => {
  it("groups applied items by kind, with names on the group, and skips the room", () => {
    const rows = sharedInUseFromItems([
      item("secret", "OPENAI_API_KEY", "applied"),
      item("secret", "ANTHROPIC_API_KEY", "applied"),
      item("secret", "NOTIFICATION_SMTP_PASSWORD", "applied"),
      item("skill", "review", "applied"),
      item("variable", "LOG_LEVEL", "pending"),
    ]);
    expect(rows).toEqual([
      {
        id: "api-keys",
        label: "2 API keys",
        names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        page: "providers",
        includesMailPassword: false,
      },
      {
        id: "mail",
        label: "notification settings",
        names: ["NOTIFICATION_SMTP_PASSWORD"],
        page: "notifications",
        includesMailPassword: true,
      },
    ]);
  });
});

describe("roomSharedLine", () => {
  const shared: EnvironmentPlanes = {
    records: "shared_unrecorded",
    broker: "moved",
    room: "shared_unrecorded",
  };

  it("names skills and the guide when the room plane is already shared", () => {
    expect(
      roomSharedLine(shared, [
        item("skill", "a", "applied"),
        item("skill", "b", "applied"),
        item("agent_selection_guide", "guide", "applied"),
      ]),
    ).toBe("The skills folder (2 skills) and the agent selection guide");
  });

  it("is null while the room is this computer's", () => {
    expect(
      roomSharedLine({ records: "local", broker: "local", room: "local" }, [
        item("skill", "a", "applied"),
      ]),
    ).toBeNull();
  });
});

describe("appliedOnHostNames", () => {
  it("lists hosts that have applied at least one item", () => {
    expect(
      appliedOnHostNames([
        host("h1", "MacBook Pro", [
          { itemKey: "LOG_LEVEL", state: "applied", reason: null, at: 1 },
        ]),
        host("h2", "dev-box", [
          { itemKey: "LOG_LEVEL", state: "received", reason: null, at: 1 },
        ]),
        host("h3", null, [
          { itemKey: "LOG_LEVEL", state: "applied", reason: null, at: 1 },
        ]),
      ]),
    ).toEqual(["MacBook Pro"]);
  });
});
