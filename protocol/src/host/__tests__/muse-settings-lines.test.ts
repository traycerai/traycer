import { describe, expect, it } from "vitest";
import {
  draftsListV20,
  draftsListV30,
  draftsListDowngradeV30ToV20,
  draftsUpsertV30,
  draftsUpsertDowngradeV30ToV20,
  draftsSubscribeV11,
  draftsSubscribeV12,
} from "../drafts/contracts";
import {
  epicGetChatRunSettingsV42,
  epicGetChatRunSettingsV50,
  epicGetChatRunSettingsDowngradeV50ToV42,
  epicGetChatRunSettingsBatchV30,
  epicGetChatRunSettingsBatchDowngradeV30ToV22,
} from "../epic/contracts";
import {
  chatFallbackListTargetsV20,
  chatFallbackListTargetsV30,
  chatFallbackListTargetsDowngradeV30ToV20,
} from "../chat-fallback";
import {
  providersFallbackPolicyPreviewTierGroupsV20,
  providersFallbackPolicyPreviewTierGroupsV30,
  providersFallbackPolicyPreviewTierGroupsDowngradeV30ToV20,
} from "../fallback-policy";

const settings = {
  harnessId: "muse",
  model: "model",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: "fast",
  agentMode: "regular",
  profileId: "profile",
  profileBinding: { kind: "source-unidentified" },
  ultracode: true,
};
const known = { ...settings, harnessId: "claude" };
const document = (
  id: string,
  runSettings: Omit<typeof settings, "profileBinding" | "ultracode">,
) => ({
  draftId: id,
  kind: "landing",
  target: { epicId: null, chatId: null, blockId: null },
  revision: 1,
  lastTouchedAt: 1,
  workspace: null,
  ownerHostId: "host",
  origin: "own",
  adoption: { state: "adopted", hostId: "host" },
  publication: {
    status: "unpublished",
    lastPublishedAt: null,
    publishedRevision: null,
    halted: null,
  },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    runSettings,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
});

describe("Muse settings lines", () => {
  it("preserves baseline draft settings and filters only unsupported documents", () => {
    const {
      profileBinding: _binding,
      ultracode: _ultracode,
      ...draftSettings
    } = settings;
    const muse = document("muse", draftSettings);
    const old = document("old", { ...draftSettings, harnessId: "claude" });
    const response = draftsListV30.responseSchema.parse({
      drafts: [muse, old],
      tombstones: [],
      snapshotSeq: 2,
    });
    expect(response.drafts[0]).toMatchObject({
      portable: { runSettings: draftSettings },
    });
    expect(
      draftsListV20.responseSchema.safeParse({ ...response, drafts: [muse] })
        .success,
    ).toBe(false);
    const downgrade = draftsListDowngradeV30ToV20.downgradeResponse(response);
    expect(
      downgrade.ok && downgrade.value.drafts.map((draft) => draft.draftId),
    ).toEqual(["old"]);
    const echo = draftsUpsertV30.responseSchema.parse({ draft: muse });
    expect(draftsUpsertDowngradeV30ToV20.downgradeResponse(echo).ok).toBe(
      false,
    );
    const frame = {
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 2,
      draftId: "muse",
      revision: 1,
      draft: muse,
    };
    expect(draftsSubscribeV12.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(draftsSubscribeV11.serverFrameSchema.safeParse(frame).success).toBe(
      false,
    );
  });

  it("refuses a Muse unary read but keeps representable batch siblings", () => {
    const single = epicGetChatRunSettingsV50.responseSchema.parse({ settings });
    expect(single.settings).toEqual(settings);
    expect(
      epicGetChatRunSettingsV42.responseSchema.safeParse(single).success,
    ).toBe(false);
    expect(
      epicGetChatRunSettingsDowngradeV50ToV42.downgradeResponse(single).ok,
    ).toBe(false);
    const batch = epicGetChatRunSettingsBatchV30.responseSchema.parse({
      entries: [
        { chatId: "muse", settings },
        { chatId: "old", settings: known },
      ],
    });
    const downgraded =
      epicGetChatRunSettingsBatchDowngradeV30ToV22.downgradeResponse(batch);
    expect(downgraded.ok && downgraded.value.entries).toEqual([
      { chatId: "old", settings: known },
    ]);
  });

  it("filters unsupported fallback offers but refuses an unsupported source tuple", () => {
    const row = (target: typeof settings) => ({
      groupId: "g",
      harnessId: target.harnessId,
      modelFamily: "model",
      model: "model",
      reasoningEffort: null,
      profileId: null,
      severity: "ok",
      usedPercent: null,
      target,
      warnings: [],
      selectable: true,
      skip: null,
    });
    const response = chatFallbackListTargetsV30.responseSchema.parse({
      outcome: "listed",
      failedTuple: known,
      profileTargets: [],
      modelTargets: [row(settings), row(known)],
      modelTargetsSkip: null,
    });
    expect(response.modelTargets[0]?.target).toEqual(settings);
    expect(
      chatFallbackListTargetsV20.responseSchema.safeParse(response).success,
    ).toBe(false);
    const downgraded =
      chatFallbackListTargetsDowngradeV30ToV20.downgradeResponse(response);
    expect(
      downgraded.ok &&
        downgraded.value.modelTargets.map((target) => target.harnessId),
    ).toEqual(["claude"]);
    expect(
      chatFallbackListTargetsDowngradeV30ToV20.downgradeResponse(
        chatFallbackListTargetsV30.responseSchema.parse({
          ...response,
          failedTuple: settings,
        }),
      ).ok,
    ).toBe(false);
  });

  it("pins the flat preview candidates on the previous line", () => {
    const candidate = {
      groupId: "g",
      candidateIndex: 0,
      harnessId: "muse",
      modelFamily: "model",
      reasoningEffort: null,
      resolvedModel: "model",
      profileId: null,
      skipReason: null,
      skipLabel: null,
      warnings: [],
      matches: [],
    };
    const response =
      providersFallbackPolicyPreviewTierGroupsV30.responseSchema.parse({
        candidates: [candidate],
      });
    expect(response.candidates).toEqual([candidate]);
    expect(
      providersFallbackPolicyPreviewTierGroupsV20.responseSchema.safeParse(
        response,
      ).success,
    ).toBe(false);
    expect(
      providersFallbackPolicyPreviewTierGroupsDowngradeV30ToV20.downgradeResponse(
        response,
      ).ok,
    ).toBe(false);
  });
});
