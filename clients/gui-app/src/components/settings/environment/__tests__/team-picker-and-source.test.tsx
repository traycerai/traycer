import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  environmentListUpgradeV10ToV11,
  type EnvironmentDescriptorV11,
  type EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TeamRows } from "@/components/settings/environment/team-rows";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";

// The shared host client and the signed-in identity are the external
// boundaries; the environment.list query, its cache and the rows are real.
const boundary = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (boundary.client === null) throw new Error("no host client mounted");
      return boundary.client;
    },
  };
});
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-me",
}));

const personal: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

function team(
  id: string,
  label: string,
  effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
): EnvironmentDescriptorV11 {
  return {
    environmentId: `env-${id}`,
    ownerKind: "organization",
    ownerId: `team-${id}`,
    roomId: `room-${id}`,
    label,
    effectiveRole,
    kind: "team",
    hostCount: 2,
    providerHandle: `handle-${id}`,
  };
}

/** What a host that only speaks `environment.list@1.0` answers, upgraded. */
function legacyTeamList(id: string, label: string): EnvironmentListResponseV11 {
  return environmentListUpgradeV10ToV11.upgradeResponse({
    environments: [
      {
        environmentId: `env-${id}`,
        ownerKind: "organization",
        ownerId: `team-${id}`,
        roomId: `room-${id}`,
        label,
      },
    ],
  });
}

type ListHandler = () => Promise<EnvironmentListResponseV11>;

function mountClient(list: ListHandler): {
  readonly Wrapper: (p: { children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: { "environment.list": list },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  boundary.client = spine.createRequester(mockLocalHostEntry);
  return {
    Wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  boundary.client = null;
});
afterEach(cleanup);

describe("TeamRows", () => {
  function PickerHarness(props: {
    onPick: (pick: unknown) => void;
  }): ReactNode {
    return (
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="personal">
            <TeamRows pick={{ kind: "personal" }} onPick={props.onPick} />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("lists teams only, with a role subtitle each, and picks the team by id", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve({
        environments: [
          personal,
          team("admin", "Acme", "admin"),
          team("editor", "Globex", "editor"),
          team("viewer", "Initech", "viewer"),
        ],
      }),
    );
    const onPick = vi.fn();
    render(<PickerHarness onPick={onPick} />, { wrapper: Wrapper });

    const row = (id: string): HTMLElement =>
      screen.getByTestId(`environment-team-env-${id}`);
    await waitFor(() => {
      expect(row("admin")).toBeTruthy();
    });
    expect(screen.queryByText("Personal")).toBeNull();
    expect(row("admin").textContent).toContain("Acme");
    expect(row("admin").textContent).toContain("team · you edit");
    expect(row("editor").textContent).toContain("team · you edit");
    expect(row("viewer").textContent).toContain("team · read-only");

    await userEvent.click(row("editor"));
    expect(onPick).toHaveBeenCalledExactlyOnceWith({
      kind: "team",
      environmentId: "env-editor",
    });
  });

  it("reads a team from an @1.0 host as read-only", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve(legacyTeamList("old", "Hooli")),
    );
    render(<PickerHarness onPick={vi.fn()} />, { wrapper: Wrapper });

    const row = await screen.findByTestId("environment-team-env-old");
    expect(row.textContent).toContain("team · read-only");
  });

  it("renders no team rows when the user is in no team", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve({ environments: [personal] }),
    );
    render(<PickerHarness onPick={vi.fn()} />, { wrapper: Wrapper });
    await screen.findByText("open");
    await waitFor(() => {
      expect(screen.queryAllByTestId(/^environment-team-/)).toHaveLength(0);
    });
  });
});

describe("usePickedTeamLabel", () => {
  function Label(props: { id: string }): ReactNode {
    return (
      <span data-testid="label">{usePickedTeamLabel(props.id) ?? "none"}</span>
    );
  }

  it("names a team by its label, the user-owned row Personal, and an unknown id nothing", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve({ environments: [personal, team("a", "Acme", "admin")] }),
    );
    render(
      <>
        <Label id="env-a" />
        <Label id="env-personal" />
        <Label id="env-gone" />
      </>,
      { wrapper: Wrapper },
    );
    const labels = (): string[] =>
      screen.getAllByTestId("label").map((el) => el.textContent);
    await waitFor(() => {
      expect(labels()).toEqual(["Acme", "Personal", "none"]);
    });
  });
});

describe("ConfigurationSourceBoundary", () => {
  function Probe(): ReactNode {
    const source = useConfigurationSource();
    return (
      <p data-testid="probe">
        {source.kind === "host"
          ? "host"
          : `${source.environmentId}|${source.roomId}|${String(source.providerHandle)}|${source.effectiveRole}|${source.configuration}`}
      </p>
    );
  }

  it("mounts no child while the team descriptor is loading", () => {
    const { Wrapper } = mountClient(() => new Promise<never>(() => undefined));
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("mounts no child for a team the list does not contain", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve({ environments: [personal] }),
    );
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-gone" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: Wrapper },
    );
    expect(
      await screen.findByText("These settings are no longer available."),
    ).toBeTruthy();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("offers Retry when the list fails, and mounts no child", async () => {
    const { Wrapper } = mountClient(() => Promise.reject(new Error("down")));
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: Wrapper },
    );
    expect(
      await screen.findByText("Couldn't read these settings."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it.each(["admin", "editor", "viewer"] as const)(
    "gives the child the pool context for a resolved team (role %s)",
    async (role) => {
      const { Wrapper } = mountClient(() =>
        Promise.resolve({ environments: [personal, team("a", "Acme", role)] }),
      );
      render(
        <ConfigurationSourceBoundary
          target={{ kind: "team", environmentId: "env-a" }}
        >
          <Probe />
        </ConfigurationSourceBoundary>,
        { wrapper: Wrapper },
      );
      expect((await screen.findByTestId("probe")).textContent).toBe(
        `env-a|room-a|handle-a|${role}|team`,
      );
    },
  );

  it("gives an @1.0 host's team the viewer role", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve(legacyTeamList("a", "Acme")),
    );
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: Wrapper },
    );
    expect((await screen.findByTestId("probe")).textContent).toBe(
      "env-a|room-a|null|viewer|team",
    );
  });

  it("resolves Personal to the user-owned row, as Personal's own configuration", async () => {
    const { Wrapper } = mountClient(() =>
      Promise.resolve({ environments: [team("a", "Acme", "admin"), personal] }),
    );
    render(
      <ConfigurationSourceBoundary target={{ kind: "personal" }}>
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: Wrapper },
    );
    const text = (await screen.findByTestId("probe")).textContent;
    expect(text).toContain(`${personal.environmentId}|`);
    expect(text).toContain("|owner|personal");
  });
});
