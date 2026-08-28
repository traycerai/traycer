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

/**
 * The Overview addresses the host it NAMES, without depending on anything
 * above it to arrange that.
 *
 * READ THE HARNESS BEFORE THE RESULT — the mocking condition is what this
 * suite means, and quoting its numbers without it would mislead.
 *
 * In production, `HostSettingsPanel` wraps this subtree in
 * `<HostRuntimeContext.Provider value={scopedBinding}>` (`:148`), so the
 * ambient binding a descendant reads has ALREADY been swapped for the scoped
 * host's. That wrapper is correct and load-bearing. This suite mounts through
 * `HostSettingsPanel`, so the wrapper is present — but it also mocks
 * `useHostBinding` wholesale, which is what `useScopedHostBinding` itself
 * calls, so the re-provision cannot take effect here. The harness therefore
 * simulates the one condition production does not have: **the wrapper absent
 * or wrong.**
 *
 * That makes it a robustness guard, not a bug reproduction. Measured against
 * the panel body BEFORE it read `scope.client`, with the ambient binding on A
 * and the scope explicitly picked to B: `host.status` dispatched **1 call on A
 * and 0 on B**. In production the wrapper compensated, so no user ever saw it;
 * what the number proves is that the body had no scoping of its own and the
 * invariant lived entirely in a wrapper two files away — one spelled
 * `HostRuntimeContext.Provider`, which the obvious greps for
 * `HostBindingProvider`/`HostRuntimeProvider` do not match. A correct mechanism
 * that reads as absent is one a refactor deletes without noticing.
 *
 * With the body reading `scope.client`, the same arrangement dispatches on B.
 * The panel is now immune to wrapper drift, and this is the test that would
 * fail if that immunity were ever traded back.
 *
 * Why it matters here in particular: eight reads hang off that client and three
 * of them WRITE — `host.identity.set` renames a machine, `host.restart` ends
 * its sessions, and the drain-gate force ends them without waiting.
 * `host-scope-status.ts` states the rule they owe: "a visible host name must
 * always match the client used by every read, stream and mutation beneath it."
 */

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

/**
 * Ambient binding on host A, scope explicitly picked to host B — two
 * independent `HostClient`s over two in-memory messengers, so which host was
 * addressed is counted at the transport rather than inferred from what was
 * passed where.
 */
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

    // Positive control FIRST: a panel that rendered nothing would satisfy the
    // negative assertion below for entirely the wrong reason.
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
