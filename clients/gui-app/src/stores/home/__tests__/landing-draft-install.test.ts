import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyLandingDraftWorkspaceSnapshot,
  UNADOPTED_LANDING_DRAFT,
  useLandingDraftStore,
  type InstallLandingDraftInput,
} from "@/stores/home/landing-draft-store";
import {
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function snapshot(
  id: string,
  overrides: Partial<InstallLandingDraftInput>,
): InstallLandingDraftInput {
  return {
    id,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "migrated" }] },
      ],
    },
    selection: { from: 1, to: 9 },
    lastTouchedAt: 1_700_000_000_000,
    settings: SETTINGS,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    closed: true,
    ...overrides,
  };
}

function readDraft(id: string) {
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((entry) => entry.id === id);
  if (draft === undefined) throw new Error(`no draft ${id}`);
  return draft;
}

describe("landing draft store: installLandingDraft", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("inserts the snapshot verbatim as a closed, dirty, unadopted row", () => {
    const input = snapshot("installed-1", {});

    expect(useLandingDraftStore.getState().installLandingDraft(input)).toBe(
      true,
    );

    const draft = readDraft("installed-1");
    expect(draft.content).toEqual(input.content);
    expect(draft.selection).toEqual({ from: 1, to: 9 });
    // The caller's timestamp survives - the stash migration ranks rows by it
    // and must not be re-stamped with `Date.now()`.
    expect(draft.lastTouchedAt).toBe(1_700_000_000_000);
    expect(draft.settings).toEqual(SETTINGS);
    expect(draft.composerMode).toBe("chat");
    expect(draft.closed).toBe(true);
    // Dirty and unadopted: the mirror adopts and publishes it on the next
    // sweep, exactly as a fork does.
    expect(draft.generation).toBe(1);
    expect(draft.syncedGeneration).toBe(0);
    expect(draft.adoption).toEqual(UNADOPTED_LANDING_DRAFT);
    expect(draft.hostRevision).toBe(0);
    expect(draft.supersedes).toBeNull();
  });

  it("installs an OPEN row when asked, without making it active", () => {
    useLandingDraftStore
      .getState()
      .installLandingDraft(snapshot("installed-open", { closed: false }));

    expect(readDraft("installed-open").closed).toBe(false);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("leaves activeDraftId alone - the composer the user is typing in is not hijacked", () => {
    const activeId = useLandingDraftStore.getState().createDraft(null);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(activeId);

    useLandingDraftStore
      .getState()
      .installLandingDraft(snapshot("installed-2", {}));

    expect(useLandingDraftStore.getState().activeDraftId).toBe(activeId);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      activeId,
      "installed-2",
    ]);
  });

  it("refuses a retired id and an id already in the store", () => {
    retireLandingDraft("retired-id", null);
    expect(
      useLandingDraftStore
        .getState()
        .installLandingDraft(snapshot("retired-id", {})),
    ).toBe(false);
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === "retired-id"),
    ).toBe(false);

    expect(
      useLandingDraftStore
        .getState()
        .installLandingDraft(snapshot("installed-3", {})),
    ).toBe(true);
    // A second install for the same id must not overwrite the live row.
    expect(
      useLandingDraftStore.getState().installLandingDraft(
        snapshot("installed-3", {
          content: { type: "doc", content: [{ type: "paragraph" }] },
        }),
      ),
    ).toBe(false);
    expect(readDraft("installed-3").content).toEqual(
      snapshot("installed-3", {}).content,
    );
  });
});
