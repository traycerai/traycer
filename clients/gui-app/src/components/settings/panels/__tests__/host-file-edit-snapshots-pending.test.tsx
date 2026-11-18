const sonner = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => sonner);

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { HostFileEditSnapshotsSection } from "@/components/settings/panels/host-file-edit-snapshots-section";
import type { HostRpcRegistry } from "@/lib/host";

const CLEAR_TESTID = "settings-clear-file-edit-snapshots";

interface Deferred {
  readonly promise: Promise<{ clearedBytes: number }>;
  readonly resolve: (value: { clearedBytes: number }) => void;
}

function createDeferred(): Deferred {
  let resolve: (value: { clearedBytes: number }) => void = () => undefined;
  const promise = new Promise<{ clearedBytes: number }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function openerButton(): HTMLButtonElement {
  const element = screen.getByTestId(CLEAR_TESTID);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("clear snapshots opener is not a button");
  }
  return element;
}

afterEach(cleanup);

beforeEach(() => {
  sonner.toast.success.mockClear();
  sonner.toast.error.mockClear();
});

describe("HostFileEditSnapshotsSection pending clear", () => {
  it("lets the confirm be closed while the clear runs and keeps the opener disabled until it settles", async () => {
    const deferred = createDeferred();
    const clearRequests: unknown[] = [];
    const hostClient = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-file-edit-snapshots-pending",
        handlers: {
          "snapshots.getLocalStorageSize": () => ({ bytes: 2048 }),
          "snapshots.clearLocalSnapshots": (params) => {
            clearRequests.push(params);
            return deferred.promise;
          },
        },
      }),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    });
    hostClient.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const client = hostClient.createRequesterForHostId(
      mockLocalHostEntry.hostId,
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HostFileEditSnapshotsSection
          client={client}
          hostId="host-b"
          hostName="Office Linux"
          enabled
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-local-snapshots-size").textContent,
      ).toBe("2 KB");
    });
    expect(openerButton().disabled).toBe(false);
    fireEvent.click(openerButton());
    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots" }));

    // Pending: the cancel button is relabelled and the opener is locked.
    const closeButton = await screen.findByRole("button", { name: "Close" });
    await waitFor(() => {
      expect(openerButton().disabled).toBe(true);
    });
    expect(clearRequests).toHaveLength(1);

    fireEvent.click(closeButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(openerButton().disabled).toBe(true);
    expect(sonner.toast.success).not.toHaveBeenCalled();

    deferred.resolve({ clearedBytes: 4096 });

    await waitFor(() => {
      expect(sonner.toast.success).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(openerButton().disabled).toBe(false);
    });
    expect(clearRequests).toHaveLength(1);
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });
});
