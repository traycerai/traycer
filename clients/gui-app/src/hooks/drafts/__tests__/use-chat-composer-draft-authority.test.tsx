import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useChatComposerDraftAuthority } from "@/hooks/drafts/use-chat-composer-draft-authority";

const DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function seedComposerDraft(
  chatId: string,
  overrides: {
    readonly draftId: string;
    readonly origin: "own" | "replica" | null;
    readonly ownerHostId: string | null;
  },
): void {
  useComposerDraftStore.getState().setSnapshot(chatId, DOC, null);
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[chatId];
    if (current === undefined) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          draftId: overrides.draftId,
          origin: overrides.origin,
          ownerHostId: overrides.ownerHostId,
        },
      },
    };
  });
}

afterEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
});

describe("useChatComposerDraftAuthority: chat fork", () => {
  it("never forks an own row on its own host", () => {
    const chatId = "chat-own";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "own",
      ownerHostId: "host-a",
    });

    const view = renderHook(() =>
      useChatComposerDraftAuthority({ chatId, tabHostId: "host-a" }),
    );

    act(() => {
      view.result.current.noteEdit();
    });

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe("d1");
    expect(after?.origin).toBe("own");
  });

  it("forks a replica row once: fresh id, same content, supersedes the old id, generation bumped, origin/ownerHostId cleared", () => {
    const chatId = "chat-replica";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "replica",
      ownerHostId: "host-b",
    });
    const before = useComposerDraftStore.getState().drafts[chatId];
    const generationBefore = before?.generation ?? 0;

    const view = renderHook(() =>
      useChatComposerDraftAuthority({ chatId, tabHostId: "host-a" }),
    );

    act(() => {
      view.result.current.noteEdit();
    });

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).not.toBe("d1");
    expect(after?.draftId).not.toBeNull();
    expect(after?.content).toEqual(DOC);
    expect(after?.supersedes).toBe("d1");
    expect(after?.generation).toBe(generationBefore + 1);
    expect(after?.origin).toBeNull();
    expect(after?.ownerHostId).toBeNull();
  });

  it("does not fork again on a second noteEdit after the fork", () => {
    const chatId = "chat-replica-twice";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "replica",
      ownerHostId: "host-b",
    });

    const view = renderHook(() =>
      useChatComposerDraftAuthority({ chatId, tabHostId: "host-a" }),
    );

    act(() => {
      view.result.current.noteEdit();
    });
    const afterFork = useComposerDraftStore.getState().drafts[chatId];
    const forkedId = afterFork?.draftId ?? null;
    expect(forkedId).not.toBeNull();

    act(() => {
      view.result.current.noteEdit();
    });
    const afterSecondEdit = useComposerDraftStore.getState().drafts[chatId];
    expect(afterSecondEdit?.draftId).toBe(forkedId);
    expect(afterSecondEdit?.generation).toBe(afterFork?.generation);
  });

  it("forks a row this tab's host does not own, even though the row itself reads own", () => {
    const chatId = "chat-owned-elsewhere";
    seedComposerDraft(chatId, {
      draftId: "d1",
      origin: "own",
      ownerHostId: "host-b",
    });

    const view = renderHook(() =>
      useChatComposerDraftAuthority({ chatId, tabHostId: "host-a" }),
    );

    act(() => {
      view.result.current.noteEdit();
    });

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).not.toBe("d1");
    expect(after?.supersedes).toBe("d1");
    expect(after?.origin).toBeNull();
    expect(after?.ownerHostId).toBeNull();
  });
});
