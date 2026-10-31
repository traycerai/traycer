import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { QuoteChatTarget } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import { AnchoredDraftPopover } from "@/components/comments/anchored-draft-popover";
import {
  BOARD_PATH,
  quotedSelection,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";
import {
  useAnchoredDraftStore,
  type AnchoredCommentDraft,
} from "@/stores/comments/anchored-draft-store";
import { readComposerDraftSnapshot } from "@/stores/composer/composer-draft-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  composerEditorAt,
  typeIntoEditor,
} from "./comment-submit-test-support";

// The popover and its Send to chat slot run for real. What is mocked lies
// outside them: the chat roster, revealing a chat, the host's copy of the
// source and the attach that finally writes the composer card.

vi.mock("@/components/canvas-artifact/use-artboard-edit", async () =>
  (
    await import("@/components/canvas-artifact/__tests__/canvas-edit-test-support")
  ).artboardEditModule(),
);
vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => null,
}));

interface AttachInput {
  readonly chatId: string;
  readonly record: CanvasAnnotationRecord;
  readonly crop: Uint8Array | null;
}
const outside = vi.hoisted(() => ({
  attach: vi.fn(),
  reveal: vi.fn(),
}));
const attach = outside.attach as Mock<
  (input: AttachInput) => Promise<CanvasAnnotationRecord>
>;
const reveal = outside.reveal as Mock<(chatId: string) => void>;

vi.mock("@/providers/use-open-epic-handle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/providers/use-open-epic-handle")
  >()),
  useOpenEpicHandle: () => ({ store: createStore(() => ({ chats: {} })) }),
}));
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => ["chat-1"],
}));
vi.mock("@/components/epic-canvas/renderers/use-reveal-chat-in-tab", () => ({
  useRevealChatInTab: () => outside.reveal,
}));
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/epics/canvas/store")>()),
  useOpenTileContentIds: () => new Set<string>(),
}));
vi.mock(
  "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets")
    >()),
    resolveQuoteChatTargets: (): QuoteChatTarget[] => [
      {
        chatId: "chat-1",
        title: "Chat one",
        isOpen: true,
        isLastFocused: true,
        isOnOtherHost: false,
      },
    ],
  }),
);
vi.mock(
  "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu",
  () => ({
    ChatTargetMenu: (props: {
      readonly trigger: ReactNode;
      readonly targets: readonly QuoteChatTarget[];
      readonly open: boolean;
      readonly onOpenChange: (open: boolean) => void;
      readonly onSelectChat: (chatId: string) => void;
    }) => (
      <div>
        <div
          role="presentation"
          onClick={() => props.onOpenChange(!props.open)}
          onKeyDown={() => undefined}
        >
          {props.trigger}
        </div>
        {props.open ? (
          <div role="menu">
            {props.targets.map((target) => (
              <button
                key={target.chatId}
                type="button"
                role="menuitem"
                onClick={() => props.onSelectChat(target.chatId)}
              >
                {target.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ),
  }),
);
vi.mock("@/hooks/files/use-artifact-object-text-query", () => ({
  useArtifactObjectTextQuery: () => ({
    data: { kind: "text", text: `<p data-tid="t">Hello big world</p>` },
  }),
}));
vi.mock(
  "@/components/canvas-artifact/canvas-annotation-attach",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/canvas-artifact/canvas-annotation-attach")
    >()),
    canvasWindowCaptureBridge: () => null,
    attachCanvasAnnotation: outside.attach,
  }),
);

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "canvas-1";
const TILE_ID = "tile-1";
const SCOPE = {
  epicId: EPIC_ID,
  artifactId: ARTIFACT_ID,
  artifactTitle: "Wiring",
  artifactType: "canvas" as const,
  hostId: "host-1",
  viewTabId: "tab-1",
};
const SURFACE = { scope: SCOPE, frameFor: () => null };
const onClosed = vi.fn<() => void>();

function storeDraft(overrides: Partial<AnchoredCommentDraft>): void {
  useAnchoredDraftStore.getState().setDraft(EPIC_ID, {
    draftId: "draft-1",
    tileId: TILE_ID,
    artifactId: ARTIFACT_ID,
    artifactType: "canvas",
    anchor: {
      kind: "element",
      artboard: BOARD_PATH,
      elementId: "t",
      label: "p",
    },
    quotedText: "",
    rect: { x: 10, y: 10, width: 100, height: 20 },
    selection: quotedSelection("Hello big world", 6, 9, {
      tid: "t",
      tagName: "p",
      marker: 0,
    }),
    retargeted: false,
    ...overrides,
  });
}

function renderPopover(sendToChat: typeof SURFACE | null): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AnchoredDraftPopover
        epicId={EPIC_ID}
        artifactId={ARTIFACT_ID}
        tileId={TILE_ID}
        hostClient={null}
        onCreated={() => undefined}
        onClosed={onClosed}
        sendToChat={sendToChat}
      />
    </QueryClientProvider>,
  );
}

function sendButton(): HTMLElement {
  return screen.getByRole("button", { name: "Send to chat" });
}

function chooseChatOne(): void {
  fireEvent.click(sendButton());
  fireEvent.click(screen.getByRole("menuitem", { name: "Chat one" }));
}

beforeEach(() => {
  attach
    .mockReset()
    .mockImplementation((input) => Promise.resolve(input.record));
  reveal.mockReset();
  onClosed.mockReset();
  useAnchoredDraftStore.setState({ byEpicId: {} });
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  useAnchoredDraftStore.setState({ byEpicId: {} });
  useComposerDraftStore.setState({ drafts: {} });
});

describe("the comment draft box's Send to chat", () => {
  it("is enabled with an empty box and sends just the element, closing the box", async () => {
    storeDraft({});
    renderPopover(SURFACE);
    expect(sendButton().hasAttribute("disabled")).toBe(false);

    chooseChatOne();

    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("chat-1");
    });
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0].record).toMatchObject({
      kind: "browser-annotation",
      source: {
        kind: "canvas",
        artifactId: ARTIFACT_ID,
        artifactTitle: "Wiring",
        boardPath: BOARD_PATH,
      },
    });
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeUndefined();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(readComposerDraftSnapshot("chat-1").content.content).toEqual([
      { type: "paragraph" },
    ]);
  });

  it("appends the typed text to the chosen chat's composer", async () => {
    storeDraft({});
    renderPopover(SURFACE);
    typeIntoEditor(composerEditorAt(0), "make this bolder");

    chooseChatOne();

    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("chat-1");
    });
    expect(readComposerDraftSnapshot("chat-1").content.content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "make this bolder" }],
      },
    ]);
  });

  it("keeps the draft and shows the failure when the attach fails", async () => {
    attach.mockRejectedValue(new Error("Composer unavailable"));
    storeDraft({});
    renderPopover(SURFACE);
    typeIntoEditor(composerEditorAt(0), "make this bolder");

    chooseChatOne();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Composer unavailable",
    );
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeDefined();
    expect(reveal).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
    expect(readComposerDraftSnapshot("chat-1").content.content).toEqual([
      { type: "paragraph" },
    ]);
  });

  it("is absent on a surface that cannot capture elements", () => {
    storeDraft({});
    renderPopover(null);
    expect(screen.queryByRole("button", { name: "Send to chat" })).toBeNull();
  });

  it("is absent on a draft pinned to a canvas point, which has no element", () => {
    storeDraft({
      selection: null,
      anchor: { kind: "canvas-point", page: "flow", x: 1, y: 2, label: "Pin" },
    });
    renderPopover(SURFACE);
    expect(screen.queryByRole("button", { name: "Send to chat" })).toBeNull();
  });
});
