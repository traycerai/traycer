// The grant minter a write carries is read from the host binding. Mocked at
// that boundary, as the other Personal suites do; the client itself is a REAL
// `HostClient` over an in-memory messenger (`buildAccessHost`), so every
// request travels the path the app uses and only the host is faked.
const hostMock = vi.hoisted(
  (): {
    binding: {
      readonly auth: unknown;
      readonly directory: unknown;
    } | null;
  } => ({ binding: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostMock.binding };
});

// Where the Review button asks Settings to go.
const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
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
import type {
  EnvironmentStatusResponse,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  buildAccessHost,
  noticeFixture,
  type AccessHost,
  type AccessHostState,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { HostOverviewAccessTab } from "@/components/settings/panels/host-overview-access-tab";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.binding = null;
  navigateToSettingsSectionMock.mockReset();
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
});

interface TabOptions {
  readonly methods: readonly string[] | null;
  readonly connecting: boolean;
  readonly usable: boolean;
  readonly withClient: boolean;
  readonly runnerHost: IRunnerHost | null;
}

const READY: TabOptions = {
  methods: ACCESS_METHODS,
  connecting: false,
  usable: true,
  withClient: true,
  runnerHost: null,
};

function renderTab(
  host: AccessHost,
  options: TabOptions,
): { readonly queryClient: QueryClient } {
  if (options.methods !== null) {
    recordNegotiatedHostMethods(ACCESS_HOST_ID, options.methods);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tab: ReactNode = (
    <HostOverviewAccessTab
      client={options.withClient ? host.client : null}
      hostId={ACCESS_HOST_ID}
      hostName={ACCESS_HOST_NAME}
      connecting={options.connecting}
      usable={options.usable}
    />
  );
  render(
    <QueryClientProvider client={queryClient}>
      {options.runnerHost === null ? (
        tab
      ) : (
        <RunnerHostContext.Provider value={options.runnerHost}>
          {tab}
        </RunnerHostContext.Provider>
      )}
    </QueryClientProvider>,
  );
  return { queryClient };
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

/** An element's text without the braille frame a spinner inside it draws. */
function plainText(element: HTMLElement): string {
  return element.textContent.replace(/[⠀-⣿]/gu, "");
}

function stepMarks(): string[] {
  return screen
    .getAllByTestId("host-setup-step")
    .map((step) => `${plainText(step)}=${step.getAttribute("data-mark")}`);
}

function claudeAmbient(enabled: boolean): ProviderCliState {
  return provider("claude-code", [
    { ...profile("ambient", "ambient"), enabled },
  ]);
}

function variableOverride(key: string, value: string): LocalOverride {
  return {
    target: { kind: "variable", key },
    os: "any",
    value,
    setAt: 1,
  };
}

function providerOverride(
  providerId: "claude-code" | "codex",
  key: string,
  value: string,
): LocalOverride {
  return {
    target: { kind: "env_override", providerId, key },
    os: "any",
    value,
    setAt: 1,
  };
}

describe("<HostOverviewAccessTab /> before the host can answer", () => {
  it("says it is connecting and reads nothing", async () => {
    const host = hostWith({}, {});
    renderTab(host, { ...READY, connecting: true });

    expect(plainText(await screen.findByTestId("host-scope-connecting"))).toBe(
      "Connecting to dev-box…",
    );
    await settle();
    expect(host.reads.status).toBe(0);
  });

  it("says these need a connection when the scope cannot reach the host", async () => {
    const host = hostWith({}, {});
    renderTab(host, { ...READY, usable: false });

    expect(
      await screen.findByText(
        "These are dev-box's own, so they need a connection to it.",
      ),
    ).toBeTruthy();
    await settle();
    expect(host.reads.status).toBe(0);
  });

  it("says the same when there is no client, even if the scope looks usable", async () => {
    const host = hostWith({}, {});
    renderTab(host, { ...READY, withClient: false });

    expect(
      await screen.findByText(
        "These are dev-box's own, so they need a connection to it.",
      ),
    ).toBeTruthy();
    expect(host.reads.status).toBe(0);
  });

  it("asks the person to update a host that does not have environment.status", async () => {
    const host = hostWith({}, {});
    renderTab(host, { ...READY, methods: ["host.status"] });

    expect(
      (await screen.findByTestId("access-tab-update-host")).textContent,
    ).toBe("Update this host to use your settings.");
    expect(screen.queryByTestId("remote-access-section")).toBeNull();
    await settle();
    expect(host.reads.status).toBe(0);
  });

  it("shows a spinner until the first handshake says what the host has", async () => {
    const host = hostWith({}, {});
    renderTab(host, { ...READY, methods: null });

    expect(await screen.findByTestId("access-tab-loading")).toBeTruthy();
    await settle();
    expect(host.reads.status).toBe(0);
    expect(screen.queryByTestId("remote-access-section")).toBeNull();
  });

  it("says it could not read the host when the status read fails", async () => {
    const host = buildAccessHost({ failStatus: true });
    renderTab(host, READY);

    expect(
      await screen.findByText("Couldn't read this host's access and setup."),
    ).toBeTruthy();
    expect(screen.queryByTestId("remote-access-section")).toBeNull();
  });
});

describe("<HostOverviewAccessTab /> setup", () => {
  it("marks the steps done, running and waiting, and names the step", async () => {
    const host = hostWith(
      { setup: { stage: "moving_settings", state: "running" } },
      {},
    );
    renderTab(host, READY);

    await screen.findByTestId("host-setup-section");
    expect(stepMarks()).toEqual([
      "Registering this host=done",
      "Moving this host's settings to Personal=running",
      "Applying your settings=waiting",
    ]);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.queryByTestId("host-setup-stopped")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("marks the first step running at step 1", async () => {
    const host = hostWith(
      { setup: { stage: "registering", state: "running" } },
      {},
    );
    renderTab(host, READY);

    await screen.findByTestId("host-setup-section");
    expect(stepMarks()).toEqual([
      "Registering this host=running",
      "Moving this host's settings to Personal=waiting",
      "Applying your settings=waiting",
    ]);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("marks the step it stopped at, says so and Retry asks the host to try again", async () => {
    const host = hostWith(
      { setup: { stage: "applying", state: "stalled" } },
      {},
    );
    renderTab(host, READY);

    expect((await screen.findByTestId("host-setup-stopped")).textContent).toBe(
      "Setup stopped while applying your settings.",
    );
    expect(stepMarks()).toEqual([
      "Registering this host=done",
      "Moving this host's settings to Personal=done",
      "Applying your settings=stopped",
    ]);
    expect(screen.queryByText(/^Step \d of 3$/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(host.paramsOf("environment.setup.retry")).toEqual([{}]);
    });
  });

  it("gives a failed move its own sentence", async () => {
    const host = hostWith(
      { setup: { stage: "moving_settings", state: "failed" } },
      {},
    );
    renderTab(host, READY);

    expect((await screen.findByTestId("host-setup-stopped")).textContent).toBe(
      "Moving this host's settings to Personal failed.",
    );
    expect(stepMarks()).toEqual([
      "Registering this host=done",
      "Moving this host's settings to Personal=stopped",
      "Applying your settings=waiting",
    ]);
  });

  it("offers no Retry on a host that cannot retry setup", async () => {
    const host = hostWith(
      { setup: { stage: "registering", state: "failed" } },
      {},
    );
    renderTab(host, {
      ...READY,
      methods: ACCESS_METHODS.filter(
        (method) => method !== "environment.setup.retry",
      ),
    });

    expect((await screen.findByTestId("host-setup-stopped")).textContent).toBe(
      "Setup stopped while registering this host.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows a stage newer than this desktop as running with every step waiting", async () => {
    const host = hostWith(
      { setup: { stage: "provisioning", state: "running" } },
      {},
    );
    renderTab(host, READY);

    await screen.findByTestId("host-setup-section");
    expect(stepMarks()).toEqual([
      "Registering this host=waiting",
      "Moving this host's settings to Personal=waiting",
      "Applying your settings=waiting",
    ]);
    expect(screen.queryByText(/^Step \d of 3$/u)).toBeNull();
  });

  it("has no setup section once setup is done, or when the host has no setup record", async () => {
    const done = hostWith({ setup: { stage: "applying", state: "done" } }, {});
    renderTab(done, READY);
    await screen.findByTestId("remote-access-section");
    expect(screen.queryByTestId("host-setup-section")).toBeNull();
    cleanup();
    resetNegotiatedManifests();

    const none = hostWith({ setup: null }, {});
    renderTab(none, READY);
    await screen.findByTestId("remote-access-section");
    expect(screen.queryByTestId("host-setup-section")).toBeNull();
  });
});

describe("<HostOverviewAccessTab /> on a team's host", () => {
  it("shows the team line outside, and every section inside, an inert region", async () => {
    const host = hostWith(
      {
        principal: { kind: "team", teamName: "Acme" },
        setup: { stage: "applying", state: "stalled" },
      },
      {
        providers: [claudeAmbient(true)],
        overrides: [variableOverride("LOG_LEVEL", "debug")],
      },
    );
    renderTab(host, READY);

    const line = await screen.findByTestId("team-owned-line");
    expect(
      within(line).getByText("These settings belong to Acme."),
    ).toBeTruthy();
    expect(line.closest("[inert]")).toBeNull();
    expect(within(line).queryByRole("button")).toBeNull();
    expect(within(line).queryByRole("link")).toBeNull();

    for (const testId of [
      "remote-access-section",
      "host-setup-section",
      "terminal-accounts-section",
      "local-values-section",
    ]) {
      const section = await screen.findByTestId(testId);
      expect(section.closest("[inert]"), testId).not.toBeNull();
    }
  });

  it("names no team when the host reports no team name", async () => {
    const host = hostWith({ principal: { kind: "team", teamName: "" } }, {});
    renderTab(host, READY);

    const line = await screen.findByTestId("team-owned-line");

    expect(
      within(line).getByText("These settings belong to your team."),
    ).toBeTruthy();
  });

  it("shows no team line, and nothing inert, on the person's own host", async () => {
    const host = hostWith({ principal: { kind: "personal" } }, {});
    renderTab(host, READY);

    const section = await screen.findByTestId("remote-access-section");
    expect(screen.queryByTestId("team-owned-line")).toBeNull();
    expect(section.closest("[inert]")).toBeNull();
  });
});

describe("<HostOverviewAccessTab /> terminal accounts", () => {
  it("names the host in the sign-in sentence of a host that is not this machine", async () => {
    const host = hostWith({}, { providers: [claudeAmbient(true)] });
    renderTab(host, READY);

    await screen.findAllByTestId("terminal-account-row");
    expect(
      screen.getByText(
        "dev-box's own sign-in, which stays on dev-box. Link a plan to use one everywhere.",
      ),
    ).toBeTruthy();
  });

  it("says this computer in the sign-in sentence of this machine's own host", async () => {
    hostMock.binding = {
      auth: {},
      directory: {
        onChange: () => ({ dispose: () => undefined }),
        getLocalHostId: () => ACCESS_HOST_ID,
      },
    };
    const host = hostWith({}, { providers: [claudeAmbient(true)] });
    renderTab(host, READY);

    await screen.findAllByTestId("terminal-account-row");
    expect(
      screen.getByText(
        "This computer's own sign-in, which stays on this computer. Link a plan to use one everywhere.",
      ),
    ).toBeTruthy();
  });

  it("lists only the providers that have an ambient profile", async () => {
    const host = hostWith(
      {},
      {
        providers: [
          claudeAmbient(true),
          provider("codex", [profile("work", "managed")]),
        ],
      },
    );
    renderTab(host, READY);

    const rows = await screen.findAllByTestId("terminal-account-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Claude Code")).toBeTruthy();
    expect(within(rows[0]).getByText("Terminal account")).toBeTruthy();
    expect(
      screen.getByText(
        "dev-box's own sign-in, which stays on dev-box. Link a plan to use one everywhere.",
      ),
    ).toBeTruthy();
  });

  it("has no terminal accounts section when no provider has an ambient profile", async () => {
    const host = hostWith(
      {},
      { providers: [provider("codex", [profile("work", "managed")])] },
    );
    renderTab(host, READY);

    await screen.findByTestId("remote-access-section");
    await settle();
    expect(screen.queryByTestId("terminal-accounts-section")).toBeNull();
  });

  it("switches the ambient profile off with providers.setProfileEnabled", async () => {
    const host = hostWith({}, { providers: [claudeAmbient(true)] });
    renderTab(host, READY);

    const toggle = await screen.findByRole("switch", {
      name: "Claude Code Terminal account",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(host.paramsOf("providers.setProfileEnabled")).toEqual([
        { providerId: "claude-code", profileId: "ambient", enabled: false },
      ]);
    });
  });

  it("switches a disabled ambient profile on", async () => {
    const host = hostWith({}, { providers: [claudeAmbient(false)] });
    renderTab(host, READY);

    const toggle = await screen.findByRole("switch", {
      name: "Claude Code Terminal account",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(host.paramsOf("providers.setProfileEnabled")).toEqual([
        { providerId: "claude-code", profileId: "ambient", enabled: true },
      ]);
    });
  });
});

describe("<HostOverviewAccessTab /> this host's own values", () => {
  it("lists what is kept on this host, by name", async () => {
    const host = hostWith(
      {},
      {
        overrides: [
          variableOverride("LOG_LEVEL", "debug"),
          providerOverride("claude-code", "ANTHROPIC_BASE_URL", "http://proxy"),
        ],
      },
    );
    renderTab(host, READY);

    const rows = await screen.findAllByTestId("local-value-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("LOG_LEVEL"),
      expect.stringContaining("Claude Code: ANTHROPIC_BASE_URL"),
    ]);
    expect(within(rows[0]).getByText("debug")).toBeTruthy();
    expect(within(rows[1]).getByText("http://proxy")).toBeTruthy();
    expect(
      screen.getByText(
        "Agents started after a change use the new value; restart the host for the host itself to pick it up.",
      ),
    ).toBeTruthy();
  });

  it("says nothing is kept when the host keeps nothing", async () => {
    const host = hostWith({}, { overrides: [] });
    renderTab(host, READY);

    expect(
      await screen.findByText("No values are kept on this host only."),
    ).toBeTruthy();
    expect(screen.queryByTestId("local-value-row")).toBeNull();
  });

  it("is absent on a host that does not have environment.localOverrides", async () => {
    const host = hostWith({}, { overrides: [variableOverride("A", "1")] });
    renderTab(host, {
      ...READY,
      methods: ACCESS_METHODS.filter(
        (method) => method !== "environment.localOverrides",
      ),
    });

    await screen.findByTestId("remote-access-section");
    await settle();
    expect(screen.queryByTestId("local-values-section")).toBeNull();
  });

  it("Edit then Save sends the target and the new value, with the grant", async () => {
    hostMock.binding = {
      directory: null,
      auth: {
        mintExecutableWriteGrant: () =>
          Promise.resolve({
            kind: "ok" as const,
            grant: "grant-1",
            expiresInSeconds: 600,
          }),
        getCredentialGeneration: () => 0,
      },
    };
    const host = hostWith(
      {},
      { overrides: [variableOverride("LOG_LEVEL", "debug")] },
    );
    renderTab(host, READY);
    const row = await screen.findByTestId("local-value-row");

    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const field = within(row).getByLabelText("LOG_LEVEL value on this host");
    expect(field).toHaveProperty("value", "debug");
    // Nothing to save until the value differs.
    expect(
      within(row)
        .getByRole("button", { name: "Save" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(field, { target: { value: "info" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(host.paramsOf("config.env.localOverride.set")).toEqual([
        {
          target: { kind: "variable", key: "LOG_LEVEL" },
          value: "info",
          executableWriteGrant: "grant-1",
        },
      ]);
    });
    // Saved: the editor closes.
    await waitFor(() => {
      expect(
        screen.queryByLabelText("LOG_LEVEL value on this host"),
      ).toBeNull();
    });
  });

  it("Save on a provider's variable sends that provider's target", async () => {
    const host = hostWith(
      {},
      {
        overrides: [providerOverride("claude-code", "ANTHROPIC_BASE_URL", "a")],
      },
    );
    renderTab(host, READY);
    const row = await screen.findByTestId("local-value-row");

    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(
      within(row).getByLabelText(
        "Claude Code: ANTHROPIC_BASE_URL value on this host",
      ),
      { target: { value: "b" } },
    );
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(host.paramsOf("config.env.localOverride.set")).toEqual([
        {
          target: {
            kind: "env_override",
            providerId: "claude-code",
            key: "ANTHROPIC_BASE_URL",
          },
          value: "b",
          executableWriteGrant: null,
        },
      ]);
    });
  });

  it("Cancel closes the editor and sends nothing", async () => {
    const host = hostWith(
      {},
      { overrides: [variableOverride("LOG_LEVEL", "debug")] },
    );
    renderTab(host, READY);
    const row = await screen.findByTestId("local-value-row");

    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(
      within(row).getByLabelText("LOG_LEVEL value on this host"),
      {
        target: { value: "info" },
      },
    );
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("LOG_LEVEL value on this host")).toBeNull();
    expect(within(row).getByText("debug")).toBeTruthy();
    expect(host.requests).toEqual([]);
  });

  it("Clear sends config.env.localOverride.clear with the target", async () => {
    const host = hostWith(
      {},
      {
        overrides: [
          variableOverride("LOG_LEVEL", "debug"),
          providerOverride("codex", "OPENAI_BASE_URL", "x"),
        ],
      },
    );
    renderTab(host, READY);
    const rows = await screen.findAllByTestId("local-value-row");

    fireEvent.click(within(rows[1]).getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(host.paramsOf("config.env.localOverride.clear")).toEqual([
        {
          target: {
            kind: "env_override",
            providerId: "codex",
            key: "OPENAI_BASE_URL",
          },
        },
      ]);
    });
    expect(host.paramsOf("config.env.localOverride.set")).toEqual([]);
  });
});

describe("<HostOverviewAccessTab /> the moved-to-Personal notice", () => {
  const SETUP_DONE = { stage: "done", state: "done" } as const;

  it("shows once setup is done and a change came from this host's move", async () => {
    const host = hostWith(
      { setup: SETUP_DONE },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);

    const notice = await screen.findByTestId("moved-to-personal-notice");
    expect(
      within(notice).getByText(
        "Your settings moved to Personal. Review what changed.",
      ),
    ).toBeTruthy();
    expect(
      within(notice).getByRole("button", { name: "Dismiss" }),
    ).toBeTruthy();
  });

  it("is not shown while setup is still running", async () => {
    const host = hostWith(
      { setup: { stage: "moving_settings", state: "running" } },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);

    await screen.findByTestId("host-setup-section");
    await settle();
    expect(screen.queryByTestId("moved-to-personal-notice")).toBeNull();
    expect(host.reads.notices).toBe(0);
  });

  it("is not shown when no change came from the move", async () => {
    const host = hostWith(
      { setup: SETUP_DONE },
      { notices: [noticeFixture({ source: "offline" })] },
    );
    renderTab(host, READY);

    await waitFor(() => {
      expect(host.reads.notices).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("moved-to-personal-notice")).toBeNull();
  });

  it("is not shown on a team's host, whose notices are not read", async () => {
    const host = hostWith(
      { setup: SETUP_DONE, principal: { kind: "team", teamName: "Acme" } },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);

    await screen.findByTestId("team-owned-line");
    await settle();
    expect(screen.queryByTestId("moved-to-personal-notice")).toBeNull();
    expect(host.reads.notices).toBe(0);
  });

  it("Dismiss hides it and records the dismissal for that host only", async () => {
    const host = hostWith(
      { setup: SETUP_DONE },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);
    await screen.findByTestId("moved-to-personal-notice");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByTestId("moved-to-personal-notice")).toBeNull();
    });
    expect(useHostAccessPromptsStore.getState().movedNoticeDismissed).toEqual({
      [ACCESS_HOST_ID]: true,
    });
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
      {},
    );
  });

  it("stays hidden once dismissed on this desktop", async () => {
    useHostAccessPromptsStore.getState().dismissMovedNotice(ACCESS_HOST_ID);
    const host = hostWith(
      { setup: SETUP_DONE },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);

    await waitFor(() => {
      expect(host.reads.notices).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("moved-to-personal-notice")).toBeNull();
  });

  it("sends Review to the Secrets page", async () => {
    const host = hostWith(
      { setup: SETUP_DONE },
      { notices: [noticeFixture({ source: "migration" })] },
    );
    renderTab(host, READY);
    const notice = await screen.findByTestId("moved-to-personal-notice");

    fireEvent.click(within(notice).getByRole("button", { name: "Review" }));

    expect(navigateToSettingsSectionMock).toHaveBeenCalledTimes(1);
    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("secrets");
  });
});
