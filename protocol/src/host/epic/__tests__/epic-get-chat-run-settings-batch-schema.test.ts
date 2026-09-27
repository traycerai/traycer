import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS,
  getChatRunSettingsBatchRequestSchema,
  getChatRunSettingsBatchResponseSchema,
} from "@traycer/protocol/host/epic/chat-records";

describe("epic.getChatRunSettingsBatch", () => {
  const v10 =
    hostRpcRegistry["epic.getChatRunSettingsBatch"][1].versions[0].contract;

  it("registers @1.0 as an optional unsupported-degrade method", () => {
    expect(v10.method).toBe("epic.getChatRunSettingsBatch");
    expect(v10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(hostRpcRegistry["epic.getChatRunSettingsBatch"][1].latestMinor).toBe(
      0,
    );
    expect(hostRpcRegistry["epic.getChatRunSettingsBatch"].degrade).toEqual({
      kind: "unsupported",
    });
    expect(v10.requestSchema).toBe(getChatRunSettingsBatchRequestSchema);
    expect(v10.responseSchema).toBe(getChatRunSettingsBatchResponseSchema);
  });

  it("round-trips a request at the id cap", () => {
    const chatIds = Array.from(
      { length: GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS },
      (_unused, index) => `chat-${String(index)}`,
    );
    expect(
      getChatRunSettingsBatchRequestSchema.parse({
        epicId: "epic-1",
        chatIds,
      }),
    ).toEqual({ epicId: "epic-1", chatIds });
  });

  it("rejects more than 50 chat ids", () => {
    const chatIds = Array.from(
      { length: GET_CHAT_RUN_SETTINGS_BATCH_MAX_IDS + 1 },
      (_unused, index) => `chat-${String(index)}`,
    );
    expect(
      getChatRunSettingsBatchRequestSchema.safeParse({
        epicId: "epic-1",
        chatIds,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty chatIds list", () => {
    expect(
      getChatRunSettingsBatchRequestSchema.safeParse({
        epicId: "epic-1",
        chatIds: [],
      }).success,
    ).toBe(false);
  });

  it("round-trips entries with a live settings tuple and a null", () => {
    const parsed = getChatRunSettingsBatchResponseSchema.parse({
      entries: [
        {
          chatId: "chat-owned",
          settings: {
            harnessId: "claude",
            model: "sonnet",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
        { chatId: "chat-null", settings: null },
      ],
    });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.settings?.harnessId).toBe("claude");
    expect(parsed.entries[1]?.settings).toBeNull();
  });
});
