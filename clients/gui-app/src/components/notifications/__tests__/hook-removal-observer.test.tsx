import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { HookRemovalObserver } from "@/components/notifications/hook-removal-observer";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  displayNotificationRows,
  notificationReplaceKey,
} from "@/lib/notifications/notification-display";
import type { NotificationNavigate } from "@/lib/notifications";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

interface ShownToast {
  readonly title: unknown;
  readonly options: {
    readonly id: string;
    readonly description: string | undefined;
    readonly duration: number | undefined;
    readonly action: { label: string; onClick: () => void } | undefined;
  };
}

const toastMock = vi.hoisted<{
  shown: ShownToast[];
  dismissed: string[];
}>(() => ({ shown: [], dismissed: [] }));

vi.mock("sonner", () => {
  const toast = Object.assign(
    (title: unknown, options: ShownToast["options"]): string => {
      toastMock.shown.push({ title, options });
      return options.id;
    },
    {
      dismiss: (id: string): void => {
        toastMock.dismissed.push(id);
      },
    },
  );
  return { toast };
});

type HooksStatus = ResponseOfMethod<
  HostRpcRegistry,
  "host.notificationHooks.status"
>;

const HOST_ID = mockLocalHostEntry.hostId;

function pendingStatus(
  notices: HooksStatus["pendingRemovalNotices"],
): HooksStatus {
  return {
    configPath: "/home/me/.traycer/notification-hooks.json",
    configError: null,
    hooks: [],
    configurationRevision: "rev-1",
    pendingRemovalNotices: notices,
  };
}

function removalNotice(id: string, hostName: string, count: number) {
  return {
    id,
    hostId: HOST_ID,
    hostName,
    count,
    occurredAt: 1_700_000_000_000,
  };
}

function mountObserver(
  status: { current: HooksStatus },
  navigate: NotificationNavigate,
): { readonly queryClient: QueryClient; readonly unmount: () => void } {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-observer",
      handlers: { "host.notificationHooks.status": () => status.current },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <HookRemovalObserver client={client} navigate={navigate} />
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

describe("<HookRemovalObserver />", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    toastMock.shown.length = 0;
    toastMock.dismissed.length = 0;
    useSettingsHostScopeStore.setState({ scopedHostId: null });
  });
  afterEach(cleanup);

  it("announces a pending removal on connection, outside Settings, once per receipt", async () => {
    const status = {
      current: pendingStatus([
        removalNotice("receipt-1", "Work laptop", 2),
        removalNotice("receipt-2", "Studio", 1),
      ]),
    };
    const view = mountObserver(status, vi.fn());

    await waitFor(() => {
      expect(toastMock.shown).toHaveLength(2);
    });
    expect(
      toastMock.shown.map(({ title, options }) => [
        title,
        options.id,
        options.description,
        options.duration,
      ]),
    ).toEqual([
      [
        "Notification hooks removed",
        "host:id:receipt-1",
        "Removed 2 notification hooks from Work laptop because they could send its private data.",
        Infinity,
      ],
      [
        "Notification hooks removed",
        "host:id:receipt-2",
        "Removed 1 notification hook from Studio because it could send its private data.",
        Infinity,
      ],
    ]);

    // A later refresh that still reports the receipt is the same event.
    await view.queryClient.invalidateQueries();
    await waitFor(() => {
      expect(view.queryClient.isFetching()).toBe(0);
    });
    expect(toastMock.shown).toHaveLength(2);
  });

  it("opens that computer's Notifications settings from Review hooks", async () => {
    const navigate = vi.fn();
    mountObserver(
      {
        current: pendingStatus([removalNotice("receipt-1", "Work laptop", 2)]),
      },
      navigate,
    );
    await waitFor(() => {
      expect(toastMock.shown).toHaveLength(1);
    });
    const action = toastMock.shown[0].options.action;
    expect(action?.label).toBe("Review hooks");

    action?.onClick();

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/notifications" }),
    );
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(HOST_ID);
  });

  it("dismisses the announcement once the host stops reporting the receipt", async () => {
    const status = {
      current: pendingStatus([removalNotice("receipt-1", "Work laptop", 2)]),
    };
    const view = mountObserver(status, vi.fn());
    await waitFor(() => {
      expect(toastMock.shown).toHaveLength(1);
    });

    status.current = pendingStatus([]);
    await view.queryClient.invalidateQueries();

    await waitFor(() => {
      expect(toastMock.dismissed).toEqual(["host:id:receipt-1"]);
    });
  });

  it("shares its toast id with the published notice, so the entry replaces it", () => {
    const published: MergedNotificationRow = {
      feedId: "host:receipt-1",
      source: "host",
      sourceId: "receipt-1",
      originHostId: HOST_ID,
      providerPackAttribution: null,
      createdAt: 1_700_000_000_000,
      readAt: null,
      title: "Notification hooks removed",
      body: "Removed 2 notification hooks from Work laptop because they could send its private data.",
      payload: {
        kind: "hostSurface",
        surface: "notificationSettings",
        hostId: HOST_ID,
        focus: undefined,
      },
      hostKind: "notification.hooks.removed",
      appLocalKind: null,
      globalEntry: null,
      severity: "info",
      outcome: "completed",
      resolvedAt: null,
      sourceRef: "receipt-1",
      category: "system",
    };
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    displayNotificationRows(
      [published],
      {
        showNotification: vi.fn(() =>
          Promise.resolve<"presented">("presented"),
        ),
        playChime: vi.fn(),
        onToastClick: vi.fn(),
      },
      HOST_ID,
    );

    expect(notificationReplaceKey(published)).toBe("host:id:receipt-1");
    expect(toastMock.shown.map(({ options }) => options.id)).toEqual([
      "host:id:receipt-1",
    ]);
  });
});
