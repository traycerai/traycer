import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
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
import type { NotificationHooksSaveResponseV40 } from "@traycer/protocol/host/notifications/host-notifications";
import { ComputerNotificationsSettingsPanel } from "@/components/settings/panels/computer-notifications-settings-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useHostBinding } from "@/lib/host";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

const accountCloud = vi.hoisted(() => ({
  requests: [] as EnvironmentTransportRequest[],
  putFailureStatus: null as number | null,
  deferPut: false,
  pendingPutResolve: null as
    | ((response: { readonly status: number; readonly text: string }) => void)
    | null,
  originSignInActive: true,
  signInId: "account-a",
  bearerToken: "test-bearer",
}));

vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => () => {
    const pressedSignIn = accountCloud.signInId;
    return {
      authnBaseUrl: "https://authn.example/",
      bearer: {
        kind: "cloud",
        getBearerToken: () => accountCloud.bearerToken,
      },
      transport: async (request: EnvironmentTransportRequest) => {
        accountCloud.requests.push(request);
        if (request.method === "PUT" && accountCloud.deferPut) {
          accountCloud.deferPut = false;
          return new Promise<{ status: number; text: string }>((resolve) => {
            accountCloud.pendingPutResolve = resolve;
          });
        }
        if (
          request.method === "PUT" &&
          accountCloud.putFailureStatus !== null
        ) {
          return {
            status: accountCloud.putFailureStatus,
            text:
              accountCloud.putFailureStatus === 503
                ? JSON.stringify({ detail: "private account failure" })
                : JSON.stringify({ statusCode: 400, error: "Bad Request" }),
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
      onOriginSignIn: () =>
        accountCloud.originSignInActive &&
        accountCloud.signInId === pressedSignIn,
    };
  },
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
  accountCloud.pendingPutResolve?.({
    status: 503,
    text: JSON.stringify({ detail: "private account failure" }),
  });
  accountCloud.requests = [];
  accountCloud.putFailureStatus = null;
  accountCloud.deferPut = false;
  accountCloud.pendingPutResolve = null;
  accountCloud.originSignInActive = true;
  accountCloud.signInId = "account-a";
  accountCloud.bearerToken = "test-bearer";
  useAuthStore.setState({ status: "signed-out" });
});

function makeHostClient(
  accountHooks: HostHooksSaveResponse["accountHooks"],
  options: {
    readonly initialHooks?: HostHooksStatus["hooks"];
    readonly deferFirstSave?: boolean;
  },
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly saves: HostHooksSaveRequest[];
  readonly getStatus: () => HostHooksStatus;
  readonly resolvePendingHostSave: () => void;
  readonly rejectPendingHostSave: () => void;
} {
  const saves: HostHooksSaveRequest[] = [];
  let rejectPendingHostSave: ((reason: Error) => void) | null = null;
  let resolvePendingHostSave: (() => void) | null = null;
  let deferNextSave = options.deferFirstSave === true;
  let status: HostHooksStatus = {
    configPath: "/home/test/.traycer/notification-hooks.json",
    configError: null,
    hooks: options.initialHooks ?? commandHooks,
    configurationRevision: "host-rev-7",
    pendingRemovalNotices: [],
  };
  let revision = 7;
  const registry = hostRpcRegistry;
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
        "host.notificationHooks.save": async (
          request: HostHooksSaveRequest,
        ): Promise<HostHooksSaveResponse> => {
          saves.push(request);
          if (deferNextSave) {
            deferNextSave = false;
            await new Promise<void>((resolve, reject) => {
              resolvePendingHostSave = resolve;
              rejectPendingHostSave = reject;
            });
          }
          if (request.configurationRevision !== `host-rev-${revision}`) {
            throw new Error("Notification hooks changed on this computer.");
          }
          revision += 1;
          status = {
            ...status,
            configurationRevision: `host-rev-${revision}`,
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
  return {
    client: spine.createRequester(mockLocalHostEntry),
    saves,
    getStatus: () => status,
    resolvePendingHostSave: () => {
      if (resolvePendingHostSave === null)
        throw new Error("No deferred host save is pending.");
      const resolve = resolvePendingHostSave;
      resolvePendingHostSave = null;
      resolve();
    },
    rejectPendingHostSave: () => {
      if (rejectPendingHostSave === null)
        throw new Error("No deferred host save is pending.");
      const reject = rejectPendingHostSave;
      rejectPendingHostSave = null;
      reject(new Error("The host save failed."));
    },
  };
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

function HostBindingCapture(props: {
  readonly onBinding: (
    binding: HostRuntimeBinding<HostRpcRegistry> | null,
  ) => void;
}) {
  const binding = useHostBinding();
  const { onBinding } = props;
  useEffect(() => onBinding(binding), [binding, onBinding]);
  return null;
}

async function openCommandHookEditor(hookId: string): Promise<HTMLElement> {
  const row = await screen.findByTestId(`notification-hook-row-${hookId}`);
  fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
  return screen.findByRole("dialog");
}

async function fillCommandHookEditorAsHttp(
  dialog: HTMLElement,
  url: string,
): Promise<void> {
  fireEvent.click(within(dialog).getByRole("combobox", { name: "Action" }));
  fireEvent.click(await screen.findByRole("option", { name: "POST to a URL" }));
  fireEvent.change(within(dialog).getByLabelText("URL"), {
    target: { value: url },
  });
  fireEvent.change(within(dialog).getByLabelText("Headers"), {
    target: { value: "authorization: Bearer literal-value" },
  });
}

async function convertCommandHookToHttp(): Promise<void> {
  const dialog = await openCommandHookEditor("convert-this-hook");
  await fillCommandHookEditorAsHttp(dialog, "https://hooks.example/converted");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));
}

async function fillHttpHookDialog(name: string, url: string): Promise<void> {
  const manager = await screen.findByTestId("notification-hooks-manager");
  const addButton = await waitFor(() => {
    const button = within(manager)
      .getAllByRole("button", { name: "Add hook" })
      .find((candidate) => !candidate.hasAttribute("disabled"));
    if (button === undefined) throw new Error("No enabled Add hook button.");
    return button;
  });
  fireEvent.click(addButton);
  await fillOpenedHttpHookDialog(name, url);
}

async function fillOpenedHttpHookDialog(
  name: string,
  url: string,
): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: name },
  });
  fireEvent.click(within(dialog).getByRole("combobox", { name: "Action" }));
  fireEvent.click(await screen.findByRole("option", { name: "POST to a URL" }));
  fireEvent.change(within(dialog).getByLabelText("URL"), {
    target: { value: url },
  });
  fireEvent.change(within(dialog).getByLabelText("Headers"), {
    target: { value: "x-form: value" },
  });
}

async function addHttpHook(name: string, url: string): Promise<void> {
  await fillHttpHookDialog(name, url);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));
}

function settleDeferredAccountPut(status: 200 | 503): void {
  const resolve = accountCloud.pendingPutResolve;
  if (resolve === null) throw new Error("No deferred account PUT is pending.");
  accountCloud.pendingPutResolve = null;
  resolve({
    status,
    text:
      status === 503
        ? JSON.stringify({ detail: "private account failure" })
        : JSON.stringify({
            settings: {
              matrix: {
                needs_action: { renderer: true },
                failure: { renderer: true },
                done: { renderer: true },
                info: { renderer: false },
              },
              hooks: [],
            },
            revision: 18,
          }),
  });
}

async function reopenAddDialog(name: string, url: string): Promise<void> {
  const manager = await screen.findByTestId("notification-hooks-manager");
  const addButton = await waitFor(() => {
    const button = within(manager)
      .getAllByRole("button", { name: "Add hook" })
      .find((candidate) => !candidate.hasAttribute("disabled"));
    if (button === undefined) throw new Error("No enabled Add hook button.");
    return button;
  });
  fireEvent.click(addButton);
  await fillOpenedHttpHookDialog(name, url);
}

describe("computer hook saves and the host's answered account part", () => {
  it("writes exactly the host's answered account hooks with held false and the app-read revision", async () => {
    const { client, saves } = makeHostClient([hostAnsweredHttpHook], {});
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
    const { client } = makeHostClient([], {});
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
    const { client } = makeHostClient(null, {});
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      accountCloud.requests.some((request) => request.method === "PUT"),
    ).toBe(false);
  });

  it("keeps the computer tab open and shows its failed-save words when the account PUT fails", async () => {
    const { client } = makeHostClient([hostAnsweredHttpHook], {});
    accountCloud.putFailureStatus = 503;
    renderComputerTab(client);

    await convertCommandHookToHttp();

    await waitFor(() =>
      expect(
        accountCloud.requests.some((request) => request.method === "PUT"),
      ).toBe(true),
    );
    expect(screen.getByTestId("notification-hooks-manager")).toBeTruthy();
    expect(
      (await within(screen.getByRole("dialog")).findByRole("alert"))
        .textContent,
    ).toBe(
      "Cloud service is temporarily unavailable. Please try again shortly. Review the refreshed hooks before saving again.",
    );
  });

  it("retries an Add with the same draft once at the host's answered revision after the account PUT fails", async () => {
    const { client, saves } = makeHostClient([hostAnsweredHttpHook], {});
    accountCloud.putFailureStatus = 503;
    renderComputerTab(client);

    await addHttpHook("Draft hook", "https://hooks.example/from-form");

    await waitFor(() => expect(accountCloud.requests).toHaveLength(2));
    expect(accountCloud.requests[0]?.method).toBe("GET");
    expect(accountCloud.requests[1]?.method).toBe("PUT");
    expect(
      (await within(screen.getByRole("dialog")).findByRole("alert"))
        .textContent,
    ).toBe(
      "Cloud service is temporarily unavailable. Please try again shortly. Review the refreshed hooks before saving again.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Name"),
    ).toHaveProperty("value", "Draft hook");
    expect(saves).toHaveLength(1);
    const firstDraft = saves[0]?.hooks.find(
      (hook) => hook.name === "Draft hook",
    );
    expect(firstDraft).toBeDefined();
    expect(saves[0]?.configurationRevision).toBe("host-rev-7");
    expect(
      (accountCloud.requests[1]?.body as { hooks: unknown[] }).hooks,
    ).toEqual([{ ...hostAnsweredHttpHook, held: false }]);

    accountCloud.putFailureStatus = null;
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Save hook",
      }),
    );

    await waitFor(() => expect(saves).toHaveLength(2));
    await waitFor(() =>
      expect(
        accountCloud.requests.filter((request) => request.method === "PUT"),
      ).toHaveLength(2),
    );
    expect(saves[1]?.configurationRevision).toBe("host-rev-8");
    const retriedDrafts = saves[1]?.hooks.filter(
      (hook) => hook.id === firstDraft?.id,
    );
    expect(retriedDrafts).toHaveLength(1);
    expect(retriedDrafts[0]).toEqual(firstDraft);
    expect(saves[1]?.hooks).toHaveLength(commandHooks.length + 1);
    expect(accountCloud.requests[2]?.method).toBe("GET");
    expect(accountCloud.requests[3]?.body).toEqual({
      hooks: [{ ...hostAnsweredHttpHook, held: false }],
      revision: 17,
    });
  });

  it("keeps a reopened Add at its old revision when the first account PUT fails", async () => {
    const { client, saves, getStatus } = makeHostClient([], {
      initialHooks: [],
    });
    accountCloud.deferPut = true;
    renderComputerTab(client);

    await addHttpHook("Draft A", "https://hooks.example/a");
    await waitFor(() => expect(accountCloud.pendingPutResolve).not.toBeNull());
    expect(saves).toHaveLength(1);
    expect(saves[0]?.configurationRevision).toBe("host-rev-7");

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await reopenAddDialog("Draft B", "https://hooks.example/b");

    settleDeferredAccountPut(503);
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByLabelText("Name"),
      ).toHaveProperty("value", "Draft B"),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Save hook",
        }),
      ).toHaveProperty("disabled", false),
    );
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Save hook",
      }),
    );
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.configurationRevision).toBe("host-rev-7");
    expect(
      accountCloud.requests.filter((request) => request.method === "PUT"),
    ).toHaveLength(1);
    expect(getStatus().configurationRevision).toBe("host-rev-8");
    expect(getStatus().hooks.map((hook) => hook.name)).toEqual(["Draft A"]);
  });

  it("does not let a late account success close a newly opened Add", async () => {
    const { client } = makeHostClient([], { initialHooks: [] });
    accountCloud.deferPut = true;
    renderComputerTab(client);

    await addHttpHook("Draft A", "https://hooks.example/a");
    await waitFor(() => expect(accountCloud.pendingPutResolve).not.toBeNull());
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await reopenAddDialog("Draft B", "https://hooks.example/b");

    settleDeferredAccountPut(200);
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Save hook",
        }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Name"),
    ).toHaveProperty("value", "Draft B");
  });

  it("does not let a late host error close a newly opened Add", async () => {
    const { client, saves, rejectPendingHostSave } = makeHostClient(null, {
      initialHooks: [],
      deferFirstSave: true,
    });
    renderComputerTab(client);

    await addHttpHook("Draft A", "https://hooks.example/a");
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await reopenAddDialog("Draft B", "https://hooks.example/b");

    rejectPendingHostSave();
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Save hook",
        }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Name"),
    ).toHaveProperty("value", "Draft B");
    expect(accountCloud.requests).toEqual([]);
  });

  it("skips the host answer's account contribution when its sign-in ends before the response", async () => {
    const { client, saves, resolvePendingHostSave } = makeHostClient(
      [hostAnsweredHttpHook],
      { initialHooks: [commandHooks[0]], deferFirstSave: true },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useAuthStore.setState({ status: "signed-in" });
    const capturedBindings: HostRuntimeBinding<HostRpcRegistry>[] = [];
    const onBinding = (
      binding: HostRuntimeBinding<HostRpcRegistry> | null,
    ): void => {
      if (binding !== null) capturedBindings.push(binding);
    };
    const wrapper = (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HostRuntimeTestProvider>{props.children}</HostRuntimeTestProvider>
      </QueryClientProvider>
    );
    render(
      <>
        <HostBindingCapture onBinding={onBinding} />
        <ComputerNotificationsSettingsPanel client={client} />
      </>,
      { wrapper },
    );

    await screen.findByTestId("notification-hook-row-convert-this-hook");
    await convertCommandHookToHttp();
    await waitFor(() => expect(saves).toHaveLength(1));
    await waitFor(() => expect(capturedBindings.length).toBeGreaterThan(0));
    const capturedBinding = capturedBindings[0];
    const directoryList = vi.spyOn(capturedBinding.directory, "list");
    const initialListCalls = directoryList.mock.calls.length;

    accountCloud.originSignInActive = false;
    resolvePendingHostSave();

    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog"))
          .getByRole("button", {
            name: "Save hook",
          })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(accountCloud.requests).toEqual([]);
    expect(directoryList).toHaveBeenCalledTimes(initialListCalls);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });

  it("skips the host answer's account contribution when the account switches from A to B before the response", async () => {
    const { client, saves, resolvePendingHostSave } = makeHostClient(
      [hostAnsweredHttpHook],
      { initialHooks: [commandHooks[0]], deferFirstSave: true },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useAuthStore.setState({ status: "signed-in" });
    const wrapper = (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HostRuntimeTestProvider>{props.children}</HostRuntimeTestProvider>
      </QueryClientProvider>
    );
    render(<ComputerNotificationsSettingsPanel client={client} />, {
      wrapper,
    });

    await screen.findByTestId("notification-hook-row-convert-this-hook");
    await convertCommandHookToHttp();
    await waitFor(() => expect(saves).toHaveLength(1));

    accountCloud.signInId = "account-b";
    accountCloud.bearerToken = "account-b-token";
    resolvePendingHostSave();

    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog"))
          .getByRole("button", {
            name: "Save hook",
          })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(accountCloud.requests).toEqual([]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });

  it("shows a failed Delete in its confirmation and not in a new Delete opening", async () => {
    const { client } = makeHostClient([hostAnsweredHttpHook], {
      initialHooks: commandHooks,
    });
    accountCloud.putFailureStatus = 503;
    renderComputerTab(client);

    const firstRow = await screen.findByTestId(
      "notification-hook-row-convert-this-hook",
    );
    fireEvent.click(within(firstRow).getByRole("button", { name: "Delete" }));
    const firstDialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(firstDialog).queryByRole("alert")).toBeNull();
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Delete" }),
    );

    expect(
      (await within(firstDialog).findByRole("alert")).textContent,
    ).toContain(
      "Cloud service is temporarily unavailable. Please try again shortly. Review the refreshed hooks before saving again.",
    );
    fireEvent.click(within(firstDialog).getByTestId("confirm-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull(),
    );
    const remainingRow = await screen.findByTestId(
      "notification-hook-row-keep-local-hook",
    );
    fireEvent.click(
      within(remainingRow).getByRole("button", { name: "Delete" }),
    );
    const secondDialog = await screen.findByTestId(
      "confirm-destructive-dialog",
    );
    expect(within(secondDialog).queryByRole("alert")).toBeNull();
  });

  it("keeps Delete locked while its account save is pending and retries its opening after failure settles", async () => {
    const { client, saves } = makeHostClient([], {
      initialHooks: [commandHooks[0]],
    });
    accountCloud.deferPut = true;
    renderComputerTab(client);

    const row = await screen.findByTestId(
      "notification-hook-row-convert-this-hook",
    );
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(accountCloud.pendingPutResolve).not.toBeNull());
    expect(saves).toHaveLength(1);
    expect(saves[0]?.configurationRevision).toBe("host-rev-7");
    expect(saves[0]?.hooks).toEqual([]);
    expect(within(dialog).getByTestId("confirm-cancel")).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByTestId("confirm-action")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(dialog).getByTestId("confirm-cancel"));
    expect(screen.getByTestId("confirm-destructive-dialog")).toBe(dialog);

    settleDeferredAccountPut(503);
    await waitFor(() =>
      expect(within(dialog).getByTestId("confirm-cancel")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(within(dialog).getByTestId("confirm-action")).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.configurationRevision).toBe("host-rev-8");
    expect(saves[1]?.hooks).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull(),
    );
    expect(
      accountCloud.requests.filter((request) => request.method === "PUT"),
    ).toHaveLength(2);
    expect(accountCloud.requests[1]?.body).toEqual({ hooks: [], revision: 17 });
  });

  it("sends oversized host-answered HTTP hooks unchanged and treats authn's 400 as a failed save", async () => {
    const oversizedHostAnswer = {
      id: "hook-" + "i".repeat(300),
      name: "n".repeat(300),
      enabled: true,
      severities: ["failure" as const],
      action: {
        type: "http" as const,
        url: `https://hooks.example/${"u".repeat(3000)}`,
        headers: { "x-long-header": "v".repeat(1200) },
      },
    };
    const { client } = makeHostClient([oversizedHostAnswer], {});
    accountCloud.putFailureStatus = 400;
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
    expect(put?.body).toEqual({
      hooks: [{ ...oversizedHostAnswer, held: false }],
      revision: 17,
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("notification-hooks-manager")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it.each([
    {
      label: "a command hook",
      hook: {
        ...hostAnsweredHttpHook,
        action: { type: "command" as const, command: "/bin/notify", args: [] },
      },
    },
    {
      label: "an interpolating HTTP hook",
      hook: {
        ...hostAnsweredHttpHook,
        action: {
          type: "http" as const,
          url: "https://hooks.example/converted",
          headers: { authorization: "Bearer $TOKEN" },
        },
      },
    },
  ])(
    "refuses a host-answer contract violation for $label without an account write",
    async ({ hook }) => {
      const { client } = makeHostClient([hook], {});
      renderComputerTab(client);

      await convertCommandHookToHttp();

      const dialog = screen.getByRole("dialog");
      expect((await within(dialog).findByRole("alert")).textContent).toBe(
        "The settings request was refused. Review the refreshed hooks before saving again.",
      );
      expect(accountCloud.requests).toEqual([]);
      expect(screen.getByRole("dialog")).toBeTruthy();
    },
  );
});
