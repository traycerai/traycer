import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentReviewEntryV12,
  EnvironmentReviewResponseV12,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { reviewEntryFixture } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

const COMMAND_DETAIL_TAIL =
  "Once approved, it runs on every computer and sandbox running Personal.";

function reviewOf(
  entries: readonly EnvironmentReviewEntryV12[],
): EnvironmentReviewResponseV12 {
  return {
    entries: [...entries],
    shownAt: null,
    acknowledgedAt: null,
    evidence: { version: "1.5.2", at: Date.UTC(2026, 9, 14, 12) },
  };
}

/** A review entry as a `@1.2` host sends it, naming what a held executable runs. */
function entryOf(
  overrides: Partial<EnvironmentReviewEntryV12>,
): EnvironmentReviewEntryV12 {
  return {
    ...reviewEntryFixture({}),
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    ...overrides,
  };
}

function renderSession(
  status: EnvironmentStatusResponseV11,
  entries: readonly EnvironmentReviewEntryV12[],
  recorded: string[],
): HostClient<HostRpcRegistry> {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => status,
    "environment.review": () => reviewOf(entries),
    "environment.review.record": (request) => {
      recorded.push(request.event);
      return { outcome: "recorded" };
    },
  };
  const { client } = buildEnvironmentClient({ hostId: "old", handlers });
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
    "environment.review": { major: 1, minor: 2 },
    "environment.review.record": { major: 1, minor: 0 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RetrospectiveSession
        client={client}
        reviewHostId="old"
        stopClient={client}
        stopHostId="old"
        hostName="Old laptop"
        open
        held={null}
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return client;
}

describe("<RetrospectiveSession /> Stop using Personal", () => {
  it("offers it while a plane is still shared by an earlier version", async () => {
    renderSession(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "local",
          room: "local",
        },
      }),
      [],
      [],
    );

    expect(
      (await screen.findByTestId("retrospective-stop-sharing")).textContent,
    ).toBe("Stop using Personal on this computer");
  });

  it("hides it once every plane has stopped, and keeps Got it", async () => {
    const recorded: string[] = [];
    renderSession(
      environmentStatusFixture({
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        stoppedAt: Date.UTC(2026, 9, 21, 12),
      }),
      [],
      recorded,
    );

    // The sheet records `shown` once the review and the planes have loaded.
    await waitFor(() => expect(recorded).toEqual(["shown"]));
    expect(screen.queryByTestId("retrospective-stop-sharing")).toBeNull();
    expect(screen.getByTestId("retrospective-got-it")).toBeTruthy();
  });
});

describe("<RetrospectiveSession /> commands on hold", () => {
  const SHARED = environmentStatusFixture({
    planes: { records: "shared_unrecorded", broker: "local", room: "local" },
  });

  it("lists held commands under Commands on hold, each naming what it runs and who gets it", async () => {
    renderSession(
      SHARED,
      [
        entryOf({
          entryId: "mcp-1",
          reason: "executable_entry",
          kind: "mcp_server",
          key: "github",
          command: "npx -y @acme/github-mcp --readonly",
        }),
        entryOf({
          entryId: "hook-1",
          reason: "executable_entry",
          kind: "hook",
          key: "notify",
          command: "notify.sh",
          event: "stop",
        }),
        entryOf({
          entryId: "mcp-2",
          reason: "executable_entry",
          kind: "mcp_server",
          key: "legacy",
        }),
        entryOf({
          entryId: "value-1",
          reason: "credential_like_value",
          key: "DATABASE_URL",
        }),
      ],
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    expect(within(commands).getByText("Commands on hold")).toBeTruthy();
    const rowText = (id: string): string | null =>
      within(commands).getByTestId(`retrospective-held-${id}`).textContent;
    expect(rowText("mcp-1")).toContain(
      `github (MCP server) runs npx -y @acme/github-mcp --readonly. ${COMMAND_DETAIL_TAIL}`,
    );
    expect(rowText("hook-1")).toContain(
      `notify (hook) runs notify.sh on stop. ${COMMAND_DETAIL_TAIL}`,
    );
    expect(rowText("mcp-2")).toContain(
      `legacy (MCP server). ${COMMAND_DETAIL_TAIL}`,
    );
    const values = screen.getByTestId("retrospective-held-values");
    expect(within(values).getByText("On hold until you choose")).toBeTruthy();
    expect(
      within(values).getByTestId("retrospective-held-value-1"),
    ).toBeTruthy();
    expect(within(values).queryByTestId("retrospective-held-mcp-1")).toBeNull();
  });

  it("words each held executable kind by what it does and who gets it", async () => {
    const EVERYWHERE = "every computer and sandbox running Personal";
    const cases: readonly {
      readonly entry: EnvironmentReviewEntryV12;
      readonly line: string;
    }[] = [
      {
        entry: entryOf({
          entryId: "skill-1",
          kind: "skill",
          key: "review",
          description: "reviewing pull requests",
        }),
        line: `review (skill) gives agents instructions for reviewing pull requests. Once approved, every provider on ${EVERYWHERE} can use it.`,
      },
      {
        entry: entryOf({ entryId: "skill-2", kind: "skill", key: "plain" }),
        line: `plain (skill) gives agents instructions for a kind of task. Once approved, every provider on ${EVERYWHERE} can use it.`,
      },
      {
        entry: entryOf({
          entryId: "shell-1",
          kind: "shell",
          key: "shell",
          os: "macos",
          command: "/bin/zsh -l",
        }),
        line: "shell (shell for macOS) is what terminals and agents start in: /bin/zsh -l. Once approved, every macOS computer and sandbox running Personal uses it.",
      },
      {
        entry: entryOf({
          entryId: "shell-2",
          kind: "shell",
          key: "shell",
          os: "any",
        }),
        line: "shell (shell) is what terminals and agents start in. Once approved, every computer and sandbox running Personal uses it.",
      },
      {
        entry: entryOf({
          entryId: "setup-1",
          kind: "setup_script",
          key: "setup",
          command: "brew bundle",
          event: "boot",
        }),
        line: "setup (setup script) runs brew bundle when a sandbox first gets it or it changes. Once approved, it runs on every sandbox running Personal, never on a computer.",
      },
      {
        entry: entryOf({
          entryId: "agent-1",
          kind: "agent_definition",
          key: "reviewer",
          harness: "claude",
        }),
        line: `reviewer (agent definition) describes an agent Claude Code can start. Once approved, ${EVERYWHERE} gets it.`,
      },
      {
        entry: entryOf({
          entryId: "agent-2",
          kind: "agent_definition",
          key: "helper",
        }),
        line: `helper (agent definition) describes an agent a provider can start. Once approved, ${EVERYWHERE} gets it.`,
      },
      {
        entry: entryOf({
          entryId: "env-1",
          kind: "env_override",
          key: "claude:NODE_OPTIONS",
          harness: "claude",
          value: "--inspect",
        }),
        line: `NODE_OPTIONS (variable) changes how Claude Code starts: NODE_OPTIONS=--inspect. Once approved, ${EVERYWHERE} starts Claude Code with it.`,
      },
      {
        entry: entryOf({
          entryId: "var-1",
          kind: "variable",
          key: "PATH_EXTRA",
        }),
        line: `PATH_EXTRA (variable) changes how programs start. Once approved, ${EVERYWHERE} starts programs with it.`,
      },
    ];
    renderSession(
      SHARED,
      cases.map(({ entry }) => ({ ...entry, reason: "executable_entry" })),
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    for (const { entry, line } of cases) {
      expect(
        within(commands).getByTestId(`retrospective-held-${entry.entryId}`)
          .textContent,
      ).toContain(line);
    }
  });
});
