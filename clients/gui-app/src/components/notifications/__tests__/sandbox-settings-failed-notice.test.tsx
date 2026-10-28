import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useRef } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  environmentStatusResponseSchemaV11,
  type EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import {
  hostNotificationsCloudFeedRowSchemaV16,
  type HostNotificationsCloudFeedRowV16,
} from "@traycer/protocol/host/notifications/contracts";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  closeSandboxDetails,
  useSandboxDetailsStore,
} from "@/stores/sandboxes/sandbox-details-store";

interface NotificationBinding extends FakeSandboxBinding {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly directory: FakeSandboxBinding["directory"] & {
    readonly getLocalEntry: () => HostDirectoryEntry;
    readonly onChange: () => { readonly dispose: () => void };
  };
}
const state = vi.hoisted(() => ({
  binding: null as NotificationBinding | null,
  client: null as HostRequester<HostRpcRegistry> | null,
}));
// These cases are about the sandboxes-on behaviour: the notice is driven by the
// sandbox list, and `usePreviewFeature` reads the user record through
// `useAuthUser`, which this harness mounts no `HostRuntimeProvider` for.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof import("@/lib/host")>()),
  useHostBinding: () => state.binding,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (original) => ({
  ...(await original<typeof import("@/hooks/host/use-host-directory-entry")>()),
  useHostDirectoryEntry: () => mockLocalHostEntry,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (original) => ({
  ...(await original<typeof import("@/hooks/host/use-host-supports-method")>()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => mockLocalHostEntry.hostId,
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: state.client,
  }),
}));
vi.mock("@/lib/notifications/notification-feed-mode", async (original) => ({
  ...(await original<
    typeof import("@/lib/notifications/notification-feed-mode")
  >()),
  useNotificationFeedMode: () => "cloud",
  useNotificationFeedModeSettling: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", async (original) => ({
  ...(await original<
    typeof import("@/hooks/sandboxes/use-sandbox-configurations")
  >()),
  useSandboxConfigurations: () => ({
    configurations: [{ kind: "personal" }],
    complete: true,
  }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const HOST_ID = mockLocalHostEntry.hostId;
const SANDBOX_ID = "sbx-settings";
const COMPUTE_CHARGED = "Compute is charged while it is awake.";
const STEPS = "Variables did not apply.";
const auth = createFakeSandboxBinding();
let queryClient: QueryClient;
let repairs: number;

function status(): EnvironmentStatusResponseV11 {
  const item = (key: string, itemStatus: string) => ({
    kind: "variable",
    key,
    os: "any",
    desiredRevision: 5,
    status: itemStatus,
    code: "ok",
    args: { exitStatus: null, stage: null, durationMs: null, kind: null },
    brokerEnforced: null,
    minimumHostVersion: null,
    appliedAs: null,
  });
  return environmentStatusResponseSchemaV11.parse({
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 5,
    receivedRevision: 5,
    appliedRevision: 5,
    receiptAgeMs: 0,
    remoteAccess: "on",
    pendingUploads: [],
    setup: null,
    sandboxSettingsOperationId: "attempt-1",
    items: [
      item("variable/test", "failed"),
      { ...item("skill/review", "applied"), kind: "skill" },
      { ...item("cursor:CURSOR_API_KEY", "not_used"), kind: "secret" },
    ],
  });
}

function notice(): HostNotificationsCloudFeedRowV16 {
  return {
    entryId: "entry-settings",
    originHostId: "cloud-settings",
    coalesceKey: "entry-settings",
    presentation: { epicTitle: null, chatTitle: null },
    entry: {
      id: "entry-settings",
      updatedAt: Date.now(),
      readAt: null,
      kind: "environment.apply.failed",
      sourceRef: "entry-settings",
      severity: "needs_action",
      epicId: null,
      chatId: null,
      outcome: "errored",
      payload: {
        kind: "environment_apply_failed",
        environmentId: "env_01J0000000000000000000A",
        hostId: HOST_ID,
        hostName: "build-box",
        itemKey: "settings",
        reason: "settings_not_applied",
        sandbox: {
          sandboxId: SANDBOX_ID,
          operationId: "attempt-1",
          name: "build-box",
          configurationName: "Personal",
          attemptId: "attempt-1",
          applied: [],
          notApplied: ["Variables"],
        },
      },
    },
  };
}

function listRows(rows: readonly SandboxSummary[]): void {
  auth.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: { sandboxes: [...rows] },
  });
}

function row(state: SandboxSummary["state"]): SandboxSummary {
  return sandboxSummaryFixture({
    id: SANDBOX_ID,
    hostId: HOST_ID,
    displayName: "build-box",
    state,
    guestConfigured: true,
    createdBy: null,
  });
}

function Shell() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <NotificationsPopover
        variant="center"
        onNavigate={() => undefined}
        headingRef={headingRef}
        shellRef={shellRef}
        shellStyle={{}}
        onFilterMenuOpenChange={() => undefined}
      />
      <SandboxDetailsDrawerHost />
    </>
  );
}

async function mountNotice(): Promise<HTMLElement> {
  useCloudNotificationsStore.setState({ accountId: "settings-user" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [hostNotificationsCloudFeedRowSchemaV16.parse(notice())],
    summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
    version: 1,
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: Shell }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return screen.findByTestId("notification-entry");
}

function occurrences(text: string, of: string): number {
  return text.split(of).length - 1;
}

beforeEach(() => {
  recordNegotiatedHostManifest(HOST_ID, {
    "host.sandbox.repairGuestConfiguration": { major: 1, minor: 1 },
  });
  auth.auth.listSandboxes.mockReset();
  listRows([row("awake")]);
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "settings-user", userName: "U", email: "u@example.com" },
      { userId: "settings-user", username: "U" },
      [],
    );
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useCloudNotificationsStore.getState().reset();
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries: [], nextCursor: null },
    recent: { entries: [], nextCursor: null },
    summary: { unreadCount: 0, attentionCount: 0 },
  });
  useNotificationsPopoverStore.getState().setOpen(false);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  repairs = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => crypto.randomUUID(),
    handlers: {
      "environment.status": () => Promise.resolve(status()),
      "host.sandbox.repairGuestConfiguration": () => {
        repairs += 1;
        return Promise.resolve({
          guestConfigured: true,
          guestConfigFailureReason: null,
          settingsApplied: false,
        });
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  state.client = client.createRequester(mockLocalHostEntry);
  state.binding = {
    ...auth,
    hostClient: client,
    directory: {
      ...auth.directory,
      getLocalEntry: () => mockLocalHostEntry,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
});

afterEach(() => {
  closeSandboxDetails();
  cleanup();
  resetNegotiatedManifests();
  queryClient.clear();
  state.client = null;
  state.binding = null;
  useCloudNotificationsStore.getState().reset();
  useAuthStore.getState().setSignedOut();
});

describe("a sandbox's settings-failure notice in the bell", () => {
  it("prints its explanation once, under the one line", async () => {
    const entry = await mountNotice();
    await within(entry).findByRole("button", { name: "Retry applying" });

    expect(within(entry).getByTestId("notification-title").textContent).toBe(
      "build-box is awake, but Personal's settings didn't apply · SBX-0520",
    );
    expect(occurrences(entry.textContent, COMPUTE_CHARGED)).toBe(1);
    expect(occurrences(entry.textContent, STEPS)).toBe(1);
  });

  it("offers the awake actions with one Details, the sandbox's own, which lists Settings delivery", async () => {
    const entry = await mountNotice();
    await within(entry).findByRole("button", { name: "Retry applying" });

    expect(
      within(entry)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((label) =>
          [
            "Retry applying",
            "Open terminal",
            "Stop",
            "Choose another host",
            "Details",
          ].includes(label),
        ),
    ).toEqual([
      "Retry applying",
      "Open terminal",
      "Stop",
      "Choose another host",
      "Details",
    ]);

    fireEvent.click(within(entry).getByRole("button", { name: "Details" }));
    expect(useSandboxDetailsStore.getState().sandboxId).toBe(SANDBOX_ID);
    const delivery = await screen.findByTestId(
      "sandbox-details-settings-delivery",
    );
    await waitFor(() => {
      expect(delivery.textContent).toContain(
        "Cursor key · not used on sandboxes",
      );
    });
    expect(delivery.textContent).toContain("Skills");
    expect(delivery.textContent).toContain("Variables");
    expect(delivery.textContent).not.toMatch(/CURSOR_API_KEY|cursor:/);
  });

  it.each(["suspending", "suspended"] as const)(
    "says nothing of an awake, charged sandbox and offers no Retry applying once the row is %s",
    async (rowState) => {
      listRows([row(rowState)]);
      const entry = await mountNotice();
      await waitFor(() => {
        expect(
          within(entry).getByTestId("notification-title").textContent,
        ).toBe("Personal's settings didn't apply on build-box · SBX-0520");
      });

      expect(entry.textContent).not.toContain("is awake");
      expect(entry.textContent).not.toContain(COMPUTE_CHARGED);
      expect(occurrences(entry.textContent, STEPS)).toBe(1);
      expect(
        within(entry).queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
      expect(
        within(entry).getAllByRole("button", { name: "Details" }),
      ).toHaveLength(1);
    },
  );

  it("offers no Retry applying for a destroyed sandbox, only its Details", async () => {
    listRows([]);
    const entry = await mountNotice();
    await waitFor(() => {
      expect(within(entry).getByTestId("notification-title").textContent).toBe(
        "Personal's settings didn't apply on build-box · SBX-0520",
      );
    });

    expect(entry.textContent).not.toContain(COMPUTE_CHARGED);
    expect(
      within(entry).queryByRole("button", { name: "Retry applying" }),
    ).toBeNull();
    const details = within(entry).getAllByRole("button", { name: "Details" });
    expect(details).toHaveLength(1);
    fireEvent.click(details[0]);
    expect(useSandboxDetailsStore.getState().sandboxId).toBe(SANDBOX_ID);
    expect(repairs).toBe(0);
  });
});
