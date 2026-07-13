import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  cleanup();
});

describe("<NotificationsSettingsPanel />", () => {
  it("reflects the severity channel matrix and writes toggles through setConfig", async () => {
    const fixture = renderNotificationsSettings();

    const needsActionWebhook = await screen.findByRole("switch", {
      name: "Needs action Webhook interruptions",
    });
    const doneRenderer = screen.getByRole("switch", {
      name: "Done In-app interruptions",
    });

    expect(needsActionWebhook.getAttribute("data-state")).toBe("checked");
    expect(doneRenderer.getAttribute("data-state")).toBe("checked");
    expect(
      screen.queryByRole("switch", { name: /email interruptions/i }),
    ).toBeNull();
    expect(screen.queryByText("Email")).toBeNull();
    expect(screen.queryByLabelText("SMTP password")).toBeNull();

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
    expect(fixture.setRequests[0].channels.webhook.signingSecret).toEqual({
      kind: "leaveUnchanged",
    });
  });

  it("keeps secrets write-only and sends leaveUnchanged when they are untouched", async () => {
    const fixture = renderNotificationsSettings();

    const webhookSecret = await screen.findByLabelText(
      "Webhook signing secret",
    );
    expect(webhookSecret).toHaveProperty("value", "");
    expect(screen.getAllByText("Credential configured")).toHaveLength(1);
    expect(screen.queryByLabelText("SMTP password")).toBeNull();

    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://hooks.example.com/updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save webhook" }));

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    expect(fixture.setRequests[0].channels.webhook).toEqual({
      url: "https://hooks.example.com/updated",
      signingSecret: { kind: "leaveUnchanged" },
    });
    expect(fixture.setRequests[0].channels.email).toEqual({
      host: "smtp.example.com",
      port: 587,
      user: "me@example.com",
      from: "Traycer <me@example.com>",
      password: { kind: "leaveUnchanged" },
    });
  });

  it("sends set and clear secret writes from explicit secret edits", async () => {
    const fixture = renderNotificationsSettings();

    fireEvent.change(await screen.findByLabelText("Webhook signing secret"), {
      target: { value: "new-webhook-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save webhook" }));

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    expect(fixture.setRequests[0].channels.webhook.signingSecret).toEqual({
      kind: "set",
      value: "new-webhook-secret",
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Clear" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save webhook" }));

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(2);
    });
    expect(fixture.setRequests[1].channels.webhook.signingSecret).toEqual({
      kind: "clear",
    });
  });

  it("keeps matrix toggles disabled while a post-save config refetch is in flight", async () => {
    const fixture = renderNotificationsSettingsWithDeferredRefetch();

    const doneWebhook = await screen.findByRole("switch", {
      name: "Done Webhook interruptions",
    });
    expect(doneWebhook.hasAttribute("disabled")).toBe(false);

    fireEvent.click(doneWebhook);

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    await waitFor(() => {
      expect(fixture.getConfigCalls.value).toBe(2);
    });

    const failureWebhook = screen.getByRole("switch", {
      name: "Failure Webhook interruptions",
    });
    expect(failureWebhook.hasAttribute("disabled")).toBe(true);

    fireEvent.click(failureWebhook);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fixture.setRequests).toHaveLength(1);

    await act(async () => {
      fixture.resolveRefetch(fixture.config.value);
      await fixture.refetchPromise;
    });
    await waitFor(() => {
      expect(failureWebhook.hasAttribute("disabled")).toBe(false);
    });
  });

  it("treats whitespace-only typed secrets as leaveUnchanged", async () => {
    const fixture = renderNotificationsSettings();

    fireEvent.change(await screen.findByLabelText("Webhook signing secret"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save webhook" }));

    await waitFor(() => {
      expect(fixture.setRequests).toHaveLength(1);
    });
    expect(fixture.setRequests[0].channels.webhook.signingSecret).toEqual({
      kind: "leaveUnchanged",
    });
  });
});

function renderNotificationsSettings(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly setRequests: SetConfigRequest[];
} {
  const setRequests: SetConfigRequest[] = [];
  let config = makeNotificationConfig();
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

  return { client, setRequests };
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
        webhook: false,
        email: false,
      },
      needs_action: {
        renderer: true,
        webhook: true,
        email: true,
      },
      failure: {
        renderer: true,
        webhook: true,
        email: false,
      },
      done: {
        renderer: true,
        webhook: false,
        email: false,
      },
    },
    channels: {
      renderer: {
        lastError: null,
      },
      webhook: {
        url: "https://hooks.example.com/traycer",
        credentialConfigured: true,
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
      webhook: {
        url: request.channels.webhook.url,
        credentialConfigured: credentialConfiguredAfterWrite(
          previous.channels.webhook.credentialConfigured,
          request.channels.webhook.signingSecret,
        ),
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
  write: SetConfigRequest["channels"]["webhook"]["signingSecret"],
): boolean {
  if (write.kind === "leaveUnchanged") return previous;
  return write.kind === "set";
}
