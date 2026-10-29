import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

type HooksStatus = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.status"
>;
type HookEntry = HooksStatus["hooks"][number];
type RemovalNotice = HooksStatus["pendingRemovalNotices"][number];
type SaveRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.save"
>;

const CONFIG_PATH = "/Users/me/.traycer/notification-hooks.json";

function hook(
  id: string,
  overrides: Partial<HookEntry> | undefined,
): HookEntry {
  return {
    id,
    name: id,
    enabled: true,
    severities: ["failure"],
    action: { type: "command", command: "/bin/echo", args: [] },
    lastResult: null,
    localOnly: null,
    ...overrides,
  };
}

function notice(id: string, hostName: string, count: number): RemovalNotice {
  return {
    id,
    hostId: mockLocalHostEntry.hostId,
    hostName,
    count,
    occurredAt: 1_700_000_000_000,
  };
}

/**
 * The host's side of the hooks RPCs, which is the external boundary here. It
 * applies a save the way the real service does for a current client: refuse a
 * stale revision, retain a new id as a local-only hook, bump the revision.
 */
class FakeHooksHost {
  hooks: HookEntry[];
  notices: RemovalNotice[];
  revision = 1;
  statusCalls = 0;
  readonly saveRequests: SaveRequest[] = [];

  constructor(hooks: HookEntry[], notices: RemovalNotice[]) {
    this.hooks = hooks;
    this.notices = notices;
  }

  get currentRevision(): string {
    return `rev-${this.revision}`;
  }

  /** Another writer changes the file; the editor on screen did not see it. */
  changeElsewhere(hooks: HookEntry[]): void {
    this.hooks = hooks;
    this.revision += 1;
  }

  status(): HooksStatus {
    this.statusCalls += 1;
    return {
      configPath: CONFIG_PATH,
      configError: null,
      hooks: this.hooks,
      configurationRevision: this.currentRevision,
      pendingRemovalNotices: this.notices,
    };
  }

  save(request: SaveRequest): HooksStatus {
    this.saveRequests.push(request);
    if (request.configurationRevision !== this.currentRevision) {
      throw new Error("Notification hooks changed on this computer.");
    }
    const previous = new Map(
      this.hooks.map((entry) => [entry.id, entry.localOnly]),
    );
    this.hooks = request.hooks.map((next) => ({
      ...next,
      lastResult: null,
      localOnly: previous.has(next.id) ? (previous.get(next.id) ?? null) : true,
    }));
    this.revision += 1;
    return this.status();
  }
}

function renderPanel(host: FakeHooksHost): {
  readonly queryClient: QueryClient;
  readonly unmount: () => void;
} {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-recovery",
      handlers: {
        "host.notifications.getConfig": () => ({
          matrix: {
            info: { renderer: true, email: false },
            needs_action: { renderer: true, email: false },
            failure: { renderer: true, email: false },
            done: { renderer: true, email: false },
          },
          channels: {
            renderer: { lastError: null },
            email: {
              host: "",
              port: 587,
              user: "",
              from: "",
              credentialConfigured: false,
              lastError: null,
            },
          },
        }),
        "host.notificationHooks.status": () => host.status(),
        "host.notificationHooks.save": (params) => host.save(params),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NotificationsSettingsPanelForClient client={client} />
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

function manager(): HTMLElement {
  return screen.getByTestId("notification-hooks-manager");
}

afterEach(cleanup);

describe("hook removal notices in Notifications settings", () => {
  it("shows each pending notice as an inline alert with its own exact sentence", async () => {
    renderPanel(
      new FakeHooksHost(
        [],
        [
          notice("receipt-1", "Work laptop", 2),
          notice("receipt-2", "Studio", 1),
        ],
      ),
    );

    const alerts = await within(
      await screen.findByTestId("notification-hooks-manager"),
    ).findAllByRole("alert");

    expect(alerts.map((alert) => alert.textContent)).toEqual([
      "Notification hooks removedRemoved 2 notification hooks from Work laptop because they could send its private data.",
      "Notification hooks removedRemoved 1 notification hook from Studio because it could send its private data.",
    ]);
  });

  it("shows no alert when nothing was removed", async () => {
    renderPanel(new FakeHooksHost([hook("kept", undefined)], []));

    await screen.findByTestId("notification-hook-row-kept");
    expect(within(manager()).queryByRole("alert")).toBeNull();
  });

  it("marks only a hook that stays on this computer", async () => {
    renderPanel(
      new FakeHooksHost(
        [
          hook("mine", { localOnly: true }),
          hook("synced", { localOnly: false }),
          hook("unknown", { localOnly: null }),
        ],
        [],
      ),
    );

    const mine = await screen.findByTestId("notification-hook-row-mine");
    expect(within(mine).getByText("On this computer")).toBeTruthy();
    for (const id of ["synced", "unknown"]) {
      expect(
        within(screen.getByTestId(`notification-hook-row-${id}`)).queryByText(
          "On this computer",
        ),
      ).toBeNull();
    }
  });
});

describe("adding a hook through the real editor", () => {
  it("saves with the revision it read and keeps the new hook after the status refresh and a remount", async () => {
    const host = new FakeHooksHost([hook("existing", undefined)], []);
    const view = renderPanel(host);
    await screen.findByTestId("notification-hook-row-existing");

    fireEvent.click(
      within(manager()).getAllByRole("button", { name: /Add hook/ })[0],
    );
    await screen.findByRole("heading", { name: "Add hook" });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Pager" },
    });
    fireEvent.change(screen.getByLabelText("Executable"), {
      target: { value: "/usr/local/bin/notify" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    await waitFor(() => {
      expect(host.saveRequests).toHaveLength(1);
    });
    const [request] = host.saveRequests;
    expect(request.configurationRevision).toBe("rev-1");
    expect(request.hooks.map((entry) => entry.id)[0]).toBe("existing");
    const added = request.hooks[1];
    expect(added).toMatchObject({
      name: "Pager",
      action: { type: "command", command: "/usr/local/bin/notify" },
    });

    const row = await screen.findByTestId(`notification-hook-row-${added.id}`);
    expect(within(row).getByText("On this computer")).toBeTruthy();
    expect(host.statusCalls).toBeGreaterThanOrEqual(2);

    view.unmount();
    renderPanel(host);
    const remounted = await screen.findByTestId(
      `notification-hook-row-${added.id}`,
    );
    expect(within(remounted).getByText("On this computer")).toBeTruthy();
    expect(screen.getByTestId("notification-hook-row-existing")).toBeTruthy();
  });
});

describe("saving from an editor opened before the hooks changed", () => {
  it("sends the revision it was opened on, then reloads with an actionable error and never retries", async () => {
    const host = new FakeHooksHost([hook("edit-me", { name: "Pager" })], []);
    const view = renderPanel(host);
    await screen.findByTestId("notification-hook-row-edit-me");
    fireEvent.click(within(manager()).getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { name: "Edit hook" });

    // A background refetch lands while the editor is open and shows a newer
    // list; the draft on screen still belongs to the earlier read.
    host.changeElsewhere([
      hook("edit-me", { name: "Pager" }),
      hook("someone-elses", undefined),
    ]);
    const callsBefore = host.statusCalls;
    await view.queryClient.invalidateQueries();
    await waitFor(() => {
      expect(host.statusCalls).toBeGreaterThan(callsBefore);
    });

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    await waitFor(() => {
      expect(host.saveRequests).toHaveLength(1);
    });
    expect(host.saveRequests[0].configurationRevision).toBe("rev-1");
    expect(host.saveRequests[0].hooks.map((entry) => entry.id)).toEqual([
      "edit-me",
    ]);

    const alert = await within(manager()).findByRole("alert");
    expect(alert.textContent).toMatch(
      /Review the refreshed hooks before saving again\.$/,
    );
    expect(screen.queryByRole("heading", { name: "Edit hook" })).toBeNull();
    await screen.findByTestId("notification-hook-row-someone-elses");

    // Settle any queued work, then prove nothing re-sent the save.
    await waitFor(() => {
      expect(
        view.queryClient.isFetching() + view.queryClient.isMutating(),
      ).toBe(0);
    });
    expect(host.saveRequests).toHaveLength(1);

    // A deliberate second save works from the refreshed read.
    fireEvent.click(
      within(screen.getByTestId("notification-hook-row-edit-me")).getByRole(
        "button",
        { name: "Edit" },
      ),
    );
    await screen.findByRole("heading", { name: "Edit hook" });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));
    await waitFor(() => {
      expect(host.saveRequests).toHaveLength(2);
    });
    expect(host.saveRequests[1].configurationRevision).toBe("rev-2");
    expect(host.saveRequests[1].hooks.map((entry) => entry.id)).toEqual([
      "edit-me",
      "someone-elses",
    ]);
  });
});
