import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type {
  IPushPermissionHost,
  PushPermissionState,
} from "@traycer-clients/shared/platform/runner-host";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import { createAppQueryClient } from "@/lib/query-client";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

interface PushPermissionDouble {
  readonly host: IPushPermissionHost;
  readonly calls: {
    get: number;
    request: number;
    openSettings: number;
  };
  /** Move the OS's answer without telling the GUI - as the OS itself does. */
  readonly setState: (next: PushPermissionState) => void;
  /** The host's "this MAY have changed, re-read it" edge. */
  readonly fireChange: () => void;
  /** Lets a deferred `openSettings()` finish, ending the pending state. */
  readonly resolveOpenSettings: () => void;
}

/**
 * Stands in for the phone's `IPushPermissionHost`. It behaves like the OS in
 * the one way that matters here: `onChange` carries no state, so a subscriber
 * only learns the new value by asking again.
 */
function createPushPermissionDouble(options: {
  readonly initial: PushPermissionState;
  /** State `request()` resolves with, i.e. what the OS prompt returned. */
  readonly requestResolvesWith: PushPermissionState;
  readonly getRejectsWith: string | null;
  /**
   * Hold `openSettings()` unresolved until `resolveOpenSettings()`. Jumping to
   * the OS Settings app is the slowest thing this row does, so it is where the
   * pending UX actually shows up.
   */
  readonly deferOpenSettings: boolean;
}): PushPermissionDouble {
  const calls = { get: 0, request: 0, openSettings: 0 };
  const handlers = new Set<() => void>();
  let state = options.initial;
  let releaseOpenSettings: () => void = () => undefined;
  const openSettingsGate = new Promise<void>((resolve) => {
    releaseOpenSettings = resolve;
  });
  const host: IPushPermissionHost = {
    get: () => {
      calls.get += 1;
      if (options.getRejectsWith !== null) {
        return Promise.reject(new Error(options.getRejectsWith));
      }
      return Promise.resolve(state);
    },
    request: () => {
      calls.request += 1;
      state = options.requestResolvesWith;
      return Promise.resolve(state);
    },
    openSettings: () => {
      calls.openSettings += 1;
      if (options.deferOpenSettings) return openSettingsGate;
      return Promise.resolve();
    },
    onChange: (handler) => {
      handlers.add(handler);
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
  };
  return {
    host,
    calls,
    setState: (next) => {
      state = next;
    },
    fireChange: () => {
      for (const handler of handlers) handler();
    },
    resolveOpenSettings: () => {
      releaseOpenSettings();
    },
  };
}

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

function doubleFor(initial: PushPermissionState): PushPermissionDouble {
  return createPushPermissionDouble({
    initial,
    requestResolvesWith: initial,
    getRejectsWith: null,
    deferOpenSettings: false,
  });
}

afterEach(() => {
  cleanup();
});

describe("<PushPermissionSection />", () => {
  it("renders nothing where the shell has no OS push permission", () => {
    renderSection(null);

    expect(screen.queryByTestId("push-permission-section")).toBeNull();
    expect(screen.queryByText("This phone")).toBeNull();
  });

  it("reports a granted permission with no control to act on", async () => {
    const permission = doubleFor("granted");
    renderSection(permission.host);

    expect(await screen.findByText("On")).toBeTruthy();
    const section = screen.getByTestId("push-permission-section");
    expect(section.textContent).toContain("This phone");
    expect(section.textContent).toContain("Push notifications");
    expect(
      screen.getByText("Delivered to this phone when an agent needs you."),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "granted",
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
      screen.getByText(
        "Turned off for Traycer in system Settings. Turn them on to get buzzed when an agent needs you.",
      ),
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
      screen.getByText("Get buzzed when an agent needs you."),
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
        "Couldn't read this phone's notification setting. permission read failed",
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
      "granted",
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
    permission.fireChange();

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "granted",
    );
  });

  it("re-reads the OS on every mount, never serving a cached permission", async () => {
    // Built on the REAL app query client: its 60s `staleTime` is the whole
    // point. The `onChange` subscription is disposed while this row is
    // unmounted, so nothing invalidates in between - leave a person to change
    // the switch in the OS Settings app between two visits to Notifications
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
    permission.setState("granted");
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
});
