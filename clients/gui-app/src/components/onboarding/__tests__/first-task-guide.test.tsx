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
import { retireOnboardingReminder } from "@/lib/toast/onboarding-reminder-toast";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { FirstTaskLandingGuide } from "@/components/onboarding/first-task-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";

interface ToastButton {
  readonly label: string;
  readonly onClick: () => void;
}

/** The options this app passes `toast()`, as the double reads them back. */
interface ToastOptions {
  readonly id: string | undefined;
  readonly description: ReactNode | undefined;
  readonly action: ToastButton | undefined;
  readonly cancel: ToastButton | undefined;
  readonly onDismiss: (() => void) | undefined;
}

const toastState = vi.hoisted(() => {
  let onDismiss: (() => void) | undefined;
  let onAction: (() => void) | undefined;
  /** The options each toast was last shown under, by the id it carries. */
  const byId = new Map<string, ToastOptions>();
  const toast = Object.assign(
    vi.fn((_message: string, options: ToastOptions) => {
      onDismiss = options.onDismiss;
      onAction = options.action?.onClick;
      if (options.id !== undefined) byId.set(options.id, options);
    }),
    {
      dismiss: vi.fn((id: string) => {
        const handler = byId.get(id)?.onDismiss ?? onDismiss;
        handler?.();
      }),
      invokeDismiss: () => onDismiss?.(),
      invokeAction: (): void => onAction?.(),
      /** The options of the toast shown under `id`, or `null` for none. */
      optionsFor: (id: string): ToastOptions | null => byId.get(id) ?? null,
      invokeActionFor: (id: string): void => {
        byId.get(id)?.action?.onClick();
      },
      invokeCancelFor: (id: string): void => {
        byId.get(id)?.cancel?.onClick();
      },
      reset: () => {
        onDismiss = undefined;
        onAction = undefined;
        byId.clear();
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
    // The app's own teardown: it is what clears an outstanding invitation,
    // which outlives any one mount by design.
    retireOnboardingReminder();
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
    // The verb is the toast's own action: `… · Review`, with no line of its
    // own repeating it.
    expect(options.description ?? null).toBeNull();
    expect(options.action?.label).toBe("Review");

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
    expect(options.cancel?.label).toBe("Not now");

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
    // The two toasts the Start page shows, each under its own id: the
    // invitation is not the setup reminder's other wording.
    const MOVE_INVITATION_TOAST_ID = "traycer-move-invitation";
    const SETUP_REMINDER_TOAST_ID = "traycer-getting-started";

    /**
     * This computer, whose `environment.status` answers whatever `answer`
     * holds: the move's own state as the host reports it over time.
     */
    function computerWhoseStatusChanges(
      answer: () => EnvironmentStatusResponseV11,
    ): void {
      const { client } = buildEnvironmentClient({
        hostId: "old",
        handlers: {
          "environment.review": () => ({
            entries: [],
            shownAt: null,
            acknowledgedAt: null,
            evidence: { version: null, at: null },
          }),
          "environment.status": () => answer(),
        },
      });
      recordNegotiatedHostManifest("old", {
        "environment.review": { major: 1, minor: 2 },
        "environment.status": { major: 1, minor: 1 },
      });
      thisComputer.current = { hostId: "old", hostName: "Old laptop", client };
    }

    it("carries its own id, so the setup reminder never stands in its place", async () => {
      computerWithStatus(NOT_MOVED_STATUS);
      mountGuide();

      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );

      expect(toastState.optionsFor(MOVE_INVITATION_TOAST_ID)).not.toBeNull();
      expect(toastState.optionsFor(SETUP_REMINDER_TOAST_ID)).toBeNull();
    });

    it("stays up when the status stops naming a move to make, pressed or × only", async () => {
      let answer = NOT_MOVED_STATUS;
      computerWhoseStatusChanges(() => answer);
      const { queryClient } = mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );
      toastState.dismiss.mockClear();

      // The read stops naming a move: an accepted move, a host swap, a
      // version without the planes. The invitation is nobody's to withdraw.
      answer = environmentStatusFixture({});
      await act(async () => {
        await queryClient.refetchQueries();
      });

      expect(toastState.dismiss).not.toHaveBeenCalledWith(
        MOVE_INVITATION_TOAST_ID,
      );
      expect(toastState).not.toHaveBeenCalledWith(
        "You're all set",
        expect.anything(),
      );
      // Its action still opens the sheet it named.
      act(() => toastState.invokeActionFor(MOVE_INVITATION_TOAST_ID));
      expect(useMoveSheetStore.getState().target).toEqual({
        hostId: "old",
        hostName: "Old laptop",
      });
    });

    it("records its dismissal when Not now is pressed", async () => {
      computerWithStatus(NOT_MOVED_STATUS);
      mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );

      act(() => toastState.invokeCancelFor(MOVE_INVITATION_TOAST_ID));

      expect(useOnboardingStore.getState().setupReminderDismissed).toBe(true);
    });

    it("is still the thing being asked when the Start page is left and comes back", async () => {
      // The invitation outlives this surface: the person leaves Start, the
      // move is accepted from the Getting started card or another window, and
      // they come back. The toast is still up, unanswered, so no reminder may
      // take its turn beside it.
      let answer = NOT_MOVED_STATUS;
      computerWhoseStatusChanges(() => answer);
      const first = mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );

      first.view.unmount();
      answer = environmentStatusFixture({});
      mountGuide();

      await waitFor(() =>
        expect(toastState.optionsFor(MOVE_INVITATION_TOAST_ID)).not.toBeNull(),
      );
      expect(toastState).not.toHaveBeenCalledWith(
        "You're all set",
        expect.anything(),
      );
    });

    it("stops the Start page nudging for good once the person answers it", async () => {
      // One dismissal covers the Start page, as it did when both wordings
      // shared one toast: Not now is an answer to being nudged here, not only
      // to the move, so the reminder does not take the invitation's turn.
      let answer = NOT_MOVED_STATUS;
      computerWhoseStatusChanges(() => answer);
      const { queryClient } = mountGuide();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );

      act(() => toastState.invokeCancelFor(MOVE_INVITATION_TOAST_ID));
      answer = environmentStatusFixture({});
      await act(async () => {
        await queryClient.refetchQueries();
      });

      expect(toastState).not.toHaveBeenCalledWith(
        "You're all set",
        expect.anything(),
      );
    });

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
          MOVE_INVITATION_TOAST_ID,
        ),
      );
      // Both ids go: the retire does not have to know which one was up.
      expect(toastState.dismiss).toHaveBeenCalledWith(SETUP_REMINDER_TOAST_ID);

      act(() => toastState.invokeAction());
      expect(useMoveSheetStore.getState().target).toBeNull();
      expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
      view.unmount();
    });

    it("lets the reminder show again for whoever signs in next", async () => {
      // The retire takes the invitation down without the person answering it,
      // so it also has to forget that one was outstanding. Left standing, the
      // next identity's Start page would hold its reminder back for ever,
      // waiting on an answer to a toast nobody can see.
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
      const { view } = mountGuideWithLifecycleBridge();
      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(MOVE_TOAST, expect.anything()),
      );
      act(() => {
        useAuthStore.setState({
          status: "signed-out",
          profile: null,
          contextMetadata: null,
        });
      });
      await waitFor(() =>
        expect(toastState.dismiss).toHaveBeenCalledWith(
          MOVE_INVITATION_TOAST_ID,
        ),
      );
      view.unmount();

      // Whoever signs in next is on a computer that has moved: no invitation
      // to make, so the reminder is the toast this Start page owes them.
      toastState.reset();
      toastState.mockClear();
      computerWithStatus(environmentStatusFixture({}));
      mountGuide();

      await waitFor(() =>
        expect(toastState).toHaveBeenCalledWith(
          "You're all set",
          expect.anything(),
        ),
      );
    });
  });
});
