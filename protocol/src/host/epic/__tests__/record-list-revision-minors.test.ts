import { describe, expect, it } from "vitest";
import {
  epicListChatRecordsUpgradeV12ToV13,
  epicListChatRecordsV12,
  epicListChatRecordsV13,
} from "@traycer/protocol/host/epic/contracts";
import {
  hostChatRecordsSubscribeServerFrameSchemaV13,
  hostChatRecordsSubscribeServerFrameSchemaV14,
  hostChatRecordsSubscribeV13,
  listChatRecordsRequestV11Schema,
  listChatRecordsRequestV13Schema,
  listChatRecordsResponseV12Schema,
  listChatRecordsResponseV13Schema,
} from "@traycer/protocol/host/epic/chat-records";
import {
  epicListTuiAgentsUpgradeV12ToV13,
  listTuiAgentsRequestV12Schema,
  listTuiAgentsRequestV13Schema,
  listTuiAgentsResponseV13Schema,
  tuiAgentRecordSummaryV12Schema,
  tuiAgentRecordSummaryV13CloudSchema,
  tuiAgentRecordSummaryV13DocSchema,
  tuiAgentRecordSummaryV13RegistrySchema,
  type TuiAgentRecordSummaryV12,
} from "@traycer/protocol/host/epic/tui-agent-records";
import {
  recordListEpochSchema,
  recordListRecencyPatchSchema,
} from "@traycer/protocol/host/epic/record-list-revision";

/**
 * Contract tests for the additive `@1.3` minors of `epic.listChatRecords`
 * and `epic.listTuiAgents`, and `host.chatRecords.subscribe@1.4`. These four
 * minors landed on one branch (`322d48c24`); see that commit and
 * `record-list-revision.ts` / `agent-session-state.ts` for the vocabulary.
 */

const STAMP = {
  epoch: "epoch-1",
  revision: 3,
  touchRevision: 1,
} as const;

// ─── A. epic.listChatRecords@1.3 ────────────────────────────────────────────

const CHAT_ROW = {
  chatId: "chat-1",
  ownerUserId: "user-1",
  originHostId: "host-1",
  title: "Protocol layer",
  isTitleEditedByUser: true,
  parentChatId: null,
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_100_000,
  archived: false,
  archivedAt: null,
  runSettingsSummary: "claude",
  revision: 7,
  visibility: "private",
  origin: "own",
  docResident: false,
} as const;

describe("epic.listChatRecords@1.3", () => {
  it("A1: a snapshot value parses as the bare @1.2 body, with `kind` and `listStamp` gone", () => {
    const snapshot = {
      kind: "snapshot" as const,
      listStamp: STAMP,
      chats: [CHAT_ROW],
    };

    const parsed = listChatRecordsResponseV12Schema.parse(snapshot);

    expect(Object.hasOwn(parsed, "kind")).toBe(false);
    expect(Object.hasOwn(parsed, "listStamp")).toBe(false);
    expect(parsed.chats).toEqual([CHAT_ROW]);
  });

  it("A2: an unchanged value fails @1.2's schema, because it carries no `chats`", () => {
    const unchanged = {
      kind: "unchanged" as const,
      listStamp: STAMP,
      touched: [],
    };

    expect(listChatRecordsResponseV12Schema.safeParse(unchanged).success).toBe(
      false,
    );
  });

  it("A3: the request upgrade fills knownRevision: null and leaves the rest untouched", () => {
    const upgraded = epicListChatRecordsUpgradeV12ToV13.upgradeRequest({
      epicId: "epic-1",
      hasDocReplica: true,
    });

    expect(listChatRecordsRequestV13Schema.parse(upgraded)).toEqual({
      epicId: "epic-1",
      hasDocReplica: true,
      knownRevision: null,
    });
  });

  it("A4: the response upgrade yields a null-stamped snapshot that preserves the rows", () => {
    const upgraded = epicListChatRecordsUpgradeV12ToV13.upgradeResponse({
      chats: [CHAT_ROW],
    });

    expect(upgraded).toEqual({
      kind: "snapshot",
      listStamp: null,
      chats: [CHAT_ROW],
    });
    expect(listChatRecordsResponseV13Schema.parse(upgraded)).toEqual(upgraded);
  });

  it("A5: the request schema rejects a @1.2 request and accepts both a null and a full stamp", () => {
    const v12Request = listChatRecordsRequestV11Schema.parse({
      epicId: "epic-1",
      hasDocReplica: false,
    });
    expect(listChatRecordsRequestV13Schema.safeParse(v12Request).success).toBe(
      false,
    );

    expect(
      listChatRecordsRequestV13Schema.safeParse({
        ...v12Request,
        knownRevision: null,
      }).success,
    ).toBe(true);
    expect(
      listChatRecordsRequestV13Schema.safeParse({
        ...v12Request,
        knownRevision: STAMP,
      }).success,
    ).toBe(true);
  });

  it("sanity: the contract pair actually negotiates @1.2 -> @1.3", () => {
    expect(epicListChatRecordsV12.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
    expect(epicListChatRecordsV13.schemaVersion).toEqual({
      major: 1,
      minor: 3,
    });
  });
});

// ─── B. epic.listTuiAgents@1.3 ──────────────────────────────────────────────

const TUI_BASE = {
  tuiAgentId: "tui-1",
  ownerUserId: "user-1",
  hostId: "host-1",
  harnessId: "claude",
  harnessSessionId: null,
  parentId: null,
  title: "An agent",
  isTitleEditedByUser: false,
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  archivedAt: null,
  workspaceFolders: [] as string[],
  workspaceMode: null,
  model: null,
  reasoningEffort: null,
  agentMode: "regular" as const,
  profileId: null,
  terminalAgentArgs: null,
  terminalShellCommand: null,
  terminalShellArgs: null as string[] | null,
  revision: 1,
  docResident: false,
};

const TUI_V12_REGISTRY: TuiAgentRecordSummaryV12 = {
  ...TUI_BASE,
  origin: "registry",
};

const TUI_V12_DOC: TuiAgentRecordSummaryV12 = {
  ...TUI_BASE,
  docResident: true,
  origin: "doc",
};

const TUI_V12_CLOUD: TuiAgentRecordSummaryV12 = {
  origin: "cloud",
  tuiAgentId: "tui-2",
  ownerUserId: "user-1",
  hostId: "host-2",
  harnessId: "claude",
  parentId: null,
  title: "A remote agent",
  isTitleEditedByUser: false,
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  revision: 7,
};

describe("epic.listTuiAgents@1.3 session facet", () => {
  it("B6: each origin arm strips the facet when reparsed under @1.2, everything else intact", () => {
    for (const [v12Row, v13Extend] of [
      [TUI_V12_REGISTRY, tuiAgentRecordSummaryV13RegistrySchema] as const,
      [TUI_V12_DOC, tuiAgentRecordSummaryV13DocSchema] as const,
      [TUI_V12_CLOUD, tuiAgentRecordSummaryV13CloudSchema] as const,
    ]) {
      const v13Row = v13Extend.parse({
        ...v12Row,
        sessionState: "running",
        lastExit: null,
      });

      const reparsed = tuiAgentRecordSummaryV12Schema.parse(v13Row);
      expect(Object.hasOwn(reparsed, "sessionState")).toBe(false);
      expect(Object.hasOwn(reparsed, "lastExit")).toBe(false);
      expect(reparsed).toEqual(v12Row);
    }
  });

  it("B7: accepts every closed sessionState/lastExit member and rejects an unknown one", () => {
    for (const sessionState of ["running", "sleeping", "stopped", null]) {
      expect(
        tuiAgentRecordSummaryV13RegistrySchema.safeParse({
          ...TUI_V12_REGISTRY,
          sessionState,
          lastExit: null,
        }).success,
      ).toBe(true);
    }
    expect(
      tuiAgentRecordSummaryV13RegistrySchema.safeParse({
        ...TUI_V12_REGISTRY,
        sessionState: "napping",
        lastExit: null,
      }).success,
    ).toBe(false);

    for (const lastExit of [
      "reaped",
      "user-stop",
      "restart",
      "process-exit",
      null,
    ]) {
      expect(
        tuiAgentRecordSummaryV13RegistrySchema.safeParse({
          ...TUI_V12_REGISTRY,
          sessionState: null,
          lastExit,
        }).success,
      ).toBe(true);
    }
    expect(
      tuiAgentRecordSummaryV13RegistrySchema.safeParse({
        ...TUI_V12_REGISTRY,
        sessionState: null,
        lastExit: "timed-out",
      }).success,
    ).toBe(false);
  });

  it("B8: the upgrade path fills knownRevision/listStamp/facet nulls and preserves every arm", () => {
    const upgradedRequest = epicListTuiAgentsUpgradeV12ToV13.upgradeRequest(
      listTuiAgentsRequestV12Schema.parse({
        epicId: "epic-1",
        hasDocReplica: false,
      }),
    );
    expect(listTuiAgentsRequestV13Schema.parse(upgradedRequest)).toEqual({
      epicId: "epic-1",
      hasDocReplica: false,
      knownRevision: null,
    });

    const upgradedResponse = epicListTuiAgentsUpgradeV12ToV13.upgradeResponse({
      tuiAgents: [TUI_V12_REGISTRY, TUI_V12_DOC, TUI_V12_CLOUD],
    });

    expect(upgradedResponse.kind).toBe("snapshot");
    expect(upgradedResponse.listStamp).toBeNull();
    if (upgradedResponse.kind !== "snapshot") {
      throw new Error("expected a snapshot arm");
    }
    expect(
      upgradedResponse.tuiAgents.map((row) => [
        row.origin,
        row.sessionState,
        row.lastExit,
      ]),
    ).toEqual([
      ["registry", null, null],
      ["doc", null, null],
      ["cloud", null, null],
    ]);

    const parsed = listTuiAgentsResponseV13Schema.parse(upgradedResponse);
    expect(parsed).toEqual(upgradedResponse);
  });

  it("B9: touched recency patches parse, and a patch missing ownerUserId is refused", () => {
    const unchanged = {
      kind: "unchanged" as const,
      listStamp: STAMP,
      touched: [
        {
          id: "tui-1",
          ownerUserId: "user-1",
          updatedAt: 5,
          revision: 2,
        },
      ],
    };
    expect(listTuiAgentsResponseV13Schema.parse(unchanged)).toEqual(unchanged);

    expect(
      recordListRecencyPatchSchema.safeParse({
        id: "tui-1",
        updatedAt: 5,
        revision: 2,
      }).success,
    ).toBe(false);
  });

  it("B10: the epoch schema rejects an empty string - no epoch is unrepresentable", () => {
    expect(recordListEpochSchema.safeParse("").success).toBe(false);
    expect(recordListEpochSchema.safeParse("e").success).toBe(true);
  });
});

// ─── C. host.chatRecords.subscribe@1.4 ──────────────────────────────────────

const CHAT_STREAM_ROW = {
  ...CHAT_ROW,
  head: null,
};

describe("host.chatRecords.subscribe@1.4", () => {
  it("C11: the @1.3 frame set is unchanged and stays installed by identity", () => {
    const v14Frame = {
      kind: "tuiUpsert" as const,
      hasBinaryPayload: false as const,
      epicId: "epic-1",
      tuiAgentId: TUI_V12_REGISTRY.tuiAgentId,
      revision: TUI_V12_REGISTRY.revision,
      listRevision: STAMP,
      record: { ...TUI_V12_REGISTRY, sessionState: "running", lastExit: null },
    };

    const reparsed =
      hostChatRecordsSubscribeServerFrameSchemaV13.parse(v14Frame);
    expect(reparsed.kind).toBe("tuiUpsert");
    if (reparsed.kind !== "tuiUpsert") {
      throw new Error("expected tuiUpsert");
    }
    expect(Object.hasOwn(reparsed, "listRevision")).toBe(false);
    expect(Object.hasOwn(reparsed.record, "sessionState")).toBe(false);
    expect(Object.hasOwn(reparsed.record, "lastExit")).toBe(false);
    expect(reparsed.record).toEqual(TUI_V12_REGISTRY);

    expect(hostChatRecordsSubscribeV13.serverFrameSchema).toBe(
      hostChatRecordsSubscribeServerFrameSchemaV13,
    );
  });

  it("C12: @1.4 requires listRevision on every record delta kind, but not on pong", () => {
    const upsertBase = {
      kind: "upsert" as const,
      hasBinaryPayload: false as const,
      epicId: "epic-1",
      chatId: CHAT_STREAM_ROW.chatId,
      revision: CHAT_STREAM_ROW.revision,
      record: CHAT_STREAM_ROW,
    };
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        ...upsertBase,
        listRevision: STAMP,
      }).success,
    ).toBe(true);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(upsertBase)
        .success,
    ).toBe(false);

    const removeBase = {
      kind: "remove" as const,
      hasBinaryPayload: false as const,
      epicId: "epic-1",
      chatId: CHAT_STREAM_ROW.chatId,
      reason: "deleted" as const,
    };
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        ...removeBase,
        listRevision: STAMP,
      }).success,
    ).toBe(true);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(removeBase)
        .success,
    ).toBe(false);

    const tuiUpsertBase = {
      kind: "tuiUpsert" as const,
      hasBinaryPayload: false as const,
      epicId: "epic-1",
      tuiAgentId: TUI_V12_REGISTRY.tuiAgentId,
      revision: TUI_V12_REGISTRY.revision,
      record: { ...TUI_V12_REGISTRY, sessionState: null, lastExit: null },
    };
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        ...tuiUpsertBase,
        listRevision: STAMP,
      }).success,
    ).toBe(true);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(tuiUpsertBase)
        .success,
    ).toBe(false);

    const tuiRemoveBase = {
      kind: "tuiRemove" as const,
      hasBinaryPayload: false as const,
      epicId: "epic-1",
      tuiAgentId: TUI_V12_REGISTRY.tuiAgentId,
      reason: "deleted" as const,
    };
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        ...tuiRemoveBase,
        listRevision: STAMP,
      }).success,
    ).toBe(true);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse(tuiRemoveBase)
        .success,
    ).toBe(false);

    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });

  it("C13: the envelope invariants still fire on both upsert kinds", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "some-other-chat",
        revision: CHAT_STREAM_ROW.revision,
        listRevision: STAMP,
        record: CHAT_STREAM_ROW,
      }).success,
    ).toBe(false);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: CHAT_STREAM_ROW.chatId,
        revision: CHAT_STREAM_ROW.revision + 1,
        listRevision: STAMP,
        record: CHAT_STREAM_ROW,
      }).success,
    ).toBe(false);

    const tuiRecord = {
      ...TUI_V12_REGISTRY,
      sessionState: null,
      lastExit: null,
    };
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        kind: "tuiUpsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: "some-other-agent",
        revision: tuiRecord.revision,
        listRevision: STAMP,
        record: tuiRecord,
      }).success,
    ).toBe(false);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV14.safeParse({
        kind: "tuiUpsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: tuiRecord.tuiAgentId,
        revision: tuiRecord.revision + 1,
        listRevision: STAMP,
        record: tuiRecord,
      }).success,
    ).toBe(false);
  });
});
