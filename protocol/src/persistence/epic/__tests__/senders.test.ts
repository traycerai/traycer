import { describe, expect, it } from "vitest";
import { chatSessionAnchorSchema } from "../senders";
import { chatRunSettingsSchema } from "../foundation";

function claudeAnchorFields() {
  return {
    harnessId: "claude" as const,
    hostId: "host-1",
    sessionId: "session-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot" as const,
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "uuid-1",
    createdAt: 100,
    coveredUntilMessageId: null,
  };
}

describe("chatSessionAnchorSchema - accentColor snapshot", () => {
  it("parses a legacy anchor with no accentColor key, defaulting it to null", () => {
    const legacy = JSON.parse(
      JSON.stringify({
        ...claudeAnchorFields(),
        profileId: "removed-uuid",
        labelSnapshot: "Work",
        accountUuid: "account-1",
      }),
    );

    const result = chatSessionAnchorSchema.parse(legacy);

    expect(result.accentColor).toBeNull();
    expect(result).toMatchObject({
      profileId: "removed-uuid",
      labelSnapshot: "Work",
      accountUuid: "account-1",
    });
  });

  it("round-trips a present accentColor snapshot unmodified", () => {
    const anchor = {
      ...claudeAnchorFields(),
      profileId: "work-uuid",
      labelSnapshot: "Work",
      accountUuid: "account-1",
      accentColor: "#ef4444",
    };

    const result = chatSessionAnchorSchema.parse(anchor);

    expect(result.accentColor).toBe("#ef4444");
  });

  it("defaults accentColor to null for an ambient (profileId: null) anchor with no snapshot fields", () => {
    const ambient = JSON.parse(
      JSON.stringify({
        ...claudeAnchorFields(),
      }),
    );

    const result = chatSessionAnchorSchema.parse(ambient);

    expect(result.profileId).toBeNull();
    expect(result.labelSnapshot).toBeNull();
    expect(result.accountUuid).toBeNull();
    expect(result.accentColor).toBeNull();
  });
});

describe("Reasonix persisted records", () => {
  it("accepts a reasonix chat run-settings tuple", () => {
    const settings = chatRunSettingsSchema.parse({
      harnessId: "reasonix",
      model: "deepseek-flash/deepseek-v4-flash",
      permissionMode: "supervised",
      reasoningEffort: null,
      agentMode: "regular",
    });

    expect(settings.harnessId).toBe("reasonix");
    expect(settings.reasoningEffort).toBeNull();
    // The two `.default(...)` backstops still apply to a brand-new harness.
    expect(settings.serviceTier).toBeNull();
    expect(settings.profileId).toBeNull();
  });

  it.each([["high"], ["minimal"], [null]])(
    "round-trips reasoningEffort %s on a reasonix tuple - efforts are per-model, not per-harness",
    (reasoningEffort) => {
      const settings = chatRunSettingsSchema.parse({
        harnessId: "reasonix",
        model: "deepseek-flash/deepseek-v4-flash",
        permissionMode: "supervised",
        reasoningEffort,
        agentMode: "regular",
      });

      expect(settings.reasoningEffort).toBe(reasoningEffort);
    },
  );

  it("parses a reasonix session anchor as a session-granularity ACP anchor", () => {
    const anchor = chatSessionAnchorSchema.parse({
      harnessId: "reasonix",
      hostId: "host-1",
      sessionId: "acp-session-1",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot" as const,
        primaryWorkspace: "/repo",
        secondaryWorkspaces: [],
      },
      createdAt: 100,
      coveredUntilMessageId: null,
    });

    expect(anchor).toMatchObject({
      harnessId: "reasonix",
      sessionId: "acp-session-1",
    });
    expect(anchor).not.toHaveProperty("opencodeUserMessageId");
    // Profile snapshot fields default the same way every other anchor's do.
    expect(anchor.profileId).toBeNull();
    expect(anchor.accentColor).toBeNull();
  });
});
