import "../../../../../__tests__/test-browser-apis";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { NewConversationModalBody } from "../new-conversation-modal";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const testState = vi.hoisted(() => ({
  createChat: vi.fn(),
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  ingesting: false,
  attachmentPresence: null as ((hash: string) => boolean) | null,
  bodyAttachmentPresence: null as ((hash: string) => boolean) | null,
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyAttachmentPresence = props.hasPastedImageBytes;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      return React.createElement(
        "button",
        { type: "button", onClick: props.onSubmit },
        "Submit new conversation",
      );
    },
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  return { useComposerToolbarStore: () => toolbarStore };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () => null,
  latestCreatedConversationOwner: () => null,
}));

vi.mock("@/hooks/worktree/use-owner-workspace-inheritance-seed", () => ({
  useOwnerWorkspaceInheritanceSeed: () => ({ seed: null }),
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: () => ({
    chats: { byId: {}, allIds: [] },
    tuiAgents: { byId: {}, allIds: [] },
  }),
}));

vi.mock("@/hooks/composer/use-composer-paste", () => ({
  useComposerPaste: () => ({
    onPaste: vi.fn(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    attachImageFiles: vi.fn(),
    isDraggingFiles: false,
    isIngestingImages: testState.ingesting,
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => true,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChat: () => ({
    isPending: false,
    mutate: testState.createChat,
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  mentionRootsFromWorktreeIntent: () => [],
  useWorkspaceMentionRoots: () => [],
}));
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({ ActiveHostWorkspaceControls: () => null }),
);
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useEpicImageFetcher: () => vi.fn(),
  useEpicAttachmentBytesPresence: () => testState.attachmentPresence,
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => ({
      markChatTitlePending: vi.fn(),
      clearChatTitlePending: vi.fn(),
    }),
  },
}));
vi.mock("@/stores/epics/initial-chat-handoff-store", () => ({
  useInitialChatHandoffStore: {
    getState: () => ({
      register: vi.fn(),
      markInitialTurnStarted: vi.fn(),
      markFailed: vi.fn(),
    }),
  },
}));

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
});

afterEach(() => {
  cleanup();
  testState.createChat.mockClear();
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.ingesting = false;
  testState.attachmentPresence = null;
  testState.bodyAttachmentPresence = null;
  useNewConversationModalStore.getState().resetForTests();
});

describe("NewConversationModalBody direct submit gate", () => {
  it("passes no paste predicate before snapshot readiness and the predicate afterward", () => {
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );

    expect(testState.bodyAttachmentPresence).toBeNull();

    testState.attachmentPresence = (hash) => hash === "present-hash";
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );

    expect(testState.bodyAttachmentPresence?.("present-hash")).toBe(true);
    expect(testState.bodyAttachmentPresence?.("missing-hash")).toBe(false);
  });

  it("blocks the actual new-conversation submit path while image ingestion is pending", () => {
    testState.ingesting = true;
    const view = render(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).not.toHaveBeenCalled();

    testState.ingesting = false;
    view.rerender(
      <NewConversationModalBody
        epicId="epic-1"
        tabId="tab-1"
        placement={ACTIVE_TILE_PLACEMENT}
        parentId={null}
        dismissPickerRef={createRef<(() => boolean) | null>()}
        onSubmitted={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Submit new conversation" }),
    );
    expect(testState.createChat).toHaveBeenCalledTimes(1);
  });
});

function editorHandle(): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => DIRTY_CONTENT,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    insertImageAttachments: () => undefined,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}
