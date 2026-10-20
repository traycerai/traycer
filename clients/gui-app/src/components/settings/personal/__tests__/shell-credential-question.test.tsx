// The shell panel, inside its Personal page frame, over the config RPC path.
// Mocked at the same boundaries as `shell-settings-panel.test.tsx`: the host
// scope (the panels render bare, without the host runtime) and the host
// binding.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
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
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import {
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const HOST_ID = "host-a";
const READY_STATUS: EnvironmentStatusResponse = environmentStatusFixture({
  items: [itemStatusFixture({ kind: "variable", key: "EXISTING" })],
});
/** `sk-` and a long run: a known token shape, whatever the variable is called. */
const API_KEY_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";
const SECRETS_PATH = "/environments/personal/secrets";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

interface EnvSetCall {
  readonly key: string;
  readonly value: string | null;
}

interface Rendered {
  readonly cli: MockTraycerCli;
  readonly runnerHost: MockRunnerHost;
  readonly set: Mock<(request: EnvSetCall) => Promise<EnvSetCall>>;
  readonly statusCalls: () => number;
}

function renderShellPage(options: {
  /** `null`: the host's `environment.status` read never resolves. */
  readonly status: EnvironmentStatusResponse | null;
  /** The methods the host advertises; the config family is always there. */
  readonly environmentMethods: readonly string[];
  readonly existingVariables: readonly { key: string; value: string }[];
}): Rendered {
  const cli = new MockTraycerCli();
  cli.shellConfig = { path: "/bin/zsh", args: ["-i", "-l"], synthesised: true };
  cli.envOverrides = [...options.existingVariables];
  const set = vi.fn(async (request: EnvSetCall): Promise<EnvSetCall> => {
    await cli.envOverrideSet(request);
    return { key: request.key, value: request.value };
  });
  let statusCalls = 0;
  const fixture = buildConfigHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    cli,
    overrideHandlers: {
      "config.env.set": set,
      "environment.status": () => {
        statusCalls += 1;
        if (options.status === null) return new Promise<never>(() => {});
        return options.status;
      },
      "environment.localOverrides": () => ({ overrides: [] }),
    },
  });
  recordNegotiatedHostMethods(HOST_ID, [
    ...CONFIG_SHELL_METHODS,
    ...options.environmentMethods,
  ]);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: HOST_ID,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId: HOST_ID,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };
  const runnerHost = new MockRunnerHost({
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
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <PersonalPageFrame section="shell">
          <ShellSettingsPanel />
        </PersonalPageFrame>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { cli, runnerHost, set, statusCalls: () => statusCalls };
}

const READY_HOST = {
  status: READY_STATUS,
  environmentMethods: ["environment.status", "environment.localOverrides"],
  existingVariables: [],
} as const;

/** Waits until the page has read the host's status: "Applied on host-a.". */
async function pageIsReady(): Promise<void> {
  await screen.findByText("Applied on host-a.");
}

async function addVariable(name: string, value: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add variable" }));
  fireEvent.change(screen.getByLabelText("New variable name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("New variable value"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
}

describe("the credential question in the shell panel (Personal host, ready status)", () => {
  it("asks before storing a credential-looking variable, and stores nothing until answered", async () => {
    const { cli, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    const dialog = await screen.findByTestId("credential-choice-dialog");
    expect(within(dialog).getByText("This looks like a secret")).toBeTruthy();
    expect(dialog.textContent).toContain("API_TOKEN");
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
  });

  it("asks for a harmless name when the VALUE has a known token shape", async () => {
    const { set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("NOTES", API_KEY_VALUE);

    expect(await screen.findByTestId("credential-choice-dialog")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("'Keep as a variable' stores the value exactly as typed and closes the question", async () => {
    const { cli, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    const dialog = await screen.findByTestId("credential-choice-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep as a variable" }),
    );

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "API_TOKEN",
      value: API_KEY_VALUE,
      executableWriteGrant: null,
    });
    expect(cli.envOverrides).toEqual([
      { key: "API_TOKEN", value: API_KEY_VALUE },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
    });
  });

  it("'Make it a secret' opens the Secrets page, stores nothing and closes the question", async () => {
    const { cli, runnerHost, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    const dialog = await screen.findByTestId("credential-choice-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Make it a secret" }),
    );

    await waitFor(() => {
      expect(runnerHost.openedExternalLinks).toHaveLength(1);
    });
    expect(runnerHost.openedExternalLinks[0]).toMatch(
      new RegExp(`${SECRETS_PATH}$`),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
    });
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
  });

  it("closing the question without answering stores nothing", async () => {
    const { cli, runnerHost, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    const dialog = await screen.findByTestId("credential-choice-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
    });
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
    expect(runnerHost.openedExternalLinks).toEqual([]);
  });

  it("stores a plain value without asking", async () => {
    const { set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("LOG_LEVEL", "debug");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "LOG_LEVEL",
      value: "debug",
      executableWriteGrant: null,
    });
    expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
  });

  it("asks when an existing variable is edited into a credential-looking value", async () => {
    const { cli, set } = renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "EDITOR", value: "vim" }],
    });
    await pageIsReady();

    const value = await screen.findByLabelText("Value for EDITOR");
    fireEvent.change(value, { target: { value: API_KEY_VALUE } });
    fireEvent.blur(value);

    expect(await screen.findByTestId("credential-choice-dialog")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([{ key: "EDITOR", value: "vim" }]);
  });
});

describe("the credential question when the page is not on a ready Personal host", () => {
  it("does not ask on a host with no settings of the person's yet (not set up)", async () => {
    const { set, statusCalls } = renderShellPage({
      ...READY_HOST,
      status: environmentStatusFixture({ principal: null }),
    });
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
    // Let the answered status reach the page before the variable is committed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await addVariable("API_TOKEN", API_KEY_VALUE);

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
  });
});

describe("the credential question while the Personal host's status is not known yet", () => {
  it("asks before storing a credential-looking variable while the status read is still pending", async () => {
    const { set, statusCalls } = renderShellPage({
      ...READY_HOST,
      status: null,
    });
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
    await addVariable("API_TOKEN", API_KEY_VALUE);
    // Give a (wrong) store call time to land before judging.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(set).not.toHaveBeenCalled();
    expect(screen.queryByTestId("credential-choice-dialog")).not.toBeNull();
  });
});

describe("the host environment group on a Personal page", () => {
  it("points other operating systems at the dashboard only once the status is ready", async () => {
    renderShellPage(READY_HOST);
    expect(screen.queryByTestId("other-os-values-note")).toBeNull();
    await pageIsReady();
    expect(screen.getByTestId("other-os-values-note").textContent).toBe(
      "Values and shells for other operating systems are set in the dashboard.",
    );
  });

  // `pendingUploads` comes from the fake host.
  it("marks a row whose edit still waits for its receipt as Pending", async () => {
    renderShellPage({
      ...READY_HOST,
      status: environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "EXISTING" })],
        pendingUploads: [
          pendingUploadFixture({ kind: "variable", key: "WAITING" }),
        ],
      }),
      existingVariables: [
        { key: "WAITING", value: "1" },
        { key: "SETTLED", value: "2" },
      ],
    });
    const note = await screen.findByTestId("env-row-note");
    expect(note.textContent).toBe("Pending");
    expect(screen.getAllByTestId("env-row-note")).toHaveLength(1);
    expect(
      note.closest("li")?.querySelector('input[aria-label="Name for WAITING"]'),
    ).not.toBeNull();
  });
});
