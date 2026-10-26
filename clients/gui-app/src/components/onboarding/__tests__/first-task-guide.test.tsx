import { useState, type ReactNode } from "react";
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
import type {
  EnvironmentReviewEntryV12,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { reviewEntryFixture } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { FirstTaskLandingGuide } from "@/components/onboarding/first-task-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";

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
  return mountGuide().view;
}

function mountGuide(): {
  readonly view: RenderResult;
  readonly queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <FirstTaskLandingGuide
        enabled
        rootRef={{ current: null }}
        workspaceFolders={null}
      />
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

function mountGuideWithLifecycleBridge(): {
  readonly view: RenderResult;
  readonly hideGuide: () => void;
} {
  let setGuideVisible: (visible: boolean) => void = () => undefined;
  function LifecycleGuide(): ReactNode {
    const [visible, setVisible] = useState(true);
    setGuideVisible = setVisible;
    return (
      <EpicSessionLifecycleBridge>
        {visible ? (
          <FirstTaskLandingGuide
            enabled
            rootRef={{ current: null }}
            workspaceFolders={null}
          />
        ) : null}
      </EpicSessionLifecycleBridge>
    );
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LifecycleGuide />
    </QueryClientProvider>,
  );
  return { view, hideGuide: () => setGuideVisible(false) };
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

/** This computer, with a fake host answering `environment.status` with `status`. */
function computerWithStatus(status: EnvironmentStatusResponseV11): void {
  const { client } = buildEnvironmentClient({
    hostId: "old",
    handlers: {
      "environment.review": () => ({
        entries: [],
        shownAt: null,
        acknowledgedAt: null,
        evidence: { version: null, at: null },
      }),
      "environment.status": () => status,
    },
  });
  recordNegotiatedHostManifest("old", {
    "environment.review": { major: 1, minor: 2 },
    "environment.status": { major: 1, minor: 1 },
  });
  thisComputer.current = { hostId: "old", hostName: "Old laptop", client };
}

/**
 * This computer, whose `environment.status` answers `status` once and then
 * fails. `statusReads` counts the reads the host has been asked.
 */
function computerWhoseStatusFailsAfterOneRead(
  status: EnvironmentStatusResponseV11,
): { readonly statusReads: () => number } {
  let reads = 0;
  const { client } = buildEnvironmentClient({
    hostId: "old",
    handlers: {
      "environment.review": () => ({
        entries: [],
        shownAt: null,
        acknowledgedAt: null,
        evidence: { version: null, at: null },
      }),
      "environment.status": () => {
        reads += 1;
        if (reads > 1) throw new Error("status read failed");
        return status;
      },
    },
  });
  recordNegotiatedHostManifest("old", {
    "environment.review": { major: 1, minor: 2 },
    "environment.status": { major: 1, minor: 1 },
  });
  thisComputer.current = { hostId: "old", hostName: "Old laptop", client };
  return { statusReads: () => reads };
}

const NOT_MOVED_STATUS = environmentStatusFixture({
  planes: { records: "local", broker: "local", room: "local" },
  consent: null,
  pendingUploads: [],
});

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
    useMoveSheetStore.setState({ target: null });
    toastState.reset();
    useOnboardingStore.getState().reset();
    useFirstTaskGuideStore.getState().prepare();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
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

  it("says this computer's settings are not in Personal, and the action opens its move sheet", async () => {
    computerWithStatus(
      environmentStatusFixture({
        planes: { records: "local", broker: "local", room: "local" },
        consent: null,
        pendingUploads: [],
      }),
    );
    renderGuide();

    await waitFor(() =>
      expect(toastState).toHaveBeenCalledWith(
        "This computer's settings aren't in Personal.",
        expect.anything(),
      ),
    );
    expect(toastState).not.toHaveBeenCalledWith(
      "You're all set",
      expect.anything(),
    );
    const [, options] = toastState.mock.calls[toastState.mock.calls.length - 1];
    expect(render(options.description).container.textContent).toBe(
      "Move them to use them everywhere",
    );
    expect(options.action?.label).toBe("Show me what moves");

    act(() => toastState.invokeAction());
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("keeps the setup reminder once this computer's settings are in Personal", async () => {
    computerWithStatus(environmentStatusFixture({}));
    renderGuide();

    await waitFor(() =>
      expect(toastState).toHaveBeenCalledWith(
        "You're all set",
        expect.anything(),
      ),
    );
    expect(toastState).not.toHaveBeenCalledWith(
      "This computer's settings aren't in Personal.",
      expect.anything(),
    );
  });

  describe("the move toast", () => {
    const MOVE_TOAST = "This computer's settings aren't in Personal.";

    async function mountedMoveToast(): Promise<RenderResult> {
      computerWithStatus(NOT_MOVED_STATUS);
      const mounted = mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );
      return mounted.view;
    }

    it("stays shown when a later read of the status fails", async () => {
      const host = computerWhoseStatusFailsAfterOneRead(NOT_MOVED_STATUS);
      const { queryClient } = mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );

      await act(async () => {
        await queryClient.refetchQueries();
      });
      await waitFor(() => expect(host.statusReads()).toBeGreaterThan(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(toastState.dismiss).not.toHaveBeenCalled();
      expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
    });

    it("is not dismissed when the guide unmounts", async () => {
      const view = await mountedMoveToast();

      view.unmount();

      expect(toastState.dismiss).not.toHaveBeenCalled();
    });

    it("records its dismissal when × is pressed after the guide unmounted", async () => {
      const view = await mountedMoveToast();
      view.unmount();

      act(() => toastState.invokeDismiss());

      expect(useOnboardingStore.getState().setupReminderDismissed).toBe(true);
    });

    it("retires the reminder and invalidates its retained action on sign-out after navigation", async () => {
      computerWithStatus(NOT_MOVED_STATUS);
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: "user-a",
          userName: "alice@example.test",
          email: "alice@example.test",
        },
        contextMetadata: {
          userId: "user-a",
          username: "alice@example.test",
        },
      });
      const { view, hideGuide } = mountGuideWithLifecycleBridge();

      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(
          "This computer's settings aren't in Personal.",
          expect.anything(),
        ),
      );
      act(() => hideGuide());
      expect(toastState.dismiss).not.toHaveBeenCalled();

      act(() => {
        useAuthStore.setState({
          status: "signed-out",
          profile: null,
          contextMetadata: null,
        });
      });
      await waitFor(() =>
        expect(toastState.dismiss).toHaveBeenCalledWith(
          "traycer-getting-started",
        ),
      );

      act(() => toastState.invokeAction());
      expect(useMoveSheetStore.getState().target).toBeNull();
      expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
      view.unmount();
    });
  });
});
