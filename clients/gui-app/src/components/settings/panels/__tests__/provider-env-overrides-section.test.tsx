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
  return { useHostScope, usePersonalHostScope: useHostScope };
});

const navigation = vi.hoisted(() => ({
  toSection: vi.fn<(id: string) => boolean>(() => true),
}));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigation.toSection,
}));

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingMock.current,
    // Add a secret, which a key-shaped value is refused for, reads the client.
    useHostClient: () => hostBindingMock.current?.hostClient,
  };
});

import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  ConfigEnvLocalOverrideClearRequest,
  ConfigEnvLocalOverrideResponse,
  EnvironmentReviewEntry,
  EnvironmentSecretV12,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import type { EnvOverrideValue } from "../env-override-editor";
import { ProviderEnvOverridesSection } from "../provider-env-overrides-section";

const mocks = vi.hoisted(() => ({
  setOverrideMutate: vi.fn<(variables: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  deleteOverrideMutate: vi.fn<(variables: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes env overrides. */
  credentialRefusal: null as string | null,
}));

vi.mock(
  "@/hooks/providers/use-providers-set-env-override-mutation",
  async () => {
    const { useMutation } = await import("@tanstack/react-query");
    return {
      useProvidersSetEnvOverride: () =>
        useMutation({ mutationFn: mocks.setOverrideMutate }),
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

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => mocks.credentialRefusal,
}));

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

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
        onOpenAccount={null}
        overrides={[]}
        envOverrideScope={input.envOverrideScope}
      />,
    ),
  );
}

describe("ProviderEnvOverridesSection — envOverrideScope copy (F1)", () => {
  it("states the variables are used to set Cursor's tools up, not its conversations (NEW-154-15)", () => {
    // Cursor is the production carrier of this scope, but the copy must be
    // driven by the descriptor — not by providerId === "cursor".
    renderSection({
      providerId: "cursor",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText(
        "Set for Cursor when Traycer sets up its tools, such as MCP servers, on every computer and sandbox running Personal. Cursor's conversations don't get them. Unset removes a variable Cursor would otherwise get from the shell.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the native-config-only copy for any providerId when the descriptor says so", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText(
        "Set for Codex when Traycer sets up its tools, such as MCP servers, on every computer and sandbox running Personal. Codex's conversations don't get them. Unset removes a variable Codex would otherwise get from the shell.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("says where Personal's variables are set for the default harness-and-native-config scope", () => {
    renderSection({
      providerId: "cursor",
      envOverrideScope: "harness-and-native-config",
    });

    expect(
      screen.getByText(
        "Set for Cursor each time it starts, on every computer and sandbox running Personal. Unset removes a variable Cursor would otherwise get from the shell.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("says the same when envOverrideScope is omitted (old hosts)", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: undefined,
    });

    expect(
      screen.getByText(
        "Set for Codex each time it starts, on every computer and sandbox running Personal. Unset removes a variable Codex would otherwise get from the shell.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("limits the reach to this computer on a Local row", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-a", hostName: "dev-box" },
    });
    renderSection({
      providerId: "cursor",
      envOverrideScope: "harness-and-native-config",
    });

    expect(
      screen.getByText(
        "Set for Cursor each time it starts, on this computer only. Unset removes a variable Cursor would otherwise get from the shell.",
      ),
    ).toBeTruthy();
  });
});

describe("ProviderEnvOverridesSection on a host that takes no credentials", () => {
  const REFUSAL = "Sandboxes don't take sign-ins";

  function renderWithOverride(): void {
    render(
      withQueryClient(
        <ProviderEnvOverridesSection
          providerId="cursor"
          onOpenAccount={null}
          overrides={[
            { key: "CURSOR_BASE_URL", value: "https://example.invalid" },
          ]}
          envOverrideScope="harness-and-native-config"
        />,
      ),
    );
  }

  it("disables the whole editor, shows the refusal, and sends nothing", () => {
    mocks.credentialRefusal = REFUSAL;
    renderWithOverride();

    expect(screen.getByTestId("credential-refusal").textContent).toBe(REFUSAL);
    expect(
      screen
        .getByRole("button", { name: "Add a variable" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByLabelText("Name for CURSOR_BASE_URL")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Remove CURSOR_BASE_URL" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove CURSOR_BASE_URL" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));

    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
  });

  it("control: on a host that takes overrides the editor is live and shows no refusal", () => {
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
    useAuthStore.setState({ status: "signed-in" });
  });
  afterEach(() => {
    useAuthStore.setState({ status: "signed-out" });
  });

  function heldEntry(key: string): EnvironmentReviewEntry {
    return {
      entryId: "entry-1",
      reason: "credential_like_value",
      kind: "env_override",
      key,
      os: "any",
      hostId: null,
      heldAt: 1,
    };
  }

  function mountOnPersonalPage(
    review: readonly EnvironmentReviewEntry[],
    facts: HostFacts,
    section: ReactNode,
  ): RenderResult {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.localOverrides": () => ({
          overrides: [...facts.localOverrides],
        }),
        "config.env.localOverride.clear": clearOverride,
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
      },
    });
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
    hostBindingMock.current = { hostClient: client };
    return render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <HeldValueHostRuntime>
          <PersonalPageFrame section="providers">{section}</PersonalPageFrame>
        </HeldValueHostRuntime>
      </QueryClientProvider>,
    );
  }

  function renderOnPersonalPage(review: readonly EnvironmentReviewEntry[]) {
    mountOnPersonalPage(
      review,
      NO_FACTS,
      <ProviderEnvOverridesSection
        providerId="cursor"
        onOpenAccount={null}
        overrides={[
          { key: "CURSOR_API_KEY", value: HELD_VALUE },
          { key: "CURSOR_BASE_URL", value: "https://example.invalid" },
        ]}
        envOverrideScope="harness-and-native-config"
      />,
    );
  }

  /** A provider's Env tab on the Personal page, with or without an Account tab. */
  function renderProviderEnvTab(
    providerId: ProviderCliState["providerId"],
    onOpenAccount: (() => void) | null,
    overrides: readonly EnvOverrideValue[],
  ): RenderResult {
    return mountOnPersonalPage(
      [],
      NO_FACTS,
      <ProviderEnvOverridesSection
        providerId={providerId}
        onOpenAccount={onOpenAccount}
        overrides={overrides}
        envOverrideScope="harness-and-native-config"
      />,
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
    {
      providerId: "claude-code",
      name: "Claude Code",
      variable: "ANTHROPIC_API_KEY",
    },
    { providerId: "kiro", name: "Kiro", variable: "KIRO_API_KEY" },
    { providerId: "droid", name: "Droid", variable: "FACTORY_API_KEY" },
  ] as const)(
    "refuses $name's own key variable with a pointer to its Account tab, clears the value and stores nothing",
    async ({ providerId, name, variable }) => {
      const onOpenAccount = vi.fn<() => void>();
      renderProviderEnvTab(providerId, onOpenAccount, []);

      await typeVariable(variable, HELD_VALUE);

      const line = await screen.findByTestId("env-key-refusal");
      expect(line.textContent).toBe(
        `This is ${name}'s key. Set it on ${name}'s Account tab.`,
      );
      expect(screen.getByLabelText("New variable value")).toBe(
        screen.getByDisplayValue(""),
      );
      expect(document.body.textContent).not.toContain(HELD_VALUE);
      expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
      expect(onOpenAccount).not.toHaveBeenCalled();

      fireEvent.click(
        within(line).getByRole("button", { name: `${name}'s Account tab` }),
      );

      expect(onOpenAccount).toHaveBeenCalledTimes(1);
      expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("New variable name")).toBeNull();
    },
  );

  it("still sends any other key-shaped name to Add a secret, with the value kept", async () => {
    const onOpenAccount = vi.fn<() => void>();
    renderProviderEnvTab("kiro", onOpenAccount, []);

    await typeVariable("NOTES", HELD_VALUE);

    expect((await screen.findByTestId("env-key-refusal")).textContent).toBe(
      "This looks like a key. Add it as a secret.",
    );
    expect(screen.getByDisplayValue(HELD_VALUE)).toBeTruthy();
    expect(onOpenAccount).not.toHaveBeenCalled();
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
  });

  it("uses the generic line for the provider's own key variable when it has no Account tab", async () => {
    renderProviderEnvTab("kiro", null, []);

    await typeVariable("KIRO_API_KEY", HELD_VALUE);

    expect((await screen.findByTestId("env-key-refusal")).textContent).toBe(
      "This looks like a key. Add it as a secret.",
    );
    expect(screen.getByDisplayValue(HELD_VALUE)).toBeTruthy();
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
  });

  it("holds the override the review names by <harness>:<NAME>, without its value, and opens the sheet from Review", async () => {
    const harness = providerIdToGuiHarnessId("cursor");
    renderOnPersonalPage([heldEntry(`${harness}:CURSOR_API_KEY`)]);

    const held = await screen.findByTestId("env-held-row");
    expect(held.textContent).toBe(
      "CURSOR_API_KEY · on hold until you choose · Review",
    );
    expect(document.body.textContent).not.toContain(HELD_VALUE);
    expect(screen.queryByLabelText("Value for CURSOR_API_KEY")).toBeNull();
    // The other override is an ordinary row.
    expect(screen.getByLabelText("Value for CURSOR_BASE_URL")).toBeTruthy();

    fireEvent.click(within(held).getByTestId("held-value-review"));
    expect(await screen.findByTestId("retrospective-sheet")).toBeTruthy();
  });

  it("does not hold an override whose harness prefix is another provider's", async () => {
    // As long as the real prefix, so only the prefix check can tell them apart.
    const otherHarness = "x".repeat(providerIdToGuiHarnessId("cursor").length);
    renderOnPersonalPage([
      heldEntry(`${otherHarness}:CURSOR_API_KEY`),
      {
        ...heldEntry(`${providerIdToGuiHarnessId("cursor")}:CURSOR_BASE_URL`),
        entryId: "entry-2",
      },
    ]);

    // The base URL's row going on hold shows the review was read.
    const held = await screen.findByTestId("env-held-row");
    expect(held.textContent).toContain("CURSOR_BASE_URL");
    expect(screen.getAllByTestId("env-held-row")).toHaveLength(1);
    // Not held, so it is a saved key-shaped value: masked.
    expect(screen.getByTestId("env-masked-row").textContent).toContain(
      "CURSOR_API_KEY",
    );
  });

  it("masks a saved key-shaped own key variable, points it at the Account tab, and leaves it saved", async () => {
    const onOpenAccount = vi.fn<() => void>();
    renderProviderEnvTab("kiro", onOpenAccount, [
      { key: "KIRO_API_KEY", value: HELD_VALUE },
    ]);

    const row = await screen.findByTestId("env-masked-row");
    expect(within(row).getByTestId("env-masked-value").textContent).toBe(
      "••••••••",
    );
    expect(screen.getByLabelText("KIRO_API_KEY is hidden")).toBeTruthy();
    expect(screen.queryByLabelText("Value for KIRO_API_KEY")).toBeNull();
    expect(screen.queryByLabelText("Name for KIRO_API_KEY")).toBeNull();
    expect(screen.queryByDisplayValue(HELD_VALUE)).toBeNull();
    expect(document.body.textContent).not.toContain(HELD_VALUE);
    const line = within(row).getByTestId("env-key-refusal");
    expect(line.textContent).toBe(
      "This is Kiro's key. Set it on Kiro's Account tab.",
    );

    fireEvent.click(
      within(line).getByRole("button", { name: "Kiro's Account tab" }),
    );

    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
  });

  it("masks a saved key-shaped value on a provider with no Account tab and carries it into Add a secret, deleting nothing", async () => {
    renderProviderEnvTab("claude-code", null, [
      { key: "ANTHROPIC_API_KEY", value: HELD_VALUE },
    ]);

    const row = await screen.findByTestId("env-masked-row");
    expect(screen.queryByDisplayValue(HELD_VALUE)).toBeNull();
    expect(screen.queryByLabelText("Value for ANTHROPIC_API_KEY")).toBeNull();
    const line = within(row).getByTestId("env-key-refusal");
    expect(line.textContent).toBe("This looks like a key. Add it as a secret.");

    fireEvent.click(
      within(line).getByRole("button", { name: "Add it as a secret." }),
    );

    const dialog = await screen.findByTestId("add-secret-dialog");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-name").value,
    ).toBe("ANTHROPIC_API_KEY");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-value").value,
    ).toBe(HELD_VALUE);
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
  });

  it("keeps an ordinary saved value editable, with no masked row", async () => {
    renderProviderEnvTab("kiro", vi.fn<() => void>(), [
      { key: "KIRO_BASE_URL", value: "https://example.invalid" },
    ]);

    const field = await screen.findByLabelText("Value for KIRO_BASE_URL");
    expect((field as HTMLInputElement).value).toBe("https://example.invalid");
    expect(screen.queryByTestId("env-masked-row")).toBeNull();
  });

  it("removes a masked row by its key", async () => {
    renderProviderEnvTab("kiro", vi.fn<() => void>(), [
      { key: "KIRO_API_KEY", value: HELD_VALUE },
    ]);

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

  it("refuses a key-shaped value typed on the provider's Env tab, stores nothing, and hands it to Add a secret", async () => {
    renderProviderEnvTab("cursor", null, []);
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

    expect((await screen.findByTestId("env-key-refusal")).textContent).toBe(
      "This looks like a key. Add it as a secret.",
    );
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Add it as a secret." }),
    );

    const dialog = await screen.findByTestId("add-secret-dialog");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-name").value,
    ).toBe("NOTES");
    expect(
      within(dialog).getByTestId<HTMLInputElement>("secret-form-value").value,
    ).toBe(HELD_VALUE);
    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
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
        onOpenAccount={null}
        overrides={overrides}
        envOverrideScope="harness-and-native-config"
      />,
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
    expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toEqual({
      providerId: "claude-code",
      key: "ANTHROPIC_BASE_URL",
      value: OWN_URL,
      executableWriteGrant: null,
    });
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
    if (rejectSave === undefined) throw new Error("save did not start");
    await act(async () => {
      rejectSave?.(new Error("save failed"));
      await save.catch(() => undefined);
    });

    expect(clearOverride).not.toHaveBeenCalled();
  });

  it("deletes the old provider variable after a renamed save resolves, even if the section unmounts", async () => {
    let resolveSave: (() => void) | undefined;
    mocks.setOverrideMutate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = renderProviderEnvTab("cursor", null, [
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

  describe("a variable a secret sets for the provider", () => {
    const TOKEN_ROW: readonly EnvOverrideValue[] = [
      { key: "ANTHROPIC_AUTH_TOKEN", value: HELD_VALUE },
    ];
    const secretSettingIt: EnvironmentSecretV12 = {
      secretId: "sec-1",
      name: "CLAUDE_TOKEN",
      kind: "api_key",
      protocol: "https",
      destinations: ["api.anthropic.com"],
      mode: "exposed",
      state: "live",
      currentVersionId: "ver-1",
      revoked: false,
      updatedAt: 1,
      variables: [],
      providerVariables: [
        { providerId: "claude-code", name: "ANTHROPIC_AUTH_TOKEN" },
      ],
    };

    it("reads the name as the secret's, with no value and no key refusal", async () => {
      renderClaudeEnvTab(
        { localOverrides: [], secrets: [secretSettingIt] },
        TOKEN_ROW,
      );

      const row = await screen.findByTestId("env-claimed-row");
      expect(row.textContent).toBe(
        "ANTHROPIC_AUTH_TOKEN · from the secret CLAUDE_TOKEN · Secrets",
      );
      expect(screen.queryByTestId("env-masked-row")).toBeNull();
      expect(screen.queryByTestId("env-key-refusal")).toBeNull();
      expect(document.body.textContent).not.toContain(HELD_VALUE);
    });

    it("control: with the name unclaimed the saved key-shaped value is masked and refused", async () => {
      renderClaudeEnvTab({ localOverrides: [], secrets: [] }, TOKEN_ROW);

      const row = await screen.findByTestId("env-masked-row");
      expect(within(row).getByTestId("env-key-refusal")).toBeTruthy();
      expect(screen.queryByTestId("env-claimed-row")).toBeNull();
    });

    describe("an Add draft named for a variable a secret sets", () => {
      const CLAIM = "ENV_R2_S3_CLAIM";
      const codexSecret: EnvironmentSecretV12 = {
        ...secretSettingIt,
        secretId: "sec-codex",
        name: "R2_S3",
        providerVariables: [{ providerId: "codex", name: CLAIM }],
      };

      async function apply(name: string, value: string): Promise<void> {
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

      /** A saved row another secret sets: its claim row is the sign the secrets have loaded. */
      const LOADED = "ENV_R2_LOADED";
      const loadedSecret: EnvironmentSecretV12 = {
        ...codexSecret,
        secretId: "sec-loaded",
        name: "R2_LOADED",
        providerVariables: [{ providerId: "codex", name: LOADED }],
      };

      async function renderCodexEnvTab(
        secrets: readonly EnvironmentSecretV12[],
      ): Promise<void> {
        mountOnPersonalPage(
          [],
          { localOverrides: [], secrets: [loadedSecret, ...secrets] },
          <ProviderEnvOverridesSection
            providerId="codex"
            onOpenAccount={null}
            overrides={[{ key: LOADED, value: HELD_VALUE }]}
            envOverrideScope="harness-and-native-config"
          />,
        );
        await screen.findByTestId("env-claimed-row");
      }

      it("shows the secret in place of the value and saves nothing, with a link to Secrets", async () => {
        await renderCodexEnvTab([codexSecret]);
        await apply(CLAIM, "plain-value");

        const claim = await screen.findByTestId("env-draft-claimed-row");
        expect(claim.textContent).toBe(
          `${CLAIM} · from the secret R2_S3 · Secrets`,
        );
        expect(screen.queryByLabelText("New variable value")).toBeNull();
        expect(
          screen
            .getByRole("button", { name: "Apply variable" })
            .hasAttribute("disabled"),
        ).toBe(true);
        expect(
          screen.getByRole("button", { name: "Discard variable" }),
        ).toBeTruthy();
        expect(mocks.setOverrideMutate).not.toHaveBeenCalled();

        fireEvent.click(within(claim).getByRole("button", { name: "Secrets" }));
        expect(navigation.toSection).toHaveBeenCalledWith("secrets");
      });

      it("shows the claim rather than the key refusal for a claimed credential-shaped name that a saved row also holds", async () => {
        renderClaudeEnvTab(
          { localOverrides: [], secrets: [secretSettingIt] },
          TOKEN_ROW,
        );
        await screen.findByTestId("env-claimed-row");
        await apply("ANTHROPIC_AUTH_TOKEN", HELD_VALUE);

        expect(
          (await screen.findByTestId("env-draft-claimed-row")).textContent,
        ).toBe("ANTHROPIC_AUTH_TOKEN · from the secret CLAUDE_TOKEN · Secrets");
        expect(screen.queryByTestId("env-key-refusal")).toBeNull();
        expect(screen.queryByText(/already/i)).toBeNull();
        expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
      });

      it("lets a plain override use the storage name of a secret that sets no provider variable", async () => {
        await renderCodexEnvTab([{ ...codexSecret, providerVariables: [] }]);
        await apply(CLAIM, "plain-value");

        await waitFor(() =>
          expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
        );
        expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toMatchObject({
          providerId: "codex",
          key: CLAIM,
        });
        expect(screen.queryByTestId("env-draft-claimed-row")).toBeNull();
      });

      it("gives the value field back when the name is corrected, then saves normally", async () => {
        await renderCodexEnvTab([codexSecret]);
        await apply(CLAIM, "plain-value");
        await screen.findByTestId("env-draft-claimed-row");

        fireEvent.change(screen.getByLabelText("New variable name"), {
          target: { value: "ENV_R2_OTHER" },
        });

        expect(screen.queryByTestId("env-draft-claimed-row")).toBeNull();
        const value =
          screen.getByLabelText<HTMLInputElement>("New variable value");
        fireEvent.change(value, { target: { value: "plain-value" } });
        fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
        await waitFor(() =>
          expect(mocks.setOverrideMutate).toHaveBeenCalledTimes(1),
        );
        expect(mocks.setOverrideMutate.mock.calls[0]?.[0]).toMatchObject({
          providerId: "codex",
          key: "ENV_R2_OTHER",
        });
      });
    });

    describe("a saved variable that shares a Personal secret's own name without being claimed (NEW-154-11)", () => {
      const SHADOW_KEY = "ENV_R2_S3_CLAIM";
      const unrelatedSecretNamedTheSame: EnvironmentSecretV12 = {
        secretId: "sec-shadow",
        name: SHADOW_KEY,
        kind: "api_key",
        protocol: null,
        destinations: [],
        mode: "exposed",
        state: "live",
        currentVersionId: "ver-shadow",
        revoked: false,
        updatedAt: 1,
        variables: [],
        providerVariables: [],
      };

      it("notes that the provider gets this value instead of the secret, with a link to Secrets", async () => {
        renderClaudeEnvTab(
          { localOverrides: [], secrets: [unrelatedSecretNamedTheSame] },
          [{ key: SHADOW_KEY, value: "r2-override" }],
        );

        const note = await screen.findByTestId("env-row-note");
        expect(note.textContent).toBe(
          `Claude Code gets this value instead of the secret ${SHADOW_KEY} · Secrets`,
        );
        expect(screen.queryByTestId("env-claimed-row")).toBeNull();
        expect(screen.getByLabelText(`Value for ${SHADOW_KEY}`)).toBeTruthy();

        fireEvent.click(within(note).getByRole("button", { name: "Secrets" }));
        expect(navigation.toSection).toHaveBeenCalledWith("secrets");
      });
    });
  });
});
