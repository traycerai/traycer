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

// The persisted half of adding a harness, which `adding-a-harness.md` calls the
// single most dangerous omission in the repo: `persistence/epic/foundation.ts`
// re-declares its OWN `guiHarnessIdSchema`, deliberately independent of the
// host RPC enum and kept in sync only by convention. Miss it and every chat run
// on the new harness becomes unreadable (`CHAT_INVALID`) on reload - a failure
// that shows up on a user's next launch, not in any compile.
//
// Nothing type-checks the two enums against each other, so this asserts the
// persisted layer directly rather than through anything that imports the RPC
// enum.
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

  // Reasonix's effort surface is DYNAMIC AND PER-MODEL: the levels come from
  // the session's live `configOptions` array (DeepSeek / Anthropic sets, or an
  // explicit `supported_efforts`), and that array is replaced wholesale on every
  // `config_option_update` - so the same install can offer efforts on one model
  // and none on the next.
  //
  // This asserts the persistence layer imposes nothing on top of that. Both a
  // concrete level and `null` round-trip for `reasonix` exactly as they do for
  // every other harness, so a per-model catalog is free to grow or shrink
  // without a persisted record becoming unreadable. Nothing here (and nothing
  // in the GUI, which reads `supportedReasoningEfforts` off the per-MODEL
  // catalog row) may hardcode an empty effort set for this harness.
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
    // Session granularity, like hermes and devin: `session/load` reloads the
    // whole ACP session and Reasonix has no per-message fork point at all -
    // `session/fork` answers `-32601`, so there is no truncation id to carry.
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
