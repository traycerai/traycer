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

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentReviewEntry } from "@traycer/protocol/host/environment-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import type { EnvOverrideValue } from "../env-override-editor";
import { ProviderEnvOverridesSection } from "../provider-env-overrides-section";

const mocks = vi.hoisted(() => ({
  setOverrideMutate: vi.fn(),
  deleteOverrideMutate: vi.fn(),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes env overrides. */
  credentialRefusal: null as string | null,
}));

vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({
    mutate: mocks.setOverrideMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({
    mutate: mocks.deleteOverrideMutate,
    isPending: false,
  }),
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
});

type EnvOverrideScope =
  ProviderCliState["nativeCapabilities"]["envOverrideScope"];

function renderSection(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly envOverrideScope: EnvOverrideScope;
}): void {
  render(
    <ProviderEnvOverridesSection
      providerId={input.providerId}
      onOpenAccount={null}
      overrides={[]}
      envOverrideScope={input.envOverrideScope}
    />,
  );
}

describe("ProviderEnvOverridesSection — envOverrideScope copy (F1)", () => {
  it("states native-config-only scope applies to native config/MCP, not chat turns", () => {
    // Cursor is the production carrier of this scope, but the copy must be
    // driven by the descriptor — not by providerId === "cursor".
    renderSection({
      providerId: "cursor",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText(
        /Applied to native configuration operations, such as MCP setup,\s*but not chat turns/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Applied when Traycer spawns the/)).toBeNull();
  });

  it("uses the native-config-only copy for any providerId when the descriptor says so", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: "native-config-only",
    });

    expect(
      screen.getByText(
        /Applied to native configuration operations, such as MCP setup,\s*but not chat turns/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/spawns the Codex harness/)).toBeNull();
  });

  it("uses the harness spawn copy for the default harness-and-native-config scope", () => {
    renderSection({
      providerId: "cursor",
      envOverrideScope: "harness-and-native-config",
    });

    expect(
      screen.getByText(/Applied when Traycer spawns the Cursor harness/),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });

  it("uses the harness spawn copy when envOverrideScope is omitted (old hosts)", () => {
    renderSection({
      providerId: "codex",
      envOverrideScope: undefined,
    });

    expect(
      screen.getByText(/Applied when Traycer spawns the Codex harness/),
    ).toBeTruthy();
    expect(screen.queryByText(/but not chat turns/)).toBeNull();
  });
});

describe("ProviderEnvOverridesSection on a host that takes no credentials", () => {
  const REFUSAL = "Sandboxes don't take sign-ins";

  function renderWithOverride(): void {
    render(
      <ProviderEnvOverridesSection
        providerId="cursor"
        onOpenAccount={null}
        overrides={[
          { key: "CURSOR_BASE_URL", value: "https://example.invalid" },
        ]}
        envOverrideScope="harness-and-native-config"
      />,
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
    section: ReactNode,
  ): void {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.localOverrides": () => ({ overrides: [] }),
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
    });
    scopeOverrides.current = {
      host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
      hostId: HOST_ID,
      status: "ready",
      client,
    };
    hostBindingMock.current = { hostClient: client };
    render(
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
  ): void {
    mountOnPersonalPage(
      [],
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

    expect(mocks.deleteOverrideMutate).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOverrideMutate).toHaveBeenCalledWith({
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
});
