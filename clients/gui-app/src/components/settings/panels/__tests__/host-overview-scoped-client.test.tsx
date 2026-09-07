// The Overview re-provides a scoped stream binding beside its unary one (for the Data & migration group), and
// the real hook reads `useAuthService` - which this suite deliberately does not stand up.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

// Same boundary as the sibling Overview suites: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

/** Read the harness before the result - the mocking condition is what this suite means, and quoting its numbers
 * without it would mislead. */

const ALL_OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

function makeRunnerHost(): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderPanel(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/** Ambient binding on host A, scope explicitly picked to host B. */
function arrangeDivergentScope(): {
  readonly ambient: OverviewHostFixture;
  readonly picked: OverviewHostFixture;
} {
  const ambient = buildOverviewHostFixture({
    hostId: "host-a",
    isLocalMachine: true,
    effectiveName: "Ambient Mac",
  });
  const picked = buildOverviewHostFixture({
    hostId: "host-b",
    isLocalMachine: false,
    effectiveName: "Office Linux",
  });
  recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
  recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);

  hostBindingMock.current = { hostClient: ambient.client };

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: "host-b",
      name: "Office Linux",
      isLocalMachine: false,
      connectable: true,
    }),
    hostId: "host-b",
    hostLabel: "Office Linux",
    status: "ready",
    client: picked.client,
    isViewingActive: false,
    activeHostId: "host-a",
  };
  return { ambient, picked };
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

describe("Overview under an explicit pick — RPCs address the PICKED host", () => {
  it("reads host.status from the picked host even with a divergent ambient binding", async () => {
    const { ambient, picked } = arrangeDivergentScope();
    renderPanel();

    // Positive control first: a panel that rendered nothing would satisfy the negative assertion below for
    // entirely the wrong reason.
    await waitFor(() => {
      expect(picked.hostStatusCalls()).toBeGreaterThan(0);
    });
    expect(ambient.hostStatusCalls()).toBe(0);
  });

  it("resolves the card's identity from the picked host, not the ambient one", async () => {
    const { ambient, picked } = arrangeDivergentScope();
    renderPanel();

    await waitFor(() => {
      expect(picked.hostStatusCalls()).toBeGreaterThan(0);
    });
    expect(ambient.identity().effectiveName).toBe("Ambient Mac");
    expect(picked.identity().effectiveName).toBe("Office Linux");
    expect(ambient.hostStatusCalls()).toBe(0);
  });
});
