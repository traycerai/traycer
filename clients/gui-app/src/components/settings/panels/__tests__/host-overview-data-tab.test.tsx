const hostQueryHooks = vi.hoisted(() => ({
  queryCalls: [] as Array<{
    readonly client: unknown;
    readonly method: string;
    readonly options: unknown;
  }>,
  mutationCalls: [] as Array<{
    readonly client: unknown;
    readonly method: string;
  }>,
  mutate: vi.fn(),
  versionHistorySettings: {
    settings: {
      enabled: true,
      retentionDays: 30,
      maxVersionsPerArtifact: 100,
      maxBytesPerArtifact: 16 * 1024 * 1024,
    },
  },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: unknown;
    readonly method: string;
    readonly options: unknown;
  }) => {
    hostQueryHooks.queryCalls.push(args);
    return {
      data:
        args.method === "epic.artifactVersionSettings.get"
          ? hostQueryHooks.versionHistorySettings
          : { bytes: 1_363_149 },
      isError: false,
      isPending: false,
    };
  },
  useHostMutation: (args: {
    readonly client: unknown;
    readonly method: string;
  }) => {
    hostQueryHooks.mutationCalls.push(args);
    return { isPending: false, mutate: hostQueryHooks.mutate };
  },
}));

const artifactVersionMutations = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly method: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }>,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    args: { readonly method: string },
  ) => ({
    isPending: false,
    mutate: (variables: Readonly<Record<string, unknown>>) => {
      artifactVersionMutations.calls.push({
        method: args.method,
        variables,
      });
    },
  }),
}));

vi.mock("@/components/settings/panels/host-import-migration-section", () => ({
  HostImportMigrationSection: () => (
    <div data-testid="import-migration-section">
      Import &amp; migration section
    </div>
  ),
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { HostOverviewDataTab } from "@/components/settings/panels/host-overview-data-tab";
import type { HostOverviewDataTabProps } from "@/components/settings/panels/host-overview-data-tab";
import type { HostRpcRegistry } from "@/lib/host";

const CLIENT: HostClient<HostRpcRegistry> = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-host-overview-data-tab-test",
    handlers: {},
  }),
});

function dataTab(props: Partial<HostOverviewDataTabProps>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const dataTabProps: HostOverviewDataTabProps = {
    client: CLIENT,
    hostId: "host-b",
    hostName: "Office Linux",
    connecting: false,
    usable: true,
    ...props,
  };
  return (
    <QueryClientProvider client={queryClient}>
      <HostOverviewDataTab {...dataTabProps} />
    </QueryClientProvider>
  );
}

function isVisible(element: HTMLElement): boolean {
  return element.closest("[hidden]") === null;
}

function expectRetainedGroupsConcealed(fallback: HTMLElement): void {
  expect(isVisible(fallback)).toBe(true);
  expect(isVisible(screen.getByTestId("artifact-version-settings"))).toBe(
    false,
  );
  expect(isVisible(screen.getByTestId("host-file-edit-snapshots"))).toBe(false);
  expect(screen.queryByTestId("import-migration-section")).toBeNull();
}

function expectFallbackReadsDisabled(): void {
  expect(
    hostQueryHooks.queryCalls.some(
      ({ client, method, options }) =>
        client === null &&
        method === "epic.artifactVersionSettings.get" &&
        typeof options === "object" &&
        options !== null &&
        "enabled" in options &&
        options.enabled === false,
    ),
  ).toBe(true);
  expect(
    hostQueryHooks.queryCalls.some(
      ({ client, method }) =>
        client === null && method === "snapshots.getLocalStorageSize",
    ),
  ).toBe(true);
}

beforeEach(() => {
  hostQueryHooks.queryCalls.length = 0;
  hostQueryHooks.mutationCalls.length = 0;
  hostQueryHooks.mutate.mockClear();
  artifactVersionMutations.calls.length = 0;
});

afterEach(cleanup);

describe("Host Overview · Data", () => {
  it("shows snapshots as an unlabeled single-row group and clears after confirmation", () => {
    render(dataTab({}));

    expect(screen.getByText("Import & migration section")).not.toBeNull();
    expect(screen.getByTestId("artifact-version-settings")).not.toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Days").value).toBe("30");
    const snapshots = screen.getByTestId("host-file-edit-snapshots");
    expect(within(snapshots).queryByRole("heading")).toBeNull();
    expect(within(snapshots).getByText("File edit snapshots")).not.toBeNull();
    expect(
      screen.getByTestId("settings-local-snapshots-size").textContent,
    ).toBe("1.3 MB");
    expect(
      screen.getByRole("button", { name: "Clear snapshots…" }),
    ).not.toBeNull();
    expect(hostQueryHooks.queryCalls).toContainEqual(
      expect.objectContaining({
        client: CLIENT,
        method: "epic.artifactVersionSettings.get",
      }),
    );
    expect(hostQueryHooks.queryCalls).toContainEqual(
      expect.objectContaining({
        client: CLIENT,
        method: "snapshots.getLocalStorageSize",
      }),
    );
    expect(
      hostQueryHooks.mutationCalls.map(({ client, method }) => ({
        client,
        method,
      })),
    ).toEqual([{ client: CLIENT, method: "snapshots.clearLocalSnapshots" }]);

    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots…" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("Clear file edit snapshots on Office Linux?"),
    ).not.toBeNull();
    expect(dialog.textContent).toContain(
      "Cleared snapshots on Office Linux cannot be restored.",
    );
    expect(dialog.textContent).toContain(
      "Conversation history and checkpoint records stay visible",
    );
    expect(dialog.textContent).toContain(
      "Undo is disabled for past turns on that host.",
    );
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear snapshots" }),
    );
    expect(hostQueryHooks.mutate).toHaveBeenCalledOnce();
    expect(hostQueryHooks.mutate).toHaveBeenCalledWith({});
  });

  it("shows the host-specific connection line while concealing data groups", () => {
    render(
      dataTab({
        client: null,
        connecting: false,
        usable: false,
      }),
    );

    expect(
      screen.getByText(
        "These live on Office Linux's disk, so they need a connection to it.",
      ),
    ).not.toBeNull();
    expectRetainedGroupsConcealed(
      screen.getByText(
        "These live on Office Linux's disk, so they need a connection to it.",
      ),
    );
    expectFallbackReadsDisabled();
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);
  });

  it("shows the connecting shape while concealing data groups", () => {
    render(
      dataTab({
        client: null,
        connecting: true,
        usable: false,
      }),
    );

    const connecting = screen.getByTestId("host-scope-connecting");
    expect(connecting.textContent).toContain("Connecting to Office Linux…");
    expectRetainedGroupsConcealed(connecting);
    expectFallbackReadsDisabled();
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);
  });

  it("keeps a typed retention draft through an unreachable round trip", () => {
    const { rerender } = render(dataTab({}));
    const days = screen.getByLabelText<HTMLInputElement>("Days");
    expect(days.value).toBe("30");

    fireEvent.change(days, { target: { value: "45" } });
    expect(days.value).toBe("45");

    rerender(
      dataTab({
        client: null,
        connecting: false,
        usable: false,
      }),
    );

    const connectionLine = screen.getByText(
      "These live on Office Linux's disk, so they need a connection to it.",
    );
    expectRetainedGroupsConcealed(connectionLine);
    expectFallbackReadsDisabled();
    expect(days.value).toBe("45");
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);

    rerender(dataTab({}));

    expect(screen.getByLabelText<HTMLInputElement>("Days").value).toBe("45");
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);
  });

  it("keeps a typed retention draft through a connecting round trip", () => {
    const { rerender } = render(dataTab({}));
    const days = screen.getByLabelText<HTMLInputElement>("Days");
    expect(days.value).toBe("30");

    fireEvent.change(days, { target: { value: "45" } });
    expect(days.value).toBe("45");

    rerender(
      dataTab({
        client: null,
        connecting: true,
        usable: false,
      }),
    );

    const connecting = screen.getByTestId("host-scope-connecting");
    expect(connecting.textContent).toContain("Connecting to Office Linux…");
    expectRetainedGroupsConcealed(connecting);
    expect(screen.queryByText(/These live on/u)).toBeNull();
    expectFallbackReadsDisabled();
    expect(days.value).toBe("45");
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);

    rerender(dataTab({}));

    expect(screen.getByLabelText<HTMLInputElement>("Days").value).toBe("45");
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Days"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    expect(screen.getByRole("dialog")).not.toBeNull();

    rerender(
      dataTab({
        client: null,
        connecting: true,
        usable: false,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expectRetainedGroupsConcealed(screen.getByTestId("host-scope-connecting"));

    rerender(dataTab({}));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
    expect(artifactVersionMutations.calls).toHaveLength(0);
  });

  it("closes an armed confirmation when the Data tab moves to another host", () => {
    const { rerender } = render(dataTab({}));
    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots…" }));
    expect(screen.getByRole("dialog")).not.toBeNull();

    rerender(
      dataTab({
        hostId: "host-c",
        hostName: "Build box",
      }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hostQueryHooks.mutate).not.toHaveBeenCalled();
  });
});
