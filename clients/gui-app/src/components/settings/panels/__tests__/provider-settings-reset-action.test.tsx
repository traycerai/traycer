import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys";

const clientHolder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

// `useHostClient` reads the host runtime context, which this suite does not
// stand up; everything under it (the mutation, the request, the invalidation)
// is real.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientHolder.client };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from "sonner";
import {
  PROVIDER_SETTINGS_RESET_CONSENT,
  PROVIDER_SETTINGS_RESET_LABEL,
  PROVIDER_SETTINGS_RESET_TITLE,
  ProviderSettingsResetAction,
} from "@/components/settings/panels/provider-settings-reset-action";

type ResetRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.settingsFile.reset"
>;
type ResetResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.settingsFile.reset"
>;

const HOST_ID = "host-a";
const MOVED_ASIDE = "provider-overrides.json.unreadable-X";

interface Harness {
  readonly queryClient: QueryClient;
  readonly resetRequests: ResetRequest[];
  /** How many times each observed read ran, by label. */
  readonly reads: Map<string, number>;
  readonly respondWith: (response: ResetResponse) => void;
}

function setUpHarness(): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const resetRequests: ResetRequest[] = [];
  let response: ResetResponse = {
    outcome: "reset",
    movedAsideFileName: MOVED_ASIDE,
    providersNotRestarted: [],
  };
  const host = { ...mockLocalHostEntry, hostId: HOST_ID };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => (hostId === host.hostId ? host : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.settingsFile.reset": (params) => {
          resetRequests.push(params);
          return Promise.resolve(response);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  clientHolder.client = spine.createRequester(host);

  // Stand-ins for the two reads a reset must refresh. Each counts how many
  // times it ran, so a refetch shows as a second run.
  const reads = new Map<string, number>();
  const observe = (key: QueryKey, label: string): void => {
    const observer = new QueryObserver<unknown>(queryClient, {
      queryKey: key,
      queryFn: () => {
        reads.set(label, (reads.get(label) ?? 0) + 1);
        return Promise.resolve({});
      },
      staleTime: Infinity,
      retry: false,
    });
    observer.subscribe(() => undefined);
  };
  observe(
    hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    ),
    "providers.list",
  );
  observe(
    hostQueryKeys.method<HostRpcRegistry, "providers.settingsFile.status">(
      HOST_ID,
      "providers.settingsFile.status",
      {},
    ),
    "providers.settingsFile.status",
  );

  return {
    queryClient,
    resetRequests,
    reads,
    respondWith: (next) => {
      response = next;
    },
  };
}

function renderAction(harness: Harness): void {
  render(
    <QueryClientProvider client={harness.queryClient}>
      <ProviderSettingsResetAction />
    </QueryClientProvider>,
  );
}

function openDialog(): HTMLElement {
  fireEvent.click(
    screen.getByRole("button", { name: PROVIDER_SETTINGS_RESET_LABEL }),
  );
  return screen.getByRole("dialog", { name: PROVIDER_SETTINGS_RESET_TITLE });
}

function confirm(dialog: HTMLElement): void {
  fireEvent.click(
    within(dialog).getByRole("button", { name: PROVIDER_SETTINGS_RESET_LABEL }),
  );
}

describe("<ProviderSettingsResetAction />", () => {
  let harness: Harness;

  beforeEach(async () => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.info).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    harness = setUpHarness();
    // Let the two stand-in reads run once so a reset's refetch is countable.
    await waitFor(() => {
      expect(harness.reads.get("providers.list")).toBe(1);
      expect(harness.reads.get("providers.settingsFile.status")).toBe(1);
    });
  });

  afterEach(() => {
    cleanup();
    harness.queryClient.clear();
    clientHolder.client = null;
  });

  it("states what the reset costs and sends nothing until it is confirmed", () => {
    renderAction(harness);

    const dialog = openDialog();

    expect(
      within(dialog).getByText(PROVIDER_SETTINGS_RESET_CONSENT),
    ).toBeDefined();
    expect(harness.resetRequests).toHaveLength(0);
  });

  it("sends nothing when the dialog is cancelled", () => {
    renderAction(harness);

    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(harness.resetRequests).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("sends one reset with empty params, names the moved-aside file, and refetches the list and the status", async () => {
    renderAction(harness);

    confirm(openDialog());

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledTimes(1);
    });
    expect(harness.resetRequests).toEqual([{}]);
    expect(vi.mocked(toast.success).mock.calls.at(0)?.[0]).toContain(
      MOVED_ASIDE,
    );
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(harness.reads.get("providers.list")).toBe(2);
      expect(harness.reads.get("providers.settingsFile.status")).toBe(2);
    });
    // The dialog closes once the request settles.
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: PROVIDER_SETTINGS_RESET_TITLE }),
      ).toBeNull();
    });
  });

  it("a committed reset whose providers could not all be restarted shows the backup name and to restart this host, and refreshes what the panel shows", async () => {
    harness.respondWith({
      outcome: "reset",
      movedAsideFileName: MOVED_ASIDE,
      providersNotRestarted: ["opencode"],
    });
    renderAction(harness);

    confirm(openDialog());

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });
    const message = vi.mocked(toast.warning).mock.calls.at(0)?.[0];
    expect(message).toContain(MOVED_ASIDE);
    // The scoped host, which can be a remote one: restarting the app here
    // would not restart the processes over there.
    expect(message).toContain("Restart this host");
    expect(message).not.toContain("Restart Traycer");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(harness.resetRequests).toEqual([{}]);
    await waitFor(() => {
      expect(harness.reads.get("providers.list")).toBe(2);
      expect(harness.reads.get("providers.settingsFile.status")).toBe(2);
    });
  });

  it("says nothing was reset when the host found the settings readable", async () => {
    harness.respondWith({ outcome: "readable" });
    renderAction(harness);

    confirm(openDialog());

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(toast.info).mock.calls.at(0)?.[0]).toMatch(
      /nothing was reset/,
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(harness.resetRequests).toEqual([{}]);
  });
});
