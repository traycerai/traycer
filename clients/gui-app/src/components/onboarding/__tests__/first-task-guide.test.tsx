import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { FirstTaskLandingGuide } from "@/components/onboarding/first-task-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

const toastState = vi.hoisted(() => {
  let onDismiss: (() => void) | undefined;
  const toast = Object.assign(
    vi.fn((_message: string, options: { readonly onDismiss?: () => void }) => {
      onDismiss = options.onDismiss;
    }),
    {
      dismiss: vi.fn(() => onDismiss?.()),
      invokeDismiss: () => onDismiss?.(),
      reset: () => {
        onDismiss = undefined;
      },
    },
  );
  return toast;
});

vi.mock("sonner", () => ({ toast: toastState }));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

describe("FirstTaskLandingGuide getting-started toast", () => {
  beforeEach(() => {
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
    toastState.reset();
    useOnboardingStore.getState().reset();
    useFirstTaskGuideStore.getState().prepare();
  });

  it("dismisses only when the toast is dismissed while mounted", () => {
    const view = render(
      <FirstTaskLandingGuide
        enabled
        rootRef={{ current: null }}
        workspaceFolders={null}
      />,
    );

    expect(toastState).toHaveBeenCalledOnce();
    act(() => toastState.invokeDismiss());
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(true);

    void act(() => useOnboardingStore.setState({ setupReminderDismissed: false }));
    expect(toastState).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(toastState.dismiss).toHaveBeenCalledWith("traycer-getting-started");
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
  });
});
