import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const reads = vi.hoisted(() => ({
  status: {
    data: null as EnvironmentStatusResponseV11 | null,
    supported: true,
    isError: false,
  },
  binding: {
    data: null as EnvironmentHostBinding | null,
    isError: false,
  },
  bindingSupport: true as boolean | null,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => reads.status,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => reads.binding,
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  readsHostBindingsFromPool: () => false,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => reads.bindingSupport,
}));

const BINDING: EnvironmentHostBinding = {
  hostId: "host-a",
  environment: {
    environmentId: "personal",
    ownerKind: "user",
    ownerId: "user-a",
    roomId: "room-a",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

const { client } = buildEnvironmentClient({ hostId: "host-a", handlers: {} });

function mount(usable: boolean, hostId: string | null): void {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HostOverviewSettingsCardSlot
        client={client}
        hostId={hostId}
        hostName="A computer"
        usable={usable}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reads.status = { data: null, supported: true, isError: false };
  reads.binding = { data: null, isError: false };
  reads.bindingSupport = true;
});

afterEach(cleanup);

describe("<HostOverviewSettingsCardSlot />", () => {
  it.each([
    [
      "an unsupported status method",
      () => {
        reads.status.supported = false;
      },
    ],
    [
      "a failed status read",
      () => {
        reads.status.isError = true;
      },
    ],
    [
      "an unsupported binding method",
      () => {
        reads.bindingSupport = false;
      },
    ],
    [
      "a failed binding read",
      () => {
        reads.binding.isError = true;
      },
    ],
  ] as const)("hides the row for %s", (_name, configure) => {
    configure();
    mount(true, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Settings" })).toBeNull();
  });

  it("hides the row when the host is unusable or unnamed", () => {
    mount(false, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    cleanup();
    mount(true, null);
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
  });

  it("keeps a skeleton while either supported read is pending", () => {
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.status.data = environmentStatusFixture({});
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.binding.data = BINDING;
    reads.status.data = null;
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });

  it("keeps the row's skeleton while binding support is unknown", () => {
    reads.status.data = environmentStatusFixture({});
    reads.bindingSupport = null;

    mount(true, "host-a");

    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });
});
