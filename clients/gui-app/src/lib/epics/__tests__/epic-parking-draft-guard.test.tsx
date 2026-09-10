import { createRef, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";

// ── Module mocks ─────────────────────────────────────────────────────────
//
// Copied from `providers/__tests__/epic-session-provider.test.tsx`, trimmed
// to only what this file's real `<EpicSessionProvider>` needs to open a
// session in jsdom: no socket, an effective host that answers "attached",
// and a passthrough on the plan-restricted reprobe attach.
const hostState = vi.hoisted((): { id: string | null; attached: boolean } => ({
  id: "host-a",
  attached: true,
}));
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
const navigateMock = vi.hoisted(() => vi.fn());
const reprobeCallbacks = vi.hoisted((): { callbacks: Array<() => void> } => ({
  callbacks: [],
}));
const hostBindingRef = vi.hoisted(
  (): { value: { readonly hostClient: unknown } | null } => ({
    value: null,
  }),
);
const sessionHostRows = vi.hoisted(
  (): { byHostId: Map<string, unknown>; userId: string | null } => ({
    byHostId: new Map(),
    userId: null,
  }),
);
const sessionHostClients = vi.hoisted(
  (): { byHostId: Map<string, unknown> } => ({
    byHostId: new Map(),
  }),
);
const resolveSessionHostClient = vi.hoisted(
  () =>
    (hostId: string | null): unknown => {
      if (hostId === null) return null;
      const existing = sessionHostClients.byHostId.get(hostId);
      if (existing !== undefined) return existing;
      const created = {
        request: vi.fn(),
        getActiveHost: () => sessionHostRows.byHostId.get(hostId) ?? null,
        getActiveHostId: () => hostId,
        getRequestContextUserId: () => sessionHostRows.userId,
      };
      sessionHostClients.byHostId.set(hostId, created);
      return created;
    },
);

vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => hostState.id,
}));

vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => hostState.attached,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    resolveSessionHostClient(hostId),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBindingRef.value,
  useAuthService: () => authServiceStub,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/host/owned-durable-stream-client", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/host/owned-durable-stream-client")
    >();
  return {
    ...actual,
    attachPlanRestrictedReprobe: (
      wsStreamClient: unknown,
      onReprobe: (() => void) | null,
    ) => {
      void wsStreamClient;
      if (onReprobe !== null) reprobeCallbacks.callbacks.push(onReprobe);
      return () => undefined;
    },
  };
});

import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import { resetFakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  epicHoldsUnsavedDraft,
  setEpicDraftHeld,
  subscribeEpicDraftGuard,
  __resetEpicDraftGuardForTests,
} from "@/lib/epics/epic-draft-guard";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "@/components/comments/comment-composer";

const setupWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
let workerFactoryBeforeTest: (() => RuntimeWorkerLike) | null = null;

function installStreamFactory(factory: EpicStreamClientFactory): void {
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker({
      streamClientFactory: factory,
      laneSelection: null,
    }).createWorker(),
  );
}

function noopStreamFactory(): ReturnType<EpicStreamClientFactory> {
  return {
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => undefined,
  };
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
  });
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
  });
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

/**
 * Waits for the session to be acquired (the composer under the gate has
 * mounted), then opens the tab and hides it - the sequence every parking
 * test below needs before it can arm the park window.
 */
async function openHiddenTabOnceReady(
  epicId: string,
  firstEditorLabel: string,
): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByLabelText(firstEditorLabel)).not.toBeNull();
  });
  act(() => {
    useEpicCanvasStore.getState().openEpicTabWithId(epicId, epicId, epicId);
    __syncEpicParkingOpenTabsForTests();
  });
  act(() => {
    setEpicSurfaceVisibility(epicId, epicId, false);
  });
}

/**
 * Real `<EpicSessionProvider>` + real `<EpicSessionGate>`, with up to two
 * real `<CommentComposer>`s toggled on/off by `showA`/`showB` - toggling off
 * unmounts the composer (arms 4 and 5), while the provider itself stays
 * mounted across `rerender()` calls (arms 1-3 need the session to survive).
 */
function Harness(props: {
  readonly epicId: string;
  readonly showA: boolean;
  readonly showB: boolean;
  readonly refA: Ref<CommentComposerHandle | null>;
  readonly refB: Ref<CommentComposerHandle | null>;
  readonly queryClient: QueryClient;
}) {
  const { epicId, showA, showB, refA, refB, queryClient } = props;
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionProvider epicId={epicId} tabId={epicId}>
        <EpicSessionGate fallback={null}>
          {showA ? (
            <CommentComposer
              epicId={epicId}
              hostClient={null}
              initialContent={null}
              placeholder="Reply A"
              focusOnMount={false}
              submitLabel="Reply"
              onSubmit={() => undefined}
              onCancel={null}
              className={undefined}
              ref={refA}
            />
          ) : null}
          {showB ? (
            <CommentComposer
              epicId={epicId}
              hostClient={null}
              initialContent={null}
              placeholder="Reply B"
              focusOnMount={false}
              submitLabel="Reply"
              onSubmit={() => undefined}
              onCancel={null}
              className={undefined}
              ref={refB}
            />
          ) : null}
        </EpicSessionGate>
      </EpicSessionProvider>
    </QueryClientProvider>
  );
}

describe("renderer parking draft-guard pins", () => {
  beforeEach(() => {
    workerFactoryBeforeTest = getEpicRuntimeWorkerFactoryOverride();
    window.localStorage.clear();
    hostState.id = "host-a";
    hostState.attached = true;
    hostBindingRef.value = null;
    sessionHostRows.byHostId.clear();
    sessionHostRows.userId = null;
    sessionHostClients.byHostId.clear();
    resetHostConnectionRegistryForTest();
    navigateMock.mockClear();
    resetCanvasStore();
    __getOpenEpicRegistryForTests().disposeAll();
    resetFakeDurableStreamTransports();
    setDesktopEpicOwnershipBridge(null);
    resetAuth("signed-in", "alice@example.com");
    reprobeCallbacks.callbacks.length = 0;
    // `canPark` reads `epicIsBusy`, which fails CLOSED until the agent
    // activity plane has answered at least once - without this every park
    // attempt refuses forever, not because of the draft guard.
    __setAgentActivityPlaneAnsweringForTests();
    installStreamFactory(() => noopStreamFactory());
  });

  afterEach(() => {
    cleanup();
    for (const epicId of [
      "epic-draft-veto",
      "epic-draft-no-veto",
      "epic-draft-cleared-to-empty",
      "epic-draft-retry",
      "epic-draft-unmount-withdraw",
      "epic-draft-two-holders",
    ]) {
      useEpicCanvasStore.getState().closeTab(epicId);
    }
    __syncEpicParkingOpenTabsForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicRuntimeWorkerFactoryForTests(workerFactoryBeforeTest);
    resetCanvasStore();
    resetAuth("signed-out", null);
    hostBindingRef.value = null;
    resetHostConnectionRegistryForTest();
    setDesktopEpicOwnershipBridge(null);
    __resetEpicParkingForTests();
    __resetEpicDraftGuardForTests();
    __resetAgentActivityStoreForTests();
    vi.useRealTimers();
  });

  it("preserves the setup worker after this file's mocks are installed", () => {
    expect(setupWorkerFactory).not.toBeNull();
  });

  it("text typed just before the park window vetoes the park, and the text survives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const EPIC_ID = "epic-draft-veto";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB={false}
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply A");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
    });

    const editor = screen.getByLabelText("Reply A");
    await user.click(editor);
    await user.type(editor, "unsent draft text");
    expect(screen.getByLabelText("Reply A").textContent).toContain(
      "unsent draft text",
    );

    // Well past the window - the veto must hold, not merely delay it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(isEpicParked(EPIC_ID)).toBe(false);
    expect(__getOpenEpicRegistryForTests().get(EPIC_ID)).not.toBeNull();
    expect(screen.getByLabelText("Reply A").textContent).toContain(
      "unsent draft text",
    );

    act(() => {
      setEpicSurfaceVisibility(EPIC_ID, EPIC_ID, true);
    });
    expect(screen.getByLabelText("Reply A").textContent).toContain(
      "unsent draft text",
    );
  });

  it("with no unsaved text, the epic parks normally at the window (negative control)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const EPIC_ID = "epic-draft-no-veto";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB={false}
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply A");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(EPIC_ID)).toBeNull();
  });

  it("text typed then deleted back to empty does not veto the park (negative control, via !isEmpty)", async () => {
    // Distinct from the "nothing typed" negative control above: that arm
    // proves an epic that never held a draft still parks; this one proves
    // the veto is WITHDRAWN once held text is emptied out - the
    // `hasUserEdits && !isEmpty` gate falling back to false through its
    // `!isEmpty` clause specifically, which `reset()` (arm 3) never
    // exercises since it clears `hasUserEdits` directly.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const EPIC_ID = "epic-draft-cleared-to-empty";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB={false}
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply A");

    const editor = screen.getByLabelText("Reply A");
    await user.click(editor);
    await user.type(editor, "draft text");
    expect(editor.textContent).toContain("draft text");

    // Select all and delete, through the editor itself - not `reset()` -
    // so this genuinely exercises `onUpdate`/`isEmpty`, not the imperative
    // handle's own `setHasUserEdits(false)`.
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(screen.getByLabelText("Reply A").textContent).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(EPIC_ID)).toBeNull();
  });

  it("a park refused for a draft retries and succeeds once the draft is cleared, without a new hide edge", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const EPIC_ID = "epic-draft-retry";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB={false}
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply A");

    const editor = screen.getByLabelText("Reply A");
    await user.click(editor);
    await user.type(editor, "draft");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    // Clear the draft the way production does on a successful submit - the
    // composer's imperative `reset()` handle - without touching visibility
    // again. The park must land synchronously inside this `act`.
    act(() => {
      refA.current?.reset();
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("a composer that unmounts without submitting withdraws its hold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const EPIC_ID = "epic-draft-unmount-withdraw";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    const view = render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB={false}
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply A");

    const editor = screen.getByLabelText("Reply A");
    await user.click(editor);
    await user.type(editor, "draft");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    // Unmount the composer WITHOUT submitting - no `reset()`, no onSubmit.
    act(() => {
      view.rerender(
        <Harness
          epicId={EPIC_ID}
          showA={false}
          showB={false}
          refA={refA}
          refB={refB}
          queryClient={queryClient}
        />,
      );
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("two composers on one epic are two independent holders", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const EPIC_ID = "epic-draft-two-holders";
    const refA = createRef<CommentComposerHandle | null>();
    const refB = createRef<CommentComposerHandle | null>();
    const queryClient = newQueryClient();

    const view = render(
      <Harness
        epicId={EPIC_ID}
        showA
        showB
        refA={refA}
        refB={refB}
        queryClient={queryClient}
      />,
    );
    await openHiddenTabOnceReady(EPIC_ID, "Reply B");

    const editorA = screen.getByLabelText("Reply A");
    await user.click(editorA);
    await user.type(editorA, "draft a");
    const editorB = screen.getByLabelText("Reply B");
    await user.click(editorB);
    await user.type(editorB, "draft b");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    // Unmount only A. A `draftId` derived from the epic (rather than
    // `useId()`) would let A's cleanup withdraw B's claim too - this is the
    // arm that would catch that.
    act(() => {
      view.rerender(
        <Harness
          epicId={EPIC_ID}
          showA={false}
          showB
          refA={refA}
          refB={refB}
          queryClient={queryClient}
        />,
      );
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    act(() => {
      view.rerender(
        <Harness
          epicId={EPIC_ID}
          showA={false}
          showB={false}
          refA={refA}
          refB={refB}
          queryClient={queryClient}
        />,
      );
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });
});

describe("epic-draft-guard aggregate transitions", () => {
  afterEach(() => {
    __resetEpicDraftGuardForTests();
  });

  it("notifies only on the epic's 0->1 and 1->0 holder transitions", () => {
    const EPIC_ID = "epic-guard-unit";
    const notifications: string[] = [];
    const unsubscribe = subscribeEpicDraftGuard((epicId) => {
      notifications.push(epicId);
    });

    expect(epicHoldsUnsavedDraft(EPIC_ID)).toBe(false);

    setEpicDraftHeld(EPIC_ID, "draft-a", true);
    expect(epicHoldsUnsavedDraft(EPIC_ID)).toBe(true);
    expect(notifications).toEqual([EPIC_ID]);

    // A second holder on the same epic changes nothing about the epic's
    // aggregate answer, so it must not notify again.
    setEpicDraftHeld(EPIC_ID, "draft-b", true);
    expect(notifications).toEqual([EPIC_ID]);

    // Withdrawing one of two holders leaves the epic still holding.
    setEpicDraftHeld(EPIC_ID, "draft-a", false);
    expect(epicHoldsUnsavedDraft(EPIC_ID)).toBe(true);
    expect(notifications).toEqual([EPIC_ID]);

    // Withdrawing the last holder flips the aggregate and notifies once more.
    setEpicDraftHeld(EPIC_ID, "draft-b", false);
    expect(epicHoldsUnsavedDraft(EPIC_ID)).toBe(false);
    expect(notifications).toEqual([EPIC_ID, EPIC_ID]);

    unsubscribe();
  });

  it("withdrawing a claim that was never made is a no-op", () => {
    const EPIC_ID = "epic-guard-unit-noop";
    const notifications: string[] = [];
    const unsubscribe = subscribeEpicDraftGuard((epicId) => {
      notifications.push(epicId);
    });

    setEpicDraftHeld(EPIC_ID, "never-held", false);
    expect(epicHoldsUnsavedDraft(EPIC_ID)).toBe(false);
    expect(notifications).toEqual([]);

    unsubscribe();
  });
});
