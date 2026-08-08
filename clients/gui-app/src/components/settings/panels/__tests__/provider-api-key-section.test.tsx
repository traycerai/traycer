import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";

const openExternalLink = vi.fn();

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openExternalLink }),
}));

function apiKeyState(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "path" },
    candidates: [],
    auth: {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    profiles: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderApiKeySection dashboard link", () => {
  it("renders the key field without a 'get a key' button when the dashboard URL is null (kiro)", () => {
    // Kiro takes a KIRO_API_KEY but has no stable public key page. The total
    // Record marks that omission with null rather than silently dropping the
    // button the way a Partial record did for any missing entry.
    render(
      <ProviderApiKeySection
        state={apiKeyState("kiro")}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Create an API key/i }),
    ).toBeNull();
  });

  it("renders a 'get a key' button when the dashboard URL is non-null (cursor)", () => {
    render(
      <ProviderApiKeySection
        state={apiKeyState("cursor")}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Create an API key/i }),
    ).toBeDefined();
  });
});
