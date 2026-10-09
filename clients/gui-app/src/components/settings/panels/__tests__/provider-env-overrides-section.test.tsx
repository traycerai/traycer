import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
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
        overrides={[{ key: "CURSOR_API_KEY", value: "sk-secret" }]}
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
        .getByRole("button", { name: "Add environment variable" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByLabelText("Name for CURSOR_API_KEY").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Remove CURSOR_API_KEY" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove CURSOR_API_KEY" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );

    expect(mocks.setOverrideMutate).not.toHaveBeenCalled();
    expect(mocks.deleteOverrideMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New environment variable name")).toBeNull();
  });

  it("control: on a host that takes overrides the editor is live and shows no refusal", () => {
    renderWithOverride();

    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add environment variable" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByLabelText("Name for CURSOR_API_KEY").hasAttribute("disabled"),
    ).toBe(false);
  });
});
