import { describe, expect, it } from "vitest";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  judgeCauseShortLabel,
  judgeFaceDimmed,
  judgeFaceInert,
  judgePickerDisabled,
  judgeSeedSelection,
  judgeSelectionMarked,
  judgeTileOpensPicker,
  judgeTileState,
  judgeUnpickedSeed,
  lastJudgePick,
  shownJudgePick,
  type JudgeTileState,
} from "@/components/settings/panels/permissions/judge-tile-state";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";
import {
  harness,
  model,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";

const CLAUDE: AutoJudgeSelection = {
  harnessId: "claude",
  model: "sonnet",
  profileId: null,
  reasoningEffort: null,
};
const CODEX: AutoJudgeSelection = {
  harnessId: "codex",
  model: "gpt-mini",
  profileId: null,
  reasoningEffort: null,
};

const HARNESSES = [
  harness({ id: "claude", label: "Claude Code" }),
  harness({ id: "codex", label: "Codex" }),
];
const CLAUDE_MODELS = [model("claude", "sonnet", "Claude Sonnet", {})];

function state(
  record: AutoJudgeGetResponse | undefined,
  overrides: Partial<Parameters<typeof judgeTileState>[0]>,
): JudgeTileState {
  return judgeTileState({
    record,
    draft: null,
    canWrite: true,
    catalogsAnswered: true,
    harnesses: HARNESSES,
    providers: [],
    shownModels: CLAUDE_MODELS,
    ...overrides,
  });
}

describe("lastJudgePick", () => {
  it("reads lastSelection, with an absent key (a 1.1 host) and null both meaning none", () => {
    expect(lastJudgePick({ selection: null, lastSelection: CODEX }, null)).toBe(
      CODEX,
    );
    expect(lastJudgePick({ selection: null }, null)).toBeNull();
    expect(
      lastJudgePick({ selection: null, lastSelection: null }, null),
    ).toBeNull();
  });

  it("while the latest pick is a switch to Automatic, is the record's own selection", () => {
    expect(
      lastJudgePick(
        { selection: CLAUDE, lastSelection: CODEX },
        { id: 1, selection: null, clearing: CLAUDE },
      ),
    ).toBe(CLAUDE);
  });

  it("keeps lastSelection for a switch to Automatic when nothing was stored, and for a draft pick", () => {
    expect(
      lastJudgePick(
        { selection: null, lastSelection: CODEX },
        { id: 1, selection: null, clearing: null },
      ),
    ).toBe(CODEX);
    expect(
      lastJudgePick(
        { selection: CLAUDE, lastSelection: CODEX },
        { id: 1, selection: CODEX, clearing: null },
      ),
    ).toBe(CODEX);
  });
});

describe("lastJudgePick, for a switch to Automatic (R4)", () => {
  it("prefers the pick the draft clears over the record's own selection", () => {
    // The record still holds the selection from before a pick whose write has
    // not landed; the draft carries the pick that was on show.
    expect(
      lastJudgePick(
        { selection: CLAUDE, lastSelection: null },
        { id: 2, selection: null, clearing: CODEX },
      ),
    ).toBe(CODEX);
  });

  it("uses the cleared pick even when the record's selection is null", () => {
    expect(
      lastJudgePick(
        { selection: null, lastSelection: null },
        { id: 2, selection: null, clearing: CODEX },
      ),
    ).toBe(CODEX);
  });
});

describe("shownJudgePick", () => {
  it("is null before the record answers, the displayed pick when there is one, else the last", () => {
    expect(shownJudgePick(undefined, null)).toBeNull();
    expect(
      shownJudgePick({ selection: CLAUDE, lastSelection: CODEX }, null),
    ).toBe(CLAUDE);
    expect(
      shownJudgePick({ selection: null, lastSelection: CODEX }, null),
    ).toBe(CODEX);
    expect(shownJudgePick({ selection: null }, null)).toBeNull();
  });
});

describe("judgeTileState", () => {
  it("loading while the record has not answered", () => {
    expect(state(undefined, {})).toEqual({
      row: "loading",
      readOnly: false,
      shown: null,
      lastCause: null,
    });
  });

  it("picked, with the latest draft's selection winning over the stored one", () => {
    expect(state({ selection: CLAUDE }, {}).row).toBe("picked");
    expect(
      state(
        { selection: CLAUDE },
        { draft: { id: 1, selection: CODEX, clearing: null } },
      ).shown,
    ).toBe(CODEX);
    expect(
      state(
        { selection: null },
        { draft: { id: 1, selection: CODEX, clearing: null } },
      ).row,
    ).toBe("picked");
  });

  it("loading until the harness and providers lists have answered, whatever the record says", () => {
    expect(state({ selection: CLAUDE }, { catalogsAnswered: false })).toEqual({
      row: "loading",
      readOnly: false,
      shown: null,
      lastCause: null,
    });
    expect(
      state(
        { selection: null, lastSelection: CODEX },
        { catalogsAnswered: false },
      ).row,
    ).toBe("loading");
  });

  it("no-last with no last pick", () => {
    expect(state({ selection: null }, {}).row).toBe("no-last");
  });

  it("last-runs when the last pick's provider, model and account are all available", () => {
    const result = state({ selection: null, lastSelection: CLAUDE }, {});
    expect(result.row).toBe("last-runs");
    expect(result.shown).toBe(CLAUDE);
    expect(result.lastCause).toBeNull();
  });

  it("last-broken, with its cause, when the last pick's provider is signed out", () => {
    const result = state(
      { selection: null, lastSelection: CODEX },
      {
        harnesses: [
          harness({ id: "claude" }),
          harness({ id: "codex", authStatus: "unauthenticated" }),
        ],
        shownModels: [model("codex", "gpt-mini", "GPT Mini", {})],
      },
    );
    expect(result.row).toBe("last-broken");
    expect(result.lastCause).toEqual({
      kind: "provider",
      blocker: "Signed out",
    });
  });

  it("last-broken when the last model is no longer offered", () => {
    const result = state(
      { selection: null, lastSelection: CLAUDE },
      { shownModels: [model("claude", "opus", "Claude Opus", {})] },
    );
    expect(result.row).toBe("last-broken");
    expect(result.lastCause).toEqual({ kind: "model" });
  });

  it("carries readOnly from canWrite", () => {
    expect(state({ selection: null }, { canWrite: false }).readOnly).toBe(true);
  });
});

describe("what each row lets the face and picker do", () => {
  const rows = {
    loading: state(undefined, {}),
    picked: state({ selection: CLAUDE }, {}),
    lastRuns: state({ selection: null, lastSelection: CLAUDE }, {}),
    lastBroken: state(
      { selection: null, lastSelection: CLAUDE },
      { shownModels: [] },
    ),
    noLast: state({ selection: null }, {}),
    readOnly: state(
      { selection: null, lastSelection: CLAUDE },
      { canWrite: false },
    ),
  };

  it("disables the picker, and inerts the face, only while loading, read-only or last-runs", () => {
    expect(judgePickerDisabled(rows.loading)).toBe(true);
    expect(judgePickerDisabled(rows.lastRuns)).toBe(true);
    expect(judgePickerDisabled(rows.readOnly)).toBe(true);
    expect(judgePickerDisabled(rows.picked)).toBe(false);
    expect(judgePickerDisabled(rows.lastBroken)).toBe(false);
    expect(judgePickerDisabled(rows.noLast)).toBe(false);
    for (const row of Object.values(rows)) {
      expect(judgeFaceInert(row)).toBe(judgePickerDisabled(row));
    }
  });

  it("dims the face on the three Automatic rows, except read-only", () => {
    expect(judgeFaceDimmed(rows.lastRuns)).toBe(true);
    expect(judgeFaceDimmed(rows.lastBroken)).toBe(true);
    expect(judgeFaceDimmed(rows.noLast)).toBe(true);
    expect(judgeFaceDimmed(rows.picked)).toBe(false);
    expect(judgeFaceDimmed(rows.loading)).toBe(false);
    expect(judgeFaceDimmed(rows.readOnly)).toBe(false);
  });

  it("opens the picker on choosing the tile only in last-broken and no-last, and not read-only", () => {
    expect(judgeTileOpensPicker(rows.lastBroken)).toBe(true);
    expect(judgeTileOpensPicker(rows.noLast)).toBe(true);
    expect(judgeTileOpensPicker(rows.lastRuns)).toBe(false);
    expect(judgeTileOpensPicker(rows.picked)).toBe(false);
    expect(judgeTileOpensPicker(rows.loading)).toBe(false);
    expect(
      judgeTileOpensPicker(state({ selection: null }, { canWrite: false })),
    ).toBe(false);
  });
});

describe("judgeUnpickedSeed and judgeSeedSelection", () => {
  it("seeds Traycer on the model Automatic resolves to when the host names one", () => {
    expect(
      judgeUnpickedSeed(
        { source: "default", harnessId: "traycer", model: "fast" },
        HARNESSES,
      ),
    ).toEqual({ harnessId: "traycer", modelSlug: "fast", profileId: null });
  });

  it("otherwise seeds the first provider that can run, with an empty model, else Traycer", () => {
    expect(judgeUnpickedSeed(null, HARNESSES)).toEqual({
      harnessId: sortGuiHarnessesByProviderOrder(HARNESSES)[0].id,
      modelSlug: "",
      profileId: null,
    });
    expect(
      judgeUnpickedSeed(undefined, [
        harness({ id: "claude", enabled: false }),
        harness({ id: "codex" }),
      ]).harnessId,
    ).toBe("codex");
    expect(judgeUnpickedSeed(undefined, undefined).harnessId).toBe("traycer");
    expect(judgeUnpickedSeed({ source: "fallback" }, undefined).modelSlug).toBe(
      "",
    );
  });

  it("seeds from the shown pick when it names a known harness, else from the unpicked seed", () => {
    expect(
      judgeSeedSelection({
        state: state({ selection: CLAUDE }, {}),
        effective: undefined,
        harnesses: HARNESSES,
      }),
    ).toEqual({ harnessId: "claude", modelSlug: "sonnet", profileId: null });
    expect(
      judgeSeedSelection({
        state: state({ selection: null }, {}),
        effective: undefined,
        harnesses: HARNESSES,
      }).modelSlug,
    ).toBe("");
    expect(
      judgeSeedSelection({
        state: state(
          {
            selection: {
              harnessId: "mystery",
              model: "m",
              profileId: null,
              reasoningEffort: null,
            },
          },
          {},
        ),
        effective: undefined,
        harnesses: HARNESSES,
      }).modelSlug,
    ).toBe("");
  });
});

describe("judgeSelectionMarked", () => {
  it("is true for a picked row naming a known harness", () => {
    expect(judgeSelectionMarked(state({ selection: CLAUDE }, {}))).toBe(true);
  });

  it("is false for a picked row whose harness this build does not know", () => {
    expect(
      judgeSelectionMarked(
        state(
          {
            selection: {
              harnessId: "mystery",
              model: "m",
              profileId: null,
              reasoningEffort: null,
            },
          },
          {},
        ),
      ),
    ).toBe(false);
  });

  it("is false in last-runs and in no-last", () => {
    expect(
      judgeSelectionMarked(
        state({ selection: null, lastSelection: CLAUDE }, {}),
      ),
    ).toBe(false);
    expect(judgeSelectionMarked(state({ selection: null }, {}))).toBe(false);
  });
});

describe("judgeCauseShortLabel", () => {
  it("names each cause in a few words", () => {
    expect(
      judgeCauseShortLabel({ kind: "provider", blocker: "Signed out" }),
    ).toBe("Signed out");
    expect(judgeCauseShortLabel({ kind: "provider-disabled" })).toBe(
      "Turned off",
    );
    expect(judgeCauseShortLabel({ kind: "unsupported-harness" })).toBe(
      "Can't judge here",
    );
    expect(judgeCauseShortLabel({ kind: "unrecognized" })).toBe(
      "Unknown provider",
    );
    expect(judgeCauseShortLabel({ kind: "model" })).toBe("No longer offered");
    expect(judgeCauseShortLabel({ kind: "profile" })).toBe("Account removed");
  });
});
