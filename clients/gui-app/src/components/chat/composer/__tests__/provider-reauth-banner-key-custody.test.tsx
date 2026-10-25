import { cleanup, render as baseRender, screen } from "@testing-library/react";
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

const CUSTODY_SENTENCE =
  "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";

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

const AMP = signedOut("amp", "AMP_API_KEY", true);
const DROID = signedOut("droid", "FACTORY_API_KEY", true);
const CLAUDE = signedOut("claude-code", "ANTHROPIC_API_KEY", false);

beforeEach(() => {
  resetNegotiatedManifests();
});

afterEach(() => {
  cleanup();
  hostState.client = null;
  resetNegotiatedManifests();
});

describe("<ProviderReauthBanner /> key custody and the host's configuration", () => {
  it("tells a forwarded provider's key on Personal that it is Personal's secret", async () => {
    hostRunning({ kind: "personal" });
    renderBanner("amp", AMP);

    expect(await screen.findByText(CUSTODY_SENTENCE)).toBeDefined();
    expect(screen.getByText("How Traycer handles this")).toBeDefined();
    expect(screen.queryByText(/Stored encrypted on /)).toBeNull();
  });

  it("names the host that keeps a Droid key on Personal, and claims no Personal custody", async () => {
    hostRunning({ kind: "personal" });
    renderBanner("droid", DROID);

    expect(
      await screen.findByText(
        `Stored encrypted on ${HOST_LABEL} only. Other computers and sandboxes running Personal don't get this key. When no key is saved here, Droid uses FACTORY_API_KEY from ${HOST_LABEL}'s shell.`,
      ),
    ).toBeDefined();
    expect(screen.queryByText(CUSTODY_SENTENCE)).toBeNull();
    expect(screen.queryByText("How Traycer handles this")).toBeNull();
  });

  it("keeps a forwarded provider's key on the one host when the host runs a team", async () => {
    hostRunning({ kind: "team", teamName: "Acme" });
    renderBanner("amp", AMP);

    expect(
      await screen.findByText(
        "Stored encrypted on Work Mac only. When no key is saved here, Amp uses AMP_API_KEY from Work Mac's shell.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(CUSTODY_SENTENCE)).toBeNull();
  });

  it("shows no custody line for an env-override-only form", async () => {
    hostRunning({ kind: "personal" });
    renderBanner("claude-code", CLAUDE);

    expect(
      await screen.findByText("Sign in to Claude Code to run it on Personal."),
    ).toBeDefined();
    expect(screen.queryByText(CUSTODY_SENTENCE)).toBeNull();
    expect(screen.queryByText(/Stored encrypted on /)).toBeNull();
  });

  it("names the team the host runs in the sign-in sentence", async () => {
    hostRunning({ kind: "team", teamName: "Acme" });
    renderBanner("claude-code", CLAUDE);

    expect(
      await screen.findByText("Sign in to Claude Code to run it on Acme."),
    ).toBeDefined();
  });

  it("names nothing when the host runs no configuration", async () => {
    hostRunning(null);
    renderBanner("claude-code", CLAUDE);

    expect(
      await screen.findByText("Sign in to Claude Code to run it."),
    ).toBeDefined();
  });
});
