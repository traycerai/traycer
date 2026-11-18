import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPushPermissionHost } from "@traycer-clients/shared/platform/runner-host";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import {
  createPushPermissionDouble,
  doubleFor,
} from "./push-permission-double";
import { createAppQueryClient } from "@/lib/query-client";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import {
  MobilePushRegistration,
  type CapacitorPushPermissionState,
  type PushNotificationsPluginSlice,
  type PushRegistrationToken,
} from "../../../../../../mobile/src/push-registration";

function renderSectionWith(
  pushPermission: IPushPermissionHost | null,
  queryClient: QueryClient,
): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ pushPermission })}>
        <PushPermissionSection />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function renderSection(
  pushPermission: IPushPermissionHost | null,
): RenderResult {
  return renderSectionWith(
    pushPermission,
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("<PushPermissionSection />", () => {
  // A host-less shell has no runner host at all, and every hook the group
  // uses reaches for one — so the gate has to return before any of them run.
  it("renders nothing, and does not throw, with no runner host above it", () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <PushPermissionSection />
      </QueryClientProvider>,
    );

    expect(view.container.innerHTML).toBe("");
  });

  it("renders nothing where the shell has no OS push permission", () => {
    renderSection(null);

    expect(screen.queryByText("Push notifications")).toBeNull();
    expect(screen.queryByTestId("push-permission-state")).toBeNull();
  });

  it("reports a granted permission with no control to act on", async () => {
    const permission = doubleFor("granted");
    renderSection(permission.host);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByText("Push notifications")).toBeTruthy();
    expect(
      screen.getByText("Only the kinds turned on below are sent."),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "registered",
    );
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("names system Settings as the repair when the OS has refused", async () => {
    const permission = doubleFor("denied");
    renderSection(permission.host);

    const action = await screen.findByRole("button", {
      name: "Open Settings",
    });
    expect(action.dataset.testid).toBe("push-permission-action");
    expect(
      screen.getByText("Turned off for Traycer in system Settings."),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "denied",
    );
    expect(screen.queryByText("On")).toBeNull();
  });

  it("offers the prompt itself while the OS still allows one", async () => {
    const permission = doubleFor("prompt");
    renderSection(permission.host);

    const action = await screen.findByRole("button", { name: "Enable" });
    expect(action.dataset.testid).toBe("push-permission-action");
    expect(
      screen.getByText("Allow Traycer to send push notifications."),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "prompt",
    );
  });

  it("shows the read failure instead of guessing a state", async () => {
    const permission = createPushPermissionDouble({
      initial: "denied",
      requestResolvesWith: "denied",
      getRejectsWith: "permission read failed",
      deferOpenSettings: false,
    });
    renderSection(permission.host);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "error",
      );
    });
    expect(
      screen.getByText(
        "Couldn't read the notification permission. permission read failed",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("opens the OS notification page exactly once per tap", async () => {
    const permission = doubleFor("denied");
    renderSection(permission.host);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );

    await waitFor(() => {
      expect(permission.calls.openSettings).toBe(1);
    });
    expect(permission.calls.request).toBe(0);
  });

  it("re-reads after a granted prompt rather than trusting the button", async () => {
    const permission = createPushPermissionDouble({
      initial: "prompt",
      requestResolvesWith: "granted",
      getRejectsWith: null,
      deferOpenSettings: false,
    });
    renderSection(permission.host);

    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() => {
      expect(permission.calls.request).toBe(1);
    });
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "registered",
    );
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("follows a permission changed outside the app, with nothing tapped here", async () => {
    // The whole point of Fix B's `onChange`: the person leaves for the OS
    // Settings app, flips the switch, and comes back. Nothing in this GUI was
    // touched, and the row must not still say the app is muted.
    const permission = doubleFor("denied");
    renderSection(permission.host);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "denied",
      );
    });

    permission.setState("granted");
    permission.setRegistration("registered");
    permission.fireChange();

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "registered",
    );
  });

  it("re-reads the OS on every mount, never serving a cached permission", async () => {
    // Built on the REAL app query client: its 60s `staleTime` is the whole
    // point. The `onChange` subscription is disposed while this row is
    // unmounted, so nothing invalidates in between - leave a person to change
    // the switch in the OS Settings app between two visits to Alerts
    // and a cached answer would show them "Off · Open Settings" on a phone
    // where push is already on.
    const permission = doubleFor("denied");
    const queryClient = createAppQueryClient();

    const first = renderSectionWith(permission.host, queryClient);
    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "denied",
      );
    });
    first.unmount();

    // The OS moves with no one listening, and nothing fires `onChange`.
    // Registration has caught up by the time Alerts is opened again.
    permission.setState("granted");
    permission.setRegistration("registered");
    const readsBeforeRemount = permission.calls.get;

    renderSectionWith(permission.host, queryClient);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(permission.calls.get).toBeGreaterThan(readsBeforeRemount);
  });

  it("holds the action disabled, labelled, and spinning while it is in flight", async () => {
    const permission = createPushPermissionDouble({
      initial: "denied",
      requestResolvesWith: "denied",
      getRejectsWith: null,
      deferOpenSettings: true,
    });
    renderSection(permission.host);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );

    // Pending UX per AGENTS.md: disabled, the SAME label (never "Opening…"),
    // and an inline spinner - so the button is still findable by its name.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Open Settings/ })
          .hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(screen.getByTestId("push-permission-action-spinner")).toBeTruthy();

    permission.resolveOpenSettings();

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Open Settings/ })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.queryByTestId("push-permission-action-spinner")).toBeNull();
  });

  it("shows the setup spinner while registration is still pending", async () => {
    const permission = createPushPermissionDouble({
      initial: "granted",
      requestResolvesWith: "granted",
      getRejectsWith: null,
      deferOpenSettings: false,
      registration: "pending",
    });
    renderSection(permission.host);

    expect(await screen.findByTestId("push-registration-pending")).toBeTruthy();
    expect(
      screen.getByText("Setting up push notifications\u2026"),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "pending",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("On")).toBeNull();
  });

  it("shows a failed registration and Retry, then the spinner while Retry is in flight", async () => {
    const permission = createPushPermissionDouble({
      initial: "granted",
      requestResolvesWith: "granted",
      getRejectsWith: null,
      deferOpenSettings: false,
      registration: "failed",
      holdRetry: true,
    });
    renderSection(permission.host);

    expect(
      await screen.findByText(
        "Push notifications couldn\u2019t be set up. Try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "failed",
    );
    expect(screen.getByTestId("push-permission-action").textContent).toContain(
      "Retry",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("push-registration-pending")).toBeTruthy();
    expect(
      screen.getByText("Setting up push notifications\u2026"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(permission.calls.retry).toBe(1);

    act(() => {
      permission.finishRetry("registered");
    });

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "registered",
    );
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });
});

function signInAs(userId: string): void {
  act(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId, userName: userId, email: `${userId}@example.com` },
        { userId, username: userId },
        [],
      );
  });
}

/**
 * The slice the row's phone stands in for. `register()` can be held so the
 * row is readable while Retry has asked the provider and is waiting for the
 * token callback.
 */
class RowRegistrationPlugin implements PushNotificationsPluginSlice {
  permission: CapacitorPushPermissionState = "granted";
  private registration: ((token: PushRegistrationToken) => void) | null = null;
  private holdRegister = false;
  private releaseRegister: () => void = () => undefined;

  readonly checkPermissions = vi.fn(() =>
    Promise.resolve({
      receive: this.permission,
    }),
  );
  readonly requestPermissions = vi.fn(() =>
    Promise.resolve({
      receive: this.permission,
    }),
  );
  readonly register = vi.fn(async () => {
    if (!this.holdRegister) return;
    await new Promise<void>((resolve) => {
      this.releaseRegister = resolve;
    });
  });

  holdNextRegister(): void {
    this.holdRegister = true;
  }

  releaseRegisterHold(): void {
    this.holdRegister = false;
    this.releaseRegister();
  }

  emitRegistration(token: string): void {
    this.registration?.({ value: token });
  }

  addListener(
    eventName: "registration",
    listener: (token: PushRegistrationToken) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "registrationError",
    listener: (error: { readonly error: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "pushNotificationActionPerformed",
    listener: (action: {
      readonly actionId: string;
      readonly notification: { readonly data: unknown };
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: string,
    listener:
      | ((token: PushRegistrationToken) => void)
      | ((error: { readonly error: string }) => void)
      | ((action: {
          readonly actionId: string;
          readonly notification: { readonly data: unknown };
        }) => void),
  ): Promise<{ remove: () => Promise<void> }> {
    if (eventName === "registration") {
      this.registration = listener as (token: PushRegistrationToken) => void;
    }
    return Promise.resolve({ remove: () => Promise.resolve() });
  }
}

function hostForRegistration(
  push: MobilePushRegistration,
): IPushPermissionHost {
  return {
    get: () => push.permissionState(),
    getRegistrationState: () => push.registrationState(),
    retryRegistration: () => push.retryRegistration(),
    request: () => push.requestPermission(),
    openSettings: () => Promise.resolve(),
    getMutedSeverities: () => push.getMutedSeverities(),
    setMutedSeverities: (set) => push.setMutedSeverities(set),
    onChange: (handler) => {
      const registration = push.onRegistrationChange(handler);
      return {
        dispose: () => {
          registration.dispose();
        },
      };
    },
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("PushPermissionSection wired to MobilePushRegistration", () => {
  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("shows a failed registration, and Retry reaches On after the token is accepted", async () => {
    signInAs("user-1");
    const plugin = new RowRegistrationPlugin();
    let uploads = 0;
    const push = new MobilePushRegistration({
      plugin,
      authnBaseUrl: "http://localhost:32350",
      platform: "ios",
      environment: "sandbox",
      registerToken: () => {
        uploads += 1;
        return Promise.resolve(
          uploads === 1 ? { kind: "network-error" } : { kind: "ok" },
        );
      },
      removeToken: () => Promise.resolve({ kind: "ok" }),
    });
    push.start(
      {
        get: () =>
          Promise.resolve({
            token: "bearer-1",
            refreshToken: "refresh-1",
            savedAt: "2026-08-05T00:00:00.000Z",
            user: { id: "user-1", email: "dev@traycer.ai", name: "Dev" },
          }),
        subscribe: () => ({ dispose: () => undefined }),
      },
      { onSystemResumed: () => ({ dispose: () => undefined }) },
    );
    await drain();
    plugin.emitRegistration("apns-token-1");
    await drain();
    expect(push.registrationState()).toBe("failed");

    renderSection(hostForRegistration(push));

    expect(
      await screen.findByText(
        "Push notifications couldn\u2019t be set up. Try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "failed",
    );

    plugin.holdNextRegister();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("push-registration-pending")).toBeTruthy();
    expect(
      screen.getByText("Setting up push notifications\u2026"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    plugin.releaseRegisterHold();
    plugin.emitRegistration("apns-token-1");

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "registered",
    );
    expect(uploads).toBe(2);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });
});
