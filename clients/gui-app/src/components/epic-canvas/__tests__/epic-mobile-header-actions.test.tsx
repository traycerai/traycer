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
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
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
}));
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

  it("refuses the rename when a registered session has no serving client", async () => {
    session.registered = true;
    session.hasHostClient = false;
    renderWithQueryClient(
      <MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />,
    );
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    // The stamp went on THIS session's store, so dispatching app-wide would
    // rename whichever host the window is pointed at and then mark the
    // session's overlay landed for an ack it can never echo. `epicRenameClient`
    // refuses the same substitution on the wide viewport by returning null;
    // this is the mobile half of that contract, so the app-wide mutation must
    // stay untouched rather than serve as a fallback.
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
    expect(sessionRequest).not.toHaveBeenCalled();
    // Nothing can land the stamp, so it is dropped rather than left to expire.
    expect(retirePendingMutation).toHaveBeenCalledWith("req-1", "failed");
    await waitFor(() => {
      expect(reportableErrorToastSpy).toHaveBeenCalledTimes(1);
    });
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
    useMobileHeaderStore.getState().setRightActions(null);
  });

  it("fills the header slot on mobile and clears it on unmount", () => {
    holder.mobile = true;
    const { unmount } = render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActions).not.toBeNull();
    unmount();
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });

  it("does not fill the slot on desktop", () => {
    holder.mobile = false;
    render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });
});
