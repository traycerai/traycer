import { useSyncExternalStore, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { FloatingDraftPopover } from "@/components/comments/floating-draft-popover";
import { ThreadAnchor } from "@/editor-core/extensions/thread-anchor";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/index.css";

/**
 * THE NEW-COMMENT POPOVER OVER A REAL EDITOR AND A HOST THAT ANSWERS ON CUE.
 *
 * The real `FloatingDraftPopover` (with the real `CommentComposer`) writes to a
 * real Tiptap editor carrying the real `ThreadAnchor` mark, through the real
 * Query mutation and a `MockHostMessenger` whose `epic.createCommentThread`
 * stays pending until a button answers it. `browser-tests/comment-draft-submit.spec.ts`
 * drives it with trusted keyboard and mouse input; the `#counters` text
 * (creates reaching the host, answers, painted anchors, current draft) can
 * also be read by eye.
 */
const EPIC_ID = "comment-draft-epic";
const ARTIFACT_ID = "comment-draft-artifact";
const TILE_ID = "comment-draft-tile";
const DOCUMENT_TEXT = "Hello commentable world";

interface PendingCreate {
  readonly resolve: (response: CreateCommentThreadResponse) => void;
  readonly reject: (error: Error) => void;
}

const pendingCreates: PendingCreate[] = [];
let createsReachedHost = 0;
let answeredCreates = 0;
let draftSequence = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

useAuthStore
  .getState()
  .setSignedIn(
    { userId: "user-1", userName: "U", email: "u@example.invalid" },
    { userId: "user-1", username: "U" },
    [],
  );

const queryClient = createAppQueryClient();
let requestCounter = 0;
const spine = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: createHostQueryInvalidator(queryClient),
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `comment-draft-${String((requestCounter += 1))}`,
    handlers: {
      "epic.createCommentThread": (_request: CreateCommentThreadRequest) => {
        createsReachedHost += 1;
        notify();
        return new Promise<CreateCommentThreadResponse>((resolve, reject) => {
          pendingCreates.push({ resolve, reject });
        });
      },
      "epic.listCommentThreads": () => ({ threads: [] }),
      "epic.listCollaborators": () => ({
        collaborators: [
          {
            role: "editor",
            accessType: "direct",
            grantedAt: 1,
            grantedBy: "user-1",
            user: {
              userId: "user-2",
              profile: {
                displayName: "Alice Chen",
                avatarUrl: "",
                email: "alice@example.invalid",
                handle: "alice",
              },
            },
            team: null,
          },
        ],
        collaboratorsAvailable: true,
      }),
    },
  }),
});
spine.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);
const hostClient = spine.createRequester(mockLocalHostEntry);

const epicHandle = openStoreForTest({
  epicId: EPIC_ID,
  userId: "user-1",
  factories: {
    streamClientFactory: noopEpicStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
epicHandle.store.setState({ durabilityStatus: null });

const artifactElement = document.querySelector("#artifact");
if (!(artifactElement instanceof HTMLElement)) {
  throw new Error("artifact root missing");
}
const artifactEditor = new Editor({
  element: artifactElement,
  extensions: [StarterKit, ThreadAnchor],
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: DOCUMENT_TEXT }] },
    ],
  },
});
artifactEditor.on("transaction", notify);
useCommentThreadsStore.subscribe(notify);

function openDraftOn(text: string): void {
  const from = DOCUMENT_TEXT.indexOf(text) + 1;
  draftSequence += 1;
  useCommentThreadsStore.getState().setDraft(EPIC_ID, {
    draftId: `draft-${String(draftSequence)}`,
    tileId: TILE_ID,
    artifactId: ARTIFACT_ID,
    from,
    to: from + text.length,
    quotedText: text,
  });
}

function answerOldestCreate(): void {
  const oldest = pendingCreates.shift();
  if (oldest === undefined) return;
  answeredCreates += 1;
  oldest.resolve({ threadId: `thread-${String(answeredCreates)}` });
  notify();
}

function describeAnchors(): string {
  const anchors: string[] = [];
  artifactEditor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "threadAnchor") continue;
      anchors.push(`${String(mark.attrs.threadId)}:${node.text ?? ""}`);
    }
  });
  return anchors.length === 0 ? "none" : anchors.join(", ");
}

/** The whole counters text; equal strings are equal snapshots to React. */
function readCounters(): string {
  const draft =
    useCommentThreadsStore.getState().draftByEpicId[EPIC_ID] ?? null;
  return [
    `creates=${String(createsReachedHost)}`,
    `answered=${String(answeredCreates)}`,
    `anchors=${describeAnchors()}`,
    `draft=${draft === null ? "none" : draft.quotedText}`,
  ].join("\n");
}

export function Counters(): ReactElement {
  const text = useSyncExternalStore(subscribe, readCounters);
  return (
    <pre id="counters" data-testid="counters">
      {text}
    </pre>
  );
}

export function CommentDraftSubmitFixture(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        {/* Pushed below the popover, which opens under the quote near the top. */}
        <div
          style={{
            margin: 16,
            marginTop: "50vh",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={() => openDraftOn("commentable")}>
            Draft on commentable
          </button>
          <button type="button" onClick={() => openDraftOn("world")}>
            Draft on world
          </button>
          <button type="button" onClick={answerOldestCreate}>
            Answer oldest create
          </button>
        </div>
        <Counters />
        <FloatingDraftPopover
          epicId={EPIC_ID}
          hostClient={hostClient}
          artifactType="spec"
          artifactId={ARTIFACT_ID}
          tileId={TILE_ID}
          editor={artifactEditor}
          onCreated={() => undefined}
        />
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<CommentDraftSubmitFixture />);
