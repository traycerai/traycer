import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { ProviderPluginsTab } from "@/components/settings/panels/provider-plugins-tab";

vi.mock("@/hooks/providers/use-providers-plugins-list-query", () => ({
  useProvidersPluginsList: () => ({
    data: { plugins: [] },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugins-mutate-mutation", () => ({
  useProvidersPluginsMutate: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-plugin-icon-query", () => ({
  useProvidersPluginIcon: () => ({ data: undefined }),
}));

const SESSION_NOTICE =
  "Plugin tools may not appear in Traycer-launched sessions. They load for this provider's own CLI, but not for the session stream Traycer drives.";

function pluginsState(
  providerId: ProviderCliState["providerId"],
  traycerSessionToolsNotice: boolean,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["plugins"],
      mcp: null,
      plugins: {
        addModes: ["read-only"],
        marketplaceBrowse: false,
        traycerSessionToolsNotice,
        actionScopes: {
          list: ["global"],
          add: [],
          remove: [],
          setEnabled: [],
        },
      },
      skills: null,
    },
    selected: { kind: "path" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

afterEach(() => {
  cleanup();
});

describe("ProviderPluginsTab session-tools notice", () => {
  it("renders the notice when caps.traycerSessionToolsNotice is true", () => {
    render(<ProviderPluginsTab state={pluginsState("cursor", true)} />);
    expect(screen.getByText(SESSION_NOTICE)).toBeDefined();
  });

  it("renders no notice when caps.traycerSessionToolsNotice is false", () => {
    render(<ProviderPluginsTab state={pluginsState("cursor", false)} />);
    expect(screen.queryByText(SESSION_NOTICE)).toBeNull();
  });

  it("uses one sentence driven solely by the flag, not by provider id", () => {
    // The cursor-specific arm is gone. Amp with the same flag must get the
    // same sentence - there is no provider-id branch left to diverge.
    const { unmount } = render(
      <ProviderPluginsTab state={pluginsState("cursor", true)} />,
    );
    const cursorText = screen.getByText(SESSION_NOTICE).textContent;
    unmount();

    render(<ProviderPluginsTab state={pluginsState("amp", true)} />);
    expect(screen.getByText(SESSION_NOTICE).textContent).toBe(cursorText);
  });
});
