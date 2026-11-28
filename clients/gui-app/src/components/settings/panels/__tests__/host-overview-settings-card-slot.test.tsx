import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
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
    kind: "binding" as const,
    query: {
      data: null as EnvironmentHostBinding | null,
      isError: false,
    },
  },
  bindingOwnSettings: false,
  bindingSupport: true as boolean | null,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => reads.status,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () =>
    reads.bindingOwnSettings ? { kind: "own_settings" } : reads.binding,
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  readsHostBindingsFromPool: () => false,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => reads.bindingSupport,
  useHostMethodSchemaVersion: () => null,
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
  mountWatching(usable, hostId, () => undefined);
}

/** The slot mounted with an `onReturn`; the answer re-renders it with a new `usable`. */
function mountWatching(
  usable: boolean,
  hostId: string | null,
  onReturn: () => void,
): (usable: boolean) => void {
  const queryClient = new QueryClient();
  const slot = (isUsable: boolean): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostOverviewSettingsCardSlot
        client={client}
        hostId={hostId}
        hostName="A computer"
        usable={isUsable}
        owner={null}
        isLocalMachine={false}
        receipt={NO_RECEIPT}
        onReturn={onReturn}
        shownFromRow={false}
      />
    </QueryClientProvider>
  );
  const view = render(slot(usable));
  return (next) => view.rerender(slot(next));
}

beforeEach(() => {
  reads.status = { data: null, supported: true, isError: false };
  reads.binding = { kind: "binding", query: { data: null, isError: false } };
  reads.bindingOwnSettings = false;
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
        reads.binding.query.isError = true;
      },
    ],
  ] as const)("hides the row for %s", (_name, configure) => {
    configure();
    mount(true, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("hides the row when the host is unusable or unnamed", () => {
    mount(false, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    cleanup();
    mount(true, null);
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("renders nothing for an unusable host instead of guessing Personal or a team", () => {
    mount(false, "host-a");

    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByText("Runs Personal")).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("calls onReturn when the card shows again after the host was away, not when it first shows", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    const onReturn = vi.fn<() => void>();

    const setUsable = mountWatching(true, "host-a", onReturn);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(onReturn).not.toHaveBeenCalled();

    setUsable(false);
    expect(screen.queryByText("Personal")).toBeNull();
    expect(onReturn).not.toHaveBeenCalled();

    setUsable(true);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("calls onReturn when the card shows again after a failed read", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    const onReturn = vi.fn<() => void>();
    const setUsable = mountWatching(true, "host-a", onReturn);

    reads.status.isError = true;
    setUsable(true);
    expect(screen.queryByText("Personal")).toBeNull();
    expect(onReturn).not.toHaveBeenCalled();

    reads.status.isError = false;
    setUsable(true);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("keeps a skeleton while either supported read is pending", () => {
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.status.data = environmentStatusFixture({});
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.binding.query.data = BINDING;
    reads.status.data = null;
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });

  it("renders a Local computer's settings row without a binding read", () => {
    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });

    mount(true, "host-a");

    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Environment" }));
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  it("renders a Local row when status is supported and host binding is unsupported", () => {
    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    reads.bindingOwnSettings = true;
    reads.bindingSupport = false;

    mount(true, "host-a");

    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
  });

  it("keeps the row's skeleton while binding support is unknown", () => {
    reads.status.data = environmentStatusFixture({});
    reads.bindingSupport = null;

    mount(true, "host-a");

    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });

  it("does not start an environment follow for a host shown from its row", () => {
    const actsBeforeMount = useSettingsEnvironmentPickStore.getState().acts;
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <HostOverviewSettingsCardSlot
          client={client}
          hostId="host-a"
          hostName="Host A"
          usable={false}
          owner={null}
          isLocalMachine={false}
          receipt={NO_RECEIPT}
          onReturn={() => undefined}
          shownFromRow
        />
      </QueryClientProvider>,
    );

    expect(useSettingsEnvironmentPickStore.getState().acts).toBe(
      actsBeforeMount,
    );
  });
});
