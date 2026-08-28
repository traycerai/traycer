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
 * The three states this control routes on. Default is NO session, which is
 * what every pre-existing test in this file runs under - the app-wide
 * fallback path - so adding this seam leaves them on the arm they were
 * written against.
 */
const session = vi.hoisted(() => ({
  registered: false,
  /** A registered session whose serving client is momentarily gone. */
  hasHostClient: false,
  /**
   * The handle's stable transport binding. `null` is the cold-restore shape -
   * a registered session that never announced a host because the provider
   * that stamps identity is unmounted - and it is NOT interchangeable with a
   * named host: only a named host that differs from the app-wide one makes an
   * app-wide dispatch a request swap.
   */
  hostId: null as string | null,
}));
const appWideHostId = vi.hoisted(() => ({ value: "host-a" as string | null }));
const beginEpicTitleMutation = vi.hoisted(() =>
  vi.fn<(title: string) => string>(() => "req-1"),
);
const retirePendingMutation = vi.hoisted(() =>
  vi.fn<(requestId: string, outcome: "landed" | "failed") => void>(),
);
const sessionRequest = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
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
                beginEpicTitleMutation,
                retirePendingMutation,
              }),
            },
          }
        : null,
  }),
  getEpicSessionHandleHostClient: () =>
    session.hasHostClient
      ? {
          getActiveHostId: () => "host-b",
          getRequestContextUserId: () => "user-1",
          request: sessionRequest,
        }
      : null,
  getEpicSessionHandleHostId: () => session.hostId,
}));
vi.mock("@/lib/host/runtime", () => ({
  getAppHostClientSnapshot: () =>
    appWideHostId.value === null
      ? null
      : { getActiveHostId: () => appWideHostId.value },
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
    appWideHostId.value = "host-a";
    beginEpicTitleMutation.mockClear();
    retirePendingMutation.mockClear();
    sessionRequest.mockClear();
    sessionRequest.mockResolvedValue(undefined);
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
    expect(sessionRequest).toHaveBeenCalledTimes(1);
    // This arm issues the RPC itself and so never runs `useEpicUpdateTitle`'s
    // `onSuccess`, which is the only other place the event is emitted. It is
    // also the NORMAL case - an epic with a live session - so losing it here
    // would zero out mobile rename analytics rather than dent them.
    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.TaskRenamed, {
        source: "direct_ui",
      });
    });
    expect(retirePendingMutation).toHaveBeenCalledWith("req-1", "landed");
  });

  it("refuses the rename when the session names a host the app-wide client is not on", async () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = "host-b";
    appWideHostId.value = "host-a";
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // The stamp went on THIS session's store, so dispatching to host-a would
    // rename the wrong machine's copy and then mark the session's overlay
    // landed for an ack it can never echo. `epicRenameClient` refuses the same
    // substitution on the wide viewport; this is the mobile half of it, so the
    // app-wide mutation must stay untouched rather than serve as a fallback.
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(sessionRequest).not.toHaveBeenCalled();
    // Nothing can land the stamp, so it is dropped rather than left to expire.
    expect(retirePendingMutation).toHaveBeenCalledWith("req-1", "failed");
    await waitFor(() => {
      expect(reportableErrorToastSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("still renames through the app-wide mutation when the session names no host", () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = null;
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // The cold-restore shape: a registered session whose provider is unmounted,
    // so it never announced a host. There is no second host to swap TO, which
    // is why `epicRenameClient` hands the strip the app-wide client for a
    // `null` tab host rather than refusing. Refusing on client-absence alone
    // would break renaming on a restored mobile tab.
    expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(reportableErrorToastSpy).not.toHaveBeenCalled();
  });

  it("still renames through the app-wide mutation when the session is on that same host", () => {
    session.registered = true;
    session.hasHostClient = false;
    session.hostId = "host-a";
    appWideHostId.value = "host-a";
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // Same host, so the app-wide client already addresses the machine the
    // stamp is on - substituting it is not a request swap. This is
    // `epicRenameClient`'s `hostId === appClient.getActiveHostId()` branch.
    expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
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
