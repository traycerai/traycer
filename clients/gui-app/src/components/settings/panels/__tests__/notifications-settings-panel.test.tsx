import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { NotificationsSettingsPanelForClient } from "@/components/settings/panels/notifications-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

type NotificationConfig = ResponseOfMethod<
  HostRpcRegistry,
  "host.notifications.getConfig"
>;
type SetConfigRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notifications.setConfig"
>;
type HooksStatus = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.status"
>;
type HookEntry = HooksStatus["hooks"][number];
type SaveHooksRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.save"
>;
type TestHookRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.test"
>;
type TestHookResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.test"
>;

type RenderNotificationsOptions = {
  readonly hooksStatus: HooksStatus | undefined;
  readonly hooksStatusError: string | undefined;
  readonly deferTest: boolean | undefined;
};

const HOOKS_CONFIG_PATH = "/Users/me/.traycer/notification-hooks.json";

afterEach(() => {
  cleanup();
});

describe("<NotificationsSettingsPanel /> severity policy", () => {
  it("renders three single-channel severity rows, not a channel matrix", async () => {
    renderNotificationsSettings(undefined);

    const needsAction = await screen.findByRole("switch", {
      name: "Needs action In-app notifications",
    });
    const failure = screen.getByRole("switch", {
      name: "Failure In-app notifications",
    });
    const done = screen.getByRole("switch", {
      name: "Done In-app notifications",
    });
    const policy = screen.getByTestId("notifications-severity-policy");

    expect(
      within(policy).getByRole("heading", {
        name: "In-app notifications · Current host",
      }),
    ).toBeTruthy();
    expect(needsAction.getAttribute("data-state")).toBe("checked");
    expect(failure.getAttribute("data-state")).toBe("checked");
    expect(done.getAttribute("data-state")).toBe("checked");
    expect(
      within(policy).getByTestId("notifications-severity-needs_action"),
    ).toBeTruthy();
    expect(
      within(policy).getByTestId("notifications-severity-failure"),
    ).toBeTruthy();
    expect(
      within(policy).getByTestId("notifications-severity-done"),
    ).toBeTruthy();
    expect(within(policy).getByText("Approvals and interviews.")).toBeTruthy();
    expect(
      within(policy).getByText(
        "Errored turns, stalls, crashes, and rate limits.",
      ),
    ).toBeTruthy();
    expect(
      within(policy).getByText("Completed or intentionally stopped turns."),
    ).toBeTruthy();

    // One switch per severity only - no channel-by-severity matrix cells.
    expect(within(policy).getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByTestId(/notifications-matrix-/)).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /webhook notifications/i }),
    ).toBeNull();
    expect(screen.queryByLabelText("Webhook URL")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /email notifications/i }),
    ).toBeNull();
    expect(screen.queryByLabelText("SMTP password")).toBeNull();
  });

  it("writes severity toggles through setConfig while preserving email channel state", async () => {
    const fixture = renderNotificationsSettings(undefined);

    const doneRenderer = await screen.findByRole("switch", {
      name: "Done In-app notifications",
    });
    fireEvent.click(doneRenderer);

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    expect(fixture.setRequests[0].matrix.done.renderer).toBe(false);
    expect(fixture.setRequests[0].matrix.done.email).toBe(
      makeNotificationConfig().matrix.done.email,
    );
    expect(fixture.setRequests[0].channels.email).toEqual({
      host: "smtp.example.com",
      port: 587,
      user: "me@example.com",
      from: "Traycer <me@example.com>",
      password: { kind: "leaveUnchanged" },
    });
  });

  it("keeps severity toggles disabled while a post-save config refetch is in flight", async () => {
    const fixture = renderNotificationsSettingsWithDeferredRefetch();

    const doneRenderer = await screen.findByRole("switch", {
      name: "Done In-app notifications",
    });
    expect(doneRenderer.hasAttribute("disabled")).toBe(false);

    fireEvent.click(doneRenderer);

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.getConfigCalls.value).toBe(2);
    });

    const failureRenderer = screen.getByRole("switch", {
      name: "Failure In-app notifications",
    });
    expect(failureRenderer.hasAttribute("disabled")).toBe(true);

    fireEvent.click(failureRenderer);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fixture.setRequests).toHaveLength(1);

    await act(async () => {
      fixture.resolveRefetch(fixture.config.value);
      await fixture.refetchPromise;
    });
    await waitFor(() => {
      expect(failureRenderer.hasAttribute("disabled")).toBe(false);
    });
  });
});

describe("<NotificationsSettingsPanel /> notification hooks manager", () => {
  it("shows the empty state with an Add hook action when no hooks exist", async () => {
    renderNotificationsSettings({
      hooksStatus: makeHooksStatus({ hooks: [] }),
      hooksStatusError: undefined,
      deferTest: undefined,
    });

    expect(await screen.findByText("No notification hooks")).toBeTruthy();
    const manager = screen.getByTestId("notification-hooks-manager");
    expect(
      within(manager).getByRole("heading", { name: "Notification hooks" }),
    ).toBeTruthy();
    expect(within(manager).getByText("0 hooks")).toBeTruthy();
    expect(
      within(manager).getByText(
        /Hooks run a script or send an HTTP request for enabled/,
      ),
    ).toBeTruthy();
    // Toolbar Add + empty-state Add.
    expect(
      within(manager).getAllByRole("button", { name: /Add hook/ }),
    ).toHaveLength(2);
    const emptyState = within(manager).getByTestId(
      "notification-hooks-empty-state",
    );
    expect(emptyState.className).toContain("h-full");
    expect(emptyState.className).toContain("items-center");
    expect(emptyState.className).toContain("justify-center");
    const configPath = within(manager).getByText(HOOKS_CONFIG_PATH);
    expect(configPath.className).toContain("min-w-0");
    expect(configPath.className).toContain("flex-1");
    expect(configPath.className).not.toContain("max-w-48");
  });

  it("shows host-unavailable policy and manager states with both group boundaries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSettingsPanelForClient client={null} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Notification settings unavailable"),
    ).toBeTruthy();
    const policy = screen.getByTestId("notifications-severity-policy");
    const manager = screen.getByTestId("notification-hooks-manager");

    expect(
      within(policy).getByRole("heading", {
        name: "In-app notifications · Current host",
      }),
    ).toBeTruthy();
    expect(
      within(manager).getByRole("heading", { name: "Notification hooks" }),
    ).toBeTruthy();
    expect(
      within(policy).getByText("Connect to a host to configure delivery."),
    ).toBeTruthy();
    expect(
      within(manager).getByText("Notification hooks unavailable"),
    ).toBeTruthy();
    expect(
      within(manager).getByText(
        "Reconnect to the current host to view and manage hooks.",
      ),
    ).toBeTruthy();
    expect(
      within(manager)
        .getByRole("button", { name: /Add hook/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps policy and manager boundaries when hooks status query errors", async () => {
    renderNotificationsSettings({
      hooksStatus: undefined,
      hooksStatusError: "host offline",
      deferTest: undefined,
    });

    expect(
      await screen.findByText("Couldn't load notification hooks"),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "In-app notifications · Current host",
      }),
    ).toBeTruthy();
    const manager = screen.getByTestId("notification-hooks-manager");
    expect(
      within(manager).getByRole("heading", { name: "Notification hooks" }),
    ).toBeTruthy();
    expect(within(manager).getByText("host offline")).toBeTruthy();
    expect(
      within(manager)
        .getByRole("button", { name: /Add hook/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables editing when the hooks file is invalid and preserves path copy", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderNotificationsSettings({
        hooksStatus: makeHooksStatus({
          configError: "Unexpected token } in JSON at position 12",
          hooks: [],
        }),
        hooksStatusError: undefined,
        deferTest: undefined,
      });

      expect(
        await screen.findByText(
          /Hooks are disabled and editing is unavailable until the file parses/,
        ),
      ).toBeTruthy();
      const manager = screen.getByTestId("notification-hooks-manager");
      expect(
        within(manager).getByText(/Unexpected token } in JSON at position 12/),
      ).toBeTruthy();
      expect(within(manager).getByText(HOOKS_CONFIG_PATH)).toBeTruthy();
      expect(
        within(manager)
          .getByRole("button", { name: /Add hook/ })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        within(manager).queryByRole("button", { name: "Test" }),
      ).toBeNull();

      fireEvent.click(
        within(manager).getByRole("button", {
          name: "Copy config file path",
        }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(HOOKS_CONFIG_PATH);
      });
    } finally {
      if (previousClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", previousClipboard);
      }
    }
  });

  it("presents per-row destination, severity filter, and latest test results", async () => {
    renderNotificationsSettings({
      hooksStatus: makeHooksStatus({
        hooks: [
          makeHook({
            id: "script-hook",
            name: "Phone alerts",
            severities: ["needs_action", "failure"],
            action: {
              type: "command",
              command: "/usr/local/bin/notify",
              args: ["--loud"],
            },
            lastResult: {
              at: 1,
              ok: true,
              detail: "Last test delivered",
            },
          }),
          makeHook({
            id: "http-hook",
            name: "Incident webhook",
            severities: ["failure"],
            action: {
              type: "http",
              url: "https://hooks.example.com/incidents",
              headers: {},
            },
            lastResult: {
              at: 2,
              ok: false,
              detail: "HTTP 500 from endpoint",
            },
          }),
          makeHook({
            id: "untested-hook",
            name: "Untested",
            lastResult: null,
          }),
        ],
      }),
      hooksStatusError: undefined,
      deferTest: undefined,
    });

    expect(await screen.findByText("Phone alerts")).toBeTruthy();
    const manager = screen.getByTestId("notification-hooks-manager");
    expect(within(manager).getByText("3 hooks")).toBeTruthy();

    const scriptRow = within(manager).getByTestId(
      "notification-hook-row-script-hook",
    );
    expect(within(scriptRow).getByText("Script")).toBeTruthy();
    expect(
      within(scriptRow).getByText("/usr/local/bin/notify --loud"),
    ).toBeTruthy();
    expect(within(scriptRow).getByText("Needs action, Failure")).toBeTruthy();
    expect(within(scriptRow).getByText("Last test delivered")).toBeTruthy();

    const httpRow = within(manager).getByTestId(
      "notification-hook-row-http-hook",
    );
    expect(within(httpRow).getByText("Incident webhook")).toBeTruthy();
    expect(within(httpRow).getByText("HTTP")).toBeTruthy();
    expect(
      within(httpRow).getByText("https://hooks.example.com/incidents"),
    ).toBeTruthy();
    expect(within(httpRow).getByText("HTTP 500 from endpoint")).toBeTruthy();

    const untestedRow = within(manager).getByTestId(
      "notification-hook-row-untested-hook",
    );
    expect(within(untestedRow).getByText("No test yet")).toBeTruthy();
  });

  it("shows running feedback on the tested hook row only", async () => {
    const fixture = renderNotificationsSettings({
      hooksStatus: makeHooksStatus({
        hooks: [
          makeHook({ id: "a", name: "Alpha" }),
          makeHook({ id: "b", name: "Beta" }),
        ],
      }),
      hooksStatusError: undefined,
      deferTest: true,
    });

    const alphaRow = await screen.findByTestId("notification-hook-row-a");
    const betaRow = screen.getByTestId("notification-hook-row-b");

    fireEvent.click(within(alphaRow).getByRole("button", { name: /Test/ }));

    await waitFor(() => {
      expect(fixture.testRequests).toHaveLength(1);
    });
    expect(fixture.testRequests[0].hookId).toBe("a");

    // Spinner only on the tested row; both Test buttons share the pending gate.
    expect(screen.getByTestId("notification-hook-test-spinner-a")).toBeTruthy();
    expect(screen.queryByTestId("notification-hook-test-spinner-b")).toBeNull();
    expect(
      within(alphaRow)
        .getByRole("button", { name: /Test/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(betaRow)
        .getByRole("button", { name: /Test/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      fixture.resolveTest({
        outcome: "ok",
        detail: "delivered",
      });
      await fixture.testPromise;
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("notification-hook-test-spinner-a"),
      ).toBeNull();
    });
  });

  it("opens the focused Add and Edit hook editors", async () => {
    renderNotificationsSettings({
      hooksStatus: makeHooksStatus({
        hooks: [makeHook({ id: "edit-me", name: "Pager" })],
      }),
      hooksStatusError: undefined,
      deferTest: undefined,
    });

    expect(await screen.findByText("Pager")).toBeTruthy();
    const manager = screen.getByTestId("notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: /Add hook/ }));

    expect(
      await screen.findByRole("heading", { name: "Add hook" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save hook" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Add hook" })).toBeNull();
    });

    fireEvent.click(within(manager).getByRole("button", { name: "Edit" }));
    expect(
      await screen.findByRole("heading", { name: "Edit hook" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Pager")).toBeTruthy();
  });

  it("requires confirmation before deleting a hook", async () => {
    const fixture = renderNotificationsSettings({
      hooksStatus: makeHooksStatus({
        hooks: [makeHook({ id: "doomed", name: "Doomed hook" })],
      }),
      hooksStatusError: undefined,
      deferTest: undefined,
    });

    expect(await screen.findByText("Doomed hook")).toBeTruthy();
    const manager = screen.getByTestId("notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText("Delete hook?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        /"Doomed hook" will be removed from the hooks file/,
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(fixture.saveRequests).toHaveLength(1);
    });
    expect(fixture.saveRequests[0].hooks).toEqual([]);
  });
});

function renderNotificationsSettings(
  options: RenderNotificationsOptions | undefined,
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly setRequests: SetConfigRequest[];
  readonly saveRequests: SaveHooksRequest[];
  readonly testRequests: TestHookRequest[];
  readonly testPromise: Promise<TestHookResponse>;
  readonly resolveTest: (value: TestHookResponse) => void;
} {
  const setRequests: SetConfigRequest[] = [];
  const saveRequests: SaveHooksRequest[] = [];
  const testRequests: TestHookRequest[] = [];
  let config = makeNotificationConfig();
  let hooksStatus =
    options === undefined || options.hooksStatus === undefined
      ? makeHooksStatus(undefined)
      : options.hooksStatus;
  let resolveTest: (value: TestHookResponse) => void = () => undefined;
  const testPromise = new Promise<TestHookResponse>((resolve) => {
    resolveTest = resolve;
  });

  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.notifications.getConfig": () => config,
        "host.notifications.setConfig": (params) => {
          setRequests.push(params);
          config = responseFromSetRequest(config, params);
          return config;
        },
        "host.notificationHooks.status": () => {
          if (options !== undefined && options.hooksStatusError !== undefined) {
            throw new Error(options.hooksStatusError);
          }
          return hooksStatus;
        },
        "host.notificationHooks.save": (params) => {
          saveRequests.push(params);
          hooksStatus = {
            ...hooksStatus,
            configError: null,
            hooks: params.hooks.map((hook) => ({
              ...hook,
              lastResult: null,
            })),
          };
          return hooksStatus;
        },
        "host.notificationHooks.test": (params) => {
          testRequests.push(params);
          if (options !== undefined && options.deferTest === true) {
            return testPromise;
          }
          return { outcome: "ok", detail: "delivered" };
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );

  render(<NotificationsSettingsPanelForClient client={client} />, {
    wrapper,
  });

  return {
    client,
    setRequests,
    saveRequests,
    testRequests,
    testPromise,
    resolveTest,
  };
}

function renderNotificationsSettingsWithDeferredRefetch(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly config: { value: NotificationConfig };
  readonly getConfigCalls: { value: number };
  readonly refetchPromise: Promise<NotificationConfig>;
  readonly resolveRefetch: (value: NotificationConfig) => void;
  readonly setRequests: SetConfigRequest[];
} {
  const setRequests: SetConfigRequest[] = [];
  const config = { value: makeNotificationConfig() };
  const getConfigCalls = { value: 0 };
  let resolveRefetch: (value: NotificationConfig) => void = () => undefined;
  const refetchPromise = new Promise<NotificationConfig>((resolve) => {
    resolveRefetch = resolve;
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.notifications.getConfig": () => {
          getConfigCalls.value += 1;
          if (getConfigCalls.value === 1) return config.value;
          return refetchPromise;
        },
        "host.notifications.setConfig": (params) => {
          setRequests.push(params);
          config.value = responseFromSetRequest(config.value, params);
          return config.value;
        },
        "host.notificationHooks.status": () => makeHooksStatus(undefined),
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );

  render(<NotificationsSettingsPanelForClient client={client} />, {
    wrapper,
  });

  return {
    client,
    config,
    getConfigCalls,
    refetchPromise,
    resolveRefetch,
    setRequests,
  };
}

function makeNotificationConfig(): NotificationConfig {
  return {
    matrix: {
      info: {
        renderer: true,
        email: false,
      },
      needs_action: {
        renderer: true,
        email: true,
      },
      failure: {
        renderer: true,
        email: false,
      },
      done: {
        renderer: true,
        email: false,
      },
    },
    channels: {
      renderer: {
        lastError: null,
      },
      email: {
        host: "smtp.example.com",
        port: 587,
        user: "me@example.com",
        from: "Traycer <me@example.com>",
        credentialConfigured: true,
        lastError: "previous email failed",
      },
    },
  };
}

function makeHooksStatus(
  overrides: Partial<HooksStatus> | undefined,
): HooksStatus {
  return {
    configPath: HOOKS_CONFIG_PATH,
    configError: null,
    hooks: [],
    ...(overrides === undefined ? {} : overrides),
  };
}

function makeHook(
  overrides: Partial<HookEntry> & Pick<HookEntry, "id">,
): HookEntry {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    enabled: overrides.enabled ?? true,
    severities: overrides.severities ?? ["failure"],
    action: overrides.action ?? {
      type: "command",
      command: "/bin/echo",
      args: [],
    },
    lastResult:
      overrides.lastResult === undefined ? null : overrides.lastResult,
  };
}

function responseFromSetRequest(
  previous: NotificationConfig,
  request: SetConfigRequest,
): NotificationConfig {
  return {
    matrix: request.matrix,
    channels: {
      renderer: {
        lastError: null,
      },
      email: {
        host: request.channels.email.host,
        port: request.channels.email.port,
        user: request.channels.email.user,
        from: request.channels.email.from,
        credentialConfigured: credentialConfiguredAfterWrite(
          previous.channels.email.credentialConfigured,
          request.channels.email.password,
        ),
        lastError: null,
      },
    },
  };
}

function credentialConfiguredAfterWrite(
  previous: boolean,
  write: SetConfigRequest["channels"]["email"]["password"],
): boolean {
  if (write.kind === "leaveUnchanged") return previous;
  return write.kind === "set";
}
