import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsEvent } from "@/lib/analytics";
import {
  EpicMobileSwitcherTrigger,
  MobileEpicHeaderActionsBinder,
  MobileEpicHeaderTitle,
} from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import {
  epicTabRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

interface RenameVariables {
  readonly epicDelta: {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  };
}

const holder = vi.hoisted(() => ({
  role: "owner",
  mobile: true,
}));
const mutateAsyncSpy = vi.hoisted(() =>
  vi.fn<(vars: RenameVariables) => Promise<void>>(),
);

/**
 * Default is NO session, which is what every pre-existing test in this file
 * runs under - the app-wide fallback path - so adding this seam leaves them
 * on the arm they were written against.
 */
const session = vi.hoisted(() => ({
  registered: false,
  /** A registered session whose serving client is momentarily gone. */
  hasHostClient: false,
  /**
   * The handle's stable transport binding. `null` is the cold-restore shape -
   * a registered session that never announced a host because the provider
   * that stamps identity is unmounted. No longer selects a routing ARM (there
   * is only one, post-T11: enqueue on the session's own store) - it is read
   * for the cloud-cache-update call only.
   */
  hostId: null as string | null,
}));
interface FakeWriteCommandResolution {
  readonly kind: "rejected";
  readonly reason: string;
}
interface FakeWriteCommandRecord {
  readonly state: "committed" | "rejected" | "superseded";
  readonly resolution: FakeWriteCommandResolution | null;
}
/**
 * The session store's write-command seam post-T11 (`enqueueWriteCommand` +
 * `waitForWriteCommand`), faked directly rather than backed by a real
 * `createOpenEpicStore` session: these tests are about WHICH requester a
 * registered session's rename reaches (session-scoped vs. app-wide), not
 * about the command queue's own lifecycle (FIFO ordering, dead-sweep
 * reconciliation, ...) - that is covered by `use-rename-canvas-tab.test.tsx`
 * and `use-switcher-rename.test.tsx`. A thin fake keeps the routing claim
 * legible without dragging in queue plumbing this file has no opinion about.
 */
const enqueueWriteCommand = vi.hoisted(() =>
  vi.fn<
    (intent: {
      readonly kind: string;
      readonly title: string;
      readonly updatedAt: number;
    }) => string | null
  >(() => "cmd-1"),
);
const waitForWriteCommand = vi.hoisted(() =>
  vi.fn<(commandId: string) => Promise<FakeWriteCommandRecord>>(() =>
    Promise.resolve({ state: "committed", resolution: null }),
  ),
);
const trackSpy = vi.hoisted(() =>
  vi.fn<(event: string, properties: unknown) => void>(),
);
const reportableErrorToastSpy = vi.hoisted(() =>
  vi.fn<(message: unknown, options: unknown, context: unknown) => void>(),
);

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => holder.mobile,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicPermissionRole: () => holder.role,
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ mutateAsync: mutateAsyncSpy, isPending: false }),
}));
// Whole-module, deliberately not a `...actual` partial: the component imports
// exactly these two, and a partial would quietly hand any export added later
// its real module-scoped registry.
vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: () => ({
    peek: () =>
      session.registered
        ? {
            store: {
              getState: () => ({
                enqueueWriteCommand,
                waitForWriteCommand,
              }),
            },
          }
        : null,
  }),
  getEpicSessionHandleHostClient: () =>
    session.hasHostClient
      ? {
          getActiveHostId: () => session.hostId ?? "host-b",
          getRequestContextUserId: () => "user-1",
        }
      : null,
}));
vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: reportableErrorToastSpy,
}));
// Only the SINGLETON is replaced. `AnalyticsEvent` stays the real enum on
// purpose: asserting against a literal the test invented would keep passing
// if the shipped member changed, which is the whole thing this test exists
// to pin.
vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, Analytics: { getInstance: () => ({ track: trackSpy }) } };
});

function openEdit(testId: string): HTMLElement {
  fireEvent.click(screen.getByTestId(testId));
  return screen.getByTestId(`${testId}-input`);
}

describe("<EpicMobileSwitcherTrigger />", () => {
  beforeEach(() => {
    useMobileSwitcherStore.setState({ openTabId: null });
  });
  afterEach(cleanup);

  it("opens the switcher store for its own tabId when tapped", () => {
    render(<EpicMobileSwitcherTrigger tabId="tab-1" />);
    const trigger = screen.getByTestId("mobile-epic-switcher-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("Switch tab");
    fireEvent.click(trigger);
    expect(useMobileSwitcherStore.getState().openTabId).toBe("tab-1");
  });

  it("renders for a viewer role too - switching tabs is not permission-gated", () => {
    holder.role = "viewer";
    render(<EpicMobileSwitcherTrigger tabId="tab-1" />);
    expect(screen.getByTestId("mobile-epic-switcher-trigger")).toBeTruthy();
    holder.role = "owner";
  });
});

/**
 * `MobileEpicHeaderTitle` reads `useQueryClient()` for the session-host
 * success arm's cloud-cache patch, so it must render under a provider - the
 * mocked mutation hook used to hide that dependency.
 */
function renderWithQueryClient(element: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      {element}
    </QueryClientProvider>,
  );
}

describe("<MobileEpicHeaderTitle />", () => {
  beforeEach(() => {
    holder.role = "owner";
    mutateAsyncSpy.mockClear();
    mutateAsyncSpy.mockResolvedValue(undefined);
    session.registered = false;
    session.hasHostClient = false;
    session.hostId = null;
    enqueueWriteCommand.mockClear();
    enqueueWriteCommand.mockReturnValue("cmd-1");
    waitForWriteCommand.mockClear();
    waitForWriteCommand.mockResolvedValue({
      state: "committed",
      resolution: null,
    });
    trackSpy.mockClear();
    reportableErrorToastSpy.mockClear();
  });
  afterEach(cleanup);

  it("renders the epic title as an editable control for an editor", () => {
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const title = screen.getByTestId("mobile-epic-header-title");
    expect(title.tagName).toBe("BUTTON");
    expect(title.textContent).toBe("My Epic");
  });

  it("commits a new title via the epic title mutation", async () => {
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    const variables = mutateAsyncSpy.mock.calls[0][0];
    expect(variables.epicDelta.id).toBe("epic-1");
    expect(variables.epicDelta.title).toBe("Renamed epic");
    // Flush the retire `.then` arms so no unhandled-promise warning bleeds
    // into the next test - there is no session registered under "epic-1"
    // here, so the retire itself is a no-op, but the promise still settles.
    await Promise.resolve();
  });

  it("Escape cancels the edit without committing", () => {
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-epic-header-title").textContent).toBe(
      "My Epic",
    );
  });

  it("an empty commit keeps the previous title and does not mutate", () => {
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-epic-header-title").textContent).toBe(
      "My Epic",
    );
  });

  it("records the rename analytics event on the session-host path", async () => {
    session.registered = true;
    session.hasHostClient = true;
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    expect(enqueueWriteCommand).toHaveBeenCalledTimes(1);
    const [[enqueuedRename]] = enqueueWriteCommand.mock.calls;
    expect(enqueuedRename.kind).toBe("update-epic-title");
    expect(enqueuedRename.title).toBe("Renamed epic");
    expect(typeof enqueuedRename.updatedAt).toBe("number");
    // Post-T11 this arm's success is `command.state === "committed"`,
    // resolved through `waitForWriteCommand` rather than an RPC promise this
    // component awaits directly - it still bypasses `useEpicUpdateTitle`'s
    // own `onSuccess`, which is the only other place the event is emitted.
    // It is also the NORMAL case - an epic with a live session - so losing
    // it here would zero out mobile rename analytics rather than dent them.
    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.TaskRenamed, {
        source: "direct_ui",
      });
    });
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
  });

  // Replaces "refuses the rename when the session names a host the app-wide
  // client is not on". Nothing refuses anymore - the host-comparison branch
  // that used to guard this was deleted at T11 (`0d4f8e1c`) because the
  // hazard it guarded against became unreachable by construction:
  // `epic-session-provider.tsx` resolves a registered session's
  // `commandRequester` for THAT session's own host
  // (`useHostClientForHostId(session?.hostId ?? targetHostId)`), so there is
  // no longer any path from a registered session to the app-wide client at
  // all. What replaces the refusal is the positive property it existed to
  // protect, asserted directly with the two requesters kept distinct
  // (`enqueueWriteCommand` vs. `mutateAsyncSpy`): a registered session's
  // rename reaches the session's own requester, and never the app-wide one -
  // pinned even under the exact host-mismatch shape the deleted branch used
  // to special-case, so a future regression that re-routes a registered
  // session's rename back through the app-wide mutation still fails here,
  // where the old test could only ever have caught a broken comparison in
  // logic that no longer exists.
  // Scope note: this pins the COMPONENT's half - the rename is enqueued on
  // the session's own store and never on the app-wide mutation. The other
  // half, that the session's queue then sends on the session's host, is
  // `epic-session-provider`'s binding (`commandRequester:
  // useHostClientForHostId(session.hostId)`) and is pinned where that binding
  // lives. Naming this test for the whole property would claim coverage this
  // file does not provide.
  it("a registered session's rename is enqueued on the SESSION's own store, never through the app-wide mutation - even when the session names a different host", () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = "host-b";
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    expect(enqueueWriteCommand).toHaveBeenCalledTimes(1);
    const [[enqueuedRename]] = enqueueWriteCommand.mock.calls;
    expect(enqueuedRename.kind).toBe("update-epic-title");
    expect(enqueuedRename.title).toBe("Renamed epic");
    expect(typeof enqueuedRename.updatedAt).toBe("number");
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
  });

  // Replaces "still renames through the app-wide mutation when the session
  // names no host". Retargeted onto the guarantee that now delivers the
  // rename for EVERY registered session regardless of host shape: it
  // enqueues on its own store, never on the app-wide mutation.
  it("a registered session enqueues on its own store even when it announces no host (cold-restore)", () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = null;
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // The cold-restore shape: a registered session whose provider is
    // unmounted, so it never announced a host. There is no separate
    // app-wide arm to fall back to post-T11 - the session's own store still
    // enqueues.
    expect(enqueueWriteCommand).toHaveBeenCalledTimes(1);
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(reportableErrorToastSpy).not.toHaveBeenCalled();
  });

  // Replaces "still renames through the app-wide mutation when the session is
  // on that same host" - same retarget as above, different `hostId` shape.
  it("a registered session enqueues on its own store even when its host happens to match what an app-wide client would resolve to", () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = "host-a";
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    expect(enqueueWriteCommand).toHaveBeenCalledTimes(1);
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(reportableErrorToastSpy).not.toHaveBeenCalled();
  });

  it("still falls back to the app-wide mutation when no session is registered", () => {
    session.registered = false;
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // No handle means no stamp to strand, so this is a substitution of
    // nothing - it is all this surface ever had before sessions carried a
    // host, and the refusal above must not have swallowed it.
    expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(reportableErrorToastSpy).not.toHaveBeenCalled();
  });

  it("renders plain text for a viewer (no editable control)", () => {
    holder.role = "viewer";
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const title = screen.getByTestId("mobile-epic-header-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-epic-header-title-input")).toBeNull();
  });
});

describe("<MobileEpicHeaderActionsBinder />", () => {
  afterEach(() => {
    cleanup();
    holder.mobile = true;
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
  });

  it("registers its tab's entry on mobile and unregisters it on unmount", () => {
    holder.mobile = true;
    const { unmount } = render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(
      useMobileHeaderStore
        .getState()
        .rightActionEntries.get(epicTabRightActionsKey("tab-1")),
    ).not.toBeUndefined();
    unmount();
    expect(useMobileHeaderStore.getState().rightActionEntries.size).toBe(0);
  });

  it("registers nothing on desktop", () => {
    holder.mobile = false;
    render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActionEntries.size).toBe(0);
  });

  // Launching a task hands the header from the start page to the epic the
  // launch created, and the two halves of that handoff are not ordered: the
  // start page's terminal panel follows its pane anchor, so it is torn down a
  // commit after this binder has already registered. Teardowns on other keys
  // cannot touch this tab's entry.
  it("keeps its entry when another surface unregisters afterwards", () => {
    holder.mobile = true;
    useMobileHeaderStore
      .getState()
      .registerRightActions("landing-terminal", <button type="button" />);
    render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    const key = epicTabRightActionsKey("tab-1");
    const registered = useMobileHeaderStore
      .getState()
      .rightActionEntries.get(key);
    expect(registered).not.toBeUndefined();

    useMobileHeaderStore.getState().unregisterRightActions("landing-terminal");

    expect(useMobileHeaderStore.getState().rightActionEntries.get(key)).toBe(
      registered,
    );
  });
});
