// The computers running Personal are its host list's rows, plus those this
// window reads that run it by their own status. The scope, the per-host
// reads and the host list are the boundary; the membership rule runs for real.
const reads = vi.hoisted(
  (): {
    scope: HostScope | null;
    readonly statuses: Map<string, unknown>;
    readonly versions: Map<string, unknown>;
    client: unknown;
    servers: EnvironmentMcpServerDeclaration[];
    readonly listed: unknown[];
    hostList: EnvironmentHostRecordV12[];
  } => ({
    scope: null,
    statuses: new Map<string, unknown>(),
    versions: new Map<string, unknown>(),
    client: null,
    servers: [],
    listed: [],
    hostList: [],
  }),
);
const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => reads.scope,
}));
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => reads.versions,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => reads.client,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMcpServerDeclaration } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import { SecretRow } from "@/components/settings/secrets/secret-row";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const ADDED = Date.UTC(2026, 9, 24, 9, 30);
const RESTART = "Tools already running keep it until they restart.";

function dayMonth(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(at);
}

const PERSONAL = environmentStatusFixture({ principal: { kind: "personal" } });
const TEAM = environmentStatusFixture({
  principal: { kind: "team", teamName: "Acme" },
});
const AWAITING_MOVE = environmentStatusFixture({
  principal: { kind: "personal" },
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});

const secret: EnvironmentSecretV12 = {
  secretId: "sec-1",
  name: "STRIPE_KEY",
  kind: "api_key",
  protocol: "https",
  destinations: ["api.stripe.com"],
  mode: "brokered",
  state: "live",
  currentVersionId: "ver-1",
  revoked: false,
  updatedAt: 1,
  variables: [],
  providerVariables: [],
};

function computer(name: string): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: name,
    name,
    isLocalMachine: false,
    registered: true,
  });
}

/** Computers by name, each answering with the status given for it. */
function setComputers(
  statusOf: Readonly<Record<string, unknown>>,
  extra: readonly HostScopeOption[],
): void {
  const hosts = [...Object.keys(statusOf).map(computer), ...extra];
  reads.scope = hostScopeFixture({ hosts, host: hosts[0] });
  for (const [name, status] of Object.entries(statusOf)) {
    reads.statuses.set(name, status);
    reads.versions.set(name, { major: 1, minor: 1 });
  }
}

function mcpServer(
  name: string,
  secretId: string | null,
  kind: "secret" | "oauth",
): EnvironmentMcpServerDeclaration {
  return {
    serverId: `srv-${name}`,
    name,
    transport: "http",
    url: `https://${name}.example.test`,
    command: null,
    args: [],
    env: [],
    credential:
      secretId === null
        ? { kind: "none", secretId: null, secretName: null, owned: false }
        : { kind, secretId, secretName: "STRIPE_KEY", owned: false },
    item: null,
  };
}

function mountRow(
  source: "host" | "pool" | "pool-personal",
  pick: EnvironmentPick | null,
): void {
  useSettingsEnvironmentPickStore.setState({ pick });
  const { client } = buildEnvironmentClient({
    hostId: "host-secrets",
    handlers: {
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-personal",
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Personal",
            effectiveRole: "owner" as const,
            kind: "personal" as const,
            hostCount: 0,
            providerHandle: null,
          },
        ],
      }),
      "environment.host.list": () => ({ hosts: reads.hostList }),
      "environment.configuration.mcpServers.list": (request: unknown) => {
        reads.listed.push(request);
        return { servers: reads.servers };
      },
      "environment.secrets.versions": () => ({
        versions: [
          {
            versionId: "ver-1",
            ordinal: 1,
            createdAt: ADDED,
            supersededAt: null,
            destroyedAt: null,
            current: true,
            rotationState: null,
          },
        ],
        removal: null,
      }),
      "environment.secrets.rotation": () => ({
        rotation: null,
        lastVerify: null,
      }),
    },
  });
  reads.client = client;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigurationSourceContext.Provider
        value={
          source === "host"
            ? { kind: "host" }
            : {
                kind: "pool",
                configuration: source === "pool" ? "team" : "personal",
                environmentId: source === "pool" ? "env-team" : "env-personal",
                roomId: "room-team",
                providerHandle: "handle",
                effectiveRole: "owner",
              }
        }
      >
        <SecretRow
          secret={secret}
          client={client}
          hostId="host-secrets"
          hostName={(hostId) => hostId}
          onChanged={() => undefined}
        />
      </ConfigurationSourceContext.Provider>
    </QueryClientProvider>,
  );
}

async function previewText(): Promise<string> {
  fireEvent.click(await screen.findByTestId("secret-row-remove"));
  const dialog = await screen.findByTestId("confirm-destructive-dialog");
  await vi.waitFor(() => {
    expect(dialog.textContent).toContain("Version 1.");
  });
  return dialog.textContent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 25, 12, 0));
  reads.statuses.clear();
  reads.servers = [];
  reads.hostList = [];
  reads.listed.length = 0;
  navigateToSettingsSectionMock.mockReset();
  reads.versions.clear();
  useAuthStore.setState({ status: "signed-in" });
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  reads.client = null;
  reads.scope = null;
  useAuthStore.setState({ status: "signed-out" });
});

describe("Remove's preview on Personal names the computers that hold a copy", () => {
  const added = `Added by you on ${dayMonth(ADDED)}. Version 1.`;

  it.each([
    { names: ["dev-box"], on: "dev-box" },
    { names: ["dev-box", "laptop"], on: "dev-box and laptop" },
    {
      names: ["dev-box", "laptop", "studio"],
      on: "dev-box, laptop and 1 more",
    },
    { names: ["a", "b", "c", "d"], on: "4 computers" },
    { names: ["a", "b", "c", "d", "e"], on: "5 computers" },
  ])(
    "with $names.length running Personal it reads $on",
    async ({ names, on }) => {
      setComputers(
        Object.fromEntries(names.map((name) => [name, PERSONAL])),
        [],
      );
      mountRow("host", null);

      expect(await previewText()).toContain(`${added} On ${on}. ${RESTART}`);
    },
  );

  it("names every computer's copy but leaves out sandboxes, Local rows and other owners", async () => {
    setComputers(
      { "dev-box": PERSONAL, "old-laptop": AWAITING_MOVE, "work-pc": TEAM },
      [
        hostScopeOptionFixture({
          hostId: "sandbox-1",
          name: "sandbox-1",
          isLocalMachine: false,
          registered: true,
          sandbox: {
            state: null,
            frozen: false,
            summary: null,
            teamOwned: false,
          },
        }),
      ],
    );
    reads.statuses.set("sandbox-1", PERSONAL);
    reads.versions.set("sandbox-1", { major: 1, minor: 1 });
    mountRow("host", null);

    const text = await previewText();
    expect(text).toContain(`${added} On dev-box. ${RESTART}`);
    expect(text).not.toMatch(/old-laptop|work-pc|sandbox-1/);
  });

  it("names the computers in Personal's host list, though this window cannot dial them, and not its sandboxes", async () => {
    const listed = (
      hostId: string,
      kind: EnvironmentHostRecordV12["kind"],
    ): EnvironmentHostRecordV12 => ({
      hostId,
      hostLabel: hostId,
      hostPlatform: "darwin",
      enrolledByUserId: "user-me",
      kind,
      boundAt: 1,
      reachable: false,
      lastReportedAt: 1,
      hasLocalRow: false,
      applied: [],
    });
    reads.hostList = [
      listed("cloud-box", "personal"),
      listed("studio", "personal"),
      listed("sandbox-9", "sandbox"),
    ];
    setComputers({}, []);
    mountRow("host", null);

    const text = await previewText();
    expect(text).toContain(`${added} On cloud-box and studio. ${RESTART}`);
    expect(text).not.toContain("sandbox-9");
  });

  it("leaves out the On clause when no computer runs Personal, keeping the restart sentence", async () => {
    setComputers({ "work-pc": TEAM }, []);
    mountRow("host", null);

    expect(await previewText()).toContain(`${added} ${RESTART}`);
    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).not.toContain(" On ");
  });
});

describe("Remove's preview on a team page", () => {
  it("has no On clause, whatever computers run Personal, and says it was added without 'by you'", async () => {
    setComputers({ "dev-box": PERSONAL, laptop: PERSONAL }, []);
    mountRow("pool", { kind: "team", environmentId: "env-team" });

    const text = await previewText();
    expect(text).toContain(
      `Added on ${dayMonth(ADDED)}. Version 1. ${RESTART}`,
    );
    expect(text).not.toMatch(/ On |dev-box|laptop/);
  });
});

describe("Remove's preview on a Local pick", () => {
  it("names no computers, whoever runs Personal", async () => {
    setComputers({ "dev-box": PERSONAL, laptop: PERSONAL }, []);
    mountRow("host", {
      kind: "local",
      hostId: "host-secrets",
      hostName: "Studio",
    });

    const text = await previewText();
    expect(text).toContain(
      `Added by you on ${dayMonth(ADDED)}. Version 1. ${RESTART}`,
    );
    expect(text).not.toMatch(/dev-box|laptop/);
  });
});

describe("Remove's preview on a Personal page read from the cloud", () => {
  it("says the person added it and names the computers running Personal", async () => {
    setComputers({ "dev-box": PERSONAL, laptop: PERSONAL }, []);
    mountRow("pool-personal", null);

    expect(await previewText()).toContain(
      `Added by you on ${dayMonth(ADDED)}. Version 1. On dev-box and laptop. ${RESTART}`,
    );
  });
});

describe("Remove's preview names the MCP servers that use the secret", () => {
  const added = `Added by you on ${dayMonth(ADDED)}. Version 1.`;
  const TAIL_ONE =
    "without a credential; if the server needs one, it stops working until you pick another secret on MCP servers.";
  const TAIL_MANY =
    "without a credential; any that need one stop working until you pick another secret on MCP servers.";

  async function usedByLine(): Promise<string> {
    fireEvent.click(await screen.findByTestId("secret-row-remove"));
    return (await screen.findByTestId("secret-remove-used-by")).textContent;
  }

  it("names one server first, before the added line, with the exact text", async () => {
    reads.servers = [mcpServer("github", "sec-1", "secret")];
    setComputers({}, []);
    mountRow("host", null);

    expect(await usedByLine()).toBe(
      `Used by github. Removing it leaves github ${TAIL_ONE}`,
    );
    const text = await previewText();
    expect(text.indexOf("Used by github.")).toBeGreaterThan(-1);
    expect(text.indexOf("Used by github.")).toBeLessThan(
      text.indexOf("Added by you"),
    );
    expect(text).toContain(`MCP servers.${added} ${RESTART}`);
    expect(reads.listed).toEqual([{ environmentId: "env-personal" }]);
  });

  it("names two and three servers, counting the rest", async () => {
    reads.servers = [
      mcpServer("github", "sec-1", "secret"),
      mcpServer("linear", "sec-1", "secret"),
    ];
    setComputers({}, []);
    mountRow("host", null);
    expect(await usedByLine()).toBe(
      `Used by github and linear. Removing it leaves them ${TAIL_MANY}`,
    );
    cleanup();

    reads.servers = [
      mcpServer("github", "sec-1", "secret"),
      mcpServer("linear", "sec-1", "secret"),
      mcpServer("notion", "sec-1", "secret"),
    ];
    mountRow("host", null);
    expect(await usedByLine()).toBe(
      `Used by github, linear and 1 more. Removing it leaves them ${TAIL_MANY}`,
    );
  });

  it("has no line when no server uses it, and does not name a server bound to another secret or none", async () => {
    reads.servers = [
      mcpServer("github", "sec-other", "secret"),
      mcpServer("plain", null, "secret"),
    ];
    setComputers({}, []);
    mountRow("host", null);

    const text = await previewText();
    await vi.waitFor(() => {
      expect(reads.listed).toHaveLength(1);
    });
    expect(screen.queryByTestId("secret-remove-used-by")).toBeNull();
    expect(text).not.toMatch(/Used by|github|plain|signed-in/);
  });

  it("takes Remove's 'MCP servers' link to that page and closes the dialog", async () => {
    reads.servers = [mcpServer("github", "sec-1", "secret")];
    setComputers({}, []);
    mountRow("host", null);
    await usedByLine();

    fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));

    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("mcp-servers");
    await vi.waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("asks for no servers on a Local pick, and shows no line", async () => {
    reads.servers = [mcpServer("github", "sec-1", "secret")];
    setComputers({}, []);
    mountRow("host", {
      kind: "local",
      hostId: "host-secrets",
      hostName: "Studio",
    });

    await previewText();

    expect(reads.listed).toEqual([]);
    expect(screen.queryByTestId("secret-remove-used-by")).toBeNull();
  });

  it("reads a team's servers by the team's id on its page", async () => {
    reads.servers = [mcpServer("github", "sec-1", "secret")];
    setComputers({}, []);
    mountRow("pool", { kind: "team", environmentId: "env-team" });

    await usedByLine();

    expect(reads.listed).toEqual([{ environmentId: "env-team" }]);
  });
});
