import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { ProviderEnvOverridesSection } from "../provider-env-overrides-section";

vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

afterEach(() => {
  cleanup();
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
