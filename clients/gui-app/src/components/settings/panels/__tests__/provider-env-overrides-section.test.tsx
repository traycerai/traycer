// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other settings panel suites do, because they render bare,
// without the host runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
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

const navigation = vi.hoisted(() => ({
  toSection: vi.fn<(id: string) => boolean>(() => true),
}));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigation.toSection,
}));

const hostBindingMock = vi.hoisted(
  (): {
    current: {
      readonly hostClient: unknown;
      readonly auth: {
        readonly environmentCloud: () => EnvironmentCloud;
        readonly listEnvironments: () => Promise<EnvironmentDirectoryResult>;
      } | null;
    } | null;
  } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingMock.current,
    useHostClient: () => hostBindingMock.current?.hostClient,
  };
});

const sandboxCredentialRefusal = vi.hoisted(() => ({
  current: null as string | null,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => sandboxCredentialRefusal.current,
}));

// The header spinner has no accessible name; a marker lets the cases read it.
vi.mock("@/components/ui/agent-spinning-dots", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/ui/agent-spinning-dots")
  >()),
  MutedAgentSpinner: () => <span data-testid="variables-save-spinner" />,
}));

import { act, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABANDONED_SAVE_MESSAGE,
  abandonedSaveError,
  saveTransportFailure,
} from "@/lib/environment/__tests__/settings-save-failure-fixtures";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type {
  ConfigEnvLocalOverrideClearRequest,
  ConfigEnvLocalOverrideResponse,
  EnvironmentReviewEntry,
  EnvironmentSecretV12,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createFakeEnvironmentAuthn,
  type FakeEnvironmentAuthn,
} from "@/components/settings/environment/__tests__/environment-authn-test-support";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { queryKeys } from "@/lib/query-keys";
import type { EnvOverrideValue } from "../env-override-editor";
import { ProviderEnvOverridesSection } from "../provider-env-overrides-section";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

const mocks = vi.hoisted(() => ({
  setOverrideMutate: vi.fn<(variables: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  setOverrideVariables: vi.fn<(variables: SetOverrideVariables) => void>(),
  deleteOverrideMutate: vi.fn<(variables: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

type SetOverrideVariables = {
  readonly providerId: string;
  readonly key: string;
};

vi.mock(
  "@/hooks/providers/use-providers-set-env-override-mutation",
  async () => {
    const { useMutation } = await import("@tanstack/react-query");
    return {
      useProvidersSetEnvOverride: (
        readValue: () => string | null,
        clearValueInput: () => void,
      ) =>
        useMutation<void, Error, SetOverrideVariables>({
          mutationFn: async (variables) => {
            mocks.setOverrideVariables(variables);
            await mocks.setOverrideMutate({
              ...variables,
              value: readValue(),
            });
          },
          onSettled: () => clearValueInput(),
        }),
    };
  },
);

vi.mock(
  "@/hooks/providers/use-providers-delete-env-override-mutation",
  async () => {
    const { useMutation } = await import("@tanstack/react-query");
    return {
      useProvidersDeleteEnvOverride: () =>
        useMutation({ mutationFn: mocks.deleteOverrideMutate }),
    };
  },
);

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  sandboxCredentialRefusal.current = null;
  fakeAuthn?.restore();
  fakeAuthn = null;
  vi.clearAllMocks();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function expectSetOverrideTargetVariables(providerId: string): void {
  const call = mocks.setOverrideVariables.mock.calls.at(-1);
  if (call === undefined)
    throw new Error("Expected an environment override dispatch.");
  const variables = call[0];
  expect({
    keys: Object.keys(variables).sort(),
    providerId: variables.providerId,
  }).toEqual({
    keys: ["key", "providerId"],
    providerId,
  });
}

type OutgoingSetOverrideRequest = {
  readonly providerId: string;
  readonly key: string;
  readonly value: string;
};

function outgoingSetOverrideMatches(
  actual: unknown,
  expected: OutgoingSetOverrideRequest,
): boolean {
  if (!isRecord(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = ["key", "providerId", "value"];
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actual.providerId === expected.providerId &&
    actual.key === expected.key &&
    actual.value === expected.value
  );
}

let fakeAuthn: FakeEnvironmentAuthn | null = null;

/** The bare section reads and writes through the query client the app provides. */
function withQueryClient(children: ReactNode): ReactNode {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

type EnvOverrideScope =
  ProviderCliState["nativeCapabilities"]["envOverrideScope"];

function renderSection(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly envOverrideScope: EnvOverrideScope;
}): void {
  render(
    withQueryClient(
      <ProviderEnvOverridesSection
        providerId={input.providerId}
        overrides={[]}
        envOverrideScope={input.envOverrideScope}
      />,
    ),
  );
}

describe("ProviderEnvOverridesSection — envOverrideScope copy (F1)", () => {
  it("states the variables are used to set Cursor's tools up, not its conversations", () => {
    // Cursor is the production carrier of this scope, but the copy must be
    // driven by the descriptor — not by providerId === "cursor".
    renderSection({
      providerId: "cursor",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText("Variables for the selected provider."),
    ).toBeTruthy();
    expect(screen.queryByText(/every computer and sandbox/)).toBeNull();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the same line for any providerId when the descriptor is native-config-only", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText("Variables for the selected provider."),
    ).toBeTruthy();
    expect(screen.queryByText(/conversations don't get them/)).toBeNull();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the same line for the default harness-and-native-config scope", () => {
    renderSection({
      providerId: "cursor",
      envOverrideScope: "harness-and-native-config",
    });

    expect(
      screen.getByText("Variables for the selected provider."),
    ).toBeTruthy();
    expect(screen.queryByText(/each time it starts/)).toBeNull();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the same line when envOverrideScope is omitted (old hosts)", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: undefined,
    });

    expect(
      screen.getByText("Variables for the selected provider."),
    ).toBeTruthy();
    expect(screen.queryByText(/each time it starts/)).toBeNull();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the same line on a Local row", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-a", hostName: "dev-box" },
    });
    renderSection({
      providerId: "cursor",
      envOverrideScope: "harness-and-native-config",
    });

    expect(
      screen.getByText("Variables for the selected provider."),
    ).toBeTruthy();
    expect(screen.queryByText(/this computer only/)).toBeNull();
  });
});

describe("ProviderEnvOverridesSection — provider env name placeholder", () => {
  it("uses CLINE_API_KEY as the add-row name placeholder for cline", () => {
    renderSection({
      providerId: "cline",
      envOverrideScope: "harness-and-native-config",
    });

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    expect(
      screen.getByLabelText("New variable name").getAttribute("placeholder"),
    ).toBe("CLINE_API_KEY");
  });
});

describe("ProviderEnvOverridesSection on a sandbox host", () => {
  function renderWithOverride(): void {
    render(
      withQueryClient(
        <ProviderEnvOverridesSection
          providerId="cursor"
          overrides={[
            { key: "CURSOR_BASE_URL", value: "https://example.invalid" },
          ]}
          envOverrideScope="harness-and-native-config"
        />,
      ),
    );
  }

  it("keeps the editor live and saves a credential-shaped variable", async () => {
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: "host-sandbox",
        isLocalMachine: false,
        kind: "sandbox",
        sandbox: {
          state: null,
          frozen: false,
          summary: null,
          teamOwned: false,
          ownerKind: "unknown",
        },
      }),
      hostId: "host-sandbox",
      status: "ready",
    };
    sandboxCredentialRefusal.current = "Sandboxes don't take sign-ins";
    renderWithOverride();

    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add a variable" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByLabelText("Name for CURSOR_BASE_URL")
        .hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "CURSOR_API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "sk-cursor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "cursor",
      key: "CURSOR_API_KEY",
      value: "sk-cursor",
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });
});

describe("ProviderEnvOverridesSection on a Personal page with a held value", () => {
  const HOST_ID = "host-a";
  const HELD_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";

  /** What the host answers for its own values and for the secrets that set names. */
  interface HostFacts {
    readonly localOverrides: readonly LocalOverride[];
    readonly secrets: readonly EnvironmentSecretV12[];
  }
  const NO_FACTS: HostFacts = { localOverrides: [], secrets: [] };
  const clearOverride = vi.fn(
    (
      _request: ConfigEnvLocalOverrideClearRequest,
    ): Promise<ConfigEnvLocalOverrideResponse> =>
      Promise.resolve({ outcome: "saved", overrides: [] }),
  );

  beforeEach(() => {
    useSettingsEnvironmentPickStore.setState({
      defaultPick: { kind: "personal" },
    });
    useAuthStore.setState({ status: "signed-in" });
  });
  afterEach(() => {
    useAuthStore.setState({ status: "signed-out" });
  });

  function mountOnPersonalPage(
    review: readonly EnvironmentReviewEntry[],
    facts: HostFacts,
    section: ReactNode,
    suppliedQueryClient: QueryClient | undefined,
  ): RenderResult {
    const environmentList = {
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
    };
    const handlers: MockHandlerMap<HostRpcRegistry> = {
      "environment.status": () => environmentStatusFixture({}),
      "environment.localOverrides": () => ({
        overrides: [...facts.localOverrides],
      }),
      "config.env.localOverride.clear": clearOverride,
      "environment.list": () => environmentList,
      "environment.secrets.list": () => ({
        secrets: [...facts.secrets],
        removed: [],
      }),
      "environment.review": () => ({
        // The `@1.2` facts each row carries, none of them known here.
        entries: review.map((entry) => ({
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
    };
    const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
    const authn = createFakeEnvironmentAuthn(handlers);
    fakeAuthn = authn;
    // On the Personal pick the page keeps this host's pages once it knows the
    // host's environment.status version and that the host runs Personal.
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.localOverrides": { major: 1, minor: 0 },
      "environment.review": { major: 1, minor: 0 },
      "environment.list": { major: 1, minor: 0 },
      "environment.secrets.list": { major: 1, minor: 2 },
      "config.env.localOverride.clear": { major: 1, minor: 0 },
    });
    scopeOverrides.current = {
      host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
      hostId: HOST_ID,
      status: "ready",
      client,
    };
    hostBindingMock.current = {
      hostClient: client,
      auth: {
        environmentCloud: () => authn.cloud,
        listEnvironments: () =>
          Promise.resolve({ kind: "ok" as const, list: environmentList }),
      },
    };
    const queryClient =
      suppliedQueryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
    return render(
      <QueryClientProvider client={queryClient}>
        <HeldValueHostRuntime>
          <PersonalPageFrame section="providers">{section}</PersonalPageFrame>
        </HeldValueHostRuntime>
      </QueryClientProvider>,
    );
  }

  /** A provider's Env tab on the Personal page, with or without a key tab. */
  function renderProviderEnvTab(
    providerId: ProviderCliState["providerId"],
    overrides: readonly EnvOverrideValue[],
  ): RenderResult {
    return mountOnPersonalPage(
      [],
      NO_FACTS,
      <ProviderEnvOverridesSection
        providerId={providerId}
        overrides={overrides}
        envOverrideScope="harness-and-native-config"
      />,
      undefined,
    );
  }

  async function typeVariable(name: string, value: string): Promise<void> {
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

  it.each([
    { providerId: "cursor", variable: "CURSOR_API_KEY" },
    { providerId: "amp", variable: "AMP_API_KEY" },
  ] as const)(
    "saves $variable through the editor",
    async ({ providerId, variable }) => {
      renderProviderEnvTab(providerId, []);

      await typeVariable(variable, HELD_VALUE);

      await waitFor(() =>
        expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
      );
      expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
        providerId,
        key: variable,
        value: HELD_VALUE,
      });
      expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    },
  );

  it("saves any other key-shaped name through the editor", async () => {
    renderProviderEnvTab("kiro", []);

    await typeVariable("NOTES", HELD_VALUE);

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "kiro",
      key: "NOTES",
      value: HELD_VALUE,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("saves the provider's own key variable when it has no key tab", async () => {
    renderProviderEnvTab("kiro", []);

    await typeVariable("KIRO_API_KEY", HELD_VALUE);

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "kiro",
      key: "KIRO_API_KEY",
      value: HELD_VALUE,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("masks a saved key-shaped own key variable and leaves it saved", async () => {
    renderProviderEnvTab("kiro", [{ key: "KIRO_API_KEY", value: HELD_VALUE }]);

    const row = await screen.findByTestId("env-masked-row");
    expect(within(row).getByTestId("env-masked-value").textContent).toBe(
      "••••••••",
    );
    expect(screen.getByLabelText("KIRO_API_KEY is hidden")).toBeTruthy();
    expect(screen.queryByLabelText("Value for KIRO_API_KEY")).toBeNull();
    expect(screen.queryByLabelText("Name for KIRO_API_KEY")).toBeNull();
    expect(screen.queryByDisplayValue(HELD_VALUE)).toBeNull();
    expect(document.body.textContent).not.toContain(HELD_VALUE);
    expect(within(row).queryByTestId("env-key-refusal")).toBeNull();
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
  });

  it("masks a saved key-shaped value and leaves it saved", async () => {
    renderProviderEnvTab("claude-code", [
      { key: "ANTHROPIC_API_KEY", value: HELD_VALUE },
    ]);

    const row = await screen.findByTestId("env-masked-row");
    expect(within(row).getByTestId("env-masked-value").textContent).toBe(
      "••••••••",
    );
    expect(screen.queryByDisplayValue(HELD_VALUE)).toBeNull();
    expect(screen.queryByLabelText("Value for ANTHROPIC_API_KEY")).toBeNull();
    expect(within(row).queryByTestId("env-key-refusal")).toBeNull();
    expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
  });

  it("keeps an ordinary saved value editable, with no masked row", async () => {
    renderProviderEnvTab("kiro", [
      { key: "KIRO_BASE_URL", value: "https://example.invalid" },
    ]);

    const field = await screen.findByLabelText("Value for KIRO_BASE_URL");
    expect((field as HTMLInputElement).value).toBe("https://example.invalid");
    expect(screen.queryByTestId("env-masked-row")).toBeNull();
  });

  it("removes a masked row by its key", async () => {
    renderProviderEnvTab("kiro", [{ key: "KIRO_API_KEY", value: HELD_VALUE }]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove KIRO_API_KEY" }),
    );

    await waitFor(() =>
      expect(mocks.deleteOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.deleteOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "kiro",
      key: "KIRO_API_KEY",
    });
  });

  it("saves a key-shaped value typed on the provider's Env tab", async () => {
    renderProviderEnvTab("cursor", []);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a variable" }),
    );
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "NOTES" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: HELD_VALUE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "cursor",
      key: "NOTES",
      value: HELD_VALUE,
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
  });

  const OWN_URL = "https://own.example.invalid";

  function ownBaseUrl(value: string): LocalOverride {
    return {
      target: {
        kind: "env_override",
        providerId: "claude-code",
        key: "ANTHROPIC_BASE_URL",
      },
      os: "any",
      value,
      setAt: 1,
    };
  }

  function renderClaudeEnvTab(
    facts: HostFacts,
    overrides: readonly EnvOverrideValue[],
  ): RenderResult {
    return mountOnPersonalPage(
      [],
      facts,
      <ProviderEnvOverridesSection
        providerId="claude-code"
        overrides={overrides}
        envOverrideScope="harness-and-native-config"
      />,
      undefined,
    );
  }

  const SHARED_URL: readonly EnvOverrideValue[] = [
    { key: "ANTHROPIC_BASE_URL", value: "https://shared.example.invalid" },
  ];

  it("reads what the host uses for a provider variable it keeps its own value for", async () => {
    renderClaudeEnvTab(
      { localOverrides: [ownBaseUrl(OWN_URL)], secrets: [] },
      SHARED_URL,
    );

    const note = await screen.findByTestId("env-row-own-value");
    expect(note.textContent).toBe(`dev-box uses: ${OWN_URL} · Use everywhere`);
  });

  it("saves the host's value for everyone, then stops the host keeping its own", async () => {
    renderClaudeEnvTab(
      { localOverrides: [ownBaseUrl(OWN_URL)], secrets: [] },
      SHARED_URL,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expectSetOverrideTargetVariables("claude-code");
    const outgoingSetCall = mocks.setOverrideMutate.mock.calls.at(0);
    expect(
      outgoingSetCall !== undefined &&
        outgoingSetOverrideMatches(outgoingSetCall[0], {
          providerId: "claude-code",
          key: "ANTHROPIC_BASE_URL",
          value: OWN_URL,
        }),
    ).toBe(true);
    // The clear RPC follows the save's resolved promise.
    await waitFor(() => expect(clearOverride).toHaveBeenCalledTimes(1));
    expect(clearOverride).toHaveBeenCalledWith({
      target: {
        kind: "env_override",
        providerId: "claude-code",
        key: "ANTHROPIC_BASE_URL",
      },
    });
  });

  it("clears a provider's own value after its save resolves, even if the section unmounts", async () => {
    let resolveSave: (() => void) | undefined;
    mocks.setOverrideMutate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = renderClaudeEnvTab(
      { localOverrides: [ownBaseUrl(OWN_URL)], secrets: [] },
      SHARED_URL,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );
    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expectSetOverrideTargetVariables("claude-code");
    expect(clearOverride).not.toHaveBeenCalled();

    view.unmount();
    if (resolveSave === undefined) throw new Error("save did not start");
    act(() => resolveSave?.());

    await waitFor(() => expect(clearOverride).toHaveBeenCalledTimes(1));
    expect(clearOverride).toHaveBeenCalledWith({
      target: {
        kind: "env_override",
        providerId: "claude-code",
        key: "ANTHROPIC_BASE_URL",
      },
    });
  });

  it("keeps a provider's own value when saving it for everyone fails", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const save = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    mocks.setOverrideMutate.mockImplementationOnce(() => save);
    renderClaudeEnvTab(
      { localOverrides: [ownBaseUrl(OWN_URL)], secrets: [] },
      SHARED_URL,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Use everywhere" }),
    );
    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expectSetOverrideTargetVariables("claude-code");
    if (rejectSave === undefined) throw new Error("save did not start");
    await act(async () => {
      rejectSave?.(new Error("save failed"));
      await save.catch(() => undefined);
    });

    expect(clearOverride).not.toHaveBeenCalled();
  });

  it("hides an abandoned provider-variable save but reports a transport failure", async () => {
    mocks.setOverrideMutate.mockRejectedValueOnce(
      abandonedSaveError("providers.setEnvOverride"),
    );
    renderProviderEnvTab("cursor", []);
    await typeVariable("NODE_ENV", "production");

    await waitFor(() => {
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Apply variable",
        }).disabled,
      ).toBe(false);
    });
    expect(screen.queryByText(ABANDONED_SAVE_MESSAGE)).toBeNull();

    const transportFailure = saveTransportFailure("providers.setEnvOverride");
    mocks.setOverrideMutate.mockRejectedValueOnce(transportFailure);
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
    expect(await screen.findByText(transportFailure.message)).toBeTruthy();
  });

  it("deletes the old provider variable after a renamed save resolves, even if the section unmounts", async () => {
    let resolveSave: (() => void) | undefined;
    mocks.setOverrideMutate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = renderProviderEnvTab("cursor", [
      { key: "CURSOR_BASE_URL", value: "https://example.invalid" },
    ]);
    const nameField = await screen.findByLabelText("Name for CURSOR_BASE_URL");
    fireEvent.change(nameField, {
      target: { value: "CURSOR_PROXY_URL" },
    });
    fireEvent.blur(nameField);

    await waitFor(() =>
      expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expectSetOverrideTargetVariables("cursor");
    // Reset the still-mounted draft so row cleanup doesn't submit the same
    // rename a second time while the first save remains in flight.
    fireEvent.change(nameField, {
      target: { value: "CURSOR_BASE_URL" },
    });

    view.unmount();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
    if (resolveSave === undefined) throw new Error("save did not start");
    act(() => resolveSave?.());

    await waitFor(() =>
      expect(mocks.deleteOverrideMutate).toHaveBeenCalledTimes(1),
    );
    expect(mocks.deleteOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "cursor",
      key: "CURSOR_BASE_URL",
    });
  });

  describe("a provider variable beside the Personal secrets", () => {
    const TOKEN_ROW: readonly EnvOverrideValue[] = [
      { key: "ANTHROPIC_AUTH_TOKEN", value: HELD_VALUE },
    ];
    const secretSettingIt: EnvironmentSecretV12 = {
      ...RETIRED_SECRET_ROW_FIELDS,
      providerVariables: [...RETIRED_PROVIDER_VARIABLES],
      secretId: "sec-1",
      name: "CLAUDE_TOKEN",
      kind: "api_key",
      protocol: "https",
      destinations: ["api.anthropic.com"],
      currentVersionId: "ver-1",
      revoked: false,
      updatedAt: 1,
      variables: [],
    };

    // Nothing binds a secret to a name in one provider's env, so a saved
    // key-shaped value there stays this provider's own masked value —
    // whether or not a Personal secret of that name exists.
    it.each([
      ["with no secret of that name", []],
      ["with a secret of that name", [secretSettingIt]],
    ] as const)(
      "masks a saved key-shaped value %s",
      async (_label, secrets) => {
        renderClaudeEnvTab({ localOverrides: [], secrets }, TOKEN_ROW);

        const row = await screen.findByTestId("env-masked-row");
        expect(within(row).getByTestId("env-masked-value").textContent).toBe(
          "••••••••",
        );
        expect(within(row).queryByTestId("env-key-refusal")).toBeNull();
        expect(document.body.textContent).not.toContain(HELD_VALUE);
      },
    );

    describe("a provider variable whose name is declared by a Personal secret", () => {
      const SHADOW_KEY = "ENV_R2_S3_CLAIM";
      const secretBoundGlobally: EnvironmentSecretV12 = {
        ...RETIRED_SECRET_ROW_FIELDS,
        providerVariables: [...RETIRED_PROVIDER_VARIABLES],
        secretId: "sec-shadow",
        name: "R2 access",
        kind: "api_key",
        protocol: "https",
        destinations: [],
        currentVersionId: "ver-shadow",
        revoked: false,
        updatedAt: 1,
        variables: [SHADOW_KEY],
      };

      it("does not show a note about the secret", async () => {
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const servingHostId = hostRpcServingTierHostId(
          "environment.secrets.list",
          HOST_ID,
          readProcessHostRpcTierPlan(),
          null,
        );
        const secretsListOptions = queryOptions({
          queryKey: [
            ...queryKeys.hostMethod(servingHostId, "environment.secrets.list", {
              environmentId: "env-personal",
            }),
            "user-me",
          ],
          queryFn: () =>
            Promise.resolve({
              secrets: [] as EnvironmentSecretV12[],
              removed: [],
            }),
        });
        queryClient.setQueryData(secretsListOptions.queryKey, {
          secrets: [secretBoundGlobally],
          removed: [],
        });
        mountOnPersonalPage(
          [],
          { localOverrides: [], secrets: [secretBoundGlobally] },
          <ProviderEnvOverridesSection
            providerId="claude-code"
            overrides={[{ key: SHADOW_KEY, value: "r2-override" }]}
            envOverrideScope="harness-and-native-config"
          />,
          queryClient,
        );

        expect(
          await screen.findByLabelText(`Value for ${SHADOW_KEY}`),
        ).toBeTruthy();
        expect(screen.queryByTestId("env-row-note")).toBeNull();
      });
    });

    describe("a variable's save", () => {
      const REREAD_VARIABLE = "CURSOR_BASE_URL";

      /** The Variables section: its header spinner and its editor. */
      function variablesSection(): HTMLElement {
        const section =
          screen.getByText("Variables for the selected provider.").parentElement
            ?.parentElement?.parentElement ?? null;
        if (section === null) {
          throw new Error("the Variables section is not mounted");
        }
        return section;
      }

      function spinnerShown(): boolean {
        return (
          within(variablesSection()).queryByTestId("variables-save-spinner") !==
          null
        );
      }

      function expectNoSaveLine(): void {
        const section = within(variablesSection());
        expect(section.queryByRole("status")).toBeNull();
        expect(section.queryByText(/Applying on|Adding|Saving|Removing/)).toBe(
          null,
        );
      }

      /** One write the section's mutation mock holds until it is released. */
      function holdWrite(
        mock: typeof mocks.setOverrideMutate,
      ): () => Promise<void> {
        const gate = Promise.withResolvers<void>();
        mock.mockImplementationOnce(() => gate.promise);
        return async () => {
          await act(async () => {
            gate.resolve();
            await gate.promise;
          });
        };
      }

      interface OverridesRead {
        readonly holdNext: () => () => Promise<void>;
        readonly count: () => number;
      }

      /**
       * The host's overrides read, already answered once, whose next answer
       * (the section's re-read after a write) is held until released.
       */
      async function overridesRead(
        queryClient: QueryClient,
      ): Promise<OverridesRead> {
        let held: Promise<null> | null = null;
        let reads = 0;
        await queryClient.fetchQuery({
          queryKey: queryKeys.hostMethod(HOST_ID, "providers.list", {}),
          queryFn: () => {
            reads += 1;
            return held ?? Promise.resolve(null);
          },
        });
        return {
          count: () => reads,
          holdNext: () => {
            const gate = Promise.withResolvers<null>();
            held = gate.promise;
            return async () => {
              await act(async () => {
                gate.resolve(null);
                await gate.promise;
              });
            };
          },
        };
      }

      async function mountWithRead(
        overrides: readonly EnvOverrideValue[],
      ): Promise<OverridesRead> {
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const read = await overridesRead(queryClient);
        mountOnPersonalPage(
          [],
          NO_FACTS,
          <ProviderEnvOverridesSection
            providerId="cursor"
            overrides={overrides}
            envOverrideScope="harness-and-native-config"
          />,
          queryClient,
        );
        return read;
      }

      const BASE_URL_ROW: EnvOverrideValue = {
        key: REREAD_VARIABLE,
        value: "https://example.invalid",
      };

      async function expectSpinnerThrough(input: {
        readonly releaseReread: () => Promise<void>;
        readonly rereadStarted: () => number;
        readonly writes: readonly (() => Promise<void>)[];
        readonly rowsDisabled: () => boolean;
      }): Promise<void> {
        for (const release of input.writes) {
          expect(spinnerShown()).toBe(true);
          expect(input.rowsDisabled()).toBe(true);
          expectNoSaveLine();
          await release();
        }
        // The writes are done; the overrides re-read is still out.
        await waitFor(() => expect(input.rereadStarted()).toBeGreaterThan(1));
        expect(spinnerShown()).toBe(true);
        expect(input.rowsDisabled()).toBe(true);
        expectNoSaveLine();

        await input.releaseReread();
        await waitFor(() => expect(spinnerShown()).toBe(false));
        await waitFor(() => expect(input.rowsDisabled()).toBe(false));
      }

      it("keeps the spinner and the draft disabled through an added variable's write and re-read", async () => {
        const read = await mountWithRead([]);
        const releaseWrite = holdWrite(mocks.setOverrideMutate);
        const releaseReread = read.holdNext();
        await typeVariable(REREAD_VARIABLE, "https://example.invalid");

        await expectSpinnerThrough({
          releaseReread,
          rereadStarted: read.count,
          writes: [releaseWrite],
          // The draft closes once the save has landed.
          rowsDisabled: () =>
            screen.queryByLabelText<HTMLInputElement>("New variable name")
              ?.disabled ?? false,
        });
      });

      it("keeps the spinner and the row disabled through a rename's two writes and the re-read", async () => {
        const read = await mountWithRead([BASE_URL_ROW]);
        const releaseSet = holdWrite(mocks.setOverrideMutate);
        const releaseDelete = holdWrite(mocks.deleteOverrideMutate);
        const releaseReread = read.holdNext();
        const nameField = await screen.findByLabelText(
          `Name for ${REREAD_VARIABLE}`,
        );
        fireEvent.change(nameField, { target: { value: "CURSOR_PROXY_URL" } });
        fireEvent.blur(nameField);

        await expectSpinnerThrough({
          releaseReread,
          rereadStarted: read.count,
          writes: [releaseSet, releaseDelete],
          rowsDisabled: () =>
            screen.getByLabelText<HTMLInputElement>(
              `Value for ${REREAD_VARIABLE}`,
            ).disabled,
        });
      });

      it("keeps the spinner and the row disabled through a removal's write and re-read", async () => {
        const read = await mountWithRead([BASE_URL_ROW]);
        const releaseDelete = holdWrite(mocks.deleteOverrideMutate);
        const releaseReread = read.holdNext();
        fireEvent.click(
          await screen.findByRole("button", {
            name: `Remove ${REREAD_VARIABLE}`,
          }),
        );

        await expectSpinnerThrough({
          releaseReread,
          rereadStarted: read.count,
          writes: [releaseDelete],
          rowsDisabled: () =>
            screen.getByLabelText<HTMLInputElement>(
              `Value for ${REREAD_VARIABLE}`,
            ).disabled,
        });
      });

      it("keeps the spinner up and the rows disabled through Use everywhere's save and the clearing of the computer's own value", async () => {
        renderClaudeEnvTab(
          { localOverrides: [ownBaseUrl(OWN_URL)], secrets: [] },
          SHARED_URL,
        );
        const releaseSave = holdWrite(mocks.setOverrideMutate);
        const clearing =
          Promise.withResolvers<ConfigEnvLocalOverrideResponse>();
        clearOverride.mockImplementationOnce(() => clearing.promise);
        const valueField = (): HTMLInputElement =>
          screen.getByLabelText<HTMLInputElement>(
            "Value for ANTHROPIC_BASE_URL",
          );
        fireEvent.click(
          await screen.findByRole("button", { name: "Use everywhere" }),
        );

        await waitFor(() => expect(spinnerShown()).toBe(true));
        expect(valueField().disabled).toBe(true);
        await releaseSave();
        // The save has landed; the computer's own value is still being cleared.
        await waitFor(() => expect(clearOverride).toHaveBeenCalledTimes(1));
        expect(spinnerShown()).toBe(true);
        expect(valueField().disabled).toBe(true);

        await act(async () => {
          clearing.resolve({ outcome: "saved", overrides: [] });
          await clearing.promise;
        });
        await waitFor(() => expect(spinnerShown()).toBe(false));
        await waitFor(() => expect(valueField().disabled).toBe(false));
      });

      it("says Couldn't save this variable. when the write fails with something that is not an Error", async () => {
        renderProviderEnvTab("cursor", []);
        mocks.setOverrideMutate.mockRejectedValueOnce("refused");
        await typeVariable(REREAD_VARIABLE, "https://example.invalid");

        const failure = await within(variablesSection()).findByRole("alert");
        expect(failure.textContent).toBe("Couldn't save this variable.");
        expect(spinnerShown()).toBe(false);
      });

      it("shows the red failure line, with no spinner, when the write fails, and drops it when the next save starts", async () => {
        renderProviderEnvTab("cursor", []);
        mocks.setOverrideMutate.mockRejectedValueOnce(
          new Error("The host refused this variable."),
        );
        await typeVariable(REREAD_VARIABLE, "https://example.invalid");

        const failure = await within(variablesSection()).findByRole("alert");
        expect(failure.textContent).toBe("The host refused this variable.");
        expect(spinnerShown()).toBe(false);
        expectNoSaveLine();

        const releaseRetry = holdWrite(mocks.setOverrideMutate);
        fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

        await waitFor(() => expect(spinnerShown()).toBe(true));
        expect(within(variablesSection()).queryByRole("alert")).toBeNull();
        await releaseRetry();
      });
    });
  });
});
