import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { ProvidersGetProfileConfigResponse } from "@traycer/protocol/host/provider-profile-config-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import { ProfileAccountTab } from "@/components/settings/panels/profile-account-tab";

const mocks = vi.hoisted(() => ({
  supportsMethod: {} as Record<string, boolean>,
  profileConfigData: undefined as ProvidersGetProfileConfigResponse | undefined,
  setEndpointMutate: vi.fn(),
  testConnectionMutate: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    mocks.supportsMethod[method] ?? true,
}));

vi.mock("@/hooks/providers/use-providers-profile-config-query", () => ({
  useProvidersProfileConfig: () => ({
    data: mocks.profileConfigData,
    isPending: false,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-set-profile-endpoint-mutation",
  () => ({
    useProvidersSetProfileEndpoint: () => ({
      mutate: mocks.setEndpointMutate,
      isPending: false,
      error: null,
    }),
  }),
);

vi.mock(
  "@/hooks/providers/use-providers-test-profile-connection-mutation",
  () => ({
    useProvidersTestProfileConnection: () => ({
      mutate: mocks.testConnectionMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

const CLAUDE_CODE_ENDPOINT_CAPABILITIES: NonNullable<
  ProviderCliState["endpointCapabilities"]
> = {
  supportsBaseUrl: true,
  credentialKinds: ["api_key", "auth_token"],
  requiresModel: false,
  extraFields: [],
  credentialStoredInNativeConfig: false,
};

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    endpointCapabilities: CLAUDE_CODE_ENDPOINT_CAPABILITIES,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [
      {
        kind: "bundled",
        path: "/opt/traycer/bin/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    },
    availabilityPending: false,
    profiles: [],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    ...overrides,
  };
}

function apiKeyProfile(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    profileId: "profile-1",
    kind: "managed",
    authType: "apiKey",
    label: "My profile",
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    enabled: true,
    endpoint: null,
    config: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mocks.supportsMethod = {};
  mocks.profileConfigData = undefined;
  mocks.setEndpointMutate.mockReset();
  mocks.testConnectionMutate.mockReset();
});

describe("ProfileAccountTab - default account arm", () => {
  it("renders ProviderApiKeySection and shows the Endpoint section only when the row supports a base URL", () => {
    const { unmount } = render(
      <ProfileAccountTab
        state={providerState({ providerId: "claude-code" })}
        hostId="host-1"
        profileId={null}
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(screen.getByRole("button", { name: "Endpoint" })).toBeDefined();
    unmount();

    // cursor has no host endpoint projection (`endpointCapabilities: null`).
    render(
      <ProfileAccountTab
        state={providerState({
          providerId: "cursor",
          endpointCapabilities: null,
        })}
        hostId="host-1"
        profileId={null}
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Endpoint" })).toBeNull();
  });

  it("host manifest without providers.setProfileConfig is byte-identical to a bare ProviderApiKeySection", () => {
    mocks.supportsMethod["providers.setProfileConfig"] = false;
    const state = providerState({ providerId: "claude-code" });

    const { container: withTab } = render(
      <ProfileAccountTab
        state={state}
        hostId="host-1"
        profileId={null}
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Endpoint" })).toBeNull();
    const tabText = withTab.textContent;
    cleanup();

    const { container: bare } = render(
      <ProviderApiKeySection
        state={state}
        draft=""
        onDraftChange={() => undefined}
      />,
    );
    expect(tabText).toBe(bare.textContent);
  });
});

describe("ProfileAccountTab - apiKey arm", () => {
  it("renders base URL / credential / default model, with the credential empty and masked even when configured", () => {
    mocks.profileConfigData = {
      config: {
        cliSelection: null,
        terminalAgentArgs: "",
        env: [],
        skills: "linked",
        plugins: "linked",
        endpoint: {
          baseUrl: "https://api.example.com",
          credentialKind: "api_key",
          credentialConfigured: true,
          defaultModel: "claude-3.5",
          lastTest: null,
        },
      },
    };
    render(
      <ProfileAccountTab
        state={providerState({
          providerId: "claude-code",
          profiles: [apiKeyProfile({})],
        })}
        hostId="host-1"
        profileId="profile-1"
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );

    const baseUrl = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(baseUrl.value).toBe("https://api.example.com");
    const credential = screen.getByLabelText("Credential") as HTMLInputElement;
    expect(credential.type).toBe("password");
    expect(credential.value).toBe("");
    const defaultModel = screen.getByLabelText(
      "Default model",
    ) as HTMLInputElement;
    expect(defaultModel.value).toBe("claude-3.5");
  });

  it("renders the credential-kind Select for claude-code and not for another apiKey provider", () => {
    const { unmount } = render(
      <ProfileAccountTab
        state={providerState({
          providerId: "claude-code",
          profiles: [apiKeyProfile({})],
        })}
        hostId="host-1"
        profileId="profile-1"
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Credential kind" }),
    ).toBeDefined();
    unmount();

    render(
      <ProfileAccountTab
        state={providerState({
          providerId: "codex",
          // Codex accepts only `api_key` (single-entry `credentialKinds`),
          // so the credential-kind Select must not render for it.
          endpointCapabilities: {
            supportsBaseUrl: true,
            credentialKinds: ["api_key"],
            requiresModel: true,
            extraFields: [],
            credentialStoredInNativeConfig: false,
          },
          profiles: [apiKeyProfile({ profileId: "profile-2" })],
        })}
        hostId="host-1"
        profileId="profile-2"
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("combobox", { name: "Credential kind" }),
    ).toBeNull();
  });

  it("renders the destructive badge with the reason verbatim for a failed test", () => {
    render(
      <ProfileAccountTab
        state={providerState({
          providerId: "claude-code",
          profiles: [
            apiKeyProfile({
              endpoint: {
                host: "https://api.example.com",
                model: "claude-3.5",
                credentialKind: "api_key",
                credentialConfigured: true,
                lastTest: {
                  at: 1_700_000_000_000,
                  ok: false,
                  reason: "401 Unauthorized: invalid key",
                },
              },
            }),
          ],
        })}
        hostId="host-1"
        profileId="profile-1"
        isSelectedHostLocal
        apiKeyDraft=""
        onApiKeyDraftChange={() => undefined}
      />,
    );

    expect(screen.getByText("Test failed")).toBeDefined();
    expect(screen.getByText("401 Unauthorized: invalid key")).toBeDefined();
  });
});
