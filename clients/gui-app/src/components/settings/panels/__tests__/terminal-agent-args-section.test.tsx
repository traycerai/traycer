import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { TerminalAgentArgsSection } from "@/components/settings/panels/terminal-agent-args-section";

/**
 * D02/G11: terminal args are ALWAYS profile-owned. With a managed profile
 * selected in the switcher, this field used to call
 * `providers.setTerminalAgentArgs` - the DEFAULT ACCOUNT's row - while the
 * switcher above said the user was editing that profile. One case per
 * direction.
 */
const mocks = vi.hoisted(() => ({
  setArgsMutate: vi.fn(),
  setProfileArgsMutate: vi.fn(),
  profileConfigData: undefined as
    | { readonly config: { readonly terminalAgentArgs: string } }
    | undefined,
  supportsProfileConfig: true as boolean | null,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: { harnesses: [{ id: "claude", modes: ["gui", "tui"] }] },
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supportsProfileConfig,
}));

vi.mock(
  "@/hooks/providers/use-providers-set-terminal-agent-args-mutation",
  () => ({
    useProvidersSetTerminalAgentArgs: () => ({
      mutate: mocks.setArgsMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-set-profile-cli-mutation", () => ({
  useProvidersSetProfileCliSelection: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useProvidersSetProfileTerminalAgentArgs: () => ({
    mutate: mocks.setProfileArgsMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-profile-config-query", () => ({
  useProvidersProfileConfig: () => ({
    data: mocks.profileConfigData,
    isPending: false,
  }),
}));

function claudeState(terminalAgentArgs: string): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs,
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

afterEach(() => {
  cleanup();
  mocks.profileConfigData = undefined;
  mocks.supportsProfileConfig = true;
  vi.clearAllMocks();
});

describe("TerminalAgentArgsSection: which row a save writes", () => {
  it("writes the profile's own config for a managed profile, never the Default account's row", () => {
    mocks.profileConfigData = { config: { terminalAgentArgs: "--old" } };
    render(
      <TerminalAgentArgsSection
        state={claudeState("--default-account-args")}
        hostId="host-1"
        profileId="managed-1"
      />,
    );

    const input = screen.getByLabelText("Terminal interface CLI arguments");
    // The field shows the PROFILE's value, not the Default account's.
    expect(input).toHaveProperty("value", "--old");
    fireEvent.change(input, { target: { value: "--new" } });
    fireEvent.blur(input);

    expect(mocks.setProfileArgsMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: "managed-1",
      terminalAgentArgs: "--new",
    });
    expect(mocks.setArgsMutate).not.toHaveBeenCalled();
  });

  it("keeps writing providers.setTerminalAgentArgs for the Default account", () => {
    render(
      <TerminalAgentArgsSection
        state={claudeState("--default-account-args")}
        hostId="host-1"
        profileId={null}
      />,
    );

    const input = screen.getByLabelText("Terminal interface CLI arguments");
    expect(input).toHaveProperty("value", "--default-account-args");
    fireEvent.change(input, { target: { value: "--new" } });
    fireEvent.blur(input);

    expect(mocks.setArgsMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
      terminalAgentArgs: "--new",
    });
    expect(mocks.setProfileArgsMutate).not.toHaveBeenCalled();
  });

  it("refuses to render an editable field for a host that cannot serve profile config", () => {
    mocks.supportsProfileConfig = false;
    render(
      <TerminalAgentArgsSection
        state={claudeState("--default-account-args")}
        hostId="host-1"
        profileId="managed-1"
      />,
    );

    expect(
      screen.queryByLabelText("Terminal interface CLI arguments"),
    ).toBeNull();
    expect(
      screen.getByText(/doesn't support per-profile CLI arguments/),
    ).toBeTruthy();
  });
});
