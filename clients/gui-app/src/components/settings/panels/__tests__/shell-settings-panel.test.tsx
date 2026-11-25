// The panel is host-scoped now (shell config / log levels are fields of the
// selected host's own config), so it reads `useHostScope`. Mock at that
// boundary: these suites render the panel bare, without the host runtime and
// query providers the real hook needs.
import type { EnvironmentCloudSource } from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";

type SettingsSaveItemExpectation = {
  readonly key: string;
  readonly value: string;
  readonly revision: number;
};

type HostBindingFixture = {
  readonly hostClient: unknown;
  readonly auth?: {
    readonly listEnvironments: () => Promise<EnvironmentDirectoryResult>;
  };
};

const settingsSaveCloudMock = vi.hoisted(() => ({
  current: null as EnvironmentCloudSource | null,
}));
const environmentEditorCommitObserver = vi.hoisted(() => ({
  current: null as {
    readonly hostId: string;
    readonly key: string;
    readonly value: string;
    readonly commit: () => void;
  } | null,
}));

const scopeOverrides = vi.hoisted(
  (): {
    current: Record<string, unknown>;
    byHost: Map<string, Record<string, unknown>>;
  } => ({ current: {}, byHost: new Map() }),
);
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { useContext } = await import("react");
  const { PersonalPageContext } =
    await import("@/components/settings/personal/personal-page-context");
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => {
    const page = useContext(PersonalPageContext);
    const scope =
      page === null
        ? scopeOverrides.current
        : (scopeOverrides.byHost.get(page.hostId ?? "") ??
          scopeOverrides.current);
    return hostScopeFixture(scope);
  };
  return {
    useHostScope,
    useHostScopeFor: useHostScope,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
    usePersonalHostScope: useHostScope,
  };
});

// `useScopedHostBinding` (and the panel's own direct `useHostBinding()?.hostClient`
// reads) go through this module. Panel suites mock it wholesale rather than
// standing up a real `<HostRuntimeProvider>` - see `providers-settings-panel.test.tsx`
// and `provider-mcp-tab.test.tsx` for the same partial-object pattern.
const hostBindingMock = vi.hoisted(
  (): {
    current: HostBindingFixture | null;
    byHost: Map<string, HostBindingFixture>;
  } => ({ current: null, byHost: new Map() }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  const { useContext } = await import("react");
  const { PersonalPageContext } =
    await import("@/components/settings/personal/personal-page-context");
  const useBinding = () => {
    const page = useContext(PersonalPageContext);
    return page === null
      ? hostBindingMock.current
      : (hostBindingMock.byHost.get(page.hostId ?? "") ??
          hostBindingMock.current);
  };
  return {
    ...actual,
    useHostBinding: useBinding,
    // Add a secret, which a key-shaped value is refused for, reads the client.
    useHostClient: () => useBinding()?.hostClient,
  };
});

vi.mock("@/hooks/environment/use-environment-cloud", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/environment/use-environment-cloud")
    >();
  return {
    ...actual,
    useEnvironmentCloud: () => settingsSaveCloudMock.current,
  };
});

vi.mock(
  "@/components/settings/panels/env-override-editor",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/env-override-editor")
      >();
    const { createElement, useContext, useLayoutEffect } =
      await import("react");
    const { PersonalPageContext } =
      await import("@/components/settings/personal/personal-page-context");
    type EditorProps = import("react").ComponentProps<
      typeof actual.EnvOverrideEditor
    >;
    const EnvOverrideEditorWithCommitSignal = (props: EditorProps) => {
      const page = useContext(PersonalPageContext);
      const observer = environmentEditorCommitObserver.current;
      const receivedExpectedRow =
        observer !== null &&
        page?.hostId === observer.hostId &&
        props.overrides.some(
          (entry) =>
            entry.key === observer.key && entry.value === observer.value,
        );
      useLayoutEffect(() => {
        if (receivedExpectedRow) {
          environmentEditorCommitObserver.current?.commit();
        }
      }, [receivedExpectedRow]);
      return createElement(actual.EnvOverrideEditor, props);
    };
    return {
      ...actual,
      EnvOverrideEditor: EnvOverrideEditorWithCommitSignal,
    };
  },
);

const sandboxCredentialRefusal = vi.hoisted(() => ({
  current: null as string | null,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => sandboxCredentialRefusal.current,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  configEnvListRequestSchema,
  configEnvListResponseSchema,
  configEnvSetRequestSchema,
  configEnvSetResponseSchema,
  type ConfigEnvSetRequest,
} from "@traycer/protocol/host/config/index";
import {
  environmentHostReadRequestSchema,
  environmentHostReadResponseSchemaV11,
} from "@traycer/protocol/host/environment/contracts";
import { environmentStatusV13 } from "@traycer/protocol/host/environment-contracts";
import {
  environmentLocalOverridesRequestSchema,
  environmentLocalOverridesResponseSchema,
} from "@traycer/protocol/host/environment-schemas";
import {
  environmentProposalsV12,
  settingValueSchema,
} from "@traycer/protocol/host/environment/settings-proposals";
import {
  authnHeldApplyConflictSchema,
  authnItemWriteResponseSchema,
  authnItemsResponseSchema,
  authnOperationReviewResponseSchema,
  type AuthnItemRow,
} from "@traycer-clients/shared/environment/authn-environment-schemas";
import {
  environmentPath,
  type EnvironmentCloud,
  type EnvironmentTransportAnswer,
  type EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import { createSettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { settingsSaveIdFromRequestId } from "@traycer/protocol/framework/settings-save-request-id";
import { SettingsSaveCoordinatorContext } from "@/providers/settings-save-coordinator-context";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";
import {
  ABANDONED_SAVE_MESSAGE,
  abandonedSaveError,
  saveTransportFailure,
} from "@/lib/environment/__tests__/settings-save-failure-fixtures";
import {
  advanceLegendListTime,
  installLegendListTestClock,
} from "@/components/chat/__tests__/legend-list-test-environment";
import type {
  IRunnerHost,
  TraycerShellConfigSetInput,
} from "@traycer-clients/shared/platform/runner-host";
import type { LocalOverride } from "@traycer/protocol/host/environment-schemas";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  PersonalPageContext,
  type PersonalPageContextValue,
} from "@/components/settings/personal/personal-page-context";
import {
  useEnvironmentLocalOverridesRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useRereadOnStaleWrite } from "@/hooks/environment/use-reread-on-stale-write";
import { useRereadHostReadsOnFocus } from "@/hooks/environment/use-reread-host-reads-on-focus";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentStaleWrite } from "@traycer/protocol/framework/environment-stale-write";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { environmentQueryKeys, queryKeys } from "@/lib/query-keys";
import {
  ALL_CONFIG_RPC_METHODS,
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
  type ConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { queryUpdatedBeyond } from "./kept-variable-actions-support";
import type {
  MockHandlerMap,
  MockPhaseEvent,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  scopeOverrides.byHost.clear();
  hostBindingMock.current = null;
  hostBindingMock.byHost.clear();
  settingsSaveCloudMock.current = null;
  environmentEditorCommitObserver.current = null;
  sandboxCredentialRefusal.current = null;
});

// A non-login program: its family default is no flags, so switching to it must
// swap the flags row away from the login shell's "-i -l".
const CAT = {
  name: "cat",
  path: "/bin/cat",
  isDefault: false,
  source: "detected" as const,
  missing: false,
};

/** Opening an editor requires its first successful environment read. */
async function openEnvAdd(): Promise<void> {
  const add = await screen.findByRole("button", { name: "Add a variable" });
  await waitFor(() => expect(add).toHaveProperty("disabled", false));
  fireEvent.click(add);
}

const SAVED_FLASH_MS = 1600;

/**
 * The panel over the config RPC path - the production path for every
 * reachable host, local or remote. Wires a real `HostClient` (over an
 * in-memory messenger delegating to a `MockTraycerCli`) as the SCOPED host's
 * client, so writes exercise the real `useHostQuery`/`useHostMutation` wiring
 * rather than a bridge stub.
 */
function renderShellPanelOverRpc(options: {
  readonly configure?: (cli: MockTraycerCli) => void;
  /** Supply the CLI when a handler override needs to close over it. */
  readonly cli?: MockTraycerCli;
  /** Replaces individual RPC handlers - e.g. to hold one write pending. */
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly hostId?: string;
  readonly isLocalMachine?: boolean;
  readonly connectable?: boolean;
  /** Supplies the Personal page context that offers local values for Use everywhere. */
  readonly localOverrides?: readonly LocalOverride[];
  readonly liveLocalOverrides?: true;
  /**
   * Recorded via `recordNegotiatedHostMethods`. Defaults to the full shell
   * family (a host that has handshaked and supports everything); pass `null`
   * to record NOTHING for this host id — the "no handshake yet" tri-state,
   * distinct from a recorded-but-empty manifest.
   */
  readonly methods?: readonly string[] | null;
  readonly hostKind?: HostScopeOption["kind"];
  readonly saveCoordinator?: SettingsSaveCoordinator;
  readonly environmentDirectory?: EnvironmentDirectoryResult;
  readonly liveEnvironmentStatus?: true;
  readonly hostName?: string;
}): ConfigHostFixture & {
  readonly queryClient: QueryClient;
  readonly container: HTMLElement;
  readonly activateBindings: () => void;
  readonly rerenderPanel: () => void;
  readonly unmountPanel: () => void;
} {
  const hostId = options.hostId ?? "host-a";
  const isLocalMachine = options.isLocalMachine ?? true;
  const cli = options.cli ?? new MockTraycerCli();
  options.configure?.(cli);
  const fixture = buildConfigHostFixture({
    hostId,
    isLocalMachine,
    cli,
    overrideHandlers: options.overrideHandlers,
  });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(
      hostId,
      options.methods ?? [
        ...CONFIG_SHELL_METHODS,
        ...(options.localOverrides === undefined
          ? []
          : ["config.env.localOverride.clear"]),
      ],
    );
  }

  const scope = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine,
      connectable: options.connectable ?? true,
      kind: options.hostKind ?? "personal",
      sandbox:
        options.hostKind === "sandbox"
          ? {
              state: null,
              frozen: false,
              summary: null,
              teamOwned: false,
              ownerKind: "unknown",
            }
          : null,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  const environmentDirectory = options.environmentDirectory;
  const binding: HostBindingFixture = {
    hostClient: fixture.client,
    ...(environmentDirectory === undefined
      ? {}
      : {
          auth: {
            listEnvironments: () => Promise.resolve(environmentDirectory),
          },
        }),
  };
  const activateBindings = (): void => {
    scopeOverrides.current = scope;
    scopeOverrides.byHost.set(hostId, scope);
    hostBindingMock.current = binding;
    hostBindingMock.byHost.set(hostId, binding);
  };
  activateBindings();

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const personalPageValue = {
    section: "shell",
    pick: PERSONAL_PICK,
    state: { kind: "unknown" },
    hostName: options.hostName ?? hostId,
    localOverrides: options.localOverrides ?? [],
    hostId,
    client: fixture.client,
    notices: [],
    review: [],
  } satisfies PersonalPageContextValue;
  const panel = () => {
    let settingsPanel = <ShellSettingsPanel />;
    if (options.liveLocalOverrides === true) {
      settingsPanel =
        options.liveEnvironmentStatus === true ? (
          <ShellPanelWithLiveStatusAndLocalOverrides page={personalPageValue} />
        ) : (
          <ShellPanelWithLiveLocalOverrides page={personalPageValue} />
        );
    } else if (options.localOverrides !== undefined) {
      settingsPanel = (
        <PersonalPageContext.Provider value={personalPageValue}>
          <ShellSettingsPanel />
        </PersonalPageContext.Provider>
      );
    }
    if (options.saveCoordinator !== undefined) {
      settingsPanel = (
        <SettingsSaveCoordinatorContext.Provider
          value={options.saveCoordinator}
        >
          {settingsPanel}
        </SettingsSaveCoordinatorContext.Provider>
      );
    }
    return (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRereaders hostId={hostId} />
          {settingsPanel}
        </RunnerHostProvider>
      </QueryClientProvider>
    );
  };
  const rendered = render(panel());
  return {
    ...fixture,
    queryClient,
    container: rendered.container,
    activateBindings,
    rerenderPanel: () => {
      activateBindings();
      rendered.rerender(panel());
    },
    unmountPanel: () => rendered.unmount(),
  };
}

function ShellPanelWithLiveLocalOverrides(props: {
  readonly page: PersonalPageContextValue;
}) {
  const { page } = props;
  const { data } = useEnvironmentLocalOverridesRead(
    page.client,
    page.hostId,
    true,
  );
  return (
    <PersonalPageContext.Provider
      value={{ ...page, localOverrides: data?.overrides ?? [] }}
    >
      <ShellSettingsPanel />
    </PersonalPageContext.Provider>
  );
}

function ShellPanelWithLiveStatusAndLocalOverrides(props: {
  readonly page: PersonalPageContextValue;
}) {
  return (
    <PersonalPageContext.Provider value={props.page}>
      <ShellPanelStatusAndLocalOverrides page={props.page} />
    </PersonalPageContext.Provider>
  );
}

function ShellPanelStatusAndLocalOverrides(props: {
  readonly page: PersonalPageContextValue;
}) {
  const { page } = props;
  useEnvironmentStatusRead(page.client, page.hostId, true);
  const { data } = useEnvironmentLocalOverridesRead(
    page.client,
    page.hostId,
    true,
  );
  return (
    <PersonalPageContext.Provider
      value={{ ...page, localOverrides: data?.overrides ?? [] }}
    >
      <ShellSettingsPanel />
    </PersonalPageContext.Provider>
  );
}

/**
 * The Local page's rereaders: a stale refusal or window focus refreshes the
 * host's settings through the same hooks as `PersonalPageFrame`.
 */
function HostRereaders(props: { readonly hostId: string }) {
  useRereadOnStaleWrite(props.hostId, null);
  useRereadHostReadsOnFocus(props.hostId);
  return null;
}

/**
 * This computer's host, unable to answer for itself: the panel falls back to
 * the CLI bridge. Covers BOTH `localConfigFallbackReason` outcomes for a local
 * host - `connectable: false` ("host-stopped", the default) or a connectable
 * host whose recorded manifest omits `config.shell.get` ("host-outdated").
 */
function renderShellPanelStoppedLocal(options: {
  readonly configure: (cli: MockTraycerCli) => void;
  readonly connectable?: boolean;
  /** Recorded via `recordNegotiatedHostMethods` when given; omitted otherwise (no handshake yet). */
  readonly methods?: readonly string[];
}): MockTraycerCli {
  const hostId = "host-a";
  const cli = new MockTraycerCli();
  options.configure(cli);
  if (options.methods !== undefined) {
    recordNegotiatedHostMethods(hostId, options.methods);
  }
  const connectable = options.connectable ?? false;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable,
    }),
    hostId,
    status: connectable ? "ready" : "unreachable",
  };
  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: cli,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <ShellSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return cli;
}

// Kept as a thin wrapper so the existing hierarchy/flags-row suites below stay
// unchanged apart from the transport underneath them.
function renderPanel(configure: (cli: MockTraycerCli) => void): MockTraycerCli {
  const fixture = renderShellPanelOverRpc({ configure });
  return fixture.cli;
}

function statusTexts(): string[] {
  return screen.getAllByRole("status").map((node) => node.textContent);
}

describe("<ShellSettingsPanel /> hierarchy", () => {
  it("labels the two cards with scope tags and puts the effective command first", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    const preview = await screen.findByLabelText("Effective shell command");
    const terminalCard = screen.getByTestId("terminal-shell-settings");
    const envCard = screen.getByTestId("host-environment-settings");

    expect(
      within(terminalCard).getByRole("heading", {
        name: "Terminal shell · New terminals",
      }),
    ).toBeTruthy();
    expect(
      within(envCard).getByRole("heading", {
        name: "Variables · After restart",
      }),
    ).toBeTruthy();

    // Cards do not repeat their external labels as internal headings, and the
    // pre-redesign "Environment variables" / bare "Shell" card titles are gone.
    expect(
      within(terminalCard).queryByRole("heading", { name: "Shell" }),
    ).toBeNull();
    expect(
      within(envCard).queryByRole("heading", {
        name: "Environment variables",
      }),
    ).toBeNull();

    const programLabel = within(terminalCard).getByText("Shell program");
    expect(
      preview.compareDocumentPosition(programLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(preview).getByText("effective command")).toBeTruthy();
    expect(within(preview).getByText("/bin/zsh")).toBeTruthy();
    expect(within(preview).getByText("-i -l")).toBeTruthy();
  });

  it("does not reserve a persistent visible Saved footer or status line", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Pre-redesign SaveStatus always painted a visible "Saved" chip in the
    // card footers. Idle chrome must stay quiet.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();
    expect(screen.queryByTestId("settings-shell-saving-spinner")).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-flags-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-environment-saving-spinner"),
    ).toBeNull();

    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.classList.contains("sr-only")).toBe(true);
      expect(status.textContent).toBe("");
    }
  });

  it("announces transient saving/saved feedback beside the changed control", async () => {
    // Gate holds the mutation in pending; setFinished resolves only after the
    // full shellConfigSet (gate + originalSet) completes — not merely after
    // the gate opens.
    let releaseGate: (() => void) | null = null;
    const setGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let resolveSetFinished: (() => void) | null = null;
    const setFinished = new Promise<void>((resolve) => {
      resolveSetFinished = resolve;
    });

    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      const originalSet = cli.shellConfigSet.bind(cli);
      cli.shellConfigSet = async (
        input: TraycerShellConfigSetInput,
      ): Promise<void> => {
        await setGate;
        try {
          await originalSet(input);
        } finally {
          resolveSetFinished?.();
        }
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Live regions mount at the terminal group root (program first, flags
    // second), outside the config-dependent skeleton/content branch.
    const terminalGroup = screen.getByTestId("terminal-shell-settings");
    const terminalStatuses = within(terminalGroup).getAllByRole("status");
    expect(terminalStatuses.length).toBe(2);
    const flagsStatus = terminalStatuses[1];
    expect(flagsStatus.textContent).toBe("");

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-shell-flags-saving-spinner"),
      ).toBeTruthy();
      // Same DOM node as idle; only text changes (fails if status remounts).
      expect(flagsStatus.textContent).toBe("Startup flags saving");
    });
    expect(
      within(screen.getByTestId("terminal-shell-settings")).getAllByRole(
        "status",
      )[1],
    ).toBe(flagsStatus);
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    // No permanent visible Saved/Saving label during the transient path either.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();

    // Installed before the save completes: the "saved" flash's timer is armed
    // by that completion, so it must already be a fake one.
    vi.useFakeTimers();
    await act(async () => {
      releaseGate?.();
      await setFinished;
      await vi.advanceTimersByTimeAsync(0);
    });

    // Re-query the second group-root status so remounts are distinguished
    // from sync races on the captured reference.
    expect(
      screen.queryByTestId("settings-shell-flags-saving-spinner"),
    ).toBeNull();
    const savedStatus = within(
      screen.getByTestId("terminal-shell-settings"),
    ).getAllByRole("status")[1];
    expect(savedStatus.textContent).toBe("Startup flags saved");
    expect(savedStatus).toBe(flagsStatus);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_FLASH_MS);
    });
    const clearedStatus = within(
      screen.getByTestId("terminal-shell-settings"),
    ).getAllByRole("status")[1];
    expect(clearedStatus.textContent).toBe("");
    expect(clearedStatus).toBe(flagsStatus);
    expect(statusTexts().every((text) => text === "")).toBe(true);
  });
});

describe("<ShellSettingsPanel /> flags row", () => {
  it("names the flags row after the shell and shows the profile helper for a login shell", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
  });

  it("floors the flags row label below md so the chips take their own line", async () => {
    // This row is two columns from its own markup rather than through
    // SettingsRow, so the shared floor is the only thing putting one under its
    // label - and the floor is what flex line-breaking acts on. Without it the
    // chips-plus-restore-button cluster keeps its intrinsic width, the label
    // takes whatever remains, and at phone width that is a sliver breaking
    // "Startup flags for zsh" one word per line. The floor pushes the cluster
    // onto a line of its own instead.
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    const label = await screen.findByText("Startup flags for zsh");
    const labelBlock = label.parentElement;
    if (labelBlock === null) throw new Error("expected label block parent");
    const row = labelBlock.parentElement;
    if (row === null) throw new Error("expected flags row container");

    expect(labelBlock.className).toContain("max-md:min-w-[70%]");
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("max-md:gap-y-3");
  });

  it("swaps the flags row to the newly-selected shell (label + helper + chips)", async () => {
    renderPanel((cli) => {
      // Synthesised so the picker trigger reads "System default" (unambiguous
      // to target), while the flags row still names the resolved login shell.
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      cli.detectedShells = [
        {
          name: "zsh",
          path: "/bin/zsh",
          isDefault: true,
          source: "detected",
          missing: false,
        },
        CAT,
      ];
    });

    // Starts on the login shell: profile helper present, flag chips shown.
    await screen.findByText("Startup flags for zsh");
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
    expect(screen.getByText("-i")).toBeTruthy();

    // Open the picker (its trigger reads "System default") and select cat.
    const trigger = screen.getByText("System default").closest("button");
    if (trigger === null) throw new Error("no picker trigger");
    fireEvent.click(trigger);
    const catRow = screen
      .getAllByRole("option")
      .find((row) => row.textContent.includes("/bin/cat"));
    if (catRow === undefined) throw new Error("no /bin/cat row");
    fireEvent.click(catRow);

    // The flags row follows the selection: label names cat, the profile helper
    // is replaced by the plain launch helper, and the login flags are gone.
    expect(await screen.findByText("Startup flags for cat")).toBeTruthy();
    expect(
      screen.getByText("Passed to cat each time a terminal opens."),
    ).toBeTruthy();
    expect(screen.queryByText(/loads your full shell profile/)).toBeNull();
    expect(await screen.findByText("No flags")).toBeTruthy();
  });

  it("keeps the System default row checked when editing flags on it", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");
    // The trigger reads "System default" — the auto state is active.
    expect(screen.getByText("System default")).toBeTruthy();

    // Add a flag chip via the "＋ flag" affordance. (Exact name: the
    // "Restore default flags" button also contains "flag".)
    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    // The new flag persists to the login shell's entry, but the selection stays
    // on the system default: the trigger still reads "System default".
    expect(await screen.findByText("-x")).toBeTruthy();
    expect(screen.getByText("System default")).toBeTruthy();
    expect(screen.getByText("Startup flags for zsh")).toBeTruthy();
  });

  // Restore stays on the flags row and is gated by `disabled`: predictable
  // placement, enabled exactly while the visible flags deviate from the
  // selected shell's family default.
  it("disables Restore default flags when the flags match the family default", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"], // == family default for a login shell
        synthesised: true,
      };
    });
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(true);
  });

  it("enables Restore default flags on a deviation and restores on click", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i"], // deviates from the -i -l family default
        synthesised: false,
      };
      cli.shellEntries = [{ path: "/bin/zsh", args: ["-i"] }];
    });

    // Wait for the config to load (the button renders immediately but stays
    // disabled until then), then it's enabled because the flags deviate.
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(false);
    fireEvent.click(restore);

    // Flags return to the family default; the button stays rendered but is
    // disabled again.
    expect(await screen.findByText("-l")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Restore default flags" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("<ShellSettingsPanel /> remote host over RPC", () => {
  it("renders the full editor for a remote, connectable host and writes go out as config.shell.* RPCs to that host's client", async () => {
    const fixture = renderShellPanelOverRpc({
      hostId: "host-remote",
      isLocalMachine: false,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.getByTestId("terminal-shell-settings")).toBeTruthy();
    expect(screen.getByTestId("host-environment-settings")).toBeTruthy();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("-x")).toBeTruthy();
    });
    // The write actually reached this host's mock CLI-backed handler — the
    // config.shell.set RPC delegates to it, so a value change here proves the
    // request was dispatched (and answered) rather than merely rendered.
    expect(fixture.cli.shellConfig.args).toContain("-x");
  });

  it("hides the native Browse affordance for a remote host (typed-path degrade)", async () => {
    renderShellPanelOverRpc({
      hostId: "host-remote",
      isLocalMachine: false,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    const trigger = (await screen.findByText("System default")).closest(
      "button",
    );
    if (trigger === null) throw new Error("no picker trigger");
    fireEvent.click(trigger);

    expect(await screen.findByLabelText("Add a shell by path")).toBeTruthy();
    expect(screen.queryByText("Browse…")).toBeNull();
  });
});

describe("<ShellSettingsPanel /> host-config-unsupported degrade", () => {
  it("shows the unsupported notice, without crashing, for a REMOTE host handshaked without config.shell.get", async () => {
    renderShellPanelOverRpc({
      hostId: "host-old",
      isLocalMachine: false,
      // Handshaked WITHOUT the shell family — an old host.
      methods: ["host.status"],
      configure: (cli) => {
        cli.shellConfig = { path: "/bin/zsh", args: [], synthesised: true };
      },
    });

    const notice = await screen.findByTestId("host-config-unsupported-notice");
    expect(notice.textContent).toContain("running an older version");
    expect(screen.queryByTestId("terminal-shell-settings")).toBeNull();
    expect(screen.queryByText("Startup flags for zsh")).toBeNull();
    // A remote host has no local truth to fall back to — it never takes the
    // bridge notice, only the capability one.
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });
});

describe("<ShellSettingsPanel /> local host falls back to the CLI bridge", () => {
  it('host-stopped: reads and writes through the CLI bridge, with data-reason="host-stopped"', async () => {
    const cli = renderShellPanelStoppedLocal({
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
      connectable: false,
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-stopped");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    // The write actually reached the local CLI bridge, not an RPC handler.
    await waitFor(() => {
      expect(cli.shellConfig.args).toContain("-x");
    });
    expect(await screen.findByText("-x")).toBeTruthy();
  });

  // The widened case: a RUNNING, connectable local host whose handshake did
  // not carry `config.shell.get` (the fleet-update window — the app updated
  // before the host it manages) still gets a working, bridge-backed page
  // instead of the capability notice.
  it('host-outdated: a connectable local host with an old manifest still uses the bridge, with data-reason="host-outdated"', async () => {
    const cli = renderShellPanelStoppedLocal({
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
      connectable: true,
      methods: ["host.status"], // handshaked WITHOUT config.shell.get
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(cli.shellConfig.args).toContain("-x");
    });
    expect(await screen.findByText("-x")).toBeTruthy();
  });

  // The tri-state guard: a local, CONNECTABLE host with no recorded manifest
  // at all ("not dialled yet", not "unsupported") must take the RPC path, not
  // the bridge — collapsing the tri-state to a boolean would divert it here
  // permanently, before its own first RPC ever produced an answer.
  it("does not fall back for a connectable local host with no handshake recorded yet", async () => {
    const fixture = renderShellPanelOverRpc({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: true,
      methods: null,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    // Loaded from the RPC-backed fixture client, not the bridge.
    expect(fixture.cli.shellConfig.path).toBe("/bin/zsh");
  });
});

// The negotiated-manifest registry never clears a stale `false` answer on its
// own - `useHostCapabilityProbe` is what re-dials a parked host so a page that
// promises "update the host and this fills in on its own" can keep that
// promise. These pins prove the probe actually dispatched (not merely that
// the panel changed state for some other reason), then prove the RPC path
// resumes once a fresh handshake and a bumped incarnation land.
describe("<ShellSettingsPanel /> capability-probe self-heal", () => {
  it("remote host: probes host.status while parked, then resumes the RPC editor once the host re-handshakes with the shell family", async () => {
    const hostId = "host-old";
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: false,
      cli,
    });
    // Handshaked WITHOUT the shell family - parks the panel on the unsupported notice.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: false,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const runnerHost: IRunnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByTestId("host-config-unsupported-notice"),
    ).toBeTruthy();

    // Non-vacuity discriminator: without the probe wired up, nothing would
    // ever call host.status while parked.
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(0);
    });
    const callsWhileParked = fixture.hostStatusCalls();

    // Bump ONLY the incarnation, manifest still unhealed: this is the leg
    // `cacheKeyIdentity` protects - a re-dial driven purely by the host's
    // version changing, still while parked. Without a cache key keyed on the
    // incarnation, this rerender would reuse the already-fetched query and
    // never ask again.
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: false,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(callsWhileParked);
    });

    // Now simulate the host updating in place: a fresh handshake carries the
    // shell family, and the host's own incarnation bumps again.
    recordNegotiatedHostMethods(hostId, ALL_CONFIG_RPC_METHODS);
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: false,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });

  it("local, connectable, outdated host: probes host.status while parked on the bridge, then resumes the RPC editor once the host re-handshakes", async () => {
    const hostId = "host-a";
    const bridgeCli = new MockTraycerCli();
    bridgeCli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    const rpcCli = new MockTraycerCli();
    rpcCli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    // Backs the probe's client (and the eventual RPC editor) - independent of
    // the local bridge's own MockTraycerCli, since a "host-outdated" host
    // reads/writes through the bridge until it heals.
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: true,
      cli: rpcCli,
    });
    // Handshaked WITHOUT the shell family - the fleet-update window.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: true,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const runnerHost: IRunnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: bridgeCli,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();

    // Non-vacuity discriminator: the probe dispatched over the scoped client
    // even though the panel itself is reading/writing through the bridge.
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(0);
    });
    const callsWhileParked = fixture.hostStatusCalls();

    // Bump ONLY the incarnation, manifest still unhealed: this is the leg
    // `cacheKeyIdentity` protects - a re-dial driven purely by the host's
    // version changing, still while parked.
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: true,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(callsWhileParked);
    });

    recordNegotiatedHostMethods(hostId, ALL_CONFIG_RPC_METHODS);
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: true,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    });
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
  });
});

describe("<ShellSettingsPanel /> env rename survives unmount", () => {
  /**
   * The rename is ONE operation, and this pins the property the repair rests
   * on: both writes live inside a single `mutationFn`, so neither half is
   * carried by a per-`mutate` callback.
   *
   * The discriminating instant is the SET being in flight when the panel goes
   * away - not the delete. In the defective shape (`setEnv(..., { onSuccess:
   * () => deleteEnv(old) })`) a set that resolves while still mounted fires
   * its callback normally and the delete goes out, so holding the DELETE
   * pending proves nothing: both shapes pass. Hold the SET across the unmount
   * and the shapes separate - TanStack drops the per-`mutate` callbacks of an
   * observer that is gone, so the defective shape never dispatches the delete
   * and the rename leaves TWO live variables, while the repaired one completes
   * inside its own `mutationFn`.
   */
  it("drops the old key when the set is still in flight as the panel unmounts", async () => {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    cli.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];

    let releaseSet: (() => void) | null = null;
    const setInFlight = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    let setDispatched: (() => void) | null = null;
    const setReached = new Promise<void>((resolve) => {
      setDispatched = resolve;
    });

    renderShellPanelOverRpc({
      cli,
      overrideHandlers: {
        "config.env.set": async (request) => {
          setDispatched?.();
          await setInFlight;
          await cli.envOverrideSet(request);
          return { key: request.key, value: request.value };
        },
      },
    });

    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    // Blur directly: the row commits in `onBlur`, and Enter only gets there by
    // calling `.blur()` on the focused element - which jsdom no-ops when the
    // input was never focused, so a keyDown alone commits nothing.
    fireEvent.blur(nameInput);

    // The rename is genuinely airborne before the panel goes away; without
    // this the unmount could precede the request and prove nothing.
    await act(async () => {
      await setReached;
    });

    cleanup();

    await act(async () => {
      releaseSet?.();
      await Promise.resolve();
    });

    // Terminal state of the store the host will read: renamed, not duplicated.
    // BOTH halves in one condition. The set writes NEW_NAME before the delete
    // runs, so waiting on NEW_NAME alone awaits an intermediate state and the
    // follow-up assertion could fail a CORRECT implementation the moment the
    // delete lands a microtask later.
    await waitFor(() => {
      const keys = cli.envOverrides.map((row) => row.key);
      expect(keys).toContain("NEW_NAME");
      expect(keys).not.toContain("OLD_NAME");
    });
  });

  /**
   * The SAME property on the stopped-local fallback. The bridge speaks IPC
   * rather than host RPC, which tempted a comment claiming it had "no
   * cross-observer boundary to lose the delete at" - but the boundary that
   * loses the second half is the OBSERVER, not the transport, so a delete
   * chained onto the set's per-`mutate` callback was dropped here exactly as
   * it was on the RPC path. This is the user-facing path for a host that is
   * stopped or predates the config methods, so it needs its own pin.
   */
  it("drops the old key on the bridge fallback when the set is still in flight as the panel unmounts", async () => {
    let releaseSet: (() => void) | null = null;
    const setInFlight = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    let setDispatched: (() => void) | null = null;
    const setReached = new Promise<void>((resolve) => {
      setDispatched = resolve;
    });

    const cli = renderShellPanelStoppedLocal({
      configure: (target) => {
        target.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
        target.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];
        const originalSet = target.envOverrideSet.bind(target);
        target.envOverrideSet = async (input): Promise<void> => {
          setDispatched?.();
          await setInFlight;
          await originalSet(input);
        };
      },
    });

    expect(
      await screen.findByTestId("local-config-fallback-notice"),
    ).toBeTruthy();
    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    fireEvent.blur(nameInput);

    await act(async () => {
      await setReached;
    });

    cleanup();

    await act(async () => {
      releaseSet?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      const keys = cli.envOverrides.map((row) => row.key);
      expect(keys).toContain("NEW_NAME");
      expect(keys).not.toContain("OLD_NAME");
    });
  });
});

describe("<ShellSettingsPanel /> partially failed rename refreshes the editor", () => {
  /**
   * A rename is two writes, so it has a THIRD outcome besides success and
   * failure: the set lands and the delete rejects, leaving both keys on the
   * host. Invalidating only in `onSuccess` skips that path entirely, so the
   * editor keeps rendering the pre-rename list over a config the host will
   * actually read. Both controllers invalidate on SETTLEMENT for this reason.
   */
  it("shows the new key after the delete half fails, on the RPC path", async () => {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    cli.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];

    renderShellPanelOverRpc({
      cli,
      overrideHandlers: {
        "config.env.delete": () =>
          Promise.reject(new Error("delete refused by the host")),
      },
    });

    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    fireEvent.blur(nameInput);

    // The set landed, so the store holds BOTH keys; the editor must refetch
    // and show that rather than sitting on its pre-rename snapshot.
    expect(
      await screen.findByRole("textbox", { name: "Name for NEW_NAME" }),
    ).toBeTruthy();
    expect(cli.envOverrides.map((row) => row.key)).toContain("OLD_NAME");
  });

  // NOTE: there is deliberately no bridge-path twin of this test. One was
  // written and PROVED VACUOUS - it passed with the invalidation reverted to
  // `onSuccess`-only, because something else on that path refreshes the list
  // before the assertion runs. The bridge controller still invalidates on
  // settlement, for symmetry with the RPC twin above and because the failure
  // mode is identical; it is simply not pinned here rather than pinned by a
  // test that cannot fail. Do not re-add one in this shape.
});

describe("<ShellSettingsPanel /> host environment variables", () => {
  const SIGN_IN_URL = "https://ghp_x@github.com/o/r";

  function envCli(): MockTraycerCli {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    return cli;
  }

  function envSetSpy(cli: MockTraycerCli) {
    return vi.fn(async (request: { key: string; value: string | null }) => {
      await cli.envOverrideSet(request);
      return { key: request.key, value: request.value };
    });
  }

  async function addVariable(
    placeholder: string,
    name: string,
    value: string,
  ): Promise<void> {
    await openEnvAdd();
    fireEvent.change(screen.getByPlaceholderText(placeholder), {
      target: { value: name },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
  }

  it("saves a value that is a URL with a sign-in", async () => {
    const cli = envCli();
    const set = envSetSpy(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set },
    });

    await addVariable("OPENAI_API_KEY", "REPO_URL", SIGN_IN_URL);

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "REPO_URL",
      value: SIGN_IN_URL,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("saves a credential-shaped variable from a sandbox's Variables and shells settings", async () => {
    sandboxCredentialRefusal.current = "Sandboxes don't take sign-ins";
    const cli = envCli();
    const set = envSetSpy(cli);
    renderShellPanelOverRpc({
      cli,
      isLocalMachine: false,
      hostKind: "sandbox",
      overrideHandlers: { "config.env.set": set },
    });

    await addVariable("OPENAI_API_KEY", "OPENAI_API_KEY", "sk-test");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "OPENAI_API_KEY",
      value: "sk-test",
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("hides an abandoned shell-variable save but reports a transport failure", async () => {
    const cli = envCli();
    const set = envSetSpy(cli);
    set.mockRejectedValueOnce(abandonedSaveError("config.env.set"));
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set },
    });

    await addVariable("OPENAI_API_KEY", "NODE_ENV", "production");

    await waitFor(() => {
      expect(set).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Apply variable",
        }).disabled,
      ).toBe(false);
    });
    expect(screen.queryByText(ABANDONED_SAVE_MESSAGE)).toBeNull();

    const transportFailure = saveTransportFailure("config.env.set");
    set.mockRejectedValueOnce(transportFailure);
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
    expect(await screen.findByText(transportFailure.message)).toBeTruthy();
  });

  it("still saves a plain value", async () => {
    const cli = envCli();
    const set = envSetSpy(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set },
    });

    await addVariable("OPENAI_API_KEY", "NODE_ENV", "production");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "NODE_ENV",
      value: "production",
    });
  });

  it("saves a sign-in URL typed into an existing variable on blur", async () => {
    const cli = envCli();
    cli.envOverrides = [{ key: "REPO_URL", value: "https://github.com/o/r" }];
    const set = envSetSpy(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set },
    });

    const field = await screen.findByLabelText("Value for REPO_URL");
    fireEvent.change(field, { target: { value: SIGN_IN_URL } });
    fireEvent.blur(field);

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "REPO_URL",
      value: SIGN_IN_URL,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("hints OPENAI_API_KEY on the add row", async () => {
    renderShellPanelOverRpc({ cli: envCli() });

    await openEnvAdd();

    expect(screen.getByPlaceholderText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.queryByPlaceholderText("NODE_ENV")).toBeNull();
  });
});

function observeVariableRows(predicate: () => boolean): {
  readonly ready: Promise<void>;
  readonly stop: () => void;
} {
  let observer: MutationObserver | undefined;
  const ready = new Promise<void>((resolve) => {
    const check = (): void => {
      if (!predicate()) return;
      observer?.disconnect();
      resolve();
    };
    observer = new MutationObserver(check);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    check();
  });
  return { ready, stop: () => observer?.disconnect() };
}

function isVariableRemove(method: string): boolean {
  return (
    method === "config.env.localOverride.clear" ||
    method === "config.env.delete"
  );
}

function variableRemoveRequests(fixture: ConfigHostFixture) {
  return fixture.messenger.phases.flatMap((event) =>
    event.kind === "request" && isVariableRemove(event.method)
      ? [{ method: event.method, params: event.params }]
      : [],
  );
}

function nextVariableRemove(
  fixture: ConfigHostFixture,
): Promise<Extract<MockPhaseEvent, { kind: "response" }>> {
  return new Promise((resolve) => {
    const stop = fixture.messenger.subscribe((event) => {
      if (event.kind === "response" && isVariableRemove(event.method)) {
        stop();
        resolve(event);
      }
    });
  });
}

function observeReadsAfterClear(fixture: ConfigHostFixture): {
  readonly ready: Promise<void>;
  readonly stop: () => void;
} {
  let unsubscribe: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    let cleared = false;
    const remaining = new Set([
      "config.env.list",
      "environment.localOverrides",
    ]);
    unsubscribe = fixture.messenger.subscribe((event) => {
      if (event.kind !== "response" || event.error !== null) return;
      if (event.method === "config.env.localOverride.clear") cleared = true;
      if (!cleared || !remaining.delete(event.method) || remaining.size > 0)
        return;
      unsubscribe?.();
      resolve();
    });
  });
  return { ready, stop: () => unsubscribe?.() };
}

function variableRemoveButton(): HTMLButtonElement | null {
  const button = screen.queryByRole("button", { name: "Remove LOG_LEVEL" });
  return button instanceof HTMLButtonElement ? button : null;
}

describe("<ShellSettingsPanel /> host environment names that look like credentials", () => {
  const PASSWORD_URL = "https://user:pw@example.com/x";

  function envCli(): MockTraycerCli {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    return cli;
  }

  function envHandlers(cli: MockTraycerCli) {
    const set = vi.fn(
      async (request: { key: string; value: string | null }) => {
        await cli.envOverrideSet(request);
        return { key: request.key, value: request.value };
      },
    );
    const remove = vi.fn(async (request: { key: string }) => {
      await cli.envOverrideDelete(request);
      return { key: request.key, deleted: true as const };
    });
    return { set, remove };
  }

  function localVariableOverride(key: string, value: string): LocalOverride {
    return {
      target: { kind: "variable", key },
      os: "any",
      value,
      setAt: 1,
    };
  }

  async function addVariable(name: string, value: string): Promise<void> {
    await openEnvAdd();
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: name },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
  }

  it("saves OPENAI_API_KEY=sk-x", async () => {
    const cli = envCli();
    const { set, remove } = envHandlers(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set, "config.env.delete": remove },
    });

    await addVariable("OPENAI_API_KEY", "sk-x");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "OPENAI_API_KEY",
      value: "sk-x",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("sends set and delete when a row is renamed to a credential-shaped name", async () => {
    const cli = envCli();
    cli.envOverrides = [{ key: "EDITOR", value: "vim" }];
    const { set, remove } = envHandlers(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set, "config.env.delete": remove },
    });

    const name = await screen.findByLabelText("Name for EDITOR");
    fireEvent.change(name, { target: { value: "GITHUB_TOKEN" } });
    fireEvent.blur(name);

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "GITHUB_TOKEN",
      value: "vim",
    });
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({ key: "EDITOR" });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("still saves EDITOR=vim", async () => {
    const cli = envCli();
    const { set } = envHandlers(cli);
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: { "config.env.set": set },
    });

    await addVariable("EDITOR", "vim");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "EDITOR",
      value: "vim",
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it.each([
    { personalValue: "info", description: "Personal's value" },
    { personalValue: null, description: "nothing in Personal" },
  ])(
    "clears a kept variable with $description before any shared Delete",
    async ({ personalValue }) => {
      const key = "LOG_LEVEL";
      let personal = personalValue;
      let local = [localVariableOverride(key, "debug")];
      const fixture = renderShellPanelOverRpc({
        cli: envCli(),
        liveLocalOverrides: true,
        methods: [
          ...CONFIG_SHELL_METHODS,
          "environment.localOverrides",
          "config.env.localOverride.clear",
        ],
        overrideHandlers: {
          "environment.localOverrides": () => ({ overrides: local }),
          "config.env.list": () => {
            if (local.length !== 0)
              return { entries: [{ key, value: "debug" }] };
            return {
              entries: personal === null ? [] : [{ key, value: personal }],
            };
          },
          "config.env.localOverride.clear": () => {
            local = [];
            return { outcome: "saved" as const, overrides: local };
          },
          "config.env.delete": (request) => {
            personal = null;
            return { key: request.key, deleted: true as const };
          },
        },
      });

      const initial = observeVariableRows(
        () =>
          screen.queryByTestId("env-row-own-value") !== null &&
          variableRemoveButton()?.disabled === false,
      );
      await initial.ready;
      const initialButton = variableRemoveButton();
      if (initialButton === null) throw new Error("missing kept row");
      const refresh = observeReadsAfterClear(fixture);
      const rendered = observeVariableRows(() => {
        if (screen.queryByTestId("env-row-own-value") !== null) return false;
        const button = variableRemoveButton();
        return personalValue === null
          ? button === null
          : button?.disabled === false;
      });
      try {
        const reply = nextVariableRemove(fixture);
        fireEvent.click(initialButton);
        expect(await reply).toMatchObject({
          method: "config.env.localOverride.clear",
          error: null,
        });
        await refresh.ready;
        await rendered.ready;
        expect(variableRemoveRequests(fixture)).toEqual([
          {
            method: "config.env.localOverride.clear",
            params: { target: { kind: "variable", key } },
          },
        ]);
        expect(screen.queryByTestId("env-row-own-value")).toBeNull();

        if (personalValue === null) {
          expect(variableRemoveButton()).toBeNull();
          return;
        }

        expect(inputValue(screen.getByLabelText("Value for LOG_LEVEL"))).toBe(
          personalValue,
        );
        const plainButton = variableRemoveButton();
        if (plainButton === null)
          throw new Error("missing restored Personal row");
        expect(plainButton.disabled).toBe(false);
        const second = nextVariableRemove(fixture);
        fireEvent.click(plainButton);
        expect(await second).toMatchObject({
          method: "config.env.delete",
          error: null,
        });
        expect(variableRemoveRequests(fixture)).toEqual([
          {
            method: "config.env.localOverride.clear",
            params: { target: { kind: "variable", key } },
          },
          { method: "config.env.delete", params: { key } },
        ]);
      } finally {
        refresh.stop();
        rendered.stop();
      }
    },
  );

  it.each([
    { supportsClear: true, description: "a host with Clear" },
    { supportsClear: false, description: "a host without Clear" },
  ])(
    "does not send shared Delete while the kept-list read is parked on $description",
    async ({ supportsClear }) => {
      const key = "LOG_LEVEL";
      let releaseRead: (() => void) | undefined;
      const parked = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let requestStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      const fixture = renderShellPanelOverRpc({
        cli: envCli(),
        liveLocalOverrides: true,
        methods: [
          ...CONFIG_SHELL_METHODS,
          "environment.localOverrides",
          ...(supportsClear ? ["config.env.localOverride.clear"] : []),
        ],
        overrideHandlers: {
          "environment.localOverrides": async () => {
            requestStarted?.();
            await parked;
            return { overrides: [localVariableOverride(key, "debug")] };
          },
          "config.env.list": () => ({ entries: [{ key, value: "debug" }] }),
        },
      });

      try {
        await started;
        await observeVariableRows(() => variableRemoveButton() !== null).ready;
        const remove = variableRemoveButton();
        if (remove === null)
          throw new Error("missing row during the kept read");
        const disabledBeforePress = remove.disabled;
        fireEvent.click(remove);
        expect(disabledBeforePress).toBe(true);
        expect(variableRemoveRequests(fixture)).toEqual([]);
        const known = observeVariableRows(() => {
          if (screen.queryByTestId("env-row-own-value") === null) return false;
          const button = variableRemoveButton();
          return supportsClear ? button?.disabled === false : button === null;
        });
        releaseRead?.();
        await known.ready;
        expect(variableRemoveRequests(fixture)).toEqual([]);
      } finally {
        releaseRead?.();
      }
    },
  );

  it("offers no Remove for a kept variable on a host without Clear", async () => {
    const cli = envCli();
    cli.envOverrides = [{ key: "LOG_LEVEL", value: "debug" }];
    const fixture = renderShellPanelOverRpc({
      cli,
      liveLocalOverrides: true,
      methods: [...CONFIG_SHELL_METHODS, "environment.localOverrides"],
      overrideHandlers: {
        "environment.localOverrides": () => ({
          overrides: [localVariableOverride("LOG_LEVEL", "debug")],
        }),
      },
    });

    await observeVariableRows(
      () =>
        screen.queryByTestId("env-row-own-value") !== null &&
        screen.queryByLabelText("Name for LOG_LEVEL") !== null,
    ).ready;
    expect(variableRemoveButton()).toBeNull();
    expect(variableRemoveRequests(fixture)).toEqual([]);
  });

  it.each([
    {
      readsKeptList: true,
      supportsClear: true,
      description: "a host with Clear",
    },
    {
      readsKeptList: true,
      supportsClear: false,
      description: "a host without Clear",
    },
    {
      readsKeptList: false,
      supportsClear: false,
      description: "a legacy host with neither RPC",
    },
  ])(
    "uses ordinary Delete for a plain variable on $description",
    async ({ readsKeptList, supportsClear }) => {
      const cli = envCli();
      cli.envOverrides = [{ key: "LOG_LEVEL", value: "info" }];
      const fixture = renderShellPanelOverRpc({
        cli,
        liveLocalOverrides: true,
        methods: [
          ...CONFIG_SHELL_METHODS,
          ...(readsKeptList ? ["environment.localOverrides"] : []),
          ...(supportsClear ? ["config.env.localOverride.clear"] : []),
        ],
        overrideHandlers: {
          "environment.localOverrides": () => ({ overrides: [] }),
        },
      });

      await observeVariableRows(
        () => variableRemoveButton()?.disabled === false,
      ).ready;
      const remove = variableRemoveButton();
      if (remove === null) throw new Error("missing ordinary Delete");
      const reply = nextVariableRemove(fixture);
      fireEvent.click(remove);
      expect(await reply).toMatchObject({
        method: "config.env.delete",
        error: null,
      });
      expect(variableRemoveRequests(fixture)).toEqual([
        { method: "config.env.delete", params: { key: "LOG_LEVEL" } },
      ]);
    },
  );

  it("offers Use everywhere for a password URL shown as dots and saves that URL", async () => {
    const cli = envCli();
    cli.envOverrides = [{ key: "REPO_URL", value: "https://example.com/path" }];
    const { set } = envHandlers(cli);
    const clear = vi.fn(() =>
      Promise.resolve({
        outcome: "saved" as const,
        overrides: [],
      }),
    );
    renderShellPanelOverRpc({
      cli,
      localOverrides: [localVariableOverride("REPO_URL", PASSWORD_URL)],
      overrideHandlers: {
        "config.env.set": set,
        "config.env.localOverride.clear": clear,
      },
    });

    const ownValue = await screen.findByTestId("env-row-own-value");
    expect(ownValue.textContent).toContain("••••••••");
    expect(ownValue.textContent).toContain("Use everywhere");
    expect(ownValue.textContent).not.toContain(PASSWORD_URL);

    fireEvent.click(screen.getByRole("button", { name: "Use everywhere" }));

    await waitFor(() => {
      expect(set).toHaveBeenCalledOnce();
      expect(clear).toHaveBeenCalledOnce();
    });
    expect(set).toHaveBeenCalledWith({
      key: "REPO_URL",
      value: PASSWORD_URL,
    });
    expect(clear).toHaveBeenCalledWith({
      target: { kind: "variable", key: "REPO_URL" },
    });
  });

  it("still moves an ordinary local variable everywhere", async () => {
    const cli = envCli();
    cli.envOverrides = [{ key: "LOG_LEVEL", value: "info" }];
    const { set } = envHandlers(cli);
    const clear = vi.fn(() =>
      Promise.resolve({
        outcome: "saved" as const,
        overrides: [],
      }),
    );
    renderShellPanelOverRpc({
      cli,
      localOverrides: [localVariableOverride("LOG_LEVEL", "error")],
      overrideHandlers: {
        "config.env.set": set,
        "config.env.localOverride.clear": clear,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );

    await waitFor(() => {
      expect(set).toHaveBeenCalledOnce();
      expect(clear).toHaveBeenCalledOnce();
    });
    expect(set).toHaveBeenCalledWith({
      key: "LOG_LEVEL",
      value: "error",
    });
    expect(clear).toHaveBeenCalledWith({
      target: { kind: "variable", key: "LOG_LEVEL" },
    });
  });

  it("clears a host's own variable after its save resolves, even if the panel unmounts", async () => {
    let releaseSave: (() => void) | undefined;
    const cli = envCli();
    cli.envOverrides = [{ key: "LOG_LEVEL", value: "info" }];
    const set = vi.fn(
      async (request: { key: string; value: string | null }) => {
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return { key: request.key, value: request.value };
      },
    );
    const clear = vi.fn(() =>
      Promise.resolve({ outcome: "saved" as const, overrides: [] }),
    );
    const panel = renderShellPanelOverRpc({
      cli,
      localOverrides: [localVariableOverride("LOG_LEVEL", "error")],
      overrideHandlers: {
        "config.env.set": set,
        "config.env.localOverride.clear": clear,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(clear).not.toHaveBeenCalled();

    panel.unmountPanel();
    if (releaseSave === undefined) throw new Error("save did not start");
    act(() => releaseSave?.());

    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(clear).toHaveBeenCalledWith({
      target: { kind: "variable", key: "LOG_LEVEL" },
    });
  });

  it("keeps a host's own variable when saving it for everyone fails", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const failedSave = new Promise<never>((_resolve, reject) => {
      rejectSave = reject;
    });
    const cli = envCli();
    cli.envOverrides = [{ key: "LOG_LEVEL", value: "info" }];
    const set = vi.fn(() => failedSave);
    const clear = vi.fn(() =>
      Promise.resolve({ outcome: "saved" as const, overrides: [] }),
    );
    renderShellPanelOverRpc({
      cli,
      localOverrides: [localVariableOverride("LOG_LEVEL", "error")],
      overrideHandlers: {
        "config.env.set": set,
        "config.env.localOverride.clear": clear,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    if (rejectSave === undefined) throw new Error("save did not start");
    await act(async () => {
      rejectSave?.(new Error("save failed"));
      await failedSave.catch(() => undefined);
    });

    expect(clear).not.toHaveBeenCalled();
  });
});

function inputValue(element: HTMLElement): string {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("expected an input");
  }
  return element.value;
}

function nextSuccessfulHostResponse(
  fixture: ConfigHostFixture,
  method: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = fixture.messenger.subscribe((event) => {
      if (event.kind !== "response" || event.method !== method) return;
      unsubscribe();
      resolve(event.error === null);
    });
  });
}

function nextConfigEnvListMatch(
  fixture: ConfigHostFixture,
  key: string,
  value: string,
  after: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = fixture.messenger.subscribe((event) => {
      if (
        event.kind !== "response" ||
        event.method !== "config.env.list" ||
        !after()
      ) {
        return;
      }
      unsubscribe();
      if (event.error !== null) {
        resolve(false);
        return;
      }
      const result = configEnvListResponseSchema.parse(event.result);
      resolve(
        result.entries.some(
          (entry) => entry.key === key && entry.value === value,
        ),
      );
    });
  });
}

function nextEnvironmentStatusRevision(
  fixture: ConfigHostFixture,
  revision: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = fixture.messenger.subscribe((event) => {
      if (event.kind !== "response" || event.method !== "environment.status")
        return;
      unsubscribe();
      if (event.error !== null) {
        resolve(false);
        return;
      }
      const status = environmentStatusV13.responseSchema.parse(event.result);
      resolve(
        status.receivedRevision === revision &&
          status.appliedRevision === revision,
      );
    });
  });
}

function variablePayloadText(value: unknown): string | null {
  const parsed = settingValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data) ||
    !("value" in parsed.data)
  ) {
    return null;
  }
  return typeof parsed.data.value === "string" ? parsed.data.value : null;
}

function settingsSaveItemHasValue(
  queryClient: QueryClient,
  environmentId: string,
  viewerId: string,
  expected: SettingsSaveItemExpectation,
): boolean {
  const query = queryClient.getQueryCache().find({
    queryKey: environmentQueryKeys
      .settingsSaveItems(environmentId, "variable", viewerId, "")
      .slice(0, 6),
    exact: false,
  });
  const data = query?.state.data;
  if (!Array.isArray(data)) return false;
  const parsed = authnItemsResponseSchema.safeParse({ items: data });
  if (!parsed.success) return false;
  const row = parsed.data.items.find((item) => item.key === expected.key);
  return (
    row !== undefined &&
    row.revision === expected.revision &&
    variablePayloadText(row.value) === expected.value
  );
}

function nextSettingsSaveItemValue(
  queryClient: QueryClient,
  environmentId: string,
  viewerId: string,
  expected: SettingsSaveItemExpectation,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    let completed = false;
    const check = (): void => {
      if (completed) return;
      const query = queryClient.getQueryCache().find({
        queryKey: environmentQueryKeys
          .settingsSaveItems(environmentId, "variable", viewerId, "")
          .slice(0, 6),
        exact: false,
      });
      if (
        query !== undefined &&
        query.state.fetchStatus === "idle" &&
        query.state.error !== null
      ) {
        completed = true;
        unsubscribe();
        resolve(false);
        return;
      }
      if (
        !settingsSaveItemHasValue(
          queryClient,
          environmentId,
          viewerId,
          expected,
        )
      ) {
        return;
      }
      completed = true;
      unsubscribe();
      resolve(true);
    };
    unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

function captureConfigEnvSetRequest(
  fixture: ConfigHostFixture,
  capture: (request: ConfigEnvSetRequest, saveId: string | null) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = fixture.messenger.subscribe((event) => {
      if (event.kind !== "request" || event.method !== "config.env.set") return;
      unsubscribe();
      const request = configEnvSetRequestSchema.parse(event.params);
      const saveId = settingsSaveIdFromRequestId(event.requestId);
      capture(request, saveId);
      resolve(saveId !== null);
    });
  });
}

function nextEnvironmentEditorCommit(
  hostId: string,
  key: string,
  value: string,
): Promise<void> {
  return new Promise((resolve) => {
    environmentEditorCommitObserver.current = {
      hostId,
      key,
      value,
      commit: () => {
        environmentEditorCommitObserver.current = null;
        resolve();
      },
    };
  });
}

const authnHostStatusRowSchema = z.strictObject({
  hostId: z.string(),
  hostName: z.string(),
  hostKind: z.enum(["personal", "sandbox"]),
  hostVersion: z.string().nullable(),
  bindingGeneration: z.number().int().nonnegative(),
  desiredRevision: z.number().int().nonnegative(),
  receivedRevision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative(),
  reportedAt: z.number().int().nonnegative().nullable(),
  online: z.boolean(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  remoteAccess: z
    .strictObject({ enabled: z.boolean(), epoch: z.number().int() })
    .nullable(),
  setupStage: z.null(),
  purgePending: z.boolean(),
  minimumHostVersion: z.string().nullable(),
  localOverrides: z.array(z.string()),
  items: z.array(z.unknown()),
  setupAttempts: z.array(z.unknown()),
  environmentId: z.string().optional(),
  sharingGeneration: z.number().int().nonnegative().optional(),
  holdsBotSlot: z.boolean().optional(),
  enrolledByUserId: z.string().nullable().optional(),
  boundAt: z.number().int().nullable().optional(),
  hostPlatform: z.string().nullable().optional(),
});
const authnHostsResponseSchema = z.strictObject({
  hosts: z.array(authnHostStatusRowSchema),
});

describe("a later Personal variable edit on two computers", () => {
  const ACCOUNT = "00000000-0000-4000-8000-000000000101";
  const PERSONAL_ENVIRONMENT = "00000000-0000-4000-8000-000000000102";
  const HOST_X = "00000000-0000-4000-8000-000000000103";
  const HOST_Y = "00000000-0000-4000-8000-000000000104";
  const KEY = "ROW21_PERSONAL_VARIABLE";
  const PERSONAL_BEFORE = "personal-before";
  const PERSONAL_AFTER = "personal-after";
  const X_OWN_VALUE = "kept-on-x";
  const HELD_ID = "00000000-0000-4000-8000-000000000121";
  const HELD_REVISION = 10;
  const PERSONAL_ROW_REVISION = 3;
  const APPLIED_REVISION = 11;

  it("applies Y's edit to X while X keeps its own value and note", async () => {
    const previousMemoryName =
      useSettingsSaveMemoryStore.persist.getOptions().name;
    useSettingsSaveMemoryStore.persist.setOptions({
      name: settingsSaveMemoryKey(ACCOUNT),
    });
    useSettingsSaveMemoryStore.persist.clearStorage();
    useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
    useAuthStore.getState().setSignedIn(
      {
        userId: ACCOUNT,
        userName: "Row 21",
        email: "row21@example.test",
      },
      { userId: ACCOUNT, username: "row21" },
      [],
    );

    const personalDirectory: EnvironmentDirectoryResult = {
      kind: "ok",
      list: {
        environments: [
          {
            environmentId: PERSONAL_ENVIRONMENT,
            ownerKind: "user",
            ownerId: ACCOUNT,
            roomId: "room-personal",
            label: "Personal",
          },
        ],
      },
    };
    const hostsResponse = (includeBinding: boolean) =>
      authnHostsResponseSchema.parse({
        hosts: [HOST_X, HOST_Y].map((hostId) => ({
          hostId,
          hostName: hostId === HOST_X ? "Computer X" : "Computer Y",
          hostKind: "personal",
          hostVersion: "1.5.4",
          bindingGeneration: 1,
          desiredRevision: personalRevision,
          receivedRevision: personalRevision,
          appliedRevision: personalRevision,
          reportedAt: 1,
          online: true,
          lastSeenAt: 1,
          remoteAccess: { enabled: true, epoch: 0 },
          setupStage: null,
          purgePending: false,
          minimumHostVersion: null,
          localOverrides: [],
          items: [],
          setupAttempts: [],
          ...(includeBinding
            ? {
                environmentId: PERSONAL_ENVIRONMENT,
                sharingGeneration: 1,
                holdsBotSlot: false,
                enrolledByUserId: ACCOUNT,
                boundAt: null,
                hostPlatform: "darwin-arm64",
              }
            : {}),
        })),
      });
    const personalRows = new Map<string, AuthnItemRow>();
    const makePersonalRow = (
      key: string,
      value: string,
      revision: number,
    ): AuthnItemRow => ({
      kind: "variable",
      key,
      os: "any",
      value: { value },
      revision,
      updatedAt: revision,
      writtenBy: { source: "live", hostId: null, hostName: null },
    });
    personalRows.set(
      KEY,
      makePersonalRow(KEY, PERSONAL_BEFORE, PERSONAL_ROW_REVISION),
    );

    const xValues = new Map<string, string>([[KEY, PERSONAL_BEFORE]]);
    const yValues = new Map<string, string>([[KEY, PERSONAL_BEFORE]]);
    const valuesByHost = new Map<string, Map<string, string>>([
      [HOST_X, xValues],
      [HOST_Y, yValues],
    ]);
    const localOverridesByHost = new Map<string, readonly LocalOverride[]>([
      [
        HOST_X,
        [
          {
            target: { kind: "variable", key: KEY },
            os: "any",
            value: X_OWN_VALUE,
            setAt: 1,
          },
        ],
      ],
      [HOST_Y, []],
    ]);
    const statusRevisionByHost = new Map<string, number>([
      [HOST_X, HELD_REVISION],
      [HOST_Y, HELD_REVISION],
    ]);
    let personalRevision = HELD_REVISION;
    let ySetRequest: ConfigEnvSetRequest | null = null;
    let ySaveId: string | null = null;
    let ySetWasLocalOverride = false;
    let holdConsumed = false;
    let applySucceeded = false;
    let resolveApply: (value: boolean) => void = () => undefined;
    const applyCompleted = new Promise<boolean>((resolve) => {
      resolveApply = resolve;
    });
    let resolvePersonalRead: (value: boolean) => void = () => undefined;
    const personalReadAfterApply = new Promise<boolean>((resolve) => {
      resolvePersonalRead = resolve;
    });

    const personalEnvironment = "/" + environmentPath(PERSONAL_ENVIRONMENT);
    const applyPrefix = personalEnvironment + "/review/held/";
    const failedApplyAnswer = (
      status: number,
      code: string,
      message: string,
    ): EnvironmentTransportAnswer => {
      resolveApply(false);
      return {
        status,
        text: JSON.stringify({ error: { code, message } }),
      };
    };
    const readPersonalHosts = (
      request: EnvironmentTransportRequest,
      url: URL,
    ): EnvironmentTransportAnswer | null => {
      const isHostsRoute =
        request.method === "GET" &&
        url.pathname === personalEnvironment + "/hosts";
      const hasValidQuery =
        url.searchParams.size === 0 ||
        (url.searchParams.size === 1 &&
          url.searchParams.get("include") === "binding");
      if (!isHostsRoute || !hasValidQuery) return null;
      const includeBinding = url.searchParams.get("include") === "binding";
      return {
        status: 200,
        text: JSON.stringify(hostsResponse(includeBinding)),
      };
    };
    const readPersonalItems = (
      request: EnvironmentTransportRequest,
      url: URL,
    ): EnvironmentTransportAnswer | null => {
      const isItemsRoute =
        request.method === "GET" &&
        url.pathname === personalEnvironment + "/items" &&
        url.searchParams.size === 1 &&
        url.searchParams.has("kind");
      if (!isItemsRoute) return null;
      const kind = url.searchParams.get("kind");
      let body: { readonly items: AuthnItemRow[] };
      try {
        body = authnItemsResponseSchema.parse({
          items: [...personalRows.values()].filter((row) => row.kind === kind),
        });
      } catch (error) {
        if (applySucceeded && kind === "variable") resolvePersonalRead(false);
        throw error;
      }
      if (applySucceeded && kind === "variable") {
        const appliedRow = body.items.find((row) => row.key === KEY);
        resolvePersonalRead(
          appliedRow !== undefined &&
            appliedRow.revision === APPLIED_REVISION &&
            variablePayloadText(appliedRow.value) === PERSONAL_AFTER &&
            appliedRow.writtenBy.source === "live" &&
            appliedRow.writtenBy.hostId === null &&
            appliedRow.writtenBy.hostName === null,
        );
      }
      return { status: 200, text: JSON.stringify(body) };
    };
    const readPersonalReview = (
      request: EnvironmentTransportRequest,
      url: URL,
    ): EnvironmentTransportAnswer | null => {
      const isReviewRoute =
        request.method === "GET" &&
        url.pathname === personalEnvironment + "/review" &&
        url.searchParams.size === 1 &&
        url.searchParams.get("include") === "operation";
      if (!isReviewRoute) return null;
      const held =
        ySetRequest === null || ySaveId === null || holdConsumed
          ? []
          : [
              {
                type: "held",
                heldId: HELD_ID,
                revision: HELD_REVISION,
                kind: "variable",
                key: ySetRequest.key,
                os: "any",
                hostId: HOST_Y,
                sharingGeneration: 1,
                hostName: "Computer Y",
                heldAt: 2,
                live: {
                  revision: PERSONAL_ROW_REVISION,
                  value: { value: PERSONAL_BEFORE },
                },
                op: "put",
                value: { value: ySetRequest.value },
              },
            ];
      const body = {
        review: {
          hosts: [],
          applied: [],
          needsYou: held,
          staysOnOneHost: [],
          unrecognisedUploaded: false,
        },
      };
      authnOperationReviewResponseSchema.parse(body);
      return { status: 200, text: JSON.stringify(body) };
    };
    const applyPersonalValue = (
      sourceRequest: ConfigEnvSetRequest,
    ): EnvironmentTransportAnswer => {
      const value = sourceRequest.value;
      if (value === null) throw new Error("expected a variable value");
      const appliedRow = makePersonalRow(
        sourceRequest.key,
        value,
        APPLIED_REVISION,
      );
      const response = authnItemWriteResponseSchema.parse({
        item: appliedRow,
        replayed: false,
        revision: APPLIED_REVISION,
      });
      if (response.item === null) {
        throw new Error("expected the applied variable row");
      }
      personalRows.set(sourceRequest.key, response.item);
      personalRevision = APPLIED_REVISION;
      const xHostValues = valuesByHost.get(HOST_X);
      if (xHostValues === undefined) {
        throw new Error("missing X variable state");
      }
      xHostValues.set(sourceRequest.key, value);
      statusRevisionByHost.set(HOST_X, APPLIED_REVISION);
      holdConsumed = true;
      applySucceeded = true;
      resolveApply(true);
      return { status: 200, text: JSON.stringify(response) };
    };
    const applyHeldPayload = (
      request: EnvironmentTransportRequest,
      heldId: string,
    ): EnvironmentTransportAnswer => {
      const parsedRequest = z
        .object({
          revision: z.number().int().nonnegative(),
          expectedLiveRevision: z.number().int().nonnegative().nullable(),
        })
        .strict()
        .safeParse(request.body);
      if (!parsedRequest.success) {
        return failedApplyAnswer(400, "bad_request", "Invalid Apply request");
      }
      const applyRequest = parsedRequest.data;
      const sourceRequest = ySetRequest;
      if (heldId !== HELD_ID || holdConsumed || sourceRequest === null) {
        return failedApplyAnswer(404, "not_found", "Held change not found");
      }
      if (applyRequest.revision !== HELD_REVISION) {
        const conflict = authnHeldApplyConflictSchema.parse({
          code: "superseded",
        });
        resolveApply(false);
        return { status: 409, text: JSON.stringify(conflict) };
      }
      const currentRow = personalRows.get(KEY) ?? null;
      if (
        applyRequest.expectedLiveRevision !== (currentRow?.revision ?? null)
      ) {
        const conflict = authnHeldApplyConflictSchema.parse({
          code: "revision_conflict",
          current: currentRow,
        });
        resolveApply(false);
        return { status: 409, text: JSON.stringify(conflict) };
      }
      return applyPersonalValue(sourceRequest);
    };
    const applyPersonalReview = (
      request: EnvironmentTransportRequest,
      url: URL,
    ): EnvironmentTransportAnswer | null => {
      const isApplyPath =
        url.pathname.includes("/review/held/") &&
        url.pathname.endsWith("/apply");
      if (!isApplyPath) return null;
      const hasValidRoute =
        request.method === "POST" &&
        url.pathname.startsWith(applyPrefix) &&
        url.searchParams.size === 0;
      if (!hasValidRoute) {
        return failedApplyAnswer(404, "not_found", "Held change not found");
      }
      const applyPath = url.pathname.slice(applyPrefix.length);
      const heldId = applyPath.slice(0, -"/apply".length);
      return applyHeldPayload(request, heldId);
    };
    const answerPersonalRequest = (
      request: EnvironmentTransportRequest,
    ): EnvironmentTransportAnswer => {
      const url = new URL(request.url);
      const answer =
        readPersonalHosts(request, url) ??
        readPersonalItems(request, url) ??
        readPersonalReview(request, url) ??
        applyPersonalReview(request, url);
      if (answer === null)
        throw new Error("unexpected Personal settings route");
      return answer;
    };
    const cloud: EnvironmentCloud = {
      authnBaseUrl: "https://authn.test/",
      bearer: { kind: "cloud", getBearerToken: () => "fixture-bearer" },
      onOriginSignIn: () => true,
      transport: (request) => {
        try {
          return Promise.resolve(answerPersonalRequest(request));
        } catch (error) {
          return Promise.reject(
            error instanceof Error
              ? error
              : new Error("Personal settings transport failed"),
          );
        }
      },
    };

    const fixtureByHost = new Map<string, ConfigHostFixture>();
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT,
      cloud: () => cloud,
      readProposals: async (hostId) => {
        const fixture = fixtureByHost.get(hostId);
        if (fixture === undefined) return null;
        const request = environmentProposalsV12.requestSchema.parse({});
        const response = await fixture.client.request(
          "environment.proposals",
          request,
        );
        return environmentProposalsV12.responseSchema.parse(response);
      },
      now: () => 10,
      schedule: () => () => undefined,
    });

    const commonMethods = [
      ...CONFIG_SHELL_METHODS,
      "environment.status",
      "environment.host.read",
      "environment.proposals",
      "environment.localOverrides",
    ];
    const handlersFor = (hostId: string): MockHandlerMap<HostRpcRegistry> => ({
      "environment.status": (request) => {
        environmentStatusV13.requestSchema.parse(request);
        const revision = statusRevisionByHost.get(hostId);
        if (revision === undefined) throw new Error("missing host revision");
        return environmentStatusV13.responseSchema.parse(
          environmentStatusFixture({
            principal: { kind: "personal" },
            desiredRevision: revision,
            receivedRevision: revision,
            appliedRevision: revision,
          }),
        );
      },
      "environment.host.read": (request) => {
        environmentHostReadRequestSchema.parse(request);
        return environmentHostReadResponseSchemaV11.parse({
          hostId,
          environment: {
            environmentId: PERSONAL_ENVIRONMENT,
            ownerKind: "user",
            ownerId: ACCOUNT,
            roomId: "room-" + hostId,
            label: "Personal",
          },
          explicit: false,
          enrolledByUserId: ACCOUNT,
          canUnbind: false,
          sharingGeneration: 1,
        });
      },
      "environment.proposals": (request) => {
        environmentProposalsV12.requestSchema.parse(request);
        const proposals =
          hostId === HOST_Y && ySetRequest !== null && ySaveId !== null
            ? [
                {
                  proposal: {
                    proposalId: ySaveId,
                    environmentId: PERSONAL_ENVIRONMENT,
                    hostId,
                    sharingGeneration: 1,
                    kind: "variable",
                    key: ySetRequest.key,
                    os: "any",
                    operation: "put",
                    state: "proposed",
                  },
                  localOverride: ySetWasLocalOverride,
                  deliveredRevision: PERSONAL_ROW_REVISION,
                  promotion: {
                    saveId: ySaveId,
                    heldRevision: HELD_REVISION,
                  },
                },
              ]
            : [];
        return environmentProposalsV12.responseSchema.parse({ proposals });
      },
      "environment.localOverrides": (request) => {
        environmentLocalOverridesRequestSchema.parse(request);
        return environmentLocalOverridesResponseSchema.parse({
          overrides: localOverridesByHost.get(hostId) ?? [],
        });
      },
      "config.env.list": (request) => {
        configEnvListRequestSchema.parse(request);
        const values = valuesByHost.get(hostId);
        if (values === undefined)
          throw new Error("missing host variable state");
        return configEnvListResponseSchema.parse({
          entries: [...values.entries()].map(([key, value]) => ({
            key,
            value,
          })),
        });
      },
      "config.env.set": (request) => {
        const parsed = configEnvSetRequestSchema.parse(request);
        const values = valuesByHost.get(hostId);
        if (values === undefined)
          throw new Error("missing host variable state");
        if (parsed.value === null) throw new Error("expected a Personal value");
        values.set(parsed.key, parsed.value);
        if (hostId === HOST_Y) {
          ySetRequest = parsed;
          ySetWasLocalOverride = true;
        }
        return configEnvSetResponseSchema.parse({
          key: parsed.key,
          value: parsed.value,
        });
      },
    });

    const methodsWithLocalOverrides = [
      ...commonMethods,
      "config.env.localOverride.clear",
    ];
    settingsSaveCloudMock.current = () => cloud;
    const x = renderShellPanelOverRpc({
      hostId: HOST_X,
      hostName: "Computer X",
      liveLocalOverrides: true,
      liveEnvironmentStatus: true,
      methods: methodsWithLocalOverrides,
      environmentDirectory: personalDirectory,
      overrideHandlers: handlersFor(HOST_X),
      saveCoordinator: coordinator,
    });
    fixtureByHost.set(HOST_X, x);

    try {
      const xField = await within(x.container).findByLabelText(
        "Value for " + KEY,
      );
      const xNote = await within(x.container).findByTestId("env-row-own-value");
      const xNoteTextBefore = xNote.textContent;
      const xStartedFromPersonal =
        inputValue(xField) === PERSONAL_BEFORE &&
        xNoteTextBefore.includes("Computer X");
      expect(xStartedFromPersonal).toBe(true);
      const xKeepWasPresentBefore = xNoteTextBefore.includes(X_OWN_VALUE);
      expect(xKeepWasPresentBefore).toBe(true);

      const initialXStatus = nextEnvironmentStatusRevision(x, HELD_REVISION);
      await act(async () => {
        await x.queryClient.invalidateQueries({
          queryKey: queryKeys.hostMethod(HOST_X, "environment.status", {}),
          exact: true,
        });
      });
      const xStartedAtInitialRevision = await initialXStatus;
      expect(xStartedAtInitialRevision).toBe(true);

      const y = renderShellPanelOverRpc({
        hostId: HOST_Y,
        hostName: "Computer Y",
        localOverrides: [],
        methods: methodsWithLocalOverrides,
        overrideHandlers: handlersFor(HOST_Y),
        saveCoordinator: coordinator,
      });
      fixtureByHost.set(HOST_Y, y);
      const yField = await within(y.container).findByLabelText(
        "Value for " + KEY,
      );
      const yStartedFromPersonal = inputValue(yField) === PERSONAL_BEFORE;
      expect(yStartedFromPersonal).toBe(true);
      const yBaselineEditBase = nextSettingsSaveItemValue(
        y.queryClient,
        PERSONAL_ENVIRONMENT,
        ACCOUNT,
        {
          key: KEY,
          value: PERSONAL_BEFORE,
          revision: PERSONAL_ROW_REVISION,
        },
      );
      const yBaselineIsBound = await yBaselineEditBase;
      expect(yBaselineIsBound).toBe(true);

      const ySetResponse = nextSuccessfulHostResponse(y, "config.env.set");
      const ySetRequestWasCorrelated = captureConfigEnvSetRequest(
        y,
        (request, saveId) => {
          ySetRequest = request;
          ySaveId = saveId;
        },
      );
      const yReadAfterEdit = nextConfigEnvListMatch(
        y,
        KEY,
        PERSONAL_AFTER,
        () => ySetRequest !== null,
      );
      const proposalResponse = nextSuccessfulHostResponse(
        y,
        "environment.proposals",
      );
      const yAppliedEditBase = nextSettingsSaveItemValue(
        y.queryClient,
        PERSONAL_ENVIRONMENT,
        ACCOUNT,
        {
          key: KEY,
          value: PERSONAL_AFTER,
          revision: APPLIED_REVISION,
        },
      );

      fireEvent.change(yField, { target: { value: PERSONAL_AFTER } });
      fireEvent.blur(yField);

      const ySetRequestHasSaveCorrelation = await ySetRequestWasCorrelated;
      expect(ySetRequestHasSaveCorrelation).toBe(true);
      const yWriteCompleted = await ySetResponse;
      expect(yWriteCompleted).toBe(true);
      const yReadHasPersonalEdit = await yReadAfterEdit;
      expect(yReadHasPersonalEdit).toBe(true);
      const proposalReadCompleted = await proposalResponse;
      expect(proposalReadCompleted).toBe(true);
      const personalProposalWasApplied = await applyCompleted;
      expect(personalProposalWasApplied && applySucceeded).toBe(true);
      const personalReadHasAppliedEdit = await personalReadAfterApply;
      expect(personalReadHasAppliedEdit).toBe(true);
      const yPersonalEditBaseWasPublished = await yAppliedEditBase;
      expect(yPersonalEditBaseWasPublished).toBe(true);

      const xReadAfterEdit = nextConfigEnvListMatch(
        x,
        KEY,
        PERSONAL_AFTER,
        () => true,
      );
      const xOverrideReadAfterEdit = nextSuccessfulHostResponse(
        x,
        "environment.localOverrides",
      );
      const xConfigListQueryKey = queryKeys.hostMethod(
        HOST_X,
        "config.env.list",
        {},
      );
      const xConfigListUpdateCount =
        x.queryClient.getQueryState(xConfigListQueryKey)?.dataUpdateCount ?? 0;
      const xConfigListUpdated = queryUpdatedBeyond(
        x.queryClient,
        "config.env.list",
        xConfigListUpdateCount,
      );
      const xEditorCommittedUpdatedRow = nextEnvironmentEditorCommit(
        HOST_X,
        KEY,
        PERSONAL_AFTER,
      );
      const appliedXStatus = nextEnvironmentStatusRevision(x, APPLIED_REVISION);
      await act(async () => {
        await x.queryClient.invalidateQueries({
          queryKey: queryKeys.hostMethod(HOST_X, "environment.status", {}),
          exact: true,
        });
      });
      const xReceivedAndAppliedRevision = await appliedXStatus;
      expect(xReceivedAndAppliedRevision).toBe(true);
      const xReadHasPersonalEdit = await xReadAfterEdit;
      expect(xReadHasPersonalEdit).toBe(true);
      const xOverrideReadCompleted = await xOverrideReadAfterEdit;
      expect(xOverrideReadCompleted).toBe(true);
      await xConfigListUpdated;
      await xEditorCommittedUpdatedRow;
      const xFieldShowsPersonalEdit = within(x.container).getByLabelText(
        "Value for " + KEY,
      );
      const xFieldHasPersonalEdit =
        inputValue(xFieldShowsPersonalEdit) === PERSONAL_AFTER;
      expect(xFieldHasPersonalEdit).toBe(true);

      const xNoteAfterEdit = within(x.container).getByTestId(
        "env-row-own-value",
      );
      const xNoteTextAfter = xNoteAfterEdit.textContent;
      const xNoteIdentifiesX = xNoteTextAfter.includes("Computer X");
      const xOwnValueRemains = xNoteTextAfter.includes(X_OWN_VALUE);
      const xKeepActionRemains = xNoteTextAfter.includes("Use everywhere");
      expect(xNoteIdentifiesX).toBe(true);
      expect(xOwnValueRemains).toBe(true);
      expect(xKeepActionRemains).toBe(true);
      y.unmountPanel();
    } finally {
      coordinator.stop();
      x.unmountPanel();
      useSettingsSaveMemoryStore.persist.clearStorage();
      useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
      useSettingsSaveMemoryStore.persist.setOptions({
        name: previousMemoryName,
      });
      useAuthStore.setState(useAuthStore.getInitialState(), true);
    }
  });
});
describe("<ShellSettingsPanel /> an accepted variable write", () => {
  function renderWithEnvRead(
    transport: "rpc" | "bridge",
    read: () => Promise<{ entries: { key: string; value: string | null }[] }>,
  ): void {
    if (transport === "rpc") {
      renderShellPanelOverRpc({
        overrideHandlers: { "config.env.list": read },
      });
    } else {
      renderShellPanelStoppedLocal({
        configure: (cli) => {
          cli.envOverrideList = async () => (await read()).entries;
          // Reads below own the simulated store. Keep the mock's enumerable
          // fields stable so its legacy object query key retains cached data.
          cli.envOverrideSet = () => Promise.resolve();
        },
      });
    }
  }

  it.each(["rpc", "bridge"] as const)(
    "disables Add until the initial environment read succeeds over %s",
    async (transport) => {
      let releaseRead: () => void = () => {
        throw new Error("read has not started");
      };
      const initialRead = new Promise<{ entries: [] }>((resolve) => {
        releaseRead = () => resolve({ entries: [] });
      });
      renderWithEnvRead(transport, () => initialRead);
      const add = await screen.findByRole("button", { name: "Add a variable" });
      expect(add).toHaveProperty("disabled", true);
      fireEvent.click(add);
      expect(screen.queryByLabelText("New variable name")).toBeNull();

      await act(async () => {
        releaseRead();
        await initialRead;
      });
      await waitFor(() => expect(add).toHaveProperty("disabled", false));
      fireEvent.click(add);
      expect(screen.getByLabelText("New variable name")).toHaveProperty(
        "disabled",
        false,
      );
    },
  );

  it.each(["rpc", "bridge"] as const)(
    "retries an initial environment read failure over %s before enabling Add",
    async (transport) => {
      let reads = 0;
      renderWithEnvRead(transport, () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new Error("Read refused"))
          : Promise.resolve({ entries: [] });
      });
      await screen.findByTestId("shell-config-read-failed");
      const add = screen.getByRole("button", { name: "Add a variable" });
      expect(add).toHaveProperty("disabled", true);
      fireEvent.click(add);
      expect(screen.queryByLabelText("New variable name")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(add).toHaveProperty("disabled", false));
      expect(screen.queryByTestId("shell-config-read-failed")).toBeNull();
      fireEvent.click(add);
      expect(screen.getByLabelText("New variable name")).toHaveProperty(
        "disabled",
        false,
      );
    },
  );

  it.each(["rpc", "bridge"] as const)(
    "keeps cached environment rows disabled after a post-write read fails over %s until retry succeeds",
    async (transport) => {
      let failReads = false;
      let currentValue = "original";
      renderWithEnvRead(transport, () =>
        failReads
          ? Promise.reject(new Error("Post-write read refused"))
          : Promise.resolve({
              entries: [{ key: "EDITOR", value: currentValue }],
            }),
      );
      const field = await screen.findByLabelText("Value for EDITOR");
      failReads = true;
      fireEvent.change(field, { target: { value: "updated" } });
      fireEvent.blur(field);

      await screen.findByTestId("shell-config-read-failed");
      await screen.findByRole("alert");
      await waitFor(() =>
        expect(screen.getByLabelText("Value for EDITOR")).toHaveProperty(
          "disabled",
          true,
        ),
      );
      const add = screen.getByRole("button", { name: "Add a variable" });
      expect(add).toHaveProperty("disabled", true);

      currentValue = "updated";
      failReads = false;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Value for EDITOR")).toHaveProperty(
          "disabled",
          false,
        ),
      );
      expect(screen.getByLabelText("Value for EDITOR")).toHaveProperty(
        "value",
        "updated",
      );
      expect(
        screen.getByRole("button", { name: "Add a variable" }),
      ).toHaveProperty("disabled", false);
      expect(screen.queryByTestId("shell-config-read-failed")).toBeNull();
    },
  );

  it.each(["removed", "normalized"] as const)(
    "settles after the fresh read reports the accepted Add as %s",
    async (outcome) => {
      let releaseRead: () => void = () => {
        throw new Error("fresh read has not started");
      };
      const freshRead = new Promise<{
        entries: { key: string; value: string | null }[];
      }>((resolve) => {
        releaseRead = () =>
          resolve({
            entries:
              outcome === "removed"
                ? []
                : [{ key: "NEW_VAR", value: "NORMALIZED" }],
          });
      });
      let reads = 0;
      const panel = renderShellPanelOverRpc({
        overrideHandlers: {
          "config.env.list": () => {
            reads += 1;
            return reads === 1 ? { entries: [] } : freshRead;
          },
          "config.env.set": (request) => ({
            key: request.key,
            value: request.value,
          }),
        },
      });
      const listKey = queryKeys.hostMethod("host-a", "config.env.list", {});
      await waitFor(() =>
        expect(panel.queryClient.getQueryData(listKey)).toEqual({
          entries: [],
        }),
      );
      const before = panel.queryClient.getQueryData(listKey);
      fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
      fireEvent.change(screen.getByLabelText("New variable name"), {
        target: { value: "NEW_VAR" },
      });
      fireEvent.change(screen.getByLabelText("New variable value"), {
        target: { value: "one" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
      await waitFor(() => expect(reads).toBe(2));
      expect(screen.queryByText(/NEW_VAR · /)).toBeNull();
      expect(screen.getByLabelText("New variable name")).toHaveProperty(
        "disabled",
        true,
      );

      await act(async () => {
        releaseRead();
        await freshRead;
      });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add a variable" }),
        ).toHaveProperty("disabled", false),
      );
      if (outcome === "removed") {
        expect(panel.queryClient.getQueryData(listKey)).toBe(before);
        expect(screen.queryByLabelText("Value for NEW_VAR")).toBeNull();
      } else {
        expect(screen.getByLabelText("Value for NEW_VAR")).toHaveProperty(
          "value",
          "NORMALIZED",
        );
      }
    },
  );

  it("keeps a successful write pending without an error when focus replaces its joined read", async () => {
    let releaseSuperseded: () => void = () => {
      throw new Error("post-write read has not started");
    };
    const supersededRead = new Promise<{
      entries: { key: string; value: string }[];
    }>((resolve) => {
      releaseSuperseded = () =>
        resolve({ entries: [{ key: "GHOST", value: "stale" }] });
    });
    let releaseFresh: () => void = () => {
      throw new Error("focus read has not started");
    };
    const freshRead = new Promise<{
      entries: { key: string; value: string }[];
    }>((resolve) => {
      releaseFresh = () =>
        resolve({ entries: [{ key: "NEW_VAR", value: "NORMALIZED" }] });
    });
    let reads = 0;
    const panel = renderShellPanelOverRpc({
      overrideHandlers: {
        "config.env.list": () => {
          reads += 1;
          if (reads === 1) return { entries: [] };
          return reads === 2 ? supersededRead : freshRead;
        },
        "config.env.set": (request) => ({
          key: request.key,
          value: request.value,
        }),
      },
    });
    await openEnvAdd();
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "NEW_VAR" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
    await waitFor(() => {
      expect(reads).toBe(2);
      // The mutation's callbacks have joined its post-write read.
      expect(panel.queryClient.isMutating()).toBe(0);
    });

    fireEvent.focus(window);
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => {
      releaseSuperseded();
      await supersededRead;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/NEW_VAR · /)).toBeNull();
    expect(screen.getByLabelText("New variable name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByLabelText("Value for GHOST")).toBeNull();

    await act(async () => {
      releaseFresh();
      await freshRead;
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Value for NEW_VAR")).toHaveProperty(
        "value",
        "NORMALIZED",
      ),
    );
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
  });

  it("cancels an older read and waits for the post-write snapshot to unlock the editor", async () => {
    const original = [{ key: "OLD_VAR", value: "original" }];
    let releaseWrite: () => void = () => {
      throw new Error("write has not started");
    };
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseStale: () => void = () => {
      throw new Error("stale read has not started");
    };
    const staleRead = new Promise<{ entries: typeof original }>((resolve) => {
      releaseStale = () =>
        resolve({ entries: [...original, { key: "GHOST", value: "stale" }] });
    });
    let releaseFresh: () => void = () => {
      throw new Error("fresh read has not started");
    };
    const freshRead = new Promise<{ entries: typeof original }>((resolve) => {
      releaseFresh = () =>
        resolve({
          entries: [...original, { key: "NEW_VAR", value: "NORMALIZED" }],
        });
    });
    let reads = 0;
    const panel = renderShellPanelOverRpc({
      overrideHandlers: {
        "config.env.list": () => {
          reads += 1;
          if (reads === 1) return { entries: original };
          return reads === 2 ? staleRead : freshRead;
        },
        "config.env.set": async (request) => {
          await write;
          return { key: request.key, value: request.value };
        },
      },
    });
    await screen.findByLabelText("Value for OLD_VAR");
    const listScope = queryKeys.hostMethodScope("host-a", "config.env.list");
    let staleRefetch: Promise<void> = Promise.resolve();
    act(() => {
      staleRefetch = panel.queryClient.refetchQueries({ queryKey: listScope });
    });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "NEW_VAR" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
    await act(async () => {
      releaseWrite();
      await write;
    });
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => {
      releaseStale();
      await staleRead;
    });
    expect(screen.queryByText(/NEW_VAR · /)).toBeNull();
    expect(screen.getByLabelText("New variable name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByLabelText("Value for GHOST")).toBeNull();

    await act(async () => {
      releaseFresh();
      await freshRead;
      await staleRefetch;
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Value for NEW_VAR")).toHaveProperty(
        "value",
        "NORMALIZED",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByLabelText("Value for GHOST")).toBeNull();
  });
});

const STALE_DETAIL: EnvironmentStaleWrite = {
  changedBy: { kind: "dashboard" },
  currentRevision: 43,
};

function staleRefusal(requestId: string, method: string): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    {
      code: "ENVIRONMENT_WRITE_STALE",
      message: "The setting changed since it was read.",
      staleWrite: STALE_DETAIL,
    },
    requestId,
    method,
  );
}

describe("<ShellSettingsPanel /> a save refused as stale", () => {
  it("after a save refused as stale, the field shows the latest value and leaving sends nothing more", async () => {
    installLegendListTestClock();
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    let listedValue = "one";
    let listsAfterRefusal = 0;
    let setCalls = 0;
    renderShellPanelOverRpc({
      cli,
      overrideHandlers: {
        "config.env.list": () => {
          if (listedValue === "two") listsAfterRefusal += 1;
          return { entries: [{ key: "STALE_PROBE", value: listedValue }] };
        },
        "config.env.set": (request) => {
          setCalls += 1;
          if (setCalls === 1) {
            listedValue = "two";
            throw staleRefusal("req-stale", "config.env.set");
          }
          return { key: request.key, value: request.value };
        },
      },
    });

    const field = await screen.findByLabelText("Value for STALE_PROBE");
    expect(inputValue(field)).toBe("one");
    fireEvent.change(field, { target: { value: "three" } });
    fireEvent.blur(field);

    await waitFor(() => expect(setCalls).toBe(1));
    await waitFor(() => expect(listsAfterRefusal).toBeGreaterThan(0));

    expect(inputValue(screen.getByLabelText("Value for STALE_PROBE"))).toBe(
      "two",
    );

    cleanup();
    // A write sent on the way out is dispatched asynchronously; give it
    // room to reach the host before counting.
    await advanceLegendListTime(100);
    expect(setCalls).toBe(1);
  });
});
