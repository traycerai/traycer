import { useRef, useState, type ReactNode, type RefObject } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { FileAttachmentUploadClient } from "@/lib/composer/file-attachment-upload";
import { putOnlyRequester } from "@/lib/composer/__tests__/file-attachment-fixtures";
import {
  attachedFileNames,
  fileTransfer,
  pdfFile,
  typedPathSpans,
} from "@/lib/composer/__tests__/file-drop-fixtures";
import { createAppQueryClient } from "@/lib/query-client";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  STAGED_NEW_TARGET,
  stagedExistingTarget,
} from "@/stores/composer/__tests__/staged-sandbox-fixtures";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { NewConversationModalBody } from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";

/**
 * What a file dropped into the in-Epic new-conversation modal becomes while a
 * sandbox is staged on it.
 *
 * A staged sandbox is where the staged send runs the draft, though the
 * modal's placement has not moved. The placement host is this machine here, so
 * a path typed into the draft would be one the placement can read and the
 * sandbox cannot: the dropped file travels as an attachment instead.
 *
 * Nothing between the drop and the document is stubbed: the modal's own
 * `useComposerHashPaste` drives the real `ComposerPromptEditor` (through the
 * real `ComposerBody`, minus its shell and toolbar), whose document is read
 * back off the editor. What is answered is the modal's placement, this
 * renderer's own host id, the file-drop host and the placement client, whose
 * `drafts.putBlob` is the put this file observes.
 */

const testState = vi.hoisted(() => ({
  /** The host the modal's placement resolves to. */
  placementHostId: "host-a",
  /** This renderer's own host id, which the placement host is compared with. */
  localHostId: null as string | null,
  /** The placement host's client; the file route uploads through it. */
  client: null as FileAttachmentUploadClient | null,
  /** The `drafts.putBlob` request the placement client received. */
  putBlob: vi.fn<FileAttachmentUploadClient["requestWithOptions"]>(),
  /** What the renderer's file drop host resolves a dropped file to. */
  resolveDroppedFilePaths:
    vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>(),
  /** The editor the modal's body was given to mount. */
  editorRef: null as RefObject<ComposerPromptEditorHandle | null> | null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({ hosts: [] });
  return { useHostOptions: () => options };
});
// The picker stages nothing of its own here and the send is never intercepted:
// the stage is put straight into the store, where the modal reads it.
vi.mock(
  "@/components/composer/use-sandbox-staging",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/composer/use-sandbox-staging")
    >()),
    useSandboxStagingTask: () => ({
      hosts: null,
      groups: [],
      collaborators: null,
    }),
    useSandboxStaging: () => null,
  }),
);
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxSend: () => ({ intercept: () => false, line: null }),
  useStagedSandboxHandoff: () => undefined,
}));

// The real body, so the real editor is mounted with the modal's own paste
// handlers; the shell's frame and the toolbar are not what this file is about.
vi.mock("@/components/home/composer/composer-body", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<
      typeof import("@/components/home/composer/composer-body")
    >();
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.editorRef = props.editorRef;
      return React.createElement(actual.ComposerBody, props);
    },
  };
});
vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: (props: { readonly editor: ReactNode }) => props.editor,
}));
vi.mock("@/components/home/composer/terminal-launch-panel", () => ({
  TerminalLaunchPanel: () => null,
}));

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => {
    const target = {
      resolvedHostId: testState.placementHostId,
      client: testState.client,
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    return {
      pin: {
        selection: null,
        honoredSelection: null,
        setSelection: () => undefined,
        resolvedHostId: testState.placementHostId,
        isPinned: false,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => target.hostLabel,
      followsEffective: true,
    };
  },
}));
const NO_MIRROR_LINE = vi.hoisted(() =>
  Object.freeze({ notice: null, markSeen: (): void => undefined }),
);
vi.mock("@/hooks/composer/use-composer-mirror-line", () => ({
  useComposerMirrorLine: () => NO_MIRROR_LINE,
}));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-session",
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: () => ({
    isPending: false,
    mutateAsync: () => Promise.resolve({ initialTurnStarted: false }),
  }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    isPending: false,
    create: () => Promise.resolve(null),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => null,
    beforeSend: () => Promise.resolve(null),
  }),
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore(() => ({
    ultracode: false,
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    values: {
      selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    },
    selectedModel: null,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
    catalog: { harnesses: [] },
  }));
  return { useComposerToolbarStore: () => store };
});
vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicTitle: () => "Epic",
}));
const stubHostClient = {
  getActiveHostId: () => "host-a",
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
};
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => stubHostClient,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => stubHostClient,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
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
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: (files: ReadonlyArray<File>) =>
        testState.resolveDroppedFilePaths(files),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => testState.localHostId,
}));
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
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
  useEpicAttachmentBytesPresence: () => null,
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
      markFailedByAction: vi.fn(),
    }),
  },
}));

function Harness() {
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  const [queryClient] = useState(() => createAppQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SurfacePresentationBoundary visible focused>
        <Dialog open>
          <DialogContent>
            <NewConversationTransientContext.Provider value={transient}>
              <NewConversationModalBody
                epicId="epic-1"
                tabId="tab-1"
                placement={null}
                parentId={null}
                hostId={null}
                dismissPickerRef={dismissPickerRef}
                onSubmitted={() => undefined}
              />
            </NewConversationTransientContext.Provider>
          </DialogContent>
        </Dialog>
      </SurfacePresentationBoundary>
    </QueryClientProvider>
  );
}

const REPORT_PATH = "/Users/me/report.pdf";

function editorDocument(): JsonContent {
  const handle = testState.editorRef?.current ?? null;
  if (handle === null) throw new Error("the modal's editor is not mounted");
  return handle.getJSON();
}

async function mountModal(): Promise<void> {
  render(<Harness />);
  await waitFor(() => {
    expect(screen.getByTestId("composer-editor")).toBeTruthy();
    expect(testState.editorRef?.current?.isReady()).toBe(true);
  });
}

/** Stages `target` on the modal's own surface, as its host picker does. */
function stageOnModalSurface(target: StagedSandboxTarget): void {
  act(() => {
    useStagedSandboxStore
      .getState()
      .stage(newConversationSurfaceKey("epic-1"), target);
  });
}

function dropReport(): void {
  fireEvent.drop(screen.getByTestId("composer-editor"), {
    dataTransfer: fileTransfer([pdfFile("report.pdf")]),
  });
}

/** Resolves once the dropped file is in the draft, as a typed path or as an attachment. */
async function waitForDropToLand(): Promise<void> {
  await waitFor(() => {
    const draft = editorDocument();
    expect(
      typedPathSpans(draft).length + attachedFileNames(draft).length,
    ).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
  testState.placementHostId = "host-a";
  testState.localHostId = "host-a";
  testState.client = putOnlyRequester(testState.putBlob);
  testState.putBlob.mockReset();
  testState.putBlob.mockResolvedValue({ ok: true });
  testState.resolveDroppedFilePaths.mockReset();
  testState.resolveDroppedFilePaths.mockResolvedValue([REPORT_PATH]);
  testState.editorRef = null;
});

afterEach(() => {
  cleanup();
  useStagedSandboxStore.setState({ bySurface: {} });
  useNewConversationModalStore.getState().resetForTests();
});

describe("new-conversation modal: a file dropped while a sandbox is staged", () => {
  it("is typed as a path, and not uploaded, when nothing is staged", async () => {
    await mountModal();

    dropReport();
    await waitForDropToLand();

    expect(typedPathSpans(editorDocument())).toEqual([REPORT_PATH]);
    expect(attachedFileNames(editorDocument())).toEqual([]);
    expect(testState.putBlob).not.toHaveBeenCalled();
  });

  it.each([
    { staged: "a new sandbox", target: STAGED_NEW_TARGET },
    {
      staged: "a resting sandbox on another computer",
      target: stagedExistingTarget("sandbox-host"),
    },
  ])(
    "is uploaded as an attachment, with no path typed, when $staged is staged",
    async ({ target }) => {
      await mountModal();
      stageOnModalSurface(target);

      dropReport();
      await waitForDropToLand();

      expect(typedPathSpans(editorDocument())).toEqual([]);
      expect(attachedFileNames(editorDocument())).toEqual(["report.pdf"]);
      await waitFor(() => expect(testState.putBlob).toHaveBeenCalledTimes(1));
      expect(testState.putBlob.mock.calls[0][1]).toMatchObject({
        kind: "file",
        fileName: "report.pdf",
        mediaType: "application/pdf",
      });
    },
  );
});
