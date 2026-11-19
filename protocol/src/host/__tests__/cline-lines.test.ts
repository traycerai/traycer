import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  agentConfigureResponseSchema,
  agentConfigureResponseSchemaV72,
  agentGetProviderProfileRateLimitsResponseSchemaV8,
  agentGetProviderProfileRateLimitsResponseSchemaV9,
  agentListProviderProfilesResponseSchema,
  agentListProviderProfilesResponseSchemaV7,
} from "@traycer/protocol/host/agent/profiles";
import {
  configEnvLocalOverrideResponseSchema,
  configEnvLocalOverrideResponseSchemaV10,
  environmentLocalOverridesResponseSchema,
  environmentLocalOverridesResponseSchemaV10,
} from "@traycer/protocol/host/environment-schemas";
import {
  providersRefreshProfileStatusResponseSchema,
  providersRefreshProfileStatusResponseSchemaV40,
} from "@traycer/protocol/host/rate-limit/schemas";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV100,
  guiHarnessIdSchemaV90,
  listAgentsResponseSchema,
  listAgentsResponseSchemaV103,
} from "@traycer/protocol/host/agent/shared";
import {
  listGuiHarnessesResponseSchema,
  listGuiHarnessesResponseSchemaV101,
  listGuiHarnessesResponseSchemaV92,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  chatFallbackListTargetsResponseSchema,
  chatFallbackListTargetsResponseSchemaV20,
} from "@traycer/protocol/host/chat-fallback";
import {
  draftsListResponseSchema,
  draftsListResponseSchemaV20,
  draftsSubscribeServerFrameSchemaV11,
  draftsSubscribeServerFrameSchemaV12,
  draftsUpsertResponseSchema,
  draftsUpsertResponseSchemaV20,
} from "@traycer/protocol/host/drafts/schemas";
import {
  getChatRunSettingsBatchResponseSchemaV30,
  getChatRunSettingsBatchResponseSchemaV22,
  getChatRunSettingsResponseSchemaV50,
  getChatRunSettingsResponseSchemaV42,
} from "@traycer/protocol/host/epic/chat-records";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
  fallbackPolicySchemaV20,
  providersFallbackPolicyGetResponseSchema,
  providersFallbackPolicyGetResponseSchemaV21,
  providersFallbackPolicyPreviewTierGroupsResponseSchema,
  providersFallbackPolicyPreviewTierGroupsResponseSchemaV20,
} from "@traycer/protocol/host/fallback-policy";
import {
  providerCliStateSchema,
  providerIdSchema,
  providerIdSchemaV100,
  providersListResponseSchema,
  providersListResponseSchemaV1013,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersChangedServerFrameSchema,
  providersChangedServerFrameSchemaV11,
  providersChangedServerFrameSchemaV12,
} from "@traycer/protocol/host/providers-changed-stream";
import {
  sessionImportRunServerFrameSchemaPreCline,
  sessionImportRunV13,
  sessionImportRunV14,
} from "@traycer/protocol/host/session-import/run";
import {
  sessionImportScanServerFrameSchemaPreCline,
  sessionImportScanV13,
  sessionImportScanV14,
} from "@traycer/protocol/host/session-import/scan";
import {
  guiHarnessIdSchema as persistedGuiHarnessIdSchema,
  guiHarnessIdSchemaPreCline,
  guiHarnessIdSchemaPreCommandCode,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  chatSessionAnchorSchema,
  chatSessionAnchorSchemaPreCline,
} from "@traycer/protocol/persistence/epic/senders";
import {
  transcriptRowContextSchema,
  transcriptRowContextSchemaPreCline,
} from "@traycer/protocol/persistence/chat-transcript/row-context";
import { userMessageAnchorResolvedEventSchema } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  chatSubscribeV146,
  chatSubscribeV147,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { guiHarnessRowForLineTest } from "./__fixtures__/harness-row";

/**
 * The Cline harness (`cline`) joined the live id enums after the 1.5.1 cut.
 * Every released line that carries a harness or provider id in a host->client
 * payload froze at the twenty-two ids it shipped (pre-Cline) and a new head
 * opened. This file asserts the mechanism of each new head: what its downgrade
 * bridges keep, what they drop, what they refuse and with which message, and
 * that every frozen schema rejects `cline` while its live counterpart takes it.
 *
 * Cline is GUI-only here: `tuiHarnessIdSchema` is untouched. Session anchors
 * ride `chat.subscribe@1.47`, while `1.21`–`1.46` pin
 * `transcriptRowContextSchemaPreCline`.
 */
const NEW_ID = "cline";

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
  expect(result.error.message).not.toMatch(/\bcline\b/i);
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
    archived: null,
    profile: null,
    permissionMode: null,
    reach: null,
    hostConnectivity: { kind: "unknown" },
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

function providerChangedFrame(providerId: string) {
  return { kind: "changed", providerId, hasBinaryPayload: false };
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

describe("cline joins the live harness and provider enums", () => {
  it("the live enums carry cline", () => {
    expect(guiHarnessIdSchema.options).toContain(NEW_ID);
    expect(persistedGuiHarnessIdSchema.options).toContain(NEW_ID);
    expect(providerIdSchema.options).toContain(NEW_ID);
    expect(providerCliStateSchema.shape.providerId.options).toContain(NEW_ID);
  });

  it("the head is the pre-Command-Code set plus every id added since", () => {
    // The newest id's line test owns this snapshot, so the older per-id tests
    // do not each carry a live-set count that the next addition invalidates.
    expect(
      persistedGuiHarnessIdSchema.options.filter(
        (id) =>
          !(
            guiHarnessIdSchemaPreCommandCode.options as readonly string[]
          ).includes(id),
      ),
    ).toEqual(["commandcode", "cline"]);
  });

  it("the frozen harness and provider sets reject cline and still take released ids", () => {
    expect(guiHarnessIdSchema.safeParse(NEW_ID).success).toBe(true);
    for (const frozen of [
      guiHarnessIdSchemaV90,
      guiHarnessIdSchemaV100,
      guiHarnessIdSchemaPreCommandCode,
      guiHarnessIdSchemaPreCline,
    ]) {
      expect(frozen.safeParse(NEW_ID).success).toBe(false);
      expect(frozen.safeParse("claude").success).toBe(true);
    }
    expect(providerIdSchemaV100.safeParse(NEW_ID).success).toBe(false);
    expect(providerIdSchemaV100.safeParse("commandcode").success).toBe(true);
  });
});

describe("every Cline head is the registry's canonical line", () => {
  const UNARY_HEADS: readonly (readonly [keyof Registry, number])[] = [
    ["agent.gui.listHarnesses", 11],
    ["agent.list", 11],
    ["providers.list", 11],
    ["agent.listProviderProfiles", 8],
    ["agent.getProviderProfileRateLimits", 9],
    ["agent.configure", 8],
    ["providers.refreshProfileStatus", 5],
    ["epic.getChatRunSettings", 5],
    ["epic.getChatRunSettingsBatch", 3],
    ["chat.fallback.listTargets", 3],
    ["drafts.list", 3],
    ["drafts.upsert", 3],
    ["providers.fallbackPolicy.get", 3],
    ["providers.fallbackPolicy.set", 3],
    ["providers.fallbackPolicy.previewTierGroups", 3],
    ["providers.fallbackPolicy.reset", 3],
    ["providers.fallbackPolicy.restoreTierGroups", 3],
    ["environment.localOverrides", 2],
    ["config.env.localOverride.set", 2],
    ["config.env.localOverride.clear", 2],
  ];

  it.each(UNARY_HEADS)(
    "%s opens major %i with a downgrade path to every lower major",
    (method, head) => {
      const entry = hostRpcRegistry[method];
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

  it("stream heads open the new minors, with pre-Cline minors frozen", () => {
    expect(hostStreamRpcRegistry["providers.changed"][1].latestMinor).toBe(3);
    expect(hostStreamRpcRegistry["drafts.subscribe"][1].latestMinor).toBe(2);
    expect(hostStreamRpcRegistry["sessionImport.scan"][1].latestMinor).toBe(4);
    expect(
      hostStreamRpcRegistry["sessionImport.scan"][1].versions[3].contract,
    ).toBe(sessionImportScanV13);
    expect(
      hostStreamRpcRegistry["sessionImport.scan"][1].versions[4].contract,
    ).toBe(sessionImportScanV14);
    expect(hostStreamRpcRegistry["sessionImport.run"][1].latestMinor).toBe(4);
    expect(
      hostStreamRpcRegistry["sessionImport.run"][1].versions[3].contract,
    ).toBe(sessionImportRunV13);
    expect(
      hostStreamRpcRegistry["sessionImport.run"][1].versions[4].contract,
    ).toBe(sessionImportRunV14);
  });
});

describe("row-dropping catalog bridges (11 -> every lower major)", () => {
  it("agent.gui.listHarnesses drops only the cline row", () => {
    const response = listGuiHarnessesResponseSchema.parse({
      harnesses: [
        guiHarnessRowForLineTest("claude"),
        guiHarnessRowForLineTest(NEW_ID),
        guiHarnessRowForLineTest("commandcode"),
      ],
    });
    for (const target of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["agent.gui.listHarnesses"],
        11,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      const ids = result.value.harnesses.map((row) => row.id);
      expect(ids, `to ${String(target)}`).not.toContain(NEW_ID);
      expect(ids, `to ${String(target)}`).toContain("claude");
      if (target === 10) {
        expect(ids).toEqual(["claude", "commandcode"]);
        expect(
          listGuiHarnessesResponseSchemaV101.safeParse(result.value).success,
        ).toBe(true);
      }
    }
  });

  it("agent.list drops cline agents and keeps null-harness and representable agents", () => {
    const response = listAgentsResponseSchema.parse({
      caller: { agentId: "self", canSendMessages: true },
      scope: "all",
      agents: [
        agentRow("a-claude", "claude"),
        agentRow("a-cline", NEW_ID),
        agentRow("a-null", null),
      ],
    });
    for (const target of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["agent.list"],
        11,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.agents.map((agent) => agent.id),
        `to ${String(target)}`,
      ).toEqual(["a-claude", "a-null"]);
      if (target === 10) {
        expect(
          listAgentsResponseSchemaV103.safeParse(result.value).success,
        ).toBe(true);
      }
    }
  });

  it("providers.list drops cline provider rows and lands on 10.13 cleanly", () => {
    const response = providersListResponseSchema.parse({
      providers: [providerState("codex"), providerState(NEW_ID)],
      native: null,
    });
    for (const target of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        11,
        target,
        response,
      );
      expect(result.ok, `to ${String(target)}`).toBe(true);
      if (!result.ok) continue;
      expect(
        result.value.providers.map((row) => row.providerId),
        `to ${String(target)}`,
      ).toEqual(["codex"]);
      if (target === 10) {
        expect(
          providersListResponseSchemaV1013.safeParse(result.value).success,
        ).toBe(true);
      }
    }
  });
});

describe("row-dropping bridges that keep non-row fields (3 -> 2)", () => {
  it("drafts.list omits cline drafts and preserves tombstones, snapshotSeq, and scopeId", () => {
    const response = draftsListResponseSchema.parse({
      scopeId: "scp_1",
      drafts: [draftDocument("d-ok", "claude"), draftDocument("d-cl", NEW_ID)],
      tombstones: [{ draftId: "gone", revision: 4, storeSeq: 9 }],
      snapshotSeq: 12,
    });
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["drafts.list"],
      3,
      2,
      response,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drafts.map((draft) => draft.draftId)).toEqual(["d-ok"]);
    expect(result.value.tombstones).toEqual(response.tombstones);
    expect(result.value.snapshotSeq).toBe(12);
    expect(result.value.scopeId).toBe("scp_1");
    expect(draftsListResponseSchemaV20.safeParse(result.value).success).toBe(
      true,
    );
  });

  it("epic.getChatRunSettingsBatch omits cline entries and keeps representable/null entries", () => {
    const response = getChatRunSettingsBatchResponseSchemaV30.parse({
      entries: [
        { chatId: "c1", settings: chatRunSettings("claude") },
        { chatId: "c2", settings: chatRunSettings(NEW_ID) },
        { chatId: "c3", settings: null },
      ],
    });
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["epic.getChatRunSettingsBatch"],
      3,
      2,
      response,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.chatId)).toEqual([
      "c1",
      "c3",
    ]);
    expect(
      getChatRunSettingsBatchResponseSchemaV22.safeParse(result.value).success,
    ).toBe(true);
  });

  it("chat.fallback.listTargets drops cline model targets and refuses on cline failedTuple", () => {
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
    const response = chatFallbackListTargetsResponseSchema.parse({
      outcome: "listed",
      failedTuple: chatRunSettings("claude"),
      profileTargets: [],
      modelTargets: [
        row("keep", "claude", "claude"),
        row("drop", NEW_ID, NEW_ID),
        row("keep-null-target", NEW_ID, null),
      ],
      modelTargetsSkip: null,
    });
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["chat.fallback.listTargets"],
      3,
      2,
      response,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.modelTargets.map((entry) => entry.groupId)).toEqual(
      ["keep", "keep-null-target"],
    );
    expect(
      chatFallbackListTargetsResponseSchemaV20.safeParse(downgraded.value)
        .success,
    ).toBe(true);

    const refused = downgradeResponseAcrossMajors(
      hostRpcRegistry["chat.fallback.listTargets"],
      3,
      2,
      chatFallbackListTargetsResponseSchema.parse({
        ...response,
        failedTuple: chatRunSettings(NEW_ID),
      }),
    );
    expectRefused(
      refused,
      "Listing fallback targets for this chat requires a newer Traycer client.",
    );
  });

  it("environment.localOverrides and config.env.localOverride.{set,clear} 2 -> 1 drop cline env overrides and keep released rows", () => {
    const overrides = [
      {
        target: { kind: "variable" as const, key: "FOO" },
        os: "linux" as const,
        value: "1",
        setAt: 100,
      },
      {
        target: {
          kind: "env_override" as const,
          providerId: "commandcode" as const,
          key: "CC_TOKEN",
        },
        os: "linux" as const,
        value: "2",
        setAt: 101,
      },
      {
        target: {
          kind: "env_override" as const,
          providerId: NEW_ID as "cline",
          key: "CLINE_API_KEY",
        },
        os: "linux" as const,
        value: "3",
        setAt: 102,
      },
    ];

    const listDowngraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["environment.localOverrides"],
      2,
      1,
      environmentLocalOverridesResponseSchema.parse({ overrides }),
    );
    expect(listDowngraded.ok).toBe(true);
    if (!listDowngraded.ok) return;
    expect(listDowngraded.value.overrides.map((o) => o.target.key)).toEqual([
      "FOO",
      "CC_TOKEN",
    ]);
    expect(
      environmentLocalOverridesResponseSchemaV10.safeParse(listDowngraded.value)
        .success,
    ).toBe(true);

    for (const method of [
      "config.env.localOverride.set",
      "config.env.localOverride.clear",
    ] as const) {
      const savedDowngraded = downgradeResponseAcrossMajors(
        hostRpcRegistry[method],
        2,
        1,
        configEnvLocalOverrideResponseSchema.parse({
          outcome: "saved",
          overrides,
        }),
      );
      expect(savedDowngraded.ok).toBe(true);
      if (!savedDowngraded.ok || savedDowngraded.value.outcome !== "saved") {
        return;
      }
      expect(savedDowngraded.value.overrides.map((o) => o.target.key)).toEqual([
        "FOO",
        "CC_TOKEN",
      ]);
      expect(
        configEnvLocalOverrideResponseSchemaV10.safeParse(savedDowngraded.value)
          .success,
      ).toBe(true);

      const grantDowngraded = downgradeResponseAcrossMajors(
        hostRpcRegistry[method],
        2,
        1,
        configEnvLocalOverrideResponseSchema.parse({ outcome: "needs_grant" }),
      );
      expect(grantDowngraded).toEqual({
        ok: true,
        value: { outcome: "needs_grant" },
      });
    }
  });
});

describe("parse-or-refuse Cline bridges", () => {
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
      label: "agent.getProviderProfileRateLimits 9 -> 8",
      message:
        "Reading this provider's rate limits requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.getProviderProfileRateLimits"],
          9,
          8,
          agentGetProviderProfileRateLimitsResponseSchemaV9.parse({
            rateLimits: {
              provider: representable ? "commandcode" : NEW_ID,
              available: false,
              reason: "not_signed_in",
            },
            usageUpdatedAt: null,
          }),
        ),
    },
    {
      label: "providers.refreshProfileStatus 5 -> 4",
      message:
        "Refreshing this provider's profile status requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.refreshProfileStatus"],
          5,
          4,
          providersRefreshProfileStatusResponseSchema.parse({
            providerRateLimits: {
              provider: representable ? "commandcode" : NEW_ID,
              available: false,
              reason: "not_signed_in",
            },
          }),
        ),
    },
    {
      label: "agent.listProviderProfiles 8 -> 7",
      message:
        "Listing this provider's profiles requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.listProviderProfiles"],
          8,
          7,
          agentListProviderProfilesResponseSchema.parse({
            providerId: representable ? "codex" : NEW_ID,
            profiles: [],
          }),
        ),
    },
    {
      label: "agent.configure 8 -> 7",
      message:
        "Configuring an agent on this harness requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["agent.configure"],
          8,
          7,
          agentConfigureResponseSchema.parse({
            settings: {
              harnessId: representable ? "claude" : NEW_ID,
              model: "model-1",
              profileSelection: { kind: "ambient" },
              reasoningEffort: null,
              fastMode: false,
              serviceTier: null,
              permissionMode: "supervised",
              agentMode: "regular",
            },
            warnings: [],
          }),
        ),
    },
    {
      label: "epic.getChatRunSettings 5 -> 4",
      message:
        "Reading this chat's run settings requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["epic.getChatRunSettings"],
          5,
          4,
          getChatRunSettingsResponseSchemaV50.parse({
            settings: chatRunSettings(representable ? "claude" : NEW_ID),
          }),
        ),
    },
    {
      label: "drafts.upsert 3 -> 2",
      message: "This draft requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["drafts.upsert"],
          3,
          2,
          draftsUpsertResponseSchema.parse({
            draft: draftDocument("d1", representable ? "claude" : NEW_ID),
          }),
        ),
    },
    {
      label: "providers.fallbackPolicy.get 3 -> 2",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.get"],
          3,
          2,
          providersFallbackPolicyGetResponseSchema.parse({
            policy: policyWithCandidate(representable ? "claude" : NEW_ID),
            storedPolicyUnreadable: false,
            inFlightCount: 0,
            source: "own",
          }),
        ),
    },
    {
      label: "providers.fallbackPolicy.set 3 -> 2",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.set"],
          3,
          2,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.reset 3 -> 2",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.reset"],
          3,
          2,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.restoreTierGroups 3 -> 2",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.restoreTierGroups"],
          3,
          2,
          {
            policy: fallbackPolicySchema.parse(
              policyWithCandidate(representable ? "claude" : NEW_ID),
            ),
          },
        ),
    },
    {
      label: "providers.fallbackPolicy.previewTierGroups 3 -> 2",
      message: "This fallback policy requires a newer Traycer client.",
      run: (representable) =>
        downgradeResponseAcrossMajors(
          hostRpcRegistry["providers.fallbackPolicy.previewTierGroups"],
          3,
          2,
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
});

describe("released wire lines reject cline; their live counterparts accept it", () => {
  it("agent.gui.listHarnesses 9.2 and 10.1 reject cline; live 11.0 accepts it", () => {
    const response = {
      harnesses: [
        guiHarnessRowForLineTest("claude"),
        guiHarnessRowForLineTest(NEW_ID),
      ],
    };
    expect(listGuiHarnessesResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(listGuiHarnessesResponseSchemaV92.safeParse(response).success).toBe(
      false,
    );
    expect(listGuiHarnessesResponseSchemaV101.safeParse(response).success).toBe(
      false,
    );
  });

  it("pre-Cline frozen unary response schemas reject cline while live schemas accept it", () => {
    expect(
      agentListProviderProfilesResponseSchemaV7.safeParse({
        providerId: NEW_ID,
        profiles: [],
      }).success,
    ).toBe(false);
    expect(
      agentGetProviderProfileRateLimitsResponseSchemaV8.safeParse({
        rateLimits: {
          provider: NEW_ID,
          available: false,
          reason: "unsupported_provider",
        },
        usageUpdatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      providersRefreshProfileStatusResponseSchemaV40.safeParse({
        providerRateLimits: {
          provider: NEW_ID,
          available: false,
          reason: "unsupported_provider",
        },
      }).success,
    ).toBe(false);
    expect(
      environmentLocalOverridesResponseSchemaV10.safeParse({
        overrides: [
          {
            target: {
              kind: "env_override",
              providerId: NEW_ID,
              key: "CLINE_API_KEY",
            },
            os: "linux",
            value: "secret",
            setAt: 100,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      configEnvLocalOverrideResponseSchemaV10.safeParse({
        outcome: "saved",
        overrides: [
          {
            target: {
              kind: "env_override",
              providerId: NEW_ID,
              key: "CLINE_API_KEY",
            },
            os: "linux",
            value: "secret",
            setAt: 100,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentConfigureResponseSchemaV72.safeParse({
        settings: {
          harnessId: NEW_ID,
          model: "model-1",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          serviceTier: null,
          permissionMode: "supervised",
          agentMode: "regular",
        },
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      getChatRunSettingsResponseSchemaV42.safeParse({
        settings: chatRunSettings(NEW_ID),
      }).success,
    ).toBe(false);
    expect(
      draftsUpsertResponseSchemaV20.safeParse({
        draft: draftDocument("d1", NEW_ID),
      }).success,
    ).toBe(false);
    expect(
      providersFallbackPolicyGetResponseSchemaV21.safeParse({
        policy: policyWithCandidate(NEW_ID),
        storedPolicyUnreadable: false,
        inFlightCount: 0,
        source: "own",
      }).success,
    ).toBe(false);
    expect(
      fallbackPolicySchemaV20.safeParse(policyWithCandidate(NEW_ID)).success,
    ).toBe(false);
    expect(
      providersFallbackPolicyPreviewTierGroupsResponseSchemaV20.safeParse({
        candidates: [
          {
            groupId: "g1",
            candidateIndex: 0,
            harnessId: NEW_ID,
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
      }).success,
    ).toBe(false);
  });

  it("providers.changed 1.1 and 1.2 reject a cline frame; live 1.3 accepts it", () => {
    expect(
      providersChangedServerFrameSchema.safeParse(providerChangedFrame(NEW_ID))
        .success,
    ).toBe(true);
    expect(
      providersChangedServerFrameSchemaV11.safeParse(
        providerChangedFrame(NEW_ID),
      ).success,
    ).toBe(false);
    expect(
      providersChangedServerFrameSchemaV12.safeParse(
        providerChangedFrame(NEW_ID),
      ).success,
    ).toBe(false);
    expect(
      providersChangedServerFrameSchemaV12.safeParse(
        providerChangedFrame("commandcode"),
      ).success,
    ).toBe(true);
  });

  it("drafts.subscribe 1.1 rejects a cline upsert frame; 1.2 accepts it", () => {
    const upsert = (id: string) => ({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 3,
      draftId: "d1",
      revision: 1,
      draft: draftDocument("d1", id),
    });
    expect(
      draftsSubscribeServerFrameSchemaV11.safeParse(upsert("commandcode"))
        .success,
    ).toBe(true);
    expect(
      draftsSubscribeServerFrameSchemaV11.safeParse(upsert(NEW_ID)).success,
    ).toBe(false);
    expect(
      draftsSubscribeServerFrameSchemaV12.safeParse(upsert(NEW_ID)).success,
    ).toBe(true);
  });

  it("sessionImport.scan/run pre-Cline frames reject cline; 1.4 accepts it", () => {
    const started = (id: string) => ({
      kind: "started",
      providers: [id],
      hasBinaryPayload: false,
    });
    expect(
      sessionImportScanServerFrameSchemaPreCline.safeParse(
        started("commandcode"),
      ).success,
    ).toBe(true);
    expect(
      sessionImportScanServerFrameSchemaPreCline.safeParse(started(NEW_ID))
        .success,
    ).toBe(false);
    expect(
      sessionImportScanV14.serverFrameSchema.safeParse(started(NEW_ID)).success,
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
      sessionImportRunServerFrameSchemaPreCline.safeParse(
        progress("commandcode"),
      ).success,
    ).toBe(true);
    expect(
      sessionImportRunServerFrameSchemaPreCline.safeParse(progress(NEW_ID))
        .success,
    ).toBe(false);
    expect(
      sessionImportRunV14.serverFrameSchema.safeParse(progress(NEW_ID)).success,
    ).toBe(true);
  });

  it("session anchor and chat.subscribe@1.46 reject cline; 1.47 and live schemas accept it", () => {
    const clineAnchor = {
      harnessId: NEW_ID,
      hostId: "host-1",
      sessionId: "cline-session-1",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot" as const,
        primaryWorkspace: "/repo",
        secondaryWorkspaces: [],
      },
      createdAt: 100,
      coveredUntilMessageId: null,
    };

    expect(chatSessionAnchorSchemaPreCline.safeParse(clineAnchor).success).toBe(
      false,
    );
    expect(chatSessionAnchorSchema.safeParse(clineAnchor).success).toBe(true);
    expect(
      transcriptRowContextSchemaPreCline.safeParse({
        sessionAnchor: clineAnchor,
      }).success,
    ).toBe(false);
    expect(
      transcriptRowContextSchema.safeParse({
        sessionAnchor: clineAnchor,
      }).success,
    ).toBe(true);
    expect(
      userMessageAnchorResolvedEventSchema.safeParse({
        blockId: "blk-1",
        timestamp: 100,
        type: "user_message.anchor_resolved",
        messageId: "msg-1",
        anchor: {
          harnessId: NEW_ID,
          sessionId: "cline-session-1",
          clineSessionId: "cline-session-1",
        },
      }).success,
    ).toBe(true);

    const chatLine = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(chatLine.latestMinor).toBe(47);
    expect(chatLine.versions[46].contract).toBe(chatSubscribeV146);
    expect(chatLine.versions[47].contract).toBe(chatSubscribeV147);

    const rangeFrame = {
      kind: "range" as const,
      epicId: "epic-1",
      chatId: "chat-1",
      hasBinaryPayload: false,
      range: {
        requestId: "req-1",
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["row-1"],
        messages: [],
        events: [],
        rowContext: {
          "row-1": { sessionAnchor: clineAnchor },
        },
        reachedStart: true,
        reachedEnd: true,
      },
    };
    expect(
      chatSubscribeV146.serverFrameSchema.safeParse(rangeFrame).success,
    ).toBe(false);
    expect(
      chatSubscribeV147.serverFrameSchema.safeParse(rangeFrame).success,
    ).toBe(true);
  });
});
