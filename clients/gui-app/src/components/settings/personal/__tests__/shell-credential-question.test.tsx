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
  return {
    ...actual,
    useHostBinding: () => {
      const real = actual.useHostBinding();
      return real === null || hostBindingMock.current === null
        ? hostBindingMock.current
        : { ...real, hostClient: hostBindingMock.current.hostClient };
    },
    // The secrets that set a variable are read through the page's client.
    useHostClient: () => hostBindingMock.current?.hostClient,
  };
});

// Where "Make it a secret" asks Settings to go.
const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  ConfigEnvLocalOverrideClearRequest,
  ConfigEnvLocalOverrideResponse,
  EnvironmentReviewEntry,
  EnvironmentSecretV12,
  EnvironmentStatusResponseV11,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
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
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

const HOST_ID = "host-a";
const READY_STATUS: EnvironmentStatusResponseV11 = environmentStatusFixture({
  // Pending, so a ready page says so ("Applying EXISTING on host-a."), which
  // is how a test knows the status was read and rendered.
  items: [
    itemStatusFixture({ kind: "variable", key: "EXISTING", status: "pending" }),
  ],
});
/** The minors a Personal case negotiates; every other method is `1.0`. */
const MANIFEST_MINORS: ReadonlyMap<string, number> = new Map([
  ["environment.status", 1],
  ["environment.secrets.list", 2],
]);
/** `sk-` and a long run: a known token shape, whatever the variable is called. */
const API_KEY_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
  navigateToSettingsSectionMock.mockReset();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
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
  /** `config.env.localOverride.clear`, answered as saved. */
  readonly clear: Mock<
    (
      request: ConfigEnvLocalOverrideClearRequest,
    ) => Promise<ConfigEnvLocalOverrideResponse>
  >;
}

function renderShellPage(options: {
  /** `null`: the host's `environment.status` read never resolves. */
  readonly status: EnvironmentStatusResponseV11 | null;
  /** The methods the host advertises; the config family is always there. */
  readonly environmentMethods: readonly string[];
  readonly existingVariables: readonly { key: string; value: string }[];
  /** What `environment.review` answers. */
  readonly review: readonly EnvironmentReviewEntry[];
  /** What `environment.localOverrides` answers: values this host keeps itself. */
  readonly localOverrides: readonly LocalOverride[];
  /** What `environment.secrets.list` answers. */
  readonly secrets: readonly EnvironmentSecretV12[];
}): Rendered {
  const cli = new MockTraycerCli();
  cli.shellConfig = { path: "/bin/zsh", args: ["-i", "-l"], synthesised: true };
  cli.envOverrides = [...options.existingVariables];
  const set = vi.fn(async (request: EnvSetCall): Promise<EnvSetCall> => {
    await cli.envOverrideSet(request);
    return { key: request.key, value: request.value };
  });
  const clear = vi.fn(
    (
      _request: ConfigEnvLocalOverrideClearRequest,
    ): Promise<ConfigEnvLocalOverrideResponse> =>
      Promise.resolve({ outcome: "saved", overrides: [] }),
  );
  let statusCalls = 0;
  const fixture = buildConfigHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    cli,
    overrideHandlers: {
      "config.env.set": set,
      "config.env.localOverride.clear": clear,
      "environment.status": () => {
        statusCalls += 1;
        if (options.status === null) return new Promise<never>(() => {});
        return options.status;
      },
      "environment.localOverrides": () => ({
        overrides: [...options.localOverrides],
      }),
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
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
      "environment.secrets.list": () => ({
        secrets: [...options.secrets],
        removed: [],
      }),
      "environment.review": () => ({
        // The `@1.2` facts each row carries, none of them known here.
        entries: options.review.map((entry) => ({
          command: null,
          event: null,
          description: null,
          harness: null,
          value: null,
          ...entry,
        })),
        shownAt: null,
        acknowledgedAt: null,
        evidence: { version: null, at: null },
      }),
    },
  });
  const methods = [...CONFIG_SHELL_METHODS, ...options.environmentMethods];
  // These cases are about a host's own pages, which a Local row reads,
  // unless a case picks Personal itself. The Personal pick keeps the host's
  // pages only once it knows the host's environment.status version, so a
  // Personal case records versions.
  if (useSettingsEnvironmentPickStore.getState().pick === null) {
    recordNegotiatedHostMethods(HOST_ID, methods);
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "dev-box" },
    });
  } else {
    recordNegotiatedHostManifest(
      HOST_ID,
      Object.fromEntries(
        methods.map((method) => [
          method,
          { major: 1, minor: MANIFEST_MINORS.get(method) ?? 0 },
        ]),
      ),
    );
  }
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
        <HeldValueHostRuntime>
          <PersonalPageFrame section="shell">
            <ShellSettingsPanel />
          </PersonalPageFrame>
        </HeldValueHostRuntime>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    cli,
    runnerHost,
    set,
    clear,
    statusCalls: () => statusCalls,
  };
}

const READY_HOST = {
  status: READY_STATUS,
  environmentMethods: [
    "environment.status",
    "environment.localOverrides",
    "environment.review",
    "environment.list",
    "environment.secrets.list",
    "config.env.localOverride.clear",
  ],
  existingVariables: [],
  review: [],
  localOverrides: [],
  secrets: [],
} as const;

/** Waits until the page has rendered the host's status it read. */
async function pageIsReady(): Promise<void> {
  await screen.findByText("Applying EXISTING on host-a.");
}

async function addVariable(name: string, value: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: "Add a variable" }),
  );
  fireEvent.change(screen.getByLabelText("New variable name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("New variable value"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
}

const KEY_REFUSAL = "This looks like a key. Add it as a secret.";

describe("a key-shaped variable on a Personal page (ready status)", () => {
  it("refuses a credential-looking variable, stores nothing and shows no dialog", async () => {
    const { cli, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    expect((await screen.findByTestId("env-key-refusal")).textContent).toBe(
      KEY_REFUSAL,
    );
    expect(screen.queryByTestId("credential-choice-dialog")).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
  });

  it("refuses a harmless name when the VALUE has a known token shape", async () => {
    const { set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("NOTES", API_KEY_VALUE);

    expect(await screen.findByTestId("env-key-refusal")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("'Add it as a secret.' opens Add a secret on the API key form with the name and value filled in, and stores nothing", async () => {
    const { cli, runnerHost, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);

    fireEvent.click(
      await screen.findByRole("button", { name: "Add it as a secret." }),
    );

    const dialog = await screen.findByTestId("add-secret-dialog");
    expect(screen.queryByTestId("secret-kind-picker")).toBeNull();
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-name").value,
    ).toBe("API_TOKEN");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-value").value,
    ).toBe(API_KEY_VALUE);
    // The add row closed: nothing is left staged.
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
    expect(runnerHost.openedExternalLinks).toEqual([]);
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
  });

  it("closing Add a secret drops the value and stores nothing", async () => {
    const { cli, set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("API_TOKEN", API_KEY_VALUE);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add it as a secret." }),
    );
    const dialog = await screen.findByTestId("add-secret-dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    expect(document.body.textContent).not.toContain(API_KEY_VALUE);
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([]);
  });

  it("stores a plain value without refusing it", async () => {
    const { set } = renderShellPage(READY_HOST);
    await pageIsReady();
    await addVariable("LOG_LEVEL", "debug");

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "LOG_LEVEL",
      value: "debug",
      executableWriteGrant: null,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("refuses an existing variable edited into a key, keeps the stored value and sends nothing", async () => {
    const { cli, set } = renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "EDITOR", value: "vim" }],
    });
    await pageIsReady();

    const value = await screen.findByLabelText("Value for EDITOR");
    fireEvent.change(value, { target: { value: API_KEY_VALUE } });
    fireEvent.blur(value);

    expect(await screen.findByTestId("env-key-refusal")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([{ key: "EDITOR", value: "vim" }]);

    fireEvent.click(
      screen.getByRole("button", { name: "Add it as a secret." }),
    );
    expect(await screen.findByTestId("add-secret-dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("vim")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});

describe("a saved key-shaped variable on a Personal page", () => {
  it("shows the saved variable masked with the key line, and its link carries the value into Add a secret leaving the variable saved", async () => {
    const { cli, set } = renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "API_TOKEN", value: API_KEY_VALUE }],
    });
    await pageIsReady();

    const row = await screen.findByTestId("env-masked-row");
    expect(row.textContent).toContain("API_TOKEN");
    expect(screen.queryByLabelText("Value for API_TOKEN")).toBeNull();
    expect(screen.queryByDisplayValue(API_KEY_VALUE)).toBeNull();
    expect(document.body.textContent).not.toContain(API_KEY_VALUE);
    expect(within(row).getByTestId("env-key-refusal").textContent).toBe(
      KEY_REFUSAL,
    );

    fireEvent.click(
      within(row).getByRole("button", { name: "Add it as a secret." }),
    );

    const dialog = await screen.findByTestId("add-secret-dialog");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-name").value,
    ).toBe("API_TOKEN");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-value").value,
    ).toBe(API_KEY_VALUE);
    expect(set).not.toHaveBeenCalled();
    expect(cli.envOverrides).toEqual([
      { key: "API_TOKEN", value: API_KEY_VALUE },
    ]);
  });

  it("removes the masked variable by its name", async () => {
    const { cli } = renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "API_TOKEN", value: API_KEY_VALUE }],
    });
    await pageIsReady();

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove API_TOKEN" }),
    );

    await waitFor(() => expect(cli.envOverrides).toEqual([]));
  });

  it("keeps an ordinary saved variable editable", async () => {
    renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "EDITOR", value: "vim" }],
    });
    await pageIsReady();

    expect(
      (await screen.findByLabelText<HTMLInputElement>("Value for EDITOR"))
        .value,
    ).toBe("vim");
    expect(screen.queryByTestId("env-masked-row")).toBeNull();
  });
});

describe("a key-shaped variable when the page is not on a ready Personal host", () => {
  it("stores it on a host with no settings of the person's yet (not set up)", async () => {
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
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("still masks a saved key-shaped variable there, with no key line", async () => {
    const { statusCalls } = renderShellPage({
      ...READY_HOST,
      status: environmentStatusFixture({ principal: null }),
      existingVariables: [{ key: "API_TOKEN", value: API_KEY_VALUE }],
    });
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(await screen.findByTestId("env-masked-row")).toBeTruthy();
    expect(screen.queryByDisplayValue(API_KEY_VALUE)).toBeNull();
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });
});

describe("a key-shaped variable while the Personal host's status is not known yet", () => {
  it("refuses it while the status read is still pending", async () => {
    const { set, statusCalls } = renderShellPage({
      ...READY_HOST,
      status: null,
    });
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
    await addVariable("API_TOKEN", API_KEY_VALUE);

    expect(await screen.findByTestId("env-key-refusal")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});

describe("the host environment group on a Personal page", () => {
  it("no longer points other operating systems at the dashboard", async () => {
    renderShellPage(READY_HOST);
    await pageIsReady();
    expect(screen.queryByTestId("other-os-values-note")).toBeNull();
    expect(
      screen.queryByText(/other operating systems are set in the dashboard/),
    ).toBeNull();
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

const PERSONAL_SUBTITLE =
  "Plain values every computer and sandbox running Personal gets, and the shell agents run in.";

describe("the Variables and shells subtitle", () => {
  it("describes what Personal shares under the Personal pick", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    renderShellPage(READY_HOST);
    await pageIsReady();
    expect(screen.getByText(PERSONAL_SUBTITLE)).toBeTruthy();
    expect(screen.queryByText(/How Traycer launches terminals/)).toBeNull();
  });

  it("keeps the launch description under a Local pick", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "host-a" },
    });
    renderShellPage(READY_HOST);
    expect(
      await screen.findByText(
        "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; variable changes apply on restart.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(PERSONAL_SUBTITLE)).toBeNull();
  });
});

describe("the Variables empty state", () => {
  it("says what Personal's variables are under the Personal pick, with no Add sentence", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    renderShellPage(READY_HOST);
    await pageIsReady();
    expect(
      screen.getByText(
        "Variables are plain values every computer and sandbox running Personal gets.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Add a variable\.$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add a variable" })).toBeTruthy();
  });

  it("keeps the host wording under a Local pick", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "host-a" },
    });
    renderShellPage(READY_HOST);
    expect(
      await screen.findByText("Variables are plain values every host gets."),
    ).toBeTruthy();
  });
});

describe("a held key-shaped variable on a Personal page", () => {
  const HELD_NAME = "API_TOKEN";
  const heldEntry = (
    reason: string,
    key: string,
    entryId: string,
  ): EnvironmentReviewEntry => ({
    entryId,
    reason,
    kind: "variable",
    key,
    os: "any",
    hostId: null,
    heldAt: 1,
  });

  it("reads on hold with a Review, never shows the value, and says so in the banner", async () => {
    renderShellPage({
      ...READY_HOST,
      existingVariables: [
        { key: HELD_NAME, value: API_KEY_VALUE },
        { key: "LOG_LEVEL", value: "debug" },
      ],
      review: [heldEntry("credential_like_value", HELD_NAME, "entry-1")],
    });

    const row = await screen.findByTestId("env-held-row");
    expect(row.textContent).toBe(
      `${HELD_NAME} · on hold until you choose · Review`,
    );
    expect(document.body.textContent).not.toContain(API_KEY_VALUE);
    expect(screen.queryByLabelText(`Value for ${HELD_NAME}`)).toBeNull();
    expect(screen.getByLabelText("Value for LOG_LEVEL")).toBeTruthy();

    const banner = await screen.findByTestId("personal-review-row");
    expect(banner.textContent).toBe(
      `${HELD_NAME} looks like a key and is on hold until you choose · Review`,
    );

    // Either Review opens the sheet for that value.
    fireEvent.click(within(row).getByTestId("held-value-review"));
    const sheet = await screen.findByTestId("retrospective-sheet");
    expect(
      within(sheet).getByTestId("retrospective-held-entry-1"),
    ).toBeTruthy();
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
  });

  it("opens the sheet from the banner's Review too", async () => {
    renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: HELD_NAME, value: API_KEY_VALUE }],
      review: [heldEntry("credential_like_value", HELD_NAME, "entry-1")],
    });

    const banner = await screen.findByTestId("personal-review-row");
    fireEvent.click(within(banner).getByTestId("held-value-review"));
    expect(await screen.findByTestId("retrospective-sheet")).toBeTruthy();
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
  });

  it("keeps an editable row for a variable held for another reason, and its Review opens Secrets", async () => {
    renderShellPage({
      ...READY_HOST,
      existingVariables: [{ key: "SHELL_INIT", value: "echo hi" }],
      review: [heldEntry("needs_grant", "SHELL_INIT", "entry-2")],
    });

    const banner = await screen.findByTestId("personal-review-row");
    expect(banner.textContent).toContain(
      "SHELL_INIT is waiting for you: was changed without your confirmation.",
    );
    expect(screen.getByLabelText("Value for SHELL_INIT")).toBeTruthy();
    expect(screen.queryByTestId("env-held-row")).toBeNull();

    fireEvent.click(within(banner).getByRole("button", { name: "Review" }));
    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("secrets");
  });
});

function variableOverride(key: string, value: string): LocalOverride {
  return {
    target: { kind: "variable", key },
    os: "any",
    value,
    setAt: 1,
  };
}

describe("a variable this computer keeps its own value for", () => {
  const OWN_VALUE_HOST = {
    ...READY_HOST,
    existingVariables: [{ key: "LOG_LEVEL", value: "info" }],
    localOverrides: [variableOverride("LOG_LEVEL", "error")],
  };

  it("reads what the host uses and offers Use everywhere", async () => {
    renderShellPage(OWN_VALUE_HOST);
    await pageIsReady();

    const note = await screen.findByTestId("env-row-own-value");
    expect(note.textContent).toBe("host-a uses: error · Use everywhere");
  });

  it("saves the host's value for everyone, and stops the host keeping its own only after the save landed", async () => {
    const { set, clear } = renderShellPage(OWN_VALUE_HOST);
    let finishSave: () => void = () => {};
    set.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      return { key: request.key, value: request.value };
    });
    await pageIsReady();

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({
      key: "LOG_LEVEL",
      value: "error",
      executableWriteGrant: null,
    });
    expect(clear).not.toHaveBeenCalled();

    finishSave();

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledWith({
      target: { kind: "variable", key: "LOG_LEVEL" },
    });
  });

  it("shows dots and no Use everywhere for a value that looks like a key", async () => {
    renderShellPage({
      ...OWN_VALUE_HOST,
      localOverrides: [variableOverride("LOG_LEVEL", API_KEY_VALUE)],
    });
    await pageIsReady();

    const note = await screen.findByTestId("env-row-own-value");
    expect(note.textContent).toBe("host-a uses: ••••••••");
    expect(screen.queryByRole("button", { name: "Use everywhere" })).toBeNull();
    expect(document.body.textContent).not.toContain(API_KEY_VALUE);
  });
});

describe("a variable a secret sets on the Personal page", () => {
  const NAME = "ENV_E2E_SERVICE_TOKEN";
  const secretSettingIt: EnvironmentSecretV12 = {
    secretId: "sec-1",
    name: NAME,
    kind: "api_key",
    protocol: "https",
    destinations: ["api.example.com"],
    mode: "exposed",
    state: "live",
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    variables: [NAME],
    providerVariables: [],
  };
  const withKeyShapedValue = {
    ...READY_HOST,
    existingVariables: [{ key: NAME, value: API_KEY_VALUE }],
  };

  it("reads the name as the secret's, with no value and no key refusal", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    renderShellPage({ ...withKeyShapedValue, secrets: [secretSettingIt] });
    await pageIsReady();

    const row = await screen.findByTestId("env-claimed-row");
    expect(row.textContent).toBe(`${NAME} · from the secret ${NAME} · Secrets`);
    expect(screen.queryByTestId("env-masked-row")).toBeNull();
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain(API_KEY_VALUE);
  });

  it("control: with no secret claiming the name, the saved key-shaped value is masked and refused", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    renderShellPage({ ...withKeyShapedValue, secrets: [] });
    await pageIsReady();

    const row = await screen.findByTestId("env-masked-row");
    expect(within(row).getByTestId("env-key-refusal").textContent).toBe(
      KEY_REFUSAL,
    );
    expect(screen.queryByTestId("env-claimed-row")).toBeNull();
  });
});
