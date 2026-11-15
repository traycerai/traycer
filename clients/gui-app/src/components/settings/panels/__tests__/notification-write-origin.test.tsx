import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import type {
  EnvironmentCloud,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { CloudNotificationHook } from "@traycer-clients/shared/environment/notification-hook-values";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import type { ConfigurationSource } from "@/components/settings/environment/configuration-source";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";
import { TeamNotificationHooksSettingsPanel } from "@/components/settings/environment/team-notification-hooks-settings-panel";
import { useAccountNotificationMatrixSave } from "@/hooks/notifications/use-account-notification-settings";
import { notificationsQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

interface SignInFixture {
  readonly signInId: string;
  readonly accountId: string;
  active: boolean;
  bearer: string;
}

interface RecordedRequest {
  readonly signInId: string;
  readonly request: EnvironmentTransportRequest;
}

interface OriginFixtures {
  cloud: EnvironmentCloud | null;
  requests: RecordedRequest[];
  teamHooks: CloudNotificationHook[];
  binding: HostRuntimeBinding<HostRpcRegistry> | null;
  refreshCalls: number;
}

const originFixtures = vi.hoisted((): OriginFixtures => ({
  cloud: null,
  requests: [],
  teamHooks: [],
  binding: null,
  refreshCalls: 0,
}));

vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => () => {
    const cloud = originFixtures.cloud;
    if (cloud === null) throw new Error("A cloud fixture is required.");
    return cloud;
  },
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return { ...actual, useCloudChatViewerId: () => "viewer-1" };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => originFixtures.binding };
});

vi.mock("@/lib/host/refresh-connected-account-settings", () => ({
  refreshConnectedAccountSettings: () => {
    originFixtures.refreshCalls += 1;
    return Promise.resolve();
  },
}));

vi.mock("@/hooks/environment/team/use-configuration-items-query", () => ({
  useConfigurationItemsQuery: () => ({
    data: { hooks: originFixtures.teamHooks, revision: 7 },
    error: null,
    isFetching: false,
    isLoading: false,
  }),
}));

vi.mock("@/components/settings/environment/team-pick-label", () => ({
  useConfigurationName: () => "Acme",
}));

vi.mock(
  "@/stores/settings/settings-environment-pick-store",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/stores/settings/settings-environment-pick-store")
    >()),
    useEnvironmentPick: () => ({ kind: "team", environmentId: "team-1" }),
  }),
);

const initialMatrix = {
  needs_action: { renderer: true },
  failure: { renderer: true },
  done: { renderer: false },
  info: { renderer: false },
};

const accountHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http" as const,
    url: "https://hooks.example/builds",
    headers: { authorization: "Bearer literal-value" },
  },
  held: false,
};

const accountResponse: AccountNotificationSettingsResponse = {
  revision: 7,
  settings: { matrix: initialMatrix, hooks: [accountHook] },
};

const teamHook: CloudNotificationHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http",
    url: "https://hooks.example/builds",
    headers: { authorization: "Bearer literal-value" },
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null)
        throw new Error("The deferred promise has no resolver.");
      resolvePromise(value);
    },
  };
}

function signIn(signInId: string, accountId: string): SignInFixture {
  return { signInId, accountId, active: true, bearer: `${signInId}-token` };
}

function cloudFor(session: SignInFixture): EnvironmentCloud {
  return {
    authnBaseUrl: "https://authn.example/",
    bearer: {
      kind: "cloud",
      getBearerToken: () => session.bearer,
    },
    transport: (request) => {
      originFixtures.requests.push({ signInId: session.signInId, request });
      if (request.url.endsWith("/api/v3/user/notification-settings"))
        return Promise.resolve({
          status: 200,
          text: JSON.stringify(accountResponse),
        });
      return Promise.resolve({ status: 204, text: "" });
    },
    onOriginSignIn: () => session.active,
  };
}

function useSignIn(session: SignInFixture): void {
  originFixtures.cloud = cloudFor(session);
  useAuthStore.setState({ status: "signed-in" });
  // The refresh helper is mocked at its boundary. The sentinel is only used
  // to make a normally refresh-eligible save prove that stale saves skip it.
  originFixtures.binding = Object.create(
    null,
  ) as HostRuntimeBinding<HostRpcRegistry>;
}

function makeMutationClient(
  gates: readonly Deferred<void>[],
  starts: readonly Deferred<void>[],
): QueryClient {
  let index = 0;
  return new QueryClient({
    mutationCache: new MutationCache({
      onMutate: async () => {
        const gate = gates[index];
        const started = starts[index];
        index += 1;
        started.resolve(undefined);
        await gate.promise;
      },
    }),
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function accountPanel(queryClient: QueryClient) {
  queryClient.setQueryData(
    notificationsQueryKeys.accountSettings("viewer-1"),
    accountResponse,
  );
  return render(<NotificationsSettingsPanel />, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

function teamSource(): ConfigurationSource {
  return {
    kind: "pool",
    configuration: "team",
    environmentId: "team-1",
    roomId: "room-1",
    providerHandle: "handle-1",
    effectiveRole: "admin",
  };
}

function teamPanel(queryClient: QueryClient) {
  return render(<TeamNotificationHooksSettingsPanel />, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ConfigurationSourceContext.Provider value={teamSource()}>
          {props.children}
        </ConfigurationSourceContext.Provider>
      </QueryClientProvider>
    ),
  });
}

afterEach(() => {
  cleanup();
  originFixtures.cloud = null;
  originFixtures.requests = [];
  originFixtures.teamHooks = [];
  originFixtures.binding = null;
  originFixtures.refreshCalls = 0;
  useAuthStore.setState({ status: "signed-out" });
});

describe("notification save sign-in ownership", () => {
  it("abandons an account matrix save after an account switch while Query onMutate is deferred", async () => {
    const oldSession = signIn("session-a", "account-a");
    useSignIn(oldSession);
    const gate = deferred<void>();
    const started = deferred<void>();
    const client = makeMutationClient([gate], [started]);
    accountPanel(client);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    fireEvent.click(
      screen.getByRole("switch", { name: "Done In-app notifications" }),
    );
    await act(async () => started.promise);

    oldSession.active = false;
    const newSession = signIn("session-b", "account-b");
    originFixtures.cloud = cloudFor(newSession);
    gate.resolve(undefined);

    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Done In-app notifications" })
          .getAttribute("data-state"),
      ).toBe("unchecked");
    });
    expect(originFixtures.requests).toEqual([]);
    expect(originFixtures.refreshCalls).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("abandons an account hook save after same-account re-entry without closing or reporting an error", async () => {
    const oldSession = signIn("session-a", "same-account");
    useSignIn(oldSession);
    const gate = deferred<void>();
    const started = deferred<void>();
    const client = makeMutationClient([gate], [started]);
    accountPanel(client);
    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts revised" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));
    await act(async () => started.promise);

    oldSession.active = false;
    const reenteredSession = signIn("session-b", "same-account");
    expect(reenteredSession.accountId).toBe(oldSession.accountId);
    originFixtures.cloud = cloudFor(reenteredSession);
    gate.resolve(undefined);

    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog"))
          .getByRole("button", {
            name: "Save hook",
          })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(originFixtures.requests).toEqual([]);
    expect(originFixtures.refreshCalls).toBe(0);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("abandons a team item save after its sign-in ends while Query onMutate is deferred", async () => {
    const oldSession = signIn("session-a", "account-a");
    useSignIn(oldSession);
    originFixtures.teamHooks = [teamHook];
    const gate = deferred<void>();
    const started = deferred<void>();
    const client = makeMutationClient([gate], [started]);
    teamPanel(client);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Add hook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Release alerts" },
    });
    fireEvent.change(within(dialog).getByLabelText("URL"), {
      target: { value: "https://hooks.example/releases" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));
    await act(async () => started.promise);

    oldSession.active = false;
    originFixtures.cloud = cloudFor(signIn("session-b", "account-b"));
    gate.resolve(undefined);

    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog"))
          .getByRole("button", {
            name: "Save hook",
          })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(originFixtures.requests).toEqual([]);
    expect(originFixtures.refreshCalls).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("continues an account matrix save through same-sign-in bearer rotation", async () => {
    const session = signIn("session-a", "account-a");
    useSignIn(session);
    const gate = deferred<void>();
    const started = deferred<void>();
    const client = makeMutationClient([gate], [started]);
    accountPanel(client);

    fireEvent.click(
      screen.getByRole("switch", { name: "Done In-app notifications" }),
    );
    await act(async () => started.promise);
    session.bearer = "rotated-token";
    gate.resolve(undefined);

    await waitFor(() =>
      expect(
        originFixtures.requests.some(({ request }) => request.method === "PUT"),
      ).toBe(true),
    );
    const put = originFixtures.requests.find(
      ({ request }) => request.method === "PUT",
    );
    expect(put?.request.headers.Authorization).toBe("Bearer rotated-token");
    expect(originFixtures.refreshCalls).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the newer same-object mutation observed when an older re-entered sign-in settles", async () => {
    const oldSession = signIn("session-a", "same-account");
    useSignIn(oldSession);
    originFixtures.binding = null;
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const client = makeMutationClient(
      [firstGate, secondGate],
      [firstStarted, secondStarted],
    );
    const wrapper = (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAccountNotificationMatrixSave(), {
      wrapper,
    });
    const request = { matrix: initialMatrix, revision: 7 };
    const firstCallbacks = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onSettled: vi.fn(),
    };
    const secondCallbacks = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onSettled: vi.fn(),
    };
    const firstOutcomes: Array<
      Promise<AccountNotificationSettingsResponse | null>
    > = [];
    act(() => {
      firstOutcomes.push(
        result.current.mutateAsync(request, firstCallbacks).then(
          (response) => response,
          () => null,
        ),
      );
    });
    await act(async () => firstStarted.promise);
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    const firstVariables = result.current.variables;

    oldSession.active = false;
    const reenteredSession = signIn("session-b", "same-account");
    expect(reenteredSession.accountId).toBe(oldSession.accountId);
    originFixtures.cloud = cloudFor(reenteredSession);
    const secondOutcomes: Array<Promise<AccountNotificationSettingsResponse>> =
      [];
    act(() => {
      secondOutcomes.push(result.current.mutateAsync(request, secondCallbacks));
    });
    await act(async () => secondStarted.promise);
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
      expect(result.current.variables).not.toBe(firstVariables);
    });
    const secondVariables = result.current.variables;
    const firstOutcome = firstOutcomes[0];
    const secondOutcome = secondOutcomes[0];

    firstGate.resolve(undefined);
    await act(async () => firstOutcome);

    expect(result.current.isPending).toBe(true);
    expect(result.current.variables).toBe(secondVariables);
    expect(result.current.variables).toEqual(request);
    expect(firstCallbacks.onSuccess).not.toHaveBeenCalled();
    expect(firstCallbacks.onError).not.toHaveBeenCalled();
    expect(firstCallbacks.onSettled).not.toHaveBeenCalled();
    expect(originFixtures.requests).toEqual([]);

    secondGate.resolve(undefined);
    await act(async () => secondOutcome);

    expect(
      originFixtures.requests.filter(
        ({ request: sent }) => sent.method === "PUT",
      ),
    ).toHaveLength(1);
    expect(originFixtures.requests[0]?.signInId).toBe("session-b");
    expect(secondCallbacks.onSuccess).toHaveBeenCalledTimes(1);
    expect(secondCallbacks.onError).not.toHaveBeenCalled();
    expect(secondCallbacks.onSettled).toHaveBeenCalledTimes(1);
  });
});
