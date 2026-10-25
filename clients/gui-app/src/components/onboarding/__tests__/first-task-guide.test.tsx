import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentReviewEntryV12 } from "@traycer/protocol/host/environment-schemas";
import { reviewEntryFixture } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { FirstTaskLandingGuide } from "@/components/onboarding/first-task-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

const toastState = vi.hoisted(() => {
  let onDismiss: (() => void) | undefined;
  let onAction: (() => void) | undefined;
  const toast = Object.assign(
    vi.fn(
      (
        _message: string,
        options: {
          readonly description?: ReactNode;
          readonly action?: {
            readonly label: string;
            readonly onClick: () => void;
          };
          readonly onDismiss?: () => void;
        },
      ) => {
        onDismiss = options.onDismiss;
        onAction = options.action?.onClick;
      },
    ),
    {
      dismiss: vi.fn(() => onDismiss?.()),
      invokeDismiss: () => onDismiss?.(),
      invokeAction: (): void => onAction?.(),
      reset: () => {
        onDismiss = undefined;
        onAction = undefined;
      },
    },
  );
  return toast;
});

// The host directory is the boundary: which computer this is. Its reads stay
// real, over a fake host.
const thisComputer = vi.hoisted((): { current: ThisComputer } => ({
  current: { hostId: null, hostName: "this computer", client: null },
}));
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: (): ThisComputer => thisComputer.current,
}));

vi.mock("sonner", () => ({ toast: toastState }));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

function renderGuide(): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FirstTaskLandingGuide
        enabled
        rootRef={{ current: null }}
        workspaceFolders={null}
      />
    </QueryClientProvider>,
  );
}

/** This computer, with a fake host answering `environment.review` with `entries`. */
function computerHolding(entries: readonly EnvironmentReviewEntryV12[]): void {
  const { client } = buildEnvironmentClient({
    hostId: "old",
    handlers: {
      "environment.review": () => ({
        entries: [...entries],
        shownAt: null,
        acknowledgedAt: null,
        evidence: { version: null, at: null },
      }),
    },
  });
  recordNegotiatedHostManifest("old", {
    "environment.review": { major: 1, minor: 2 },
  });
  thisComputer.current = { hostId: "old", hostName: "Old laptop", client };
}

function held(
  overrides: Partial<EnvironmentReviewEntryV12>,
): EnvironmentReviewEntryV12 {
  return {
    ...reviewEntryFixture({}),
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    ...overrides,
  };
}

describe("FirstTaskLandingGuide getting-started toast", () => {
  beforeEach(() => {
    toastState.mockClear();
    toastState.dismiss.mockClear();
    toastState.reset();
    useFirstTaskGuideStore.setState({
      status: "inactive",
      imports: new Map(),
      workspaceReviewed: false,
    });
    useOnboardingStore.setState({
      completedAt: Date.now(),
      setupReminderDismissed: false,
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
    });
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    thisComputer.current = {
      hostId: null,
      hostName: "this computer",
      client: null,
    };
    useRetrospectiveSheetStore.setState({
      target: null,
      open: false,
      heldToastDismissed: false,
    });
    toastState.reset();
    useOnboardingStore.getState().reset();
    useFirstTaskGuideStore.getState().prepare();
  });

  it("dismisses only when the toast is dismissed while mounted", () => {
    const view = renderGuide();

    expect(toastState).toHaveBeenCalledOnce();
    const [message, options] = toastState.mock.calls[0];
    expect(message).toBe("You're all set");
    expect(render(options.description).container.textContent).toBe(
      "More setup is in Settings.",
    );
    expect(options.action?.label).toBe("Open");
    act(() => toastState.invokeDismiss());
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(true);

    void act(() =>
      useOnboardingStore.setState({ setupReminderDismissed: false }),
    );
    expect(toastState).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(toastState.dismiss).toHaveBeenCalledWith("traycer-getting-started");
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
  });

  it("replaces the setup reminder with a Review toast while this computer's earlier upload holds something", async () => {
    computerHolding([
      held({ reason: "executable_entry", kind: "mcp_server", key: "github" }),
    ]);
    renderGuide();

    await waitFor(() =>
      expect(toastState).toHaveBeenCalledWith(
        "An earlier version shared this computer's settings",
        expect.anything(),
      ),
    );
    // The toast waits for the review, so the reminder never shows first.
    expect(toastState).not.toHaveBeenCalledWith(
      "You're all set",
      expect.anything(),
    );
    const [, options] = toastState.mock.calls[toastState.mock.calls.length - 1];
    expect(render(options.description).container.textContent).toBe("Review");
    expect(options.action?.label).toBe("Open");

    act(() => toastState.invokeAction());
    expect(useRetrospectiveSheetStore.getState()).toMatchObject({
      open: true,
      target: { hostId: "old", hostName: "Old laptop" },
    });
  });

  it("keeps the setup reminder when nothing is on hold", async () => {
    computerHolding([held({ reason: "needs_grant" })]);
    renderGuide();

    await waitFor(() =>
      expect(toastState).toHaveBeenCalledWith(
        "You're all set",
        expect.anything(),
      ),
    );
    expect(toastState).not.toHaveBeenCalledWith(
      "An earlier version shared this computer's settings",
      expect.anything(),
    );
  });
});
