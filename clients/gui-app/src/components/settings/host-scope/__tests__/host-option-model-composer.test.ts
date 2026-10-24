import { describe, expect, it } from "vitest";
import type {
  SandboxMember,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  awakeSandboxCount,
  groupComposerHostOptions,
  hostOptionCanActivate,
  hostOptionPickerGroup,
} from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const VIEWER = { userId: "user-me" };
const ME: SandboxMember = { userId: "user-me", displayName: "Me" };
const ADA: SandboxMember = { userId: "user-ada", displayName: "Ada" };

function sandboxRow(
  hostId: string,
  input: {
    readonly teamOwned: boolean;
    readonly summary: Partial<SandboxSummary>;
    readonly state?: "awake" | "suspended";
  },
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    kind: "sandbox",
    isLocalMachine: false,
    sandbox: {
      state: input.state ?? "awake",
      frozen: false,
      summary: sandboxSummaryFixture({
        id: `sbx-${hostId}`,
        hostId,
        ...input.summary,
      }),
      teamOwned: input.teamOwned,
    },
  });
}

const personalComputer = hostScopeOptionFixture({ hostId: "laptop" });

describe("hostOptionPickerGroup in the composer mode", () => {
  it("hides a team sandbox the viewer neither started nor kept", () => {
    const row = sandboxRow("team-a", {
      teamOwned: true,
      summary: { createdBy: ADA, keptBy: null },
    });
    expect(hostOptionPickerGroup(row, false, VIEWER)).toBe("hidden");
    expect(hostOptionPickerGroup(row, false, null)).toBe("sandbox");
  });

  it("shows a team sandbox the viewer started", () => {
    const row = sandboxRow("team-a", {
      teamOwned: true,
      summary: { createdBy: ME },
    });
    expect(hostOptionPickerGroup(row, false, VIEWER)).toBe("sandbox");
  });

  it("shows a teammate's team sandbox the viewer kept", () => {
    const row = sandboxRow("team-a", {
      teamOwned: true,
      summary: { createdBy: ADA, keptBy: ME },
    });
    expect(hostOptionPickerGroup(row, false, VIEWER)).toBe("sandbox");
  });

  it("hides every team sandbox from a viewer with no user id", () => {
    const row = sandboxRow("team-a", {
      teamOwned: true,
      summary: { createdBy: ME },
    });
    expect(hostOptionPickerGroup(row, false, { userId: null })).toBe("hidden");
  });

  it("counts a personal non-burst sandbox as the viewer's although its createdBy is null", () => {
    const row = sandboxRow("mine", {
      teamOwned: false,
      summary: { createdBy: null },
    });
    expect(hostOptionPickerGroup(row, false, VIEWER)).toBe("sandbox");
  });

  it("keeps a burst sandbox hidden even when the viewer started it", () => {
    const row = sandboxRow("burst", {
      teamOwned: false,
      summary: { burst: true, createdBy: ME },
    });
    expect(hostOptionPickerGroup(row, false, VIEWER)).toBe("hidden");
  });

  it("leaves hostOptionCanActivate to who the sandbox belongs to, not who started it", () => {
    const strangers = sandboxRow("team-a", {
      teamOwned: true,
      summary: { createdBy: ADA },
    });
    expect(hostOptionPickerGroup(strangers, false, VIEWER)).toBe("hidden");
    expect(hostOptionCanActivate(strangers)).toBe(true);
  });
});

describe("groupComposerHostOptions", () => {
  it("returns Yours and Sandboxes you started, the viewer's own and the team's they started or kept, in list order", () => {
    const own = sandboxRow("own", { teamOwned: false, summary: {} });
    const startedTeam = sandboxRow("team-started", {
      teamOwned: true,
      summary: { createdBy: ME },
    });
    const keptTeam = sandboxRow("team-kept", {
      teamOwned: true,
      summary: { createdBy: ADA, keptBy: ME },
    });
    const strangers = sandboxRow("team-other", {
      teamOwned: true,
      summary: { createdBy: ADA },
    });
    const burst = sandboxRow("burst", {
      teamOwned: false,
      summary: { burst: true },
    });

    const groups = groupComposerHostOptions(
      [startedTeam, personalComputer, strangers, own, burst, keptTeam],
      VIEWER,
      null,
    );

    expect(groups.yours.map((host) => host.hostId)).toEqual(["laptop"]);
    expect([...groups.started.map((host) => host.hostId)].sort()).toEqual([
      "own",
      "team-kept",
      "team-started",
    ]);
  });

  it("keeps the row the composer points at even when it is not the viewer's", () => {
    const strangers = sandboxRow("team-other", {
      teamOwned: true,
      summary: { createdBy: ADA },
    });
    const groups = groupComposerHostOptions([strangers], VIEWER, "team-other");
    expect(groups.started.map((host) => host.hostId)).toEqual(["team-other"]);
  });
});

describe("awakeSandboxCount", () => {
  it("counts the awake sandboxes that are not frozen", () => {
    const awake = sandboxRow("a", { teamOwned: false, summary: {} });
    const asleep = sandboxRow("b", {
      teamOwned: false,
      summary: {},
      state: "suspended",
    });
    expect(awakeSandboxCount([awake, asleep, personalComputer])).toBe(1);
  });
});
