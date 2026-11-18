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
import { ProviderRowResetAction } from "@/components/settings/panels/provider-settings-reset-action";
import {
  providerRowResetConsent,
  providerRowResetLabel,
} from "@/components/settings/panels/provider-row-reset-copy";

type ResetProviderRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.settingsFile.resetProvider"
>;
type ResetProviderResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.settingsFile.resetProvider"
>;

const HOST_ID = "host-a";
const BACKUP = "provider-overrides.json.droid-unreadable-X";
const EARLIER_BACKUP = "provider-overrides.json.droid-unreadable-W";
const LABEL = "Droid";

interface Harness {
  readonly queryClient: QueryClient;
  readonly requests: ResetProviderRequest[];
  readonly reads: Map<string, number>;
  readonly respondWith: (response: ResetProviderResponse) => void;
}

function setUpHarness(): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const requests: ResetProviderRequest[] = [];
  let response: ResetProviderResponse = {
    outcome: "reset",
    backupFileName: BACKUP,
    backupFileNames: [BACKUP],
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
        "providers.settingsFile.resetProvider": (params) => {
          requests.push(params);
          return Promise.resolve(response);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  clientHolder.client = spine.createRequester(host);

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
    hostQueryKeys.method<HostRpcRegistry, "providers.settingsFile.status">(
      HOST_ID,
      "providers.settingsFile.status",
      {},
    ),
    "providers.settingsFile.status",
  );

  return {
    queryClient,
    requests,
    reads,
    respondWith: (next) => {
      response = next;
    },
  };
}

function renderAction(harness: Harness): void {
  render(
    <QueryClientProvider client={harness.queryClient}>
      <ProviderRowResetAction providerId="droid" providerLabel={LABEL} />
    </QueryClientProvider>,
  );
}

function openDialog(): HTMLElement {
  fireEvent.click(
    screen.getByRole("button", { name: providerRowResetLabel(LABEL) }),
  );
  return screen.getByRole("dialog", {
    name: `${providerRowResetLabel(LABEL)}?`,
  });
}

function confirm(dialog: HTMLElement): void {
  fireEvent.click(
    within(dialog).getByRole("button", { name: providerRowResetLabel(LABEL) }),
  );
}

describe("<ProviderRowResetAction />", () => {
  let harness: Harness;

  beforeEach(async () => {
    for (const fn of [toast.success, toast.info, toast.error, toast.warning]) {
      vi.mocked(fn).mockClear();
    }
    harness = setUpHarness();
    await waitFor(() => {
      expect(harness.reads.get("providers.settingsFile.status")).toBe(1);
    });
  });

  afterEach(() => {
    cleanup();
    harness.queryClient.clear();
    clientHolder.client = null;
  });

  it("says a copy is kept and the provider may be turned off, and sends nothing until confirmed", () => {
    renderAction(harness);

    const dialog = openDialog();

    expect(
      within(dialog).getByText(providerRowResetConsent(LABEL)),
    ).toBeTruthy();
    expect(providerRowResetConsent(LABEL)).toContain("may be turned off");
    expect(providerRowResetConsent(LABEL)).toContain("keep a copy");
    expect(harness.requests).toEqual([]);
  });

  it("resets only that provider, names the backup and refreshes the file status", async () => {
    renderAction(harness);

    confirm(openDialog());

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        `Droid settings reset. A copy of the old file was kept as ${BACKUP}. Turn Droid on and enter its key again.`,
      );
    });
    expect(harness.requests).toEqual([{ providerId: "droid" }]);
    await waitFor(() => {
      expect(harness.reads.get("providers.settingsFile.status")).toBe(2);
    });
  });

  it("names an earlier attempt's copy and asks for a host restart when a provider was not restarted", async () => {
    harness.respondWith({
      outcome: "reset",
      backupFileName: BACKUP,
      backupFileNames: [EARLIER_BACKUP, BACKUP],
      providersNotRestarted: ["droid"],
    });
    renderAction(harness);

    confirm(openDialog());

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        `Droid settings reset. A copy of the old file was kept as ${BACKUP} (also ${EARLIER_BACKUP}). Turn Droid on and enter its key again. Restart this host to finish applying the new settings.`,
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("names every backup when nothing was reset", async () => {
    const cases: readonly {
      readonly response: ResetProviderResponse;
      readonly toastFn: typeof toast.info;
      readonly text: string;
    }[] = [
      {
        response: { outcome: "readable", backupFileNames: [BACKUP] },
        toastFn: toast.info,
        text: `Droid settings can be read again, so nothing was reset. A copy of the old file was kept as ${BACKUP}.`,
      },
      {
        response: { outcome: "document-unreadable", backupFileNames: [] },
        toastFn: toast.warning,
        text: "The whole provider settings file can't be used now, so Droid was not reset on its own. Use Reset provider settings instead.",
      },
      {
        response: {
          outcome: "changed",
          backupFileNames: [EARLIER_BACKUP, BACKUP],
        },
        toastFn: toast.warning,
        text: `The provider settings file kept changing, so nothing was reset. Try again. A copy of the old file was kept as ${EARLIER_BACKUP}, ${BACKUP}.`,
      },
      {
        response: { outcome: "failed", backupFileNames: [BACKUP] },
        toastFn: toast.warning,
        text: `Couldn't reset Droid settings, and nothing was changed. A copy of the old file was kept as ${BACKUP}.`,
      },
    ];
    for (const { response, toastFn, text } of cases) {
      vi.mocked(toastFn).mockClear();
      harness.respondWith(response);
      renderAction(harness);

      confirm(openDialog());

      await waitFor(() => {
        expect(toastFn).toHaveBeenCalledWith(text);
      });
      cleanup();
    }
    expect(toast.success).not.toHaveBeenCalled();
  });
});
