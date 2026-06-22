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
};

const TURN: ChatActiveTurn = {
  turnId: "turn-1",
  status: "running",
  harnessId: "codex",
  model: "gpt-5-codex",
  reasoningEffort: "medium",
  serviceTier: "default",
  agentMode: "regular",
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
});
