import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
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
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { markTargetAnswer } from "@traycer/protocol/host-transport/remote/rpc-types";
import { recordingRefusedHost } from "@/lib/host/refused-host";
import { unsupportedHostMethodError } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  poolEntry,
  remoteEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  epicCreateCommentThreadV11,
  epicCreateCommentThreadV12,
} from "@traycer/protocol/host/epic/contracts";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { QuoteChatTarget } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useNewConversationAnnotationStore } from "@/stores/epics/new-conversation-annotation-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
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
import { useAuthStore } from "@/stores/auth/auth-store";
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
  realMenu: { current: false },
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
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu")
      >();
    return {
      // Only the regression case needs Radix's portalled menu; the rest use
      // a stub that keeps the roster inside the box.
      ChatTargetMenu: (props: Parameters<typeof actual.ChatTargetMenu>[0]) =>
        outside.realMenu.current ? (
          <actual.ChatTargetMenu {...props} />
        ) : (
          <StubChatTargetMenu {...props} />
        ),
    };
  },
);
function StubChatTargetMenu(props: {
  readonly trigger: ReactNode;
  readonly targets: readonly QuoteChatTarget[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectChat: (chatId: string) => void;
  readonly onSelectNewChat: (() => void) | null;
}) {
  return (
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
          {props.onSelectNewChat === null ? null : (
            <button
              type="button"
              role="menuitem"
              onClick={props.onSelectNewChat}
            >
              New chat
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
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
const hostClientDisposers: Array<() => void> = [];

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

function renderPopover(
  sendToChat: typeof SURFACE | null,
  hostClient: HostClient<HostRpcRegistry> | null,
): RenderResult {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AnchoredDraftPopover
        epicId={EPIC_ID}
        artifactId={ARTIFACT_ID}
        tileId={TILE_ID}
        hostClient={hostClient}
        onCreated={() => undefined}
        onClosed={onClosed}
        sendToChat={sendToChat}
      />
    </QueryClientProvider>,
  );
}

function hostClientFor(hostId: string): HostClient<HostRpcRegistry> {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (candidate) => {
      if (candidate === POOL_HOST_ID) return poolEntry;
      if (candidate === hostId) return remoteEntry(candidate, null);
      return null;
    },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "comment-draft-request",
      handlers: {
        "epic.listCollaborators": () => ({
          collaborators: [],
          collaboratorsAvailable: true,
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "comment-token",
    }),
  );
  const requester = spine.createRequesterForHostId(hostId);
  hostClientDisposers.push(() => {
    spine.dispose();
    queryClient.clear();
  });
  return requester;
}

function hostClientForUnsupportedPoolComment(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "comment-draft-unsupported-request",
    handlers: {
      "epic.listCollaborators": () => ({
        collaborators: [],
        collaboratorsAvailable: true,
      }),
      "epic.createCommentThread": () => {
        throw unsupportedHostMethodError(
          "epic.createCommentThread",
          "host-request",
        );
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (candidate) =>
      candidate === POOL_HOST_ID ? poolEntry : null,
    messenger: recordingRefusedHost(messenger),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "comment-token",
    }),
  );
  hostClientDisposers.push(() => {
    spine.dispose();
    queryClient.clear();
  });
  return {
    client: spine.createRequesterForHostId(POOL_HOST_ID),
    messenger,
  };
}

function hostClientForPendingPoolUnknown(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly rejectUnknown: () => void;
} {
  const queryClient = createAppQueryClient();
  let rejectUnknown: (() => void) | null = null;
  const error = HostRpcError.fromWireEnvelope(
    {
      code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
      message: "The authoritative write outcome could not be confirmed.",
    },
    "comment-draft-unknown-request",
    "epic.createCommentThread",
  );
  markTargetAnswer(error);
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "comment-draft-unknown-request",
    handlers: {
      "epic.listCollaborators": () => ({
        collaborators: [],
        collaboratorsAvailable: true,
      }),
      "epic.createCommentThread": () =>
        new Promise((_, reject) => {
          rejectUnknown = () => reject(error);
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (candidate) =>
      candidate === POOL_HOST_ID ? poolEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "comment-token",
    }),
  );
  hostClientDisposers.push(() => {
    spine.dispose();
    queryClient.clear();
  });
  return {
    client: spine.createRequesterForHostId(POOL_HOST_ID),
    messenger,
    rejectUnknown: () => {
      if (rejectUnknown === null) {
        throw new Error("the pool create request was not pending");
      }
      rejectUnknown();
    },
  };
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
  resetNegotiatedManifests();
});

afterEach(() => {
  for (const dispose of hostClientDisposers.splice(0)) dispose();
  useNewConversationAnnotationStore.setState({ byEpicId: {} });
  useNewConversationModalOpenStore.setState({ request: null });
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  outside.realMenu.current = false;
  vi.restoreAllMocks();
  cleanup();
  useAnchoredDraftStore.setState({ byEpicId: {} });
  useComposerDraftStore.setState({ drafts: {} });
  useAuthStore.setState({ status: "signed-out" });
});

describe("the comment draft box's Send to chat", () => {
  it.each([
    [POOL_HOST_ID, "The comment could not be saved. Try again."],
    ["comment-computer", "Update the host to comment on this artifact."],
  ] as const)(
    "shows the pool save fallback or preserves computer upgrade copy for an older negotiated comment contract (%s)",
    async (hostId, expectedFailure) => {
      recordNegotiatedHostManifest(hostId, {
        "epic.createCommentThread": epicCreateCommentThreadV11.schemaVersion,
      });
      storeDraft({});
      renderPopover(SURFACE, hostClientFor(hostId));
      typeIntoEditor(composerEditorAt(0), "Needs attention");
      fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        expectedFailure,
      );
      expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeDefined();
      expect(onClosed).not.toHaveBeenCalled();
    },
  );

  it("keeps the draft after a dispatched pool refusal despite a passing negotiated precheck", async () => {
    useAuthStore.setState({ status: "signed-in" });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.createCommentThread": epicCreateCommentThreadV12.schemaVersion,
    });
    const { client, messenger } = hostClientForUnsupportedPoolComment();
    storeDraft({});
    renderPopover(SURFACE, client);
    typeIntoEditor(composerEditorAt(0), "Needs attention");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The comment could not be saved. Try again.",
    );
    const dispatchedComment = messenger.calls.filter(
      (call) => call.method === "epic.createCommentThread",
    );
    expect(dispatchedComment).toHaveLength(1);
    expect(dispatchedComment[0]?.authority.endpoint.hostId).toBe(POOL_HOST_ID);
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeDefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("uses the captured pool peer when an unknown answer arrives after the popover follows another host", async () => {
    useAuthStore.setState({ status: "signed-in" });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.createCommentThread": epicCreateCommentThreadV12.schemaVersion,
    });
    const { client, messenger, rejectUnknown } =
      hostClientForPendingPoolUnknown();
    storeDraft({});
    const view = renderPopover(SURFACE, client);
    typeIntoEditor(composerEditorAt(0), "Needs attention");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));

    await waitFor(() => {
      expect(
        messenger.calls.filter(
          (call) => call.method === "epic.createCommentThread",
        ),
      ).toHaveLength(1);
    });
    const [dispatchedComment] = messenger.calls.filter(
      (call) => call.method === "epic.createCommentThread",
    );
    expect(dispatchedComment.authority.endpoint.hostId).toBe(POOL_HOST_ID);

    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AnchoredDraftPopover
          epicId={EPIC_ID}
          artifactId={ARTIFACT_ID}
          tileId={TILE_ID}
          hostClient={hostClientFor("comment-computer")}
          onCreated={() => undefined}
          onClosed={onClosed}
          sendToChat={SURFACE}
        />
      </QueryClientProvider>,
    );
    rejectUnknown();

    await waitFor(() => {
      expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toMatchObject({
        submitting: false,
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeDefined();
    expect(
      messenger.calls.filter(
        (call) => call.method === "epic.createCommentThread",
      ),
    ).toHaveLength(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("keeps anchor-preparation failures visible inline before dispatch", async () => {
    useAuthStore.setState({ status: "signed-in" });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.createCommentThread": epicCreateCommentThreadV12.schemaVersion,
    });
    const { client, messenger } = hostClientForPendingPoolUnknown();
    storeDraft({
      anchor: {
        kind: "element",
        artboard: BOARD_PATH,
        elementId: null,
        label: "p",
      },
      selection: null,
    });
    renderPopover(SURFACE, client);
    typeIntoEditor(composerEditorAt(0), "Needs attention");
    fireEvent.click(screen.getByRole("button", { name: /^Comment/ }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Select an element in the page to comment on it.",
    );
    expect(
      messenger.calls.filter(
        (call) => call.method === "epic.createCommentThread",
      ),
    ).toHaveLength(0);
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toMatchObject({
      submitting: false,
    });
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeDefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("is enabled with an empty box and sends just the element, closing the box", async () => {
    storeDraft({});
    renderPopover(SURFACE, null);
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

  it("attaches the typed text to the element in the chosen chat", async () => {
    storeDraft({});
    renderPopover(SURFACE, null);
    typeIntoEditor(composerEditorAt(0), "make this bolder");

    chooseChatOne();

    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("chat-1");
    });
    expect(attach.mock.calls[0][0].record.comment).toBe("make this bolder");
    expect(readComposerDraftSnapshot("chat-1").content.content).toEqual([
      { type: "paragraph" },
    ]);
  });

  it("keeps the draft and shows the failure when the attach fails", async () => {
    attach.mockRejectedValue(new Error("Composer unavailable"));
    storeDraft({});
    renderPopover(SURFACE, null);
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

  it("keeps a click in the real picker inside the box: no discard prompt, one send", async () => {
    outside.realMenu.current = true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    storeDraft({});
    renderPopover(SURFACE, null);
    typeIntoEditor(composerEditorAt(0), "make this bolder");

    fireEvent.pointerDown(sendButton(), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const item = await screen.findByRole("menuitem", { name: /Chat one/ });
    fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
    fireEvent.click(item);

    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith("chat-1");
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0].record.comment).toBe("make this bolder");
    expect(readComposerDraftSnapshot("chat-1").content.content).toEqual([
      { type: "paragraph" },
    ]);
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeUndefined();
  });

  it("is absent on a surface that cannot capture elements", () => {
    storeDraft({});
    renderPopover(null, null);
    expect(screen.queryByRole("button", { name: "Send to chat" })).toBeNull();
  });

  it("is absent on a draft pinned to a canvas point, which has no element", () => {
    storeDraft({
      selection: null,
      anchor: { kind: "canvas-point", page: "flow", x: 1, y: 2, label: "Pin" },
    });
    renderPopover(SURFACE, null);
    expect(screen.queryByRole("button", { name: "Send to chat" })).toBeNull();
  });
});

describe("the draft box's New chat", () => {
  async function openPicker(): Promise<void> {
    storeDraft({});
    renderPopover(SURFACE, null);
    typeIntoEditor(composerEditorAt(0), "make this bolder");
    fireEvent.click(sendButton());
    await screen.findByRole("menuitem", { name: "Chat one" });
  }

  it("moves the element and the text into the new-conversation modal and closes the box", async () => {
    recordNegotiatedHostManifest(SCOPE.hostId, {
      "epic.createChat": { major: 1, minor: 5 },
    });
    await openPicker();

    fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));

    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledOnce();
    });
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[EPIC_ID],
    ).toMatchObject([{ comment: "make this bolder" }]);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.content?.content,
    ).toBeUndefined();
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: EPIC_ID,
      tabId: SCOPE.viewTabId,
      placement: null,
      parentId: null,
      hostId: null,
    });
    expect(useAnchoredDraftStore.getState().byEpicId[EPIC_ID]).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it.each([
    ["a host below the minor", { major: 1, minor: 4 }],
    ["a host that has not negotiated", null],
  ])("offers no New chat for %s", async (_name, version) => {
    if (version !== null)
      recordNegotiatedHostManifest(SCOPE.hostId, {
        "epic.createChat": version,
      });
    await openPicker();

    expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
  });
});
