import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
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
  bindingFailed: false,
  bindingSupport: true as boolean | null,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => reads.status,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => {
    if (reads.bindingFailed) return { kind: "failed", retry: () => undefined };
    return reads.bindingOwnSettings ? { kind: "own_settings" } : reads.binding;
  },
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

const { client } = buildEnvironmentClient({
  hostId: "host-a",
  handlers: {
    "environment.move.stopPreview": () => ({
      managed: [],
      needsChoice: [
        {
          row: {
            kind: "variable",
            key: "LOG_LEVEL",
            os: "any",
            label: "LOG_LEVEL",
            detail: null,
          },
          reason: "edited_here",
          origin: "changed_here",
          usedBy: [],
        },
      ],
      sheetDigest: null,
    }),
  },
});

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
      />
    </QueryClientProvider>
  );
  const view = render(slot(usable));
  return (next) => view.rerender(slot(next));
}

function committedElement(
  read: () => HTMLElement | null,
): Promise<HTMLElement> {
  const existing = read();
  if (existing !== null) return Promise.resolve(existing);
  const committed = Promise.withResolvers<HTMLElement>();
  const observer = new MutationObserver(() => {
    const element = read();
    if (element === null) return;
    observer.disconnect();
    committed.resolve(element);
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  onTestFinished(() => observer.disconnect());
  return committed.promise;
}

beforeEach(() => {
  reads.status = { data: null, supported: true, isError: false };
  reads.binding = { kind: "binding", query: { data: null, isError: false } };
  reads.bindingOwnSettings = false;
  reads.bindingFailed = false;
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

  it.each(["status", "binding"])(
    "keeps the Overview card and its open Stop sheet after a failed %s reread",
    async (read) => {
      reads.status.data = environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      });
      reads.binding.query.data = BINDING;
      const rerender = mountWatching(true, "host-a", () => undefined);
      const row = screen.getByTestId("host-settings-source");
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Environment" }), {
        key: "ArrowDown",
      });
      const option = await committedElement(() =>
        screen.queryByRole("option", { name: /^A computer/ }),
      );
      fireEvent.click(option);
      const choiceId = "stop-sharing-choice-variable-LOG_LEVEL-keep_locally";
      const choice = await committedElement(() =>
        screen.queryByTestId(choiceId),
      );
      fireEvent.click(choice);
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      const sheet = screen.getByTestId("stop-sharing-sheet");

      if (read === "status") {
        reads.status.isError = true;
        reads.bindingFailed = true;
      } else {
        reads.binding.query.isError = true;
      }
      rerender(true);

      expect(screen.getByTestId("stop-sharing-sheet")).toBe(sheet);
      expect(screen.getByTestId("host-settings-source")).toBe(row);
      expect(screen.getByTestId(choiceId).getAttribute("aria-pressed")).toBe(
        "true",
      );
    },
  );

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
});
