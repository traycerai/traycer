import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CommentThreadWire,
  EditCommentRequest,
  EditCommentResponse,
  ReplyToCommentThreadRequest,
  ReplyToCommentThreadResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  composerEditorAt,
  composerEditors,
  createDeferred,
  settle,
  typeIntoEditor,
  type Deferred,
} from "./comment-submit-test-support";

/**
 * The sidebar's reply and edit composers go through the same single-flight
 * rule as the new-comment popover. The host is real (a mock messenger behind
 * the real client and mutation hooks) and answers only when the test says so.
 */

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "spec-1";
const THREAD_ID = "thread-1";
const COMMENT_ID = "comment-1";

interface RecordedCall<Request, Response> {
  readonly request: Request;
  readonly answer: Deferred<Response>;
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
let replies: Array<
  RecordedCall<ReplyToCommentThreadRequest, ReplyToCommentThreadResponse>
>;
let edits: Array<RecordedCall<EditCommentRequest, EditCommentResponse>>;
let createCount: number;

const thread: CommentThreadWire = {
  threadId: THREAD_ID,
  resolved: false,
  createdAt: 1,
  comments: [
    {
      commentId: COMMENT_ID,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "original comment" }],
          },
        ],
      },
      createdAt: 1,
      updatedAt: null,
      author: { userId: "user-1", fallbackHandle: "someone" },
    },
  ],
  data: { createdByUserId: "user-1", quotedText: "quoted" },
};

beforeEach(() => {
  replies = [];
  edits = [];
  createCount = 0;
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
        "epic.replyToCommentThread": (request) => {
          const answer = createDeferred<ReplyToCommentThreadResponse>();
          replies.push({ request, answer });
          return answer.promise;
        },
        "epic.editComment": (request) => {
          const answer = createDeferred<EditCommentResponse>();
          edits.push({ request, answer });
          return answer.promise;
        },
        "epic.createCommentThread": () => {
          createCount += 1;
          return { threadId: "unexpected-thread" };
        },
        "epic.listCommentThreads": () => ({ threads: [thread] }),
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
});

afterEach(() => {
  cleanup();
  epicHandle.dispose();
  queryClient.clear();
  useAuthStore.getState().setSignedOut();
});

function cardElement(threadToRender: CommentThreadWire, isExpanded: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        <CommentThreadCard
          epicId={EPIC_ID}
          hostClient={hostClient}
          artifactType="spec"
          artifactId={ARTIFACT_ID}
          thread={threadToRender}
          currentUserId="user-1"
          canModerate={false}
          isExpanded={isExpanded}
          hasAnchor
          onExpandedChange={() => undefined}
          onActivateAnchor={() => undefined}
        />
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

async function renderCard(threadToRender: CommentThreadWire) {
  const view = render(cardElement(threadToRender, true));
  await screen.findByRole("button", { name: /^Reply/ });
  return {
    async setExpanded(isExpanded: boolean) {
      view.rerender(cardElement(threadToRender, isExpanded));
      if (isExpanded) await screen.findByRole("button", { name: /^Reply/ });
    },
  };
}

async function renderExpandedCard(): Promise<void> {
  await renderCard(thread);
}

function replyButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Reply/ });
}

function commentActionsButton(index: number): HTMLElement {
  const button = screen
    .getAllByRole("button", { name: "Comment actions" })
    .at(index);
  if (button === undefined) {
    throw new Error(`no comment actions button at index ${String(index)}`);
  }
  return button;
}

function replyAt(
  index: number,
): RecordedCall<ReplyToCommentThreadRequest, ReplyToCommentThreadResponse> {
  const recorded = replies.at(index);
  if (recorded === undefined) {
    throw new Error(
      `no replyToCommentThread request at index ${String(index)}`,
    );
  }
  return recorded;
}

function editAt(
  index: number,
): RecordedCall<EditCommentRequest, EditCommentResponse> {
  const recorded = edits.at(index);
  if (recorded === undefined) {
    throw new Error(`no editComment request at index ${String(index)}`);
  }
  return recorded;
}

describe("<CommentThreadCard /> reply submit", () => {
  it("sends one reply for repeated submits, then accepts the next reply after the ack resets the composer", async () => {
    await renderExpandedCard();
    const replyEditor = composerEditorAt(0);
    typeIntoEditor(replyEditor, "first reply");

    fireEvent.click(replyButton());
    await waitFor(() => {
      expect(replies).toHaveLength(1);
      expect(replyButton().hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(replyButton());
    fireEvent.keyDown(replyEditor.view.dom, { key: "Enter", ctrlKey: true });
    await settle();

    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replyAt(0).request.content)).toContain("first reply");

    replyAt(0).answer.resolve({ ok: true });
    await waitFor(() => {
      expect(replyEditor.isEmpty).toBe(true);
    });

    typeIntoEditor(replyEditor, "second reply");
    await waitFor(() => {
      expect(replyButton().hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(replyButton());
    await waitFor(() => {
      expect(replies).toHaveLength(2);
    });
    expect(JSON.stringify(replyAt(1).request.content)).toContain(
      "second reply",
    );
    expect(createCount).toBe(0);

    replyAt(1).answer.resolve({ ok: true });
    await settle();
  });
});

describe("<CommentThreadCard /> reply submit across a remount", () => {
  it("keeps text typed in a reopened reply composer when the earlier reply is acknowledged", async () => {
    const view = await renderCard(thread);
    typeIntoEditor(composerEditorAt(0), "old reply");
    fireEvent.click(replyButton());
    await waitFor(() => {
      expect(replies).toHaveLength(1);
    });

    // Collapse and reopen the thread while the reply is in flight.
    await view.setExpanded(false);
    await view.setExpanded(true);
    const reopenedEditor = composerEditorAt(0);
    typeIntoEditor(reopenedEditor, "fresh text");

    replyAt(0).answer.resolve({ ok: true });
    await waitFor(() => {
      expect(replyButton().hasAttribute("disabled")).toBe(false);
    });
    await settle();

    expect(reopenedEditor.getText()).toBe("fresh text");
  });
});

describe("<CommentThreadCard /> edit submit", () => {
  it("saves an edit through editComment once and never creates a thread", async () => {
    await renderExpandedCard();
    const user = userEvent.setup();

    // Radix opens the menu on pointerdown, which `userEvent` synthesizes.
    await user.click(screen.getByRole("button", { name: "Comment actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const saveButton = await screen.findByRole("button", { name: /^Save/ });
    // The edit composer mounts above the reply composer.
    expect(composerEditors()).toHaveLength(2);
    typeIntoEditor(composerEditorAt(0), " (edited)");

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    fireEvent.click(saveButton);
    await settle();

    expect(edits).toHaveLength(1);
    expect(editAt(0).request.commentId).toBe(COMMENT_ID);
    expect(JSON.stringify(editAt(0).request.content)).toContain("(edited)");
    expect(createCount).toBe(0);
    expect(replies).toHaveLength(0);

    editAt(0).answer.resolve({ ok: true });

    // The edit composer closes on the ack.
    await waitFor(() => {
      expect(composerEditors()).toHaveLength(1);
    });
    expect(createCount).toBe(0);
  });

  it("keeps a second comment's edit open when the first comment's save is acknowledged", async () => {
    const secondComment = {
      ...thread.comments[0],
      commentId: "comment-2",
    };
    await renderCard({
      ...thread,
      comments: [...thread.comments, secondComment],
    });
    const user = userEvent.setup();

    await user.click(commentActionsButton(0));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    typeIntoEditor(composerEditorAt(0), " one");
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });

    // Move on to the second comment while the first save is still in flight.
    await user.click(commentActionsButton(1));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const secondEditor = composerEditorAt(0);
    typeIntoEditor(secondEditor, " two");

    editAt(0).answer.resolve({ ok: true });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Save/ }).hasAttribute("disabled"),
      ).toBe(false);
    });
    await settle();

    expect(composerEditors()).toHaveLength(2);
    expect(secondEditor.getText()).toContain("two");
  });

  it("keeps text typed in a reopened edit composer when the earlier save is acknowledged", async () => {
    const view = await renderCard(thread);
    const user = userEvent.setup();

    await user.click(commentActionsButton(0));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    typeIntoEditor(composerEditorAt(0), " old");
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });

    // Collapse and reopen the thread; the comment is still the one being edited.
    await view.setExpanded(false);
    await view.setExpanded(true);
    const reopenedEditor = composerEditorAt(0);
    typeIntoEditor(reopenedEditor, " fresh");

    editAt(0).answer.resolve({ ok: true });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Save/ }).hasAttribute("disabled"),
      ).toBe(false);
    });
    await settle();

    expect(composerEditors()).toHaveLength(2);
    expect(reopenedEditor.getText()).toContain("fresh");
  });
});
