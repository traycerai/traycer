import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  CommentThreadWire,
  ReplyToCommentThreadRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import { SwitcherCommentsList } from "@/components/epic-canvas/mobile/switcher-comments-list";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const ARTIFACT_ID = "spec-1";
const QUOTED_TEXT = "the sentence this thread hangs off";
const REPLY_CONTENT: JsonContent = { type: "doc", content: [] };

// The coarse-pointer hit-slop rules the sheet imports. jsdom computes no
// pseudo-element under a media query, so the rule is read from source. Vitest's
// cwd is the gui-app root.
const touchTargetsCss = readFileSync(
  join(
    process.cwd(),
    "src/components/layout/shell/mobile-shell-touch-targets.css",
  ),
  "utf8",
);

// The panel resolves the artifact RECORD (for its kind) from the epic
// projection, which needs a live Y.Doc; the tile ref the list reads is seeded
// into the real canvas store below, so the resolution under test - shown tile ->
// artifact - stays real.
const artifactKind = { value: "spec" as string | null };
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () =>
    artifactKind.value === null ? null : { kind: artifactKind.value },
}));

// The Epic SESSION's client, which is what the panel must read threads on.
const hostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => hostClientRef.current,
}));

// The reply composer is a Tiptap editor; stand in for it with the submit
// control alone, so this file exercises what a reply DOES (the mutation, on the
// session host) rather than Tiptap's jsdom behavior.
vi.mock("@/components/comments/comment-composer", () => ({
  CommentComposer: (props: {
    readonly submitLabel: string;
    readonly onSubmit: (content: JsonContent) => void;
  }) => (
    <button type="button" onClick={() => props.onSubmit(REPLY_CONTENT)}>
      {props.submitLabel}
    </button>
  ),
}));

function threadFixture(): CommentThreadWire {
  return {
    threadId: "thread-1",
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: "comment-1",
        content: { type: "doc", content: [] },
        createdAt: 1,
        updatedAt: null,
        author: { userId: "user-1", fallbackHandle: "someone" },
      },
    ],
    data: { createdByUserId: "user-1", quotedText: QUOTED_TEXT },
  };
}

function artifactRef(): EpicCanvasTileRef {
  return {
    id: ARTIFACT_ID,
    instanceId: "inst-1",
    type: "spec",
    name: "Spec",
    hostId: mockLocalHostEntry.hostId,
  };
}

function terminalRef(): EpicCanvasTileRef {
  return {
    id: "term-1",
    instanceId: "inst-2",
    type: "terminal",
    name: "zsh",
    hostId: mockLocalHostEntry.hostId,
    cwd: "/ws",
    titleSource: "default",
  };
}

/**
 * Seed the one tile the phone shows, exactly as the canvas store holds it.
 * `activePaneId` is explicit because `null` - a pane the store has not marked
 * active, which the phone still renders - is a state under test here, not an
 * edge case to default away.
 */
function seedShownTile(
  ref: EpicCanvasTileRef | null,
  activePaneId: string | null,
): void {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: ref === null ? [] : [ref.instanceId],
    activeTabId: ref?.instanceId ?? null,
    previewTabId: null,
    activationHistory: [],
  };
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    canvasByTabId: {
      [TAB_ID]: {
        root,
        activePaneId,
        tilesByInstanceId: ref === null ? {} : { [ref.instanceId]: ref },
        sizesByGroupId: {},
      },
    },
  });
}

let queryClient: QueryClient;
let threads: ReadonlyArray<CommentThreadWire> = [];
let replies: ReplyToCommentThreadRequest[] = [];

beforeEach(() => {
  artifactKind.value = "spec";
  threads = [];
  replies = [];
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
        "epic.listCommentThreads": () => ({ threads: [...threads] }),
        "epic.replyToCommentThread": (request) => {
          replies.push(request);
          return { ok: true } as const;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClientRef.current = spine.createRequester(mockLocalHostEntry);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  hostClientRef.current = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
});

function renderList() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SwitcherCommentsList epicId={EPIC_ID} tabId={TAB_ID} />
    </QueryClientProvider>,
  );
}

const NO_ARTIFACT_MESSAGE = "Open an artifact to see and add comments on it.";

describe("<SwitcherCommentsList />", () => {
  it("lists the shown artifact's threads", async () => {
    threads = [threadFixture()];
    seedShownTile(artifactRef(), "pane-A");

    renderList();

    expect(await screen.findByText(QUOTED_TEXT)).not.toBeNull();
  });

  it("replies to a thread on the Epic session's host", async () => {
    threads = [threadFixture()];
    seedShownTile(artifactRef(), "pane-A");
    const user = userEvent.setup();

    renderList();
    await screen.findByText(QUOTED_TEXT);

    // Expanding is how a phone user reads a thread: the card is collapsed to
    // its quoted snapshot until then, and the reply composer comes with the
    // expansion.
    await user.click(screen.getByRole("button", { name: /1 comment/ }));
    await user.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() => {
      expect(replies).toHaveLength(1);
    });
    expect(replies[0].threadId).toBe("thread-1");
    expect(replies[0].artifactId).toBe(ARTIFACT_ID);
  });

  it("gives the thread's expand control a slot the coarse-pointer slop addresses", async () => {
    // The control is a raw `<button>`, not a `ui/button`, and on a thread with
    // no quoted snapshot its box is one line of meta text - well under 44px. The
    // slop rules address controls by `data-slot`, so it only earns the hit area
    // by declaring one.
    threads = [threadFixture()];
    seedShownTile(artifactRef(), "pane-A");

    renderList();
    await screen.findByText(QUOTED_TEXT);

    const toggle = screen.getByRole("button", { name: /1 comment/ });
    expect(toggle.dataset.slot).toBe("comment-thread-toggle");
    expect(touchTargetsCss).toContain('data-slot="comment-thread-toggle"');
  });

  it("names the condition when the shown tile is not an artifact", () => {
    // A silently blank panel would read as "this artifact has no comments".
    seedShownTile(terminalRef(), "pane-A");

    renderList();

    expect(screen.getByText(NO_ARTIFACT_MESSAGE)).not.toBeNull();
  });

  it("names the condition on an empty pane", () => {
    seedShownTile(null, "pane-A");

    renderList();

    expect(screen.getByText(NO_ARTIFACT_MESSAGE)).not.toBeNull();
  });

  it("follows the shown tile even when no pane is marked active", async () => {
    // `selectMobileTile` falls back to the first pane, so the phone shows an
    // artifact with `activePaneId` null - the state the canvas store's own
    // active-tile selectors answer `null` for. Reading those here would blank
    // the panel underneath a visibly-open artifact.
    threads = [threadFixture()];
    seedShownTile(artifactRef(), null);

    renderList();

    expect(await screen.findByText(QUOTED_TEXT)).not.toBeNull();
    expect(screen.queryByText(NO_ARTIFACT_MESSAGE)).toBeNull();
  });
});
