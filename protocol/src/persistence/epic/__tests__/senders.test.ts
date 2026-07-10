import { describe, expect, it } from "vitest";
import { chatSessionAnchorSchema } from "../senders";

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
    // A genuine pre-T7 payload: no `accentColor` key at all, matching how a
    // real anchor persisted before this field existed round-trips through
    // JSON (TypeScript can't express "missing key" on a typed literal).
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
