import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { openLandingDraftFromHistory } from "@/lib/commands/actions/open-landing-draft-from-history";
import { draftTabIntent } from "@/lib/tab-navigation/intents";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabSourceRefs } from "@/stores/tabs/source-refs";

const activateTabIntent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return {
    ...actual,
    activateTabIntent,
  };
});

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("openLandingDraftFromHistory", () => {
  beforeEach(() => {
    activateTabIntent.mockReset();
    window.localStorage.clear();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("reopens the retained draft then activates the draft tab intent", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore
      .getState()
      .setDraftContent(id, textContent("keep"), null);
    useLandingDraftStore.getState().closeDraft(id);
    expect(useLandingDraftStore.getState().drafts[0]?.closed).toBe(true);
    expect(tabSourceRefs().some((ref) => ref.id === id)).toBe(false);

    const navigate = vi.fn() as UseNavigateResult<string>;
    openLandingDraftFromHistory(navigate, id);

    expect(useLandingDraftStore.getState().drafts[0]?.closed).toBe(false);
    expect(useLandingDraftStore.getState().drafts[0]?.id).toBe(id);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(id);
    expect(tabSourceRefs().some((ref) => ref.id === id)).toBe(true);
    expect(activateTabIntent).toHaveBeenCalledWith(
      navigate,
      draftTabIntent(id),
      undefined,
    );
  });
});
