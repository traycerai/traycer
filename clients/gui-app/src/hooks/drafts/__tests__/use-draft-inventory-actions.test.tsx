import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useDraftInventoryActions } from "@/hooks/drafts/use-draft-inventory-actions";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
  type InstallLandingDraftInput,
} from "@/stores/home/landing-draft-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const activateTabIntentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: activateTabIntentMock };
});

// This hook's own job is resolving a host CLIENT for the row's owner; that
// resolution is exercised directly against a fake host in
// `lib/drafts/__tests__/draft-inventory-actions.test.ts`. Here the boundary is
// mocked so these tests stay about what THIS file adds: the analytics call
// and the (surface, input) it threads through.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/host", () => ({ useHostBinding: () => null }));

const toastFn = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock("sonner", () => ({ toast: toastFn }));

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

type LandingRow = Extract<DraftInventoryRow, { readonly kind: "landing" }>;
type ChatRow = Extract<DraftInventoryRow, { readonly kind: "chat" }>;
type NewChatRow = Extract<DraftInventoryRow, { readonly kind: "new-chat" }>;

function landingRow(
  overrides: Partial<LandingRow> & { readonly id: string },
): LandingRow {
  return {
    kind: "landing",
    preview: "a landing draft",
    content: typed("a landing draft"),
    lastTouchedAt: Date.now() - 1_000,
    open: false,
    foreign: false,
    ownerHostId: null,
    ...overrides,
  };
}

function chatRow(
  overrides: Partial<ChatRow> & { readonly id: string },
): ChatRow {
  return {
    kind: "chat",
    preview: "a chat draft",
    content: typed("a chat draft"),
    lastTouchedAt: Date.now() - 1_000,
    open: false,
    foreign: false,
    chatId: "chat-1",
    epicId: "epic-1",
    ownerHostId: "host-a",
    chatTitle: "Sibling chat",
    epicTitle: "Payments",
    ...overrides,
  };
}

function newChatRow(
  overrides: Partial<NewChatRow> & { readonly id: string },
): NewChatRow {
  return {
    kind: "new-chat",
    preview: "a new agent draft",
    content: typed("a new agent draft"),
    lastTouchedAt: Date.now() - 1_000,
    open: false,
    foreign: false,
    epicId: "epic-2",
    ownerHostId: "host-a",
    epicTitle: "Billing",
    ...overrides,
  };
}

function installLandingDraft(
  id: string,
  overrides: Partial<InstallLandingDraftInput>,
): void {
  useLandingDraftStore.getState().installLandingDraft({
    id,
    content: typed("landing content"),
    selection: null,
    lastTouchedAt: Date.now() - 1_000,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    closed: false,
    ...overrides,
  });
}

const clipboardWriteText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  navigateMock.mockReset();
  activateTabIntentMock.mockReset();
  toastFn.mockClear();
  toastFn.success.mockClear();
  toastFn.error.mockClear();
  clipboardWriteText.mockReset();
  clipboardWriteText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
  useNewConversationModalOpenStore.setState({ request: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDraftInventoryActions", () => {
  it("openRow fires draft_opened for a landing row and reopens it", () => {
    installLandingDraft("d-landing", { closed: true });
    const row = landingRow({ id: "d-landing", open: true });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.openRow(row, "pointer");
    });

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftOpened, {
      surface: "start_page",
      draft_kind: "start_page",
      input: "pointer",
      already_open: true,
      draft_age: "under_1h",
    });
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === "d-landing")
        ?.closed,
    ).toBe(false);
  });

  it("openRow fires draft_opened for a chat row and activates its tab", () => {
    const row = chatRow({ id: "d-chat", open: true });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions("host-effective", "avatar_menu"),
    );

    act(() => {
      result.current.openRow(row, "keyboard");
    });

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftOpened, {
      surface: "avatar_menu",
      draft_kind: "chat",
      input: "keyboard",
      already_open: true,
      draft_age: "under_1h",
    });
    expect(activateTabIntentMock).toHaveBeenCalledTimes(1);
  });

  it("openRow fires draft_opened for a new-agent row and opens the new-conversation modal", () => {
    const row = newChatRow({ id: "d-new-chat", open: false, epicId: "epic-open-test" });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions("host-effective", "avatar_menu"),
    );

    act(() => {
      result.current.openRow(row, "pointer");
    });

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftOpened, {
      surface: "avatar_menu",
      draft_kind: "new_agent",
      input: "pointer",
      already_open: false,
      draft_age: "under_1h",
    });
    expect(useNewConversationModalOpenStore.getState().request?.epicId).toBe(
      "epic-open-test",
    );
  });

  it("copyRow fires draft_copied only after the clipboard write resolves", async () => {
    const row = landingRow({ id: "d-copy", content: typed("copy me") });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.copyRow(row, "pointer");
    });

    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.DraftCopied,
      expect.anything(),
    );

    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftCopied, {
        surface: "start_page",
        draft_kind: "start_page",
        input: "pointer",
      });
    });
    expect(clipboardWriteText).toHaveBeenCalledWith("copy me");
  });

  it("does not fire draft_copied when the clipboard write rejects", async () => {
    clipboardWriteText.mockImplementation(() => Promise.reject(new Error("denied")));
    const row = landingRow({ id: "d-copy-fail" });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.copyRow(row, "pointer");
    });

    await waitFor(() => {
      expect(toastFn.error).toHaveBeenCalled();
    });
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.DraftCopied,
      expect.anything(),
    );
  });

  // The bucket math is a private 7-line helper (`draftAge`), so its four
  // branches are proven here, at their exact lower boundary: `< N` means the
  // boundary value itself belongs to the NEXT bucket, not the current one.
  const FIXED_NOW = 1_700_000_000_000;

  describe("draft_age at its exact bucket boundaries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ["under_1h", FIXED_NOW - 59 * 60 * 1_000],
      ["1h_24h", FIXED_NOW - 3_600_000],
      ["1d_7d", FIXED_NOW - 24 * 3_600_000],
      ["over_7d", FIXED_NOW - 168 * 3_600_000],
    ] as const)("classifies draft_age as %s", (expected, lastTouchedAt) => {
      const row = landingRow({ id: `age-${expected}`, lastTouchedAt });
      const trackSpy = vi
        .spyOn(Analytics.getInstance(), "track")
        .mockImplementation(() => true);
      const { result } = renderHook(() =>
        useDraftInventoryActions(null, "start_page"),
      );

      act(() => {
        result.current.openRow(row, "pointer");
      });

      expect(trackSpy).toHaveBeenCalledWith(
        AnalyticsEvent.DraftOpened,
        expect.objectContaining({ draft_age: expected }),
      );
    });
  });

  it("deleteRow fires draft_deleted with undo_offered true for an own landing row", () => {
    installLandingDraft("d-delete", {});
    const row = landingRow({ id: "d-delete" });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.deleteRow(row, "pointer");
    });

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftDeleted, {
      surface: "start_page",
      draft_kind: "start_page",
      input: "pointer",
      undo_offered: true,
      draft_age: "under_1h",
    });
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === "d-delete"),
    ).toBeUndefined();
  });

  it("clicking Undo on the delete toast fires draft_delete_undone and restores the row", () => {
    installLandingDraft("d-undo", {});
    const row = landingRow({ id: "d-undo" });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.deleteRow(row, "pointer");
    });

    const lastToastCall = toastFn.mock.calls.at(-1) as
      | [string, { action?: { onClick?: () => void } }]
      | undefined;
    const onUndo = lastToastCall?.[1]?.action?.onClick;
    expect(onUndo).toBeDefined();

    trackSpy.mockClear();
    act(() => {
      onUndo?.();
    });

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftDeleteUndone, {
      surface: "start_page",
      draft_kind: "start_page",
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("shows a skip toast and fires no draft_delete_undone when Undo cannot apply", () => {
    useComposerDraftStore.getState().bindTarget("chat-undo-skip", "epic-undo-skip");
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-undo-skip", typed("original"), null);
    const draftId =
      useComposerDraftStore.getState().drafts["chat-undo-skip"]?.draftId;
    if (draftId === undefined || draftId === null) {
      throw new Error("expected a draft id");
    }
    const row = chatRow({
      id: draftId,
      chatId: "chat-undo-skip",
      epicId: "epic-undo-skip",
    });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "avatar_menu"),
    );

    act(() => {
      result.current.deleteRow(row, "pointer");
    });
    // The user reopens the chat and types before pressing Undo.
    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot("chat-undo-skip", typed("new work"), null);
    });

    const lastToastCall = toastFn.mock.calls.at(-1) as
      | [string, { action?: { onClick?: () => void } }]
      | undefined;
    const onUndo = lastToastCall?.[1]?.action?.onClick;
    expect(onUndo).toBeDefined();
    trackSpy.mockClear();

    act(() => {
      onUndo?.();
    });

    expect(toastFn).toHaveBeenCalledWith(
      "Undo skipped. You typed something new here.",
    );
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.DraftDeleteUndone,
      expect.anything(),
    );
    expect(
      useComposerDraftStore.getState().drafts["chat-undo-skip"]?.content,
    ).toEqual(typed("new work"));

    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
  });

  it("does not fire draft_deleted when the row no longer exists in the store", () => {
    const row = landingRow({ id: "already-gone" });
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const { result } = renderHook(() =>
      useDraftInventoryActions(null, "start_page"),
    );

    act(() => {
      result.current.deleteRow(row, "pointer");
    });

    expect(trackSpy).not.toHaveBeenCalled();
  });
});
