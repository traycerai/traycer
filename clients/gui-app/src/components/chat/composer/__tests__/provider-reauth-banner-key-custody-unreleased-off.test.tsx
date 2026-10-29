/**
 * The build without environments (`unreleased-features.ts`) draws no custody
 * line under a pasted key: the banner had none before them.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

import {
  act,
  cleanup,
  render as baseRender,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-1";
const HOST_LABEL = "Work Mac";

const hostState = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: HOST_ID, kind: "local", label: HOST_LABEL }],
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => hostState.client,
}));
vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () => ({ hostClient: { id: "real-client" } }),
  };
});
vi.mock("@/hooks/providers/use-providers-login-ownership", () => ({
  useProvidersLoginOwnership: () => false,
  useProvidersLoginOwnershipForClient: () => false,
}));

import { ProviderReauthBanner } from "../provider-reauth-banner";

function QueryWrapper({ children }: { readonly children: ReactNode }) {
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

function render(ui: ReactElement) {
  return baseRender(ui, { wrapper: QueryWrapper });
}

/** The host answers `environment.status` with `principal`, over a real client. */
function hostRunning(principal: EnvironmentStatusResponseV11["principal"]) {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => environmentStatusFixture({ principal }),
    },
  });
  hostState.client = client;
  recordNegotiatedHostMethods(HOST_ID, ["environment.status"]);
}

function signedOut(
  providerId: ProviderId,
  tokenVar: string,
  apiKeySupported: boolean,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [
      {
        kind: "bundled",
        path: `/opt/traycer/bin/${providerId}`,
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: apiKeySupported, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: null,
      token: { vars: [tokenVar] },
      codePaste: null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  };
}

function renderBanner(providerId: ProviderId, state: ProviderCliState) {
  return render(
    <ProviderReauthBanner
      epicId={null}
      viewTabId={null}
      providerId={providerId}
      state={state}
      reason="provider_unauthenticated"
      profileId={null}
      profileLabel={null}
      onContinueOnAmbient={null}
    />,
  );
}

const DROID = signedOut("droid", "FACTORY_API_KEY", true);

beforeEach(() => {
  resetNegotiatedManifests();
});

afterEach(() => {
  cleanup();
  hostState.client = null;
  resetNegotiatedManifests();
});

describe("<ProviderReauthBanner /> without environments", () => {
  it("draws the pasted key field with no custody line under it", async () => {
    hostRunning({ kind: "personal" });
    renderBanner("droid", DROID);

    expect(await screen.findByRole("button", { name: "Save" })).toBeDefined();
    // Let the host's environment.status answer, which is what would draw it.
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(screen.queryByText(/Stored encrypted/)).toBeNull();
  });
});
