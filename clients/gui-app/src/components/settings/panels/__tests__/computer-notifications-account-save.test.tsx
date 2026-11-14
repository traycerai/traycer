import {
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
import type { EnvironmentTransportRequest } from "@traycer-clients/shared/environment/environment-cloud";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostNotificationHooksSaveDowngradeV40ToV10,
  hostNotificationHooksSaveDowngradeV40ToV20,
  hostNotificationHooksSaveDowngradeV40ToV30,
  hostNotificationHooksSaveUpgradeV3ToV4,
  hostNotificationHooksSaveV40,
  type NotificationHooksSaveResponseV40,
} from "@traycer/protocol/host/notifications/host-notifications";
import { ComputerNotificationsSettingsPanel } from "@/components/settings/panels/computer-notifications-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

const accountCloud = vi.hoisted(() => ({
  requests: [] as EnvironmentTransportRequest[],
  failPut: false,
}));

vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => () => ({
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
    transport: async (request: EnvironmentTransportRequest) => {
      accountCloud.requests.push(request);
      if (request.method === "PUT" && accountCloud.failPut) {
        return {
          status: 503,
          text: JSON.stringify({ detail: "private account failure" }),
        };
      }
      const matrix = {
        needs_action: { renderer: true },
        failure: { renderer: true },
        done: { renderer: true },
        info: { renderer: false },
      };
      const hooks =
        request.method === "PUT" &&
        typeof request.body === "object" &&
        request.body !== null &&
        "hooks" in request.body
          ? request.body.hooks
          : [];
      return {
        status: 200,
        text: JSON.stringify({
          settings: { matrix, hooks },
          revision: request.method === "GET" ? 17 : 18,
        }),
      };
    },
    onOriginSignIn: () => true,
  }),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "viewer-1",
}));

type HostHooksStatus = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.status"
>;
type HostHooksSaveRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.save"
>;
type HostHooksSaveResponse = NotificationHooksSaveResponseV40;

const commandHooks = [
  {
    id: "convert-this-hook",
    name: "Convert this hook",
    enabled: true,
    severities: ["failure" as const],
    action: { type: "command" as const, command: "/bin/notify", args: [] },
    lastResult: null,
    localOnly: true,
  },
  {
    id: "keep-local-hook",
    name: "Keep local hook",
    enabled: true,
    severities: ["done" as const],
    action: { type: "command" as const, command: "/bin/other", args: [] },
    lastResult: null,
    localOnly: true,
  },
];

const hostAnsweredHttpHook = {
  id: "convert-this-hook",
  name: "Convert this hook",
  enabled: true,
  severities: ["failure" as const],
  action: {
    type: "http" as const,
    url: "https://hooks.example/converted",
    headers: { authorization: "Bearer literal-value" },
  },
};

afterEach(() => {
  cleanup();
  accountCloud.requests = [];
  accountCloud.failPut = false;
  useAuthStore.setState({ status: "signed-out" });
});

function makeHostClient(accountHooks: HostHooksSaveResponse["accountHooks"]): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly saves: HostHooksSaveRequest[];
} {
  const saves: HostHooksSaveRequest[] = [];
  let status: HostHooksStatus = {
    configPath: "/home/test/.traycer/notification-hooks.json",
    configError: null,
    hooks: commandHooks,
    configurationRevision: "host-rev-7",
    pendingRemovalNotices: [],
  };
  const registry = {
    ...hostRpcRegistry,
    "host.notificationHooks.save": {
      ...hostRpcRegistry["host.notificationHooks.save"],
      4: {
        latestMinor: 0,
        versions: {
          0: {
            contract: hostNotificationHooksSaveV40,
            upgradeFromPreviousVersion: hostNotificationHooksSaveUpgradeV3ToV4,
          },
        },
        downgradePathsFromLatest: {
          1: hostNotificationHooksSaveDowngradeV40ToV10,
          2: hostNotificationHooksSaveDowngradeV40ToV20,
          3: hostNotificationHooksSaveDowngradeV40ToV30,
        },
      },
    },
  } as HostRpcRegistry;
  const spine = new HostClient<HostRpcRegistry>({
    registry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry,
      requestId: () => "computer-notifications-account-save",
      handlers: {
        "host.notifications.getLongTurnAlert": () => ({ thresholdMs: null }),
        "host.notifications.setLongTurnAlert": (request) => request,
        "host.notificationHooks.status": () => status,
        "host.notificationHooks.test": () => ({
          outcome: "ok",
          detail: "delivered",
        }),
        "host.notificationHooks.save": (
          request: HostHooksSaveRequest,
        ): HostHooksSaveResponse => {
          saves.push(request);
          status = {
            ...status,
            hooks: request.hooks.map((hook) => ({
              ...hook,
              lastResult: null,
              localOnly: hook.action.type === "command",
            })),
          };
          return { ...status, accountHooks };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-bearer",
    }),
  );
  return { client: spine.createRequester(mockLocalHostEntry), saves };
}

function renderComputerTab(client: HostClient<HostRpcRegistry>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useAuthStore.setState({ status: "signed-in" });
  return render(<ComputerNotificationsSettingsPanel client={client} />, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

async function convertCommandHookToHttp(): Promise<void> {
  const manager = await screen.findByTestId("notification-hooks-manager");
  fireEvent.click(within(manager).getAllByRole("button", { name: "Edit" })[0]!);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("combobox", { name: "Action" }));
  fireEvent.click(await screen.findByRole("option", { name: "POST to a URL" }));
  fireEvent.change(within(dialog).getByLabelText("URL"), {
    target: { value: "https://hooks.example/converted" },
  });
  fireEvent.change(within(dialog).getByLabelText("Headers"), {
    target: { value: "authorization: Bearer literal-value" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));
}

describe("computer hook saves and the host's answered account part", () => {
  it("writes exactly the host's answered account hooks with held false and the app-read revision", async () => {
    const { client, saves } = makeHostClient([hostAnsweredHttpHook]);
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() =>
      expect(
        accountCloud.requests.some((request) => request.method === "PUT"),
      ).toBe(true),
    );
    const put = accountCloud.requests.find(
      (request) => request.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(put?.body).toEqual({
      hooks: [{ ...hostAnsweredHttpHook, held: false }],
      revision: 17,
    });
    expect(
      accountCloud.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.hooks).toHaveLength(2);
    expect((put?.body as { readonly hooks: unknown[] }).hooks).not.toEqual(
      saves[0]?.hooks,
    );
  });

  it("replaces the account hook list with empty when the host answers an empty account part", async () => {
    const { client } = makeHostClient([]);
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() =>
      expect(
        accountCloud.requests.some((request) => request.method === "PUT"),
      ).toBe(true),
    );
    const put = accountCloud.requests.find(
      (request) => request.method === "PUT",
    );
    expect(put?.body).toEqual({ hooks: [], revision: 17 });
  });

  it("does not write the account when the host answers null", async () => {
    const { client } = makeHostClient(null);
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      accountCloud.requests.some((request) => request.method === "PUT"),
    ).toBe(false);
  });

  it("keeps the computer tab open and shows its failed-save words when the account PUT fails", async () => {
    const { client } = makeHostClient([hostAnsweredHttpHook]);
    accountCloud.failPut = true;
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() =>
      expect(
        accountCloud.requests.some((request) => request.method === "PUT"),
      ).toBe(true),
    );
    expect(screen.getByTestId("notification-hooks-manager")).toBeTruthy();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save notification hooks. Review the refreshed hooks before saving again.",
    );
  });
});
