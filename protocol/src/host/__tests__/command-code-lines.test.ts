import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  agentConfigureResponseSchema,
  agentConfigureResponseSchemaV6,
  agentGetProviderProfileRateLimitsResponseSchemaV6,
  agentGetProviderProfileRateLimitsResponseSchemaV7,
  agentListProviderProfilesResponseSchema,
  agentListProviderProfilesResponseSchemaV6,
} from "@traycer/protocol/host/agent/profiles";
import {
  guiHarnessIdSchemaV90,
  listAgentsResponseSchema,
  listAgentsResponseSchemaV91,
  listAgentsResponseSchemaV92,
} from "@traycer/protocol/host/agent/shared";
import {
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV92,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  chatSubscribeV120,
  chatSubscribeV121,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  chatFallbackListTargetsResponseSchema,
  chatFallbackListTargetsResponseSchemaV10,
} from "@traycer/protocol/host/chat-fallback";
import {
  draftsListResponseSchema,
  draftsListResponseSchemaV10,
  draftsSubscribeServerFrameSchemaV10,
  draftsSubscribeServerFrameSchemaV11,
  draftsUpsertResponseSchema,
  draftsUpsertResponseSchemaV10,
} from "@traycer/protocol/host/drafts/schemas";
import {
  getChatRunSettingsBatchResponseSchema,
  getChatRunSettingsBatchResponseSchemaV10,
  getChatRunSettingsResponseSchema,
  getChatRunSettingsResponseSchemaV30,
} from "@traycer/protocol/host/epic/chat-records";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
  fallbackPolicySchemaV10,
  providersFallbackPolicyGetResponseSchema,
  providersFallbackPolicyGetResponseSchemaV10,
  providersFallbackPolicyPreviewTierGroupsResponseSchema,
  providersFallbackPolicyPreviewTierGroupsResponseSchemaV11,
} from "@traycer/protocol/host/fallback-policy";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV92,
} from "@traycer/protocol/host/provider-schemas";
import { providersChangedServerFrameSchemaV11 } from "@traycer/protocol/host/providers-changed-stream";
import {
  providersRefreshProfileStatusResponseSchema,
  providersRefreshProfileStatusResponseSchemaV20,
} from "@traycer/protocol/host/rate-limit/schemas";
import {
  sessionImportRunServerFrameSchemaPreCommandCode,
  sessionImportRunV13,
} from "@traycer/protocol/host/session-import/run";
import {
  sessionImportScanServerFrameSchemaPreCommandCode,
  sessionImportScanV13,
} from "@traycer/protocol/host/session-import/scan";
import { transcriptRowContextSchema } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { transcriptRowContextSchemaPreCommandCode } from "@traycer/protocol/persistence/chat-transcript/row-context";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { guiHarnessIdSchemaPreCommandCode } from "@traycer/protocol/persistence/epic/foundation";

/**
 * The Command Code harness (`commandcode`) joined the live id enums after the
 * 1.5.0 cut. Every released line that carries a harness/provider id in a
 * host->client payload froze at the twenty-one ids it shipped and a new head
 * opened. This file asserts the MECHANISM of each new head: what its downgrade
 * bridges keep, what they drop, what they refuse and with which message, and
 * that every frozen schema rejects the new id while its live counterpart takes
 * it. Each negative has its positive control beside it.
 */

const NEW_ID = "commandcode";

type Registry = typeof hostRpcRegistry;

function chatRunSettings(harnessId: string) {
  return {
    harnessId,
    model: "model-1",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };
}

function expectRefused(
  result: {
    readonly ok: boolean;
    readonly error?: { readonly code: string; readonly message: string };
  },
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) return;
  expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  expect(result.error.message).toBe(message);
  // The refusal must be id-agnostic: an old client has no business learning
  // the name of a harness it cannot represent.
  expect(result.error.message).not.toMatch(/command ?code/i);
}

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
  };
}

function harnessRow(id: string) {
  return {
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
  };
}

function agentRow(id: string, harnessId: string | null) {
  return {
    id,
    parentId: null,
    hostId: "host-1",
    isLocal: true,
    surface: "gui",
    harnessId,
    isSelf: false,
    title: id,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: [],
    isWorktree: false,
    runConfig: null,
    sessionState: null,
    lastExit: null,
    // `agent.list@9.2` put `archived` on the row; 10.0 carries it live.
    archived: null,
  };
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function draftDocument(draftId: string, harnessId: string) {
  return {
    draftId,
    kind: "landing" as const,
    target: { epicId: null, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 1_753_000_000_000,
    workspace: null,
    supersedes: null,
    portable: {
      content: EMPTY_DOC,
      selection: { from: 1, to: 1 },
      runSettings: chatRunSettings(harnessId),
      composerMode: "chat" as const,
      blobHashes: [] as string[],
      closed: false,
    },
    ownerHostId: "host-1",
    origin: "own" as const,
    adoption: { state: "adopted" as const, hostId: "host-1" },
    publication: {
      status: "unpublished" as const,
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
  };
}

function policyWithCandidate(harnessId: string) {
  return {
    ...createDefaultFallbackPolicy(),
    tierGroups: [
      {
        id: "g1",
        candidates: [{ harnessId, modelFamily: "*", reasoningEffort: null }],
      },
    ],
    defaultTierGroupId: "g1",
  };
}

function unavailableRateLimits(provider: string) {
  return { provider, available: false, reason: "cli_not_found" };
}

function downgradeTargetsOf(line: object | undefined): number[] {
  if (
    typeof line !== "object" ||
    line === null ||
    !("downgradePathsFromLatest" in line)
  ) {
    throw new Error("expected a major line carrying downgrade paths");
  }
  const paths = line.downgradePathsFromLatest;
  if (typeof paths !== "object" || paths === null) {
    throw new Error("expected downgrade paths to be an object");
  }
  return Object.keys(paths)
    .map(Number)
    .sort((x, y) => x - y);
}

describe("every new head is the registry's canonical line", () => {
  const UNARY_HEADS: readonly (readonly [keyof Registry, number])[] = [
    ["agent.gui.listHarnesses", 10],
    ["agent.list", 10],
    ["providers.list", 10],
    ["agent.listProviderProfiles", 7],
    ["agent.getProviderProfileRateLimits", 7],
    ["agent.configure", 7],
    ["providers.refreshProfileStatus", 3],
    ["epic.getChatRunSettings", 4],
    ["epic.getChatRunSettingsBatch", 2],
    ["chat.fallback.listTargets", 2],
    ["drafts.list", 2],
    ["drafts.upsert", 2],
    ["providers.fallbackPolicy.get", 2],
    ["providers.fallbackPolicy.set", 2],
    ["providers.fallbackPolicy.previewTierGroups", 2],
    ["providers.fallbackPolicy.reset", 2],
    ["providers.fallbackPolicy.restoreTierGroups", 2],
  ];

  it.each(UNARY_HEADS)(
    "%s opens major %i with a downgrade path to every lower major",
    (method, head) => {
      const entry = hostRpcRegistry[method];
      // The highest installed major is the head, and the previous head is the
      // one that froze (a positive control for "this is not the old line").
      const majors = Object.keys(entry)
        .filter((key) => /^\d+$/.test(key))
        .map(Number)
        .sort((a, b) => a - b);
      expect(majors.at(-1)).toBe(head);
      expect(majors).toContain(head - 1);
      const headLine = Object.entries(entry).find(
        ([key]) => key === String(head),
      )?.[1];
      const lower = downgradeTargetsOf(headLine);
      expect(lower).toEqual(majors.filter((major) => major < head));
    },
  );

  it("stream heads are the new minors, with the released minors still installed", () => {
    const chat = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(chat.latestMinor).toBe(21);
    expect(chat.versions[21].contract).toBe(chatSubscribeV121);
    expect(chat.versions[20].contract).toBe(chatSubscribeV120);
    expect(hostStreamRpcRegistry["sessionImport.scan"][1].latestMinor).toBe(3);
    expect(
      hostStreamRpcRegistry["sessionImport.scan"][1].versions[3].contract,
    ).toBe(sessionImportScanV13);
    expect(hostStreamRpcRegistry["sessionImport.run"][1].latestMinor).toBe(3);
    expect(
      hostStreamRpcRegistry["sessionImport.run"][1].versions[3].contract,
    ).toBe(sessionImportRunV13);
    expect(hostStreamRpcRegistry["providers.changed"][1].latestMinor).toBe(2);
    expect(hostStreamRpcRegistry["drafts.subscribe"][1].latestMinor).toBe(1);
  });
});

describe("row-dropping catalog bridges (10 -> every lower major)", () => {
  it("agent.gui.listHarnesses drops only the commandcode row", () => {
    const response = listGuiHarnessesResponseSchema.parse({
      harnesses: [
        harnessRow("claude"),
        harnessRow(NEW_ID),
        harnessRow("codex"),
      ],
    });
    expect(response.harnesses.map((row) => row.id)).toEqual([
      "claude",
      NEW_ID,
      "codex",
    ]);
    for (const target of [9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["agent.gui.listHarnesses"],
        10,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.harnesses.map((row) => row.id),
        `to ${String(target)}`,
      ).toEqual(["claude", "codex"]);
    }
  });

  it("agent.list drops commandcode agents, keeps a null-harness agent", () => {
    const response = listAgentsResponseSchema.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentRow("a-claude", "claude"),
        agentRow("a-cc", NEW_ID),
        agentRow("a-null", null),
      ],
    });
    expect(response.agents.map((agent) => agent.id)).toEqual([
      "a-claude",
      "a-cc",
      "a-null",
    ]);
    for (const target of [9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["agent.list"],
        10,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.agents.map((agent) => agent.id),
        `to ${String(target)}`,
      ).toEqual(["a-claude", "a-null"]);
      // `caller` and `scope` are not rows and ride through.
      expect(result.value.scope).toBe("all");
      expect(result.value.caller).toEqual({
        agentId: "self",
        canSendMessages: true,
      });
    }
  });

  it("providers.list drops commandcode provider rows and lands on 9.2 by identity for the rest", () => {
    const response = providersListResponseSchema.parse({
      providers: [providerState("codex"), providerState(NEW_ID)],
      native: null,
    });
    expect(response.providers.map((row) => row.providerId)).toEqual([
      "codex",
      NEW_ID,
    ]);
    for (const target of [9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        10,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.providers.map((row) => row.providerId),
        `to ${String(target)}`,
      ).toEqual(["codex"]);
    }
    const nine = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      10,
      9,
      response,
    );
    if (!nine.ok) throw new Error("expected 10 -> 9 to succeed");
    expect(providersListResponseSchemaV92.safeParse(nine.value).success).toBe(
      true,
    );
  });
});

describe("row-dropping bridges that keep non-row fields", () => {
  it("drafts.list omits unrepresentable rows and leaves tombstones, snapshotSeq and scopeId alone", () => {
    const tombstone = {
      draftId: "gone",
      revision: 4,
      storeSeq: 9,
    };
    const response = draftsListResponseSchema.parse({
      scopeId: "scp_1",
      drafts: [draftDocument("d-ok", "claude"), draftDocument("d-cc", NEW_ID)],
      tombstones: [tombstone],
      snapshotSeq: 12,
    });
    expect(response.drafts.map((draft) => draft.draftId)).toEqual([
      "d-ok",
      "d-cc",
    ]);
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["drafts.list"],
      2,
      1,
      response,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drafts.map((draft) => draft.draftId)).toEqual(["d-ok"]);
    expect(result.value.tombstones).toEqual(response.tombstones);
    expect(result.value.snapshotSeq).toBe(12);
    expect(result.value.scopeId).toBe("scp_1");
    expect(draftsListResponseSchemaV10.safeParse(result.value).success).toBe(
      true,
    );
  });

  it("chat.fallback.listTargets omits only unrepresentable model rows and keeps profileTargets and outcome", () => {
    const profileTarget = {
      profileId: null,
      label: "Ambient",
      severity: "ok",
      usedPercent: null,
      target: chatRunSettings("claude"),
      warnings: [],
      selectable: true,
      skip: null,
    };
    const row = (
      groupId: string,
      harnessId: string,
      targetHarness: string | null,
    ) => ({
      groupId,
      harnessId,
      modelFamily: "*",
      model: null,
      reasoningEffort: null,
      profileId: null,
      severity: "ok",
      usedPercent: null,
      target: targetHarness === null ? null : chatRunSettings(targetHarness),
      warnings: [],
      selectable: targetHarness !== null,
      skip: null,
    });
    const parsedProfile =
      chatFallbackListTargetsResponseSchema.shape.profileTargets.element.safeParse(
        profileTarget,
      );
    const response = chatFallbackListTargetsResponseSchema.parse({
      outcome: "listed",
      failedTuple: chatRunSettings("claude"),
      profileTargets: parsedProfile.success ? [parsedProfile.data] : [],
      modelTargets: [
        row("keep", "claude", "claude"),
        row("drop", NEW_ID, NEW_ID),
        // A row NAMING the new id with no target is representable: `harnessId`
        // is an open string on the wire, only `target` is typed.
        row("keep-null-target", NEW_ID, null),
      ],
      modelTargetsSkip: null,
    });
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["chat.fallback.listTargets"],
      2,
      1,
      response,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelTargets.map((entry) => entry.groupId)).toEqual([
      "keep",
      "keep-null-target",
    ]);
    expect(result.value.outcome).toBe("listed");
    expect(result.value.profileTargets).toEqual(response.profileTargets);
    expect(result.value.failedTuple).toEqual(response.failedTuple);
    expect(
      chatFallbackListTargetsResponseSchemaV10.safeParse(result.value).success,
    ).toBe(true);
  });

  it("chat.fallback.listTargets refuses (id-agnostic) only when failedTuple is unrepresentable", () => {
    const response = chatFallbackListTargetsResponseSchema.parse({
      outcome: "listed",
      failedTuple: chatRunSettings(NEW_ID),
      profileTargets: [],
      modelTargets: [],
      modelTargetsSkip: null,
    });
    expectRefused(
      downgradeResponseAcrossMajors(
        hostRpcRegistry["chat.fallback.listTargets"],
        2,
        1,
        response,
      ),
      "Listing fallback targets for this chat requires a newer Traycer client.",
    );
    // Positive control: the same response with a representable tuple passes.
    const ok = downgradeResponseAcrossMajors(
      hostRpcRegistry["chat.fallback.listTargets"],
      2,
      1,
      chatFallbackListTargetsResponseSchema.parse({
        ...response,
        failedTuple: chatRunSettings("claude"),
      }),
    );
    expect(ok.ok).toBe(true);
  });

  it("epic.getChatRunSettingsBatch omits unrepresentable entries, keeps the others, and never refuses", () => {
    const response = getChatRunSettingsBatchResponseSchema.parse({
      entries: [
        { chatId: "c1", settings: chatRunSettings("claude") },
        { chatId: "c2", settings: chatRunSettings(NEW_ID) },
        { chatId: "c3", settings: null },
      ],
    });
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["epic.getChatRunSettingsBatch"],
      2,
      1,
      response,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.chatId)).toEqual([
      "c1",
      "c3",
    ]);
    expect(
      getChatRunSettingsBatchResponseSchemaV10.safeParse(result.value).success,
    ).toBe(true);

    // Every entry unrepresentable: still an answer (an empty one), not a refusal.
    const allDropped = downgradeResponseAcrossMajors(
      hostRpcRegistry["epic.getChatRunSettingsBatch"],
      2,
      1,
      getChatRunSettingsBatchResponseSchema.parse({
        entries: [{ chatId: "c2", settings: chatRunSettings(NEW_ID) }],
      }),
    );
    expect(allDropped.ok).toBe(true);
    if (!allDropped.ok) return;
    expect(allDropped.value.entries).toEqual([]);
  });
});

describe("parse-or-refuse bridges", () => {
  type Case = {
    readonly label: string;
    readonly run: (representable: boolean) => {
      readonly ok: boolean;
      readonly error?: { readonly code: string; readonly message: string };
    };
    readonly message: string;
  };

  const cases: readonly Case[] = [
    {
      label: "agent.listProviderProfiles 7 -> 6",
      message:
        "Listing this provider's profiles requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.listProviderProfiles"],
          7,
          6,
          agentListProviderProfilesResponseSchema.parse({
            providerId: representable ? "codex" : NEW_ID,
            profiles: [],
          }),
        ),
    },
    {
      label: "agent.getProviderProfileRateLimits 7 -> 6",
      message:
        "Reading this provider's rate limits requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.getProviderProfileRateLimits"],
          7,
          6,
          agentGetProviderProfileRateLimitsResponseSchemaV7.parse({
            rateLimits: unavailableRateLimits(representable ? "codex" : NEW_ID),
            usageUpdatedAt: null,
          }),
        ),
    },
    {
      label: "agent.configure 7 -> 6",
      message:
        "Configuring an agent on this harness requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.configure"],
          7,
          6,
          agentConfigureResponseSchema.parse({
            settings: {
              harnessId: representable ? "claude" : NEW_ID,
              model: "model-1",
              profileSelection: { kind: "ambient" },
              reasoningEffort: null,
              fastMode: false,
              permissionMode: "supervised",
              agentMode: "regular",
            },
            warnings: [],
          }),
        ),
    },
    {
      label: "providers.refreshProfileStatus 3 -> 2",
      message:
        "Refreshing this provider's profile status requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.refreshProfileStatus"],
          3,
          2,
          providersRefreshProfileStatusResponseSchema.parse({
            providerRateLimits: unavailableRateLimits(
              representable ? "codex" : NEW_ID,
            ),
          }),
        ),
    },
    {
      label: "epic.getChatRunSettings 4 -> 3",
      message:
        "Reading this chat's run settings requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["epic.getChatRunSettings"],
          4,
          3,
          getChatRunSettingsResponseSchema.parse({
            settings: chatRunSettings(representable ? "claude" : NEW_ID),
          }),
        ),
    },
    {
      label: "drafts.upsert 2 -> 1",
      message: "This draft requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["drafts.upsert"],
          2,
          1,
          draftsUpsertResponseSchema.parse({
            draft: draftDocument("d1", representable ? "claude" : NEW_ID),
          }),
        ),
    },
    {
      label: "providers.fallbackPolicy.get 2 -> 1",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.get"],
          2,
          1,
          providersFallbackPolicyGetResponseSchema.parse({
            policy: policyWithCandidate(representable ? "claude" : NEW_ID),
            storedPolicyUnreadable: false,
            inFlightCount: 0,
          }),
        ),
    },
    {
      label: "providers.fallbackPolicy.set 2 -> 1",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.set"],
          2,
          1,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.reset 2 -> 1",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.reset"],
          2,
          1,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.restoreTierGroups 2 -> 1",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.restoreTierGroups"],
          2,
          1,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.previewTierGroups 2 -> 1",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.previewTierGroups"],
          2,
          1,
          providersFallbackPolicyPreviewTierGroupsResponseSchema.parse({
            candidates: [
              {
                groupId: "g1",
                candidateIndex: 0,
                harnessId: representable ? "claude" : NEW_ID,
                modelFamily: "*",
                reasoningEffort: null,
                resolvedModel: null,
                profileId: null,
                skipReason: null,
                skipLabel: null,
                warnings: [],
                matches: [],
              },
            ],
          }),
        ),
    },
  ];

  it.each(cases)(
    "$label passes a representable response through and refuses an unrepresentable one",
    ({ run, message }) => {
      expect(run(true).ok).toBe(true);
      expectRefused(run(false), message);
    },
  );

  it("agent.configure 7 -> 1 refuses the unrepresentable response through the whole chain", () => {
    const response = agentConfigureResponseSchema.parse({
      settings: {
        harnessId: NEW_ID,
        model: "model-1",
        profileSelection: { kind: "ambient" },
        reasoningEffort: null,
        fastMode: false,
        permissionMode: "supervised",
        agentMode: "regular",
      },
      warnings: [],
    });
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["agent.configure"],
      7,
      1,
      response,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(result.error.message).not.toMatch(/command ?code/i);
  });
});

describe("every new frozen response schema rejects commandcode while its live counterpart accepts it", () => {
  type Pair = {
    readonly label: string;
    readonly frozen: { safeParse(value: unknown): { success: boolean } };
    readonly live: { safeParse(value: unknown): { success: boolean } };
    readonly oldId: string;
    readonly withId: (id: string) => unknown;
  };

  const pairs: readonly Pair[] = [
    {
      label: "agent.gui.listHarnesses 9.2",
      oldId: "claude",
      frozen: listGuiHarnessesResponseSchemaV92,
      live: listGuiHarnessesResponseSchema,
      withId: (id) => ({ harnesses: [harnessRow(id)] }),
    },
    {
      label: "agent.list 9.1",
      oldId: "claude",
      frozen: listAgentsResponseSchemaV91,
      live: listAgentsResponseSchema,
      withId: (id) => ({
        caller: { agentId: "self", canSendMessages: true },
        scope: "all",
        agents: [agentRow("a1", id)],
      }),
    },
    {
      label: "agent.list 9.2",
      oldId: "claude",
      frozen: listAgentsResponseSchemaV92,
      live: listAgentsResponseSchema,
      withId: (id) => ({
        caller: { agentId: "self", canSendMessages: true },
        scope: "all",
        agents: [agentRow("a1", id)],
      }),
    },
    {
      label: "providers.list 9.2",
      oldId: "codex",
      frozen: providersListResponseSchemaV92,
      live: providersListResponseSchema,
      withId: (id) => ({ providers: [providerState(id)], native: null }),
    },
    {
      label: "agent.listProviderProfiles 6.0",
      oldId: "codex",
      frozen: agentListProviderProfilesResponseSchemaV6,
      live: agentListProviderProfilesResponseSchema,
      withId: (id) => ({ providerId: id, profiles: [] }),
    },
    {
      label: "agent.getProviderProfileRateLimits 6.0",
      oldId: "codex",
      frozen: agentGetProviderProfileRateLimitsResponseSchemaV6,
      live: agentGetProviderProfileRateLimitsResponseSchemaV7,
      withId: (id) => ({
        rateLimits: unavailableRateLimits(id),
        usageUpdatedAt: null,
      }),
    },
    {
      label: "agent.configure 6.0",
      oldId: "claude",
      frozen: agentConfigureResponseSchemaV6,
      live: agentConfigureResponseSchema,
      withId: (id) => ({
        settings: {
          harnessId: id,
          model: "model-1",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          permissionMode: "supervised",
          agentMode: "regular",
        },
        warnings: [],
      }),
    },
    {
      label: "providers.refreshProfileStatus 2.0",
      oldId: "codex",
      frozen: providersRefreshProfileStatusResponseSchemaV20,
      live: providersRefreshProfileStatusResponseSchema,
      withId: (id) => ({ providerRateLimits: unavailableRateLimits(id) }),
    },
    {
      label: "epic.getChatRunSettings 3.0",
      oldId: "claude",
      frozen: getChatRunSettingsResponseSchemaV30,
      live: getChatRunSettingsResponseSchema,
      withId: (id) => ({ settings: chatRunSettings(id) }),
    },
    {
      label: "epic.getChatRunSettingsBatch 1.0",
      oldId: "claude",
      frozen: getChatRunSettingsBatchResponseSchemaV10,
      live: getChatRunSettingsBatchResponseSchema,
      withId: (id) => ({
        entries: [{ chatId: "c1", settings: chatRunSettings(id) }],
      }),
    },
    {
      label: "chat.fallback.listTargets 1.0",
      oldId: "claude",
      frozen: chatFallbackListTargetsResponseSchemaV10,
      live: chatFallbackListTargetsResponseSchema,
      withId: (id) => ({
        outcome: "listed",
        failedTuple: chatRunSettings(id),
        profileTargets: [],
        modelTargets: [],
        modelTargetsSkip: null,
      }),
    },
    {
      label: "drafts.list 1.0",
      oldId: "claude",
      frozen: draftsListResponseSchemaV10,
      live: draftsListResponseSchema,
      withId: (id) => ({
        drafts: [draftDocument("d1", id)],
        tombstones: [],
        snapshotSeq: 1,
      }),
    },
    {
      label: "drafts.upsert 1.0",
      oldId: "claude",
      frozen: draftsUpsertResponseSchemaV10,
      live: draftsUpsertResponseSchema,
      withId: (id) => ({ draft: draftDocument("d1", id) }),
    },
    {
      label: "providers.fallbackPolicy.get 1.x",
      oldId: "claude",
      frozen: providersFallbackPolicyGetResponseSchemaV10,
      live: providersFallbackPolicyGetResponseSchema,
      withId: (id) => ({
        policy: policyWithCandidate(id),
        storedPolicyUnreadable: false,
        inFlightCount: 0,
      }),
    },
    {
      label: "fallbackPolicy tuple 1.0",
      oldId: "claude",
      frozen: fallbackPolicySchemaV10,
      live: fallbackPolicySchema,
      withId: (id) => policyWithCandidate(id),
    },
    {
      label: "providers.fallbackPolicy.previewTierGroups 1.1",
      oldId: "claude",
      frozen: providersFallbackPolicyPreviewTierGroupsResponseSchemaV11,
      live: providersFallbackPolicyPreviewTierGroupsResponseSchema,
      withId: (id) => ({
        candidates: [
          {
            groupId: "g1",
            candidateIndex: 0,
            harnessId: id,
            modelFamily: "*",
            reasoningEffort: null,
            resolvedModel: null,
            profileId: null,
            skipReason: null,
            skipLabel: null,
            warnings: [],
            matches: [],
          },
        ],
      }),
    },
  ];

  it.each(pairs)("$label", ({ frozen, live, oldId, withId }) => {
    // Positive control: a representable id parses on both.
    expect(frozen.safeParse(withId(oldId)).success).toBe(true);
    expect(live.safeParse(withId(oldId)).success).toBe(true);
    expect(live.safeParse(withId(NEW_ID)).success).toBe(true);
    expect(frozen.safeParse(withId(NEW_ID)).success).toBe(false);
  });

  it("the frozen id sets name the twenty-one released ids and exclude commandcode", () => {
    expect(guiHarnessIdSchemaPreCommandCode.options).toHaveLength(21);
    expect(guiHarnessIdSchemaPreCommandCode.options).not.toContain(NEW_ID);
    expect(guiHarnessIdSchemaV90.options).toHaveLength(21);
    expect(guiHarnessIdSchemaV90.options).not.toContain(NEW_ID);
    expect(guiHarnessIdSchema.options).toContain(NEW_ID);
    expect(guiHarnessIdSchema.options).toHaveLength(22);
    expect(providerCliStateSchema.shape.providerId.options).toContain(NEW_ID);
  });
});

describe("frozen stream frames reject commandcode, live counterparts accept it", () => {
  const anchor = {
    harnessId: NEW_ID,
    hostId: "host-1",
    sessionId: "s-1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    createdAt: 1,
    coveredUntilMessageId: null,
  };

  it("transcriptRowContextSchemaPreCommandCode drops the anchor arm; the live one takes it", () => {
    expect(
      transcriptRowContextSchema.safeParse({ sessionAnchor: anchor }).success,
    ).toBe(true);
    expect(
      transcriptRowContextSchemaPreCommandCode.safeParse({
        sessionAnchor: anchor,
      }).success,
    ).toBe(false);
    // Positive control: an empty context and a released anchor still parse.
    expect(transcriptRowContextSchemaPreCommandCode.safeParse({}).success).toBe(
      true,
    );
  });

  it("providers.changed 1.1 rejects a commandcode `changed` frame; 1.2's live frame takes it", () => {
    const frame = (id: string) => ({
      kind: "changed",
      providerId: id,
      hasBinaryPayload: false,
    });
    expect(
      providersChangedServerFrameSchemaV11.safeParse(frame("codex")).success,
    ).toBe(true);
    expect(
      providersChangedServerFrameSchemaV11.safeParse(frame(NEW_ID)).success,
    ).toBe(false);
    const live =
      hostStreamRpcRegistry["providers.changed"][1].versions[2].contract
        .serverFrameSchema;
    expect(live.safeParse(frame(NEW_ID)).success).toBe(true);
  });

  it("sessionImport.scan/run frozen frames reject commandcode; 1.3 accepts it", () => {
    const started = (id: string) => ({
      kind: "started",
      providers: [id],
      hasBinaryPayload: false,
    });
    expect(
      sessionImportScanServerFrameSchemaPreCommandCode.safeParse(
        started("claude"),
      ).success,
    ).toBe(true);
    expect(
      sessionImportScanServerFrameSchemaPreCommandCode.safeParse(
        started(NEW_ID),
      ).success,
    ).toBe(false);
    expect(
      sessionImportScanV13.serverFrameSchema.safeParse(started(NEW_ID)).success,
    ).toBe(true);

    const progress = (id: string) => ({
      kind: "progress",
      runId: "run-1",
      index: 0,
      total: 1,
      harness: id,
      nativeSessionId: "s-1",
      outcome: { kind: "imported", epicId: "e-1", chatId: "c-1" },
      hasBinaryPayload: false,
    });
    expect(
      sessionImportRunServerFrameSchemaPreCommandCode.safeParse(
        progress("claude"),
      ).success,
    ).toBe(true);
    expect(
      sessionImportRunServerFrameSchemaPreCommandCode.safeParse(
        progress(NEW_ID),
      ).success,
    ).toBe(false);
    expect(
      sessionImportRunV13.serverFrameSchema.safeParse(progress(NEW_ID)).success,
    ).toBe(true);
  });

  it("drafts.subscribe 1.0 rejects an upsert frame carrying commandcode run settings; 1.1 takes it", () => {
    const upsert = (id: string) => ({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 3,
      draftId: "d1",
      revision: 1,
      draft: draftDocument("d1", id),
    });
    expect(
      draftsSubscribeServerFrameSchemaV10.safeParse(upsert("claude")).success,
    ).toBe(true);
    expect(
      draftsSubscribeServerFrameSchemaV10.safeParse(upsert(NEW_ID)).success,
    ).toBe(false);
    expect(
      draftsSubscribeServerFrameSchemaV11.safeParse(upsert(NEW_ID)).success,
    ).toBe(true);
    // Non-row frames are shared by both lines.
    expect(
      draftsSubscribeServerFrameSchemaV10.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });

  it("chat.subscribe 1.20's range frame rejects a commandcode row-context anchor; 1.21's takes it", () => {
    const rangeFrame = (rowContext: Record<string, unknown>) => ({
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
        events: [],
        rowContext,
        reachedStart: true,
        reachedEnd: true,
      },
    });
    // Positive control: the same frame with no anchor parses on both lines.
    expect(
      chatSubscribeV120.serverFrameSchema.safeParse(rangeFrame({})).success,
    ).toBe(true);
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(rangeFrame({})).success,
    ).toBe(true);
    const withAnchor = rangeFrame({ "row-1": { sessionAnchor: anchor } });
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(withAnchor).success,
    ).toBe(true);
    expect(
      chatSubscribeV120.serverFrameSchema.safeParse(withAnchor).success,
    ).toBe(false);
  });
});
