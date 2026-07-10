import { describe, expect, it } from "vitest";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { decideSteerSettings } from "@/lib/chats/decide-steer-settings";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: "default",
  agentMode: "regular",
  profileId: null,
};

const TURN: ChatActiveTurn = {
  turnId: "turn-1",
  status: "running",
  harnessId: "codex",
  model: "gpt-5-codex",
  reasoningEffort: "medium",
  serviceTier: "default",
  agentMode: "regular",
  profileId: null,
  userMessageId: "message-1",
  startedAt: 1,
  updatedAt: 1,
};

describe("decideSteerSettings", () => {
  it("injects silently when there is no active turn", () => {
    expect(decideSteerSettings(null, SETTINGS)).toEqual({
      kind: "silent_inject",
    });
  });

  it("injects silently when nothing differs", () => {
    expect(decideSteerSettings(TURN, SETTINGS)).toEqual({
      kind: "silent_inject",
    });
  });

  it("injects silently when only the permission mode differs (soft)", () => {
    const result = decideSteerSettings(TURN, {
      ...SETTINGS,
      permissionMode: "full_access",
    });
    expect(result.kind).toBe("silent_inject");
  });

  it("restarts on a model change", () => {
    const result = decideSteerSettings(TURN, { ...SETTINGS, model: "gpt-5" });
    expect(result).toEqual({
      kind: "interrupt_restart",
      newSettings: { ...SETTINGS, model: "gpt-5" },
      changed: ["model"],
    });
  });

  it("treats a harness swap as a model change", () => {
    const result = decideSteerSettings(TURN, {
      ...SETTINGS,
      harnessId: "claude",
    });
    expect(result.kind).toBe("interrupt_restart");
    if (result.kind !== "interrupt_restart") return;
    expect(result.changed).toEqual(["model"]);
  });

  it("restarts on a reasoning or service-tier change", () => {
    expect(
      decideSteerSettings(TURN, { ...SETTINGS, reasoningEffort: "high" }),
    ).toMatchObject({ kind: "interrupt_restart" });
    expect(
      decideSteerSettings(TURN, { ...SETTINGS, serviceTier: "flex" }),
    ).toMatchObject({ kind: "interrupt_restart" });
  });

  it("restarts on an agent-mode change", () => {
    const result = decideSteerSettings(TURN, {
      ...SETTINGS,
      agentMode: "epic",
    });
    expect(result).toEqual({
      kind: "interrupt_restart",
      newSettings: { ...SETTINGS, agentMode: "epic" },
      changed: ["agent mode"],
    });
  });

  it("restarts when a queued item is restamped to a different managed profile mid-turn", () => {
    const turnOnProfileA: ChatActiveTurn = { ...TURN, profileId: "profile-a" };
    const result = decideSteerSettings(turnOnProfileA, {
      ...SETTINGS,
      profileId: "profile-b",
    });
    expect(result).toEqual({
      kind: "interrupt_restart",
      newSettings: { ...SETTINGS, profileId: "profile-b" },
      changed: ["profile"],
    });
  });

  it("injects silently when the queued item stays on the turn's own managed profile", () => {
    const turnOnProfileA: ChatActiveTurn = { ...TURN, profileId: "profile-a" };
    const result = decideSteerSettings(turnOnProfileA, {
      ...SETTINGS,
      profileId: "profile-a",
    });
    expect(result.kind).toBe("silent_inject");
  });

  // Backward-compat: a turn received from a host (or read from persisted
  // state) before `profileId` existed on the wire parses with the schema's
  // `null` default - indistinguishable here from a turn that genuinely ran
  // ambient. Comparing against ANY selected managed profile must still force
  // a restart (never silently fold a real profile into a turn of unknown
  // profile) - the safe direction, matching this file's doc comment.
  it("restarts when the active turn has no recorded profileId (old-turn default) and a managed profile is now selected", () => {
    const result = decideSteerSettings(TURN, {
      ...SETTINGS,
      profileId: "profile-a",
    });
    expect(result).toEqual({
      kind: "interrupt_restart",
      newSettings: { ...SETTINGS, profileId: "profile-a" },
      changed: ["profile"],
    });
  });
});
