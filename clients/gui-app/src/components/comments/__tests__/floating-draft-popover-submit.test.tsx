import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CreateCommentThreadRequest,
  CreateCommentThreadResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { FloatingDraftPopover } from "@/components/comments/floating-draft-popover";
import { ThreadAnchor } from "@/editor-core/extensions/thread-anchor";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  composerEditorAt,
  createDeferred,
  settle,
  typeIntoEditor,
  type Deferred,
} from "./comment-submit-test-support";

/**
 * Two submissions made while the first create is still in flight produced two
 * durable threads, and only the LAST call's per-call `onSuccess` ran - so the
 * first thread was never painted onto the document. These tests run the real
 * popover, the real Query mutation observer and a real host client whose
 * `epic.createCommentThread` answers only when the test says so.
 */

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "spec-1";
const TILE_ID = "tile-1";
const DOCUMENT_TEXT = "Hello commentable world";
// Paragraph content starts at position 1, so "commentable" spans 7..18.
const DRAFT_FROM = 7;
const DRAFT_TO = 18;

interface RecordedCreate {
  readonly request: CreateCommentThreadRequest;
  readonly answer: Deferred<CreateCommentThreadResponse>;
}

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let queryClient: QueryClient;
let epicHandle: OpenEpicStoreHandle;
let hostClient: HostClient<HostRpcRegistry>;
let artifactEditor: Editor;
let artifactElement: HTMLElement;
let creates: RecordedCreate[];
const onCreated = vi.fn<(threadId: string) => void>();

beforeEach(() => {
  creates = [];
  onCreated.mockReset();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
      [],
    );
  queryClient = createAppQueryClient();
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String((requestCount += 1))}`,
      handlers: {
        "epic.createCommentThread": (request) => {
          const answer = createDeferred<CreateCommentThreadResponse>();
          creates.push({ request, answer });
          return answer.promise;
        },
        "epic.listCommentThreads": () => ({ threads: [] }),
        "epic.listCollaborators": () => ({
          collaborators: [],
          collaboratorsAvailable: true,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClient = spine.createRequester(mockLocalHostEntry);
  epicHandle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-1",
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  epicHandle.store.setState({ durabilityStatus: null });

  artifactElement = document.createElement("div");
  document.body.appendChild(artifactElement);
  artifactEditor = new Editor({
    element: artifactElement,
    extensions: [StarterKit, ThreadAnchor],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: DOCUMENT_TEXT }] },
      ],
    },
  });
  useCommentThreadsStore.getState().setDraft(EPIC_ID, {
    draftId: "draft-1",
    tileId: TILE_ID,
    artifactId: ARTIFACT_ID,
    from: DRAFT_FROM,
    to: DRAFT_TO,
    quotedText: "commentable",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  if (!artifactEditor.isDestroyed) artifactEditor.destroy();
  artifactElement.remove();
  epicHandle.dispose();
  queryClient.clear();
  useAuthStore.getState().setSignedOut();
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
});

async function renderPopover(): Promise<void> {
  render(
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        <FloatingDraftPopover
          epicId={EPIC_ID}
          hostClient={hostClient}
          artifactType="spec"
          artifactId={ARTIFACT_ID}
          tileId={TILE_ID}
          editor={artifactEditor}
          onCreated={onCreated}
        />
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: /^Comment/ });
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Comment/ });
}

function pressCtrlEnter(): void {
  fireEvent.keyDown(composerEditorAt(0).view.dom, {
    key: "Enter",
    ctrlKey: true,
  });
}

/** Every `threadAnchor` mark in the artifact document, with the text it covers. */
function paintedAnchors(): ReadonlyArray<{
  readonly threadId: string;
  readonly text: string;
}> {
  const anchors: Array<{ threadId: string; text: string }> = [];
  artifactEditor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "threadAnchor") continue;
      const threadId: unknown = mark.attrs.threadId;
      if (typeof threadId === "string") {
        anchors.push({ threadId, text: node.text ?? "" });
      }
    }
  });
  return anchors;
}

function createAt(index: number): RecordedCreate {
  const recorded = creates.at(index);
  if (recorded === undefined) {
    throw new Error(`no createCommentThread request at index ${String(index)}`);
  }
  return recorded;
}

describe("<FloatingDraftPopover /> duplicate submit", () => {
  it("sends one createCommentThread for a second submit made while the first is in flight", async () => {
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "looks good");

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
      expect(submitButton().hasAttribute("disabled")).toBe(true);
    });

    // Simulated repeated dispatch, by every route.
    fireEvent.click(submitButton());
    pressCtrlEnter();
    await settle();

    expect(creates).toHaveLength(1);
    expect(createAt(0).request.quotedText).toBe("commentable");
    expect(JSON.stringify(createAt(0).request.content)).toContain("looks good");

    createAt(0).answer.resolve({ threadId: "thread-1" });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
  });

  it("paints the anchor of the thread the host created and reports it once", async () => {
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "looks good");

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    fireEvent.click(submitButton());
    pressCtrlEnter();
    await settle();

    // Answer every request that reached the host, in order. With one submission
    // there is one; a build that let the repeat through would answer two, and
    // only the later call's `onSuccess` would run.
    for (const [index, recorded] of creates.entries()) {
      recorded.answer.resolve({ threadId: `thread-${String(index + 1)}` });
      await settle();
    }

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(paintedAnchors()).toEqual([
      { threadId: "thread-1", text: "commentable" },
    ]);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith("thread-1");
    expect(useCommentThreadsStore.getState().draftByEpicId[EPIC_ID]).toBeNull();
  });

  it("keeps the draft and text after a rejected create and lets a retry through", async () => {
    await renderPopover();
    const editor = composerEditorAt(0);
    typeIntoEditor(editor, "retry me");

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    await act(async () => {
      createAt(0).answer.reject(new Error("host unavailable"));
      await Promise.resolve();
    });

    // Query reports the failure on its own schedule; wait for the observable
    // result (the button usable again) rather than a fixed number of ticks.
    await waitFor(() => {
      expect(submitButton().hasAttribute("disabled")).toBe(false);
    });
    expect(editor.getText()).toBe("retry me");
    expect(useCommentThreadsStore.getState().draftByEpicId[EPIC_ID]).not.toBe(
      null,
    );
    expect(paintedAnchors()).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(2);
    });

    createAt(1).answer.resolve({ threadId: "thread-retry" });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("thread-retry");
    });
    expect(paintedAnchors()).toEqual([
      { threadId: "thread-retry", text: "commentable" },
    ]);
  });

  it("keeps the anchor on the quoted text when text is inserted before it while the create is pending", async () => {
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "looks good");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });

    act(() => {
      artifactEditor.commands.insertContentAt(1, "Well, ");
    });
    createAt(0).answer.resolve({ threadId: "thread-1" });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("thread-1");
    });
    expect(paintedAnchors()).toEqual([
      { threadId: "thread-1", text: "commentable" },
    ]);
  });

  it("finalizes the saved thread without an anchor when the quoted text is deleted while the create is pending", async () => {
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "looks good");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });

    // Leaves the document shorter than the range the submit captured.
    act(() => {
      artifactEditor.commands.deleteRange({
        from: 1,
        to: 1 + DOCUMENT_TEXT.length,
      });
    });
    createAt(0).answer.resolve({ threadId: "thread-1" });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(onCreated).toHaveBeenCalledWith("thread-1");
    expect(paintedAnchors()).toEqual([]);
    expect(useCommentThreadsStore.getState().draftByEpicId[EPIC_ID]).toBeNull();
  });

  it("keeps a newer draft when an earlier, dismissed draft's create is acknowledged", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "old comment");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });

    // Dismiss the pending draft, then start another one on "world".
    fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New comment" })).toBeNull();
    });
    act(() => {
      useCommentThreadsStore.getState().setDraft(EPIC_ID, {
        draftId: "draft-2",
        tileId: TILE_ID,
        artifactId: ARTIFACT_ID,
        from: 19,
        to: 24,
        quotedText: "world",
      });
    });
    await screen.findByRole("button", { name: /^Comment/ });
    const newEditor = composerEditorAt(0);
    typeIntoEditor(newEditor, "new comment");

    createAt(0).answer.resolve({ threadId: "thread-1" });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("thread-1");
    });
    await settle();

    expect(paintedAnchors()).toEqual([
      { threadId: "thread-1", text: "commentable" },
    ]);
    expect(
      useCommentThreadsStore.getState().draftByEpicId[EPIC_ID],
    ).toMatchObject({ quotedText: "world" });
    expect(newEditor.getText()).toBe("new comment");
  });

  it("retires the saved draft without anchoring when the artifact editor is destroyed before the ack", async () => {
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "looks good");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });

    act(() => {
      artifactEditor.destroy();
    });
    createAt(0).answer.resolve({ threadId: "thread-1" });

    // The thread is saved, so the draft must not stay open to be resubmitted.
    await waitFor(() => {
      expect(
        useCommentThreadsStore.getState().draftByEpicId[EPIC_ID],
      ).toBeNull();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps a newer draft when the artifact editor is destroyed before an earlier create's ack", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPopover();
    typeIntoEditor(composerEditorAt(0), "old comment");
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New comment" })).toBeNull();
    });
    act(() => {
      useCommentThreadsStore.getState().setDraft(EPIC_ID, {
        draftId: "draft-2",
        tileId: TILE_ID,
        artifactId: ARTIFACT_ID,
        from: 19,
        to: 24,
        quotedText: "world",
      });
    });

    act(() => {
      artifactEditor.destroy();
    });
    createAt(0).answer.resolve({ threadId: "thread-1" });
    await settle();

    expect(
      useCommentThreadsStore.getState().draftByEpicId[EPIC_ID],
    ).toMatchObject({ draftId: "draft-2" });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
