// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other Personal suites do, because they render bare, without
// the host runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

// The grant minter a write carries is read from the host binding. The client
// is a REAL `HostClient` over an in-memory messenger (`buildAccessHost`): only
// the host on the far side is faked.
const hostMock = vi.hoisted(
  (): { binding: { readonly auth: unknown } | null } => ({ binding: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostMock.binding };
});

// What a dashboard link asks the app to open.
const openLinkMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  buildAccessHost,
  DASHBOARD_ORIGIN,
  dashboardRunnerHost,
  noticeFixture,
  reviewEntryFixture,
  type AccessHost,
  type AccessHostState,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { provider } from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { RunnerHostContext } from "@/providers/runner-host-context";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostMock.binding = null;
  openLinkMock.mockReset();
});

function FakePanel(): ReactNode {
  return (
    <SettingsPanelShell title="Shell" description="How terminals start.">
      <button type="button">Edit the page</button>
    </SettingsPanelShell>
  );
}

interface FrameOptions {
  readonly section: SettingsSectionId;
  readonly methods: readonly string[];
  /** The host id the window addresses; the notice's host id is compared to it. */
  readonly windowHostId: string;
  readonly runnerHost: IRunnerHost | null;
  /** `true` stands up a grant minter, so a write's grant is observable. */
  readonly mintsGrants: boolean;
}

const SHELL_PAGE: FrameOptions = {
  section: "shell",
  methods: ACCESS_METHODS,
  windowHostId: ACCESS_HOST_ID,
  runnerHost: null,
  mintsGrants: true,
};

function renderPage(host: AccessHost, options: FrameOptions): void {
  recordNegotiatedHostMethods(options.windowHostId, options.methods);
  hostMock.binding = options.mintsGrants
    ? {
        auth: {
          mintExecutableWriteGrant: () =>
            Promise.resolve({
              kind: "ok" as const,
              grant: "grant-1",
              expiresInSeconds: 600,
            }),
          getCredentialGeneration: () => 0,
        },
      }
    : null;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.windowHostId,
      name: ACCESS_HOST_NAME,
    }),
    hostId: options.windowHostId,
    status: "ready",
    client: host.client,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const page: ReactNode = (
    <PersonalPageFrame section={options.section}>
      <FakePanel />
    </PersonalPageFrame>
  );
  render(
    <QueryClientProvider client={queryClient}>
      {options.runnerHost === null ? (
        page
      ) : (
        <RunnerHostContext.Provider value={options.runnerHost}>
          {page}
        </RunnerHostContext.Provider>
      )}
    </QueryClientProvider>,
  );
}

function hostWith(
  status: Partial<EnvironmentStatusResponse>,
  rest: Partial<AccessHostState>,
): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture(status),
    ...rest,
  });
}

/** Lets everything a NEGATIVE assertion depends on happen first. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

function methodsOf(host: AccessHost): string[] {
  return host.requests.map((request) => request.method);
}

const FROM_DEV_BOX = {
  kind: "host",
  hostId: ACCESS_HOST_ID,
  hostLabel: ACCESS_HOST_NAME,
} as const;

describe("a Personal page's convergence notices", () => {
  it("says which change now applies everywhere, and where it came from", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({ key: "LOG_LEVEL", from: FROM_DEV_BOX }),
          noticeFixture({
            noticeId: "notice-2",
            key: "DATABASE_URL",
            from: { kind: "dashboard" },
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-notice");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("LOG_LEVEL from dev-box now applies everywhere."),
      expect.stringContaining(
        "DATABASE_URL from the dashboard now applies everywhere.",
      ),
    ]);
    // Under the page's heading, in the shell's header with the status line.
    const header = rows[0].closest("header");
    expect(header).not.toBeNull();
    expect(header?.closest("[data-settings-panel-shell]")).not.toBeNull();
  });

  it("names another host without a label as 'another host'", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            from: { kind: "host", hostId: "host-b", hostLabel: null },
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    expect(
      (await screen.findByTestId("personal-notice")).textContent,
    ).toContain("LOG_LEVEL from another host now applies everywhere.");
  });

  it("shows only the notices of this page's kinds", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({ kind: "variable", key: "LOG_LEVEL" }),
          noticeFixture({
            noticeId: "notice-2",
            kind: "mcp_server",
            key: "linear",
          }),
          noticeFixture({
            noticeId: "notice-3",
            kind: "skill",
            key: "review",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-notice");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("LOG_LEVEL");
  });

  it("shows no notices list when this page has none", async () => {
    const host = hostWith(
      {},
      { notices: [noticeFixture({ kind: "mcp_server", key: "linear" })] },
    );
    renderPage(host, SHELL_PAGE);

    await waitFor(() => {
      expect(host.reads.notices).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("personal-page-notices")).toBeNull();
    expect(screen.queryByTestId("personal-notice")).toBeNull();
  });

  it("reads no notices on a host that does not have environment.notices", async () => {
    const host = hostWith({}, { notices: [noticeFixture({})] });
    renderPage(host, {
      ...SHELL_PAGE,
      methods: ACCESS_METHODS.filter(
        (method) => method !== "environment.notices",
      ),
    });

    await screen.findByRole("button", { name: "Edit the page" });
    await settle();
    expect(screen.queryByTestId("personal-notice")).toBeNull();
    expect(host.reads.notices).toBe(0);
  });
});

describe("Undo on a notice", () => {
  it("sends environment.undo with the notice id and the grant", async () => {
    const host = hostWith({}, { notices: [noticeFixture({})] });
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(host.paramsOf("environment.undo")).toEqual([
        { noticeId: "notice-1", executableWriteGrant: "grant-1" },
      ]);
    });
    expect(screen.queryByTestId("personal-notice-refusal")).toBeNull();
  });

  it("has no Undo once the notice cannot be undone, but still says the change", async () => {
    const host = hostWith(
      {},
      { notices: [noticeFixture({ undoAvailable: false })] },
    );
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    expect(row.textContent).toContain("LOG_LEVEL from dev-box");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("says the value was changed again since when the host answers stale", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({})],
        undoAnswer: {
          outcome: "stale",
          currentRevision: 5,
          changedBy: { kind: "dashboard" },
        },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe("Couldn't undo: LOG_LEVEL was changed again since.");
  });

  it("says the undo waits for a reconnect when the host queued it", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({})],
        undoAnswer: { outcome: "pending", uploadId: "upload-1" },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe("Undo applies when this host reconnects.");
  });

  it("asks the person to sign in again when the host needs a confirmation", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({})],
        undoAnswer: { outcome: "needs_grant" },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe(
      "Couldn't undo: it needs your confirmation. Sign in again and retry.",
    );
  });
});

describe("Keep this host's value", () => {
  const KEEP = "Keep dev-box's value on dev-box";

  it("keeps the current value on this host FIRST and undoes the change everywhere SECOND", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    await waitFor(() => {
      expect(methodsOf(host)).toEqual([
        "config.env.localOverride.set",
        "environment.undo",
      ]);
    });
    expect(host.requests).toEqual([
      {
        method: "config.env.localOverride.set",
        params: {
          target: { kind: "variable", key: "LOG_LEVEL" },
          value: "debug",
          executableWriteGrant: "grant-1",
        },
      },
      {
        method: "environment.undo",
        params: { noticeId: "notice-1", executableWriteGrant: "grant-1" },
      },
    ]);
    expect(screen.queryByTestId("personal-notice-refusal")).toBeNull();
  });

  it("keeps the value on this host even when the undo is refused as stale, and says so", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
        undoAnswer: {
          outcome: "stale",
          currentRevision: 5,
          changedBy: { kind: "dashboard" },
        },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe(
      "Kept on dev-box, but couldn't undo the change everywhere: LOG_LEVEL was changed again since.",
    );
    // The override stays: it was set, and nothing took it back.
    expect(methodsOf(host)).toEqual([
      "config.env.localOverride.set",
      "environment.undo",
    ]);
    expect(host.paramsOf("config.env.localOverride.clear")).toEqual([]);
  });

  it("does not undo anything when the host will not keep the value without a confirmation", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
        localOverrideNeedsGrant: true,
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe("Couldn't keep the value without your confirmation.");
    expect(methodsOf(host)).toEqual(["config.env.localOverride.set"]);
  });

  it("is offered only on the host the change came from", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            from: { kind: "host", hostId: "host-b", hostLabel: "laptop" },
          }),
        ],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    expect(row.textContent).toContain("LOG_LEVEL from laptop");
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    await settle();
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("is not offered for a change made in the dashboard", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: { kind: "dashboard" } })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    await settle();
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("is not offered until the host's current value is read", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "OTHER", value: "x" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    await settle();
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("is not offered when the undo is gone", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX, undoAvailable: false })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    await settle();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("keeps a provider's variable as that provider's override", async () => {
    const claude = {
      ...provider("claude-code", []),
      envOverrides: [{ key: "ANTHROPIC_BASE_URL", value: "http://proxy" }],
    };
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            kind: "env_override",
            key: "claude-code:ANTHROPIC_BASE_URL",
            from: FROM_DEV_BOX,
          }),
        ],
        providers: [claude],
      },
    );
    // Nothing else on the page reads the provider list: the Keep row reads
    // the value itself.
    renderPage(host, { ...SHELL_PAGE, section: "providers" });

    expect(
      (await screen.findByTestId("personal-notice")).textContent,
    ).toContain("ANTHROPIC_BASE_URL from dev-box now applies everywhere.");
    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    await waitFor(() => {
      expect(methodsOf(host)).toEqual([
        "config.env.localOverride.set",
        "environment.undo",
      ]);
    });
    expect(host.paramsOf("config.env.localOverride.set")).toEqual([
      {
        target: {
          kind: "env_override",
          providerId: "claude-code",
          key: "ANTHROPIC_BASE_URL",
        },
        value: "http://proxy",
        executableWriteGrant: "grant-1",
      },
    ]);
  });
});

describe("a Personal page's 'needs you' rows", () => {
  it("says why each held value waits, with a way to review it in the dashboard", async () => {
    const host = hostWith(
      {},
      {
        review: [
          reviewEntryFixture({
            entryId: "entry-1",
            key: "DATABASE_URL",
            reason: "credential_like_value",
          }),
          reviewEntryFixture({
            entryId: "entry-2",
            key: "SHELL_INIT",
            reason: "executable_entry",
          }),
          reviewEntryFixture({
            entryId: "entry-3",
            key: "LOG_LEVEL",
            reason: "needs_grant",
          }),
          reviewEntryFixture({
            entryId: "entry-4",
            key: "FUTURE_THING",
            reason: "a_reason_from_a_newer_host",
          }),
        ],
      },
    );
    renderPage(host, { ...SHELL_PAGE, runnerHost: dashboardRunnerHost() });

    const rows = await screen.findAllByTestId("personal-review-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(
        "DATABASE_URL is waiting for you: looks like a secret.",
      ),
      expect.stringContaining("SHELL_INIT is waiting for you: runs a command."),
      expect.stringContaining(
        "LOG_LEVEL is waiting for you: was changed without your confirmation.",
      ),
      expect.stringContaining("FUTURE_THING is waiting for you."),
    ]);
    for (const row of rows) {
      expect(
        within(row).getByRole("button", { name: "Review in the dashboard" }),
      ).toBeTruthy();
    }

    fireEvent.click(
      within(rows[0]).getByRole("button", { name: "Review in the dashboard" }),
    );
    expect(openLinkMock).toHaveBeenCalledTimes(1);
    expect(openLinkMock.mock.calls[0]?.[0]).toBe(
      `${DASHBOARD_ORIGIN}/environments/personal/review`,
    );
    expect(openLinkMock.mock.calls[0]?.[1]).toBe("account");
  });

  it("says the row text and offers no review button without a shell to name the dashboard", async () => {
    const host = hostWith({}, { review: [reviewEntryFixture({})] });
    renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-review-row");
    expect(row.textContent).toContain(
      "DATABASE_URL is waiting for you: looks like a secret.",
    );
    expect(
      within(row).queryByRole("button", { name: "Review in the dashboard" }),
    ).toBeNull();
  });

  it("shows only the rows of this page's kinds", async () => {
    const host = hostWith(
      {},
      {
        review: [
          reviewEntryFixture({ kind: "variable", key: "DATABASE_URL" }),
          reviewEntryFixture({
            entryId: "entry-2",
            kind: "mcp_server",
            key: "linear",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-review-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("DATABASE_URL");
  });
});

describe("a team's host on a Personal page", () => {
  it("shows the team line, puts the page in an inert region and reads no notices", async () => {
    const host = hostWith(
      { principal: { kind: "team", teamName: "Acme" } },
      {
        notices: [noticeFixture({})],
        review: [reviewEntryFixture({})],
      },
    );
    renderPage(host, { ...SHELL_PAGE, runnerHost: dashboardRunnerHost() });

    const line = await screen.findByTestId("team-owned-line");
    expect(
      within(line).getByText(
        "These settings belong to Acme. Change them in the dashboard.",
      ),
    ).toBeTruthy();
    expect(line.closest("[inert]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).not.toBeNull();

    await settle();
    expect(screen.queryByTestId("personal-notice")).toBeNull();
    expect(screen.queryByTestId("personal-review-row")).toBeNull();
    expect(host.reads.notices).toBe(0);
    expect(host.reads.review).toBe(0);
  });

  it("does not put the person's own page in an inert region", async () => {
    const host = hostWith({ principal: { kind: "personal" } }, {});
    renderPage(host, SHELL_PAGE);

    const edit = await screen.findByRole("button", { name: "Edit the page" });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(edit.closest("[inert]")).toBeNull();
    expect(screen.queryByTestId("team-owned-line")).toBeNull();
  });
});
