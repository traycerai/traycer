import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  landingDraftRememberSynced,
  useLandingDraftStore,
  UNADOPTED_LANDING_DRAFT,
} from "@/stores/home/landing-draft-store";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";

describe("landing draft store: forkDraft", () => {
  beforeEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  afterEach(() => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetLandingDraftRetirementsForTests();
  });

  it("copies content/selection/settings/composerMode/workspace into a fresh unadopted row and moves activeDraftId when the source was active", () => {
    const sourceId = useLandingDraftStore.getState().createDraft(null);
    const content = {
      type: "doc" as const,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      ],
    };
    const selection = { from: 1, to: 6 };
    const settings: ChatRunSettings = {
      harnessId: "claude",
      model: "sonnet",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };
    useLandingDraftStore
      .getState()
      .setDraftContent(sourceId, content, selection);
    useLandingDraftStore.getState().setDraftSettings(sourceId, settings);
    useLandingDraftStore.getState().setDraftComposerMode(sourceId, "terminal");
    useLandingDraftStore.getState().setActiveDraft(sourceId);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(sourceId);

    const source = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === sourceId);
    expect(source).toBeDefined();

    const nextId = "forked-draft";
    const ok = useLandingDraftStore.getState().forkDraft(sourceId, nextId);
    expect(ok).toBe(true);

    const next = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === nextId);
    expect(next).toBeDefined();
    if (next === undefined) return;

    expect(next.content).toEqual(content);
    expect(next.selection).toEqual(selection);
    expect(next.settings).toEqual(settings);
    expect(next.composerMode).toBe("terminal");
    expect(next.workspace).toEqual(source?.workspace);

    expect(next.origin).toBeNull();
    expect(next.ownerHostId).toBeNull();
    expect(next.adoption).toEqual(UNADOPTED_LANDING_DRAFT);
    expect(next.hostRevision).toBe(0);
    expect(next.generation).toBe(1);
    expect(next.syncedGeneration).toBe(0);
    expect(next.closed).toBe(false);
    expect(next.supersedes).toBe(sourceId);

    expect(useLandingDraftStore.getState().activeDraftId).toBe(nextId);
  });

  it("clears supersedes once the fork's first host write acks (hostRevision > 0), but keeps it while unsynced", () => {
    const sourceId = useLandingDraftStore.getState().createDraft(null);
    const nextId = "forked-draft-supersedes-clear";
    const ok = useLandingDraftStore.getState().forkDraft(sourceId, nextId);
    expect(ok).toBe(true);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === nextId)?.supersedes,
    ).toBe(sourceId);

    // hostRevision 0 (still unacknowledged): the pointer must ride along.
    landingDraftRememberSynced(nextId, 0, 1);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === nextId)?.supersedes,
    ).toBe(sourceId);

    // The fork's first write ACKs with a real host revision: the host now
    // holds the row (and the retraction debt), so the one-shot pointer is
    // cleared and must not ride a later write.
    landingDraftRememberSynced(nextId, 1, 1);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === nextId)?.supersedes,
    ).toBeNull();
  });

  it("does not move activeDraftId when the source was not the active draft", () => {
    const sourceId = useLandingDraftStore.getState().createDraft(null);
    const otherActiveId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setActiveDraft(otherActiveId);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(otherActiveId);

    const nextId = "forked-draft-inactive-source";
    const ok = useLandingDraftStore.getState().forkDraft(sourceId, nextId);
    expect(ok).toBe(true);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(otherActiveId);
  });

  it("returns false when nextId already exists", () => {
    const sourceId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.setState((state) => ({
      drafts: [
        ...state.drafts,
        {
          id: "already-exists",
          content: { type: "doc", content: [] },
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
        },
      ],
    }));

    const ok = useLandingDraftStore
      .getState()
      .forkDraft(sourceId, "already-exists");
    expect(ok).toBe(false);
  });

  it("returns false when the source draft is missing", () => {
    const ok = useLandingDraftStore
      .getState()
      .forkDraft("does-not-exist", "fresh-target");
    expect(ok).toBe(false);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.some((d) => d.id === "fresh-target"),
    ).toBe(false);
  });
});
