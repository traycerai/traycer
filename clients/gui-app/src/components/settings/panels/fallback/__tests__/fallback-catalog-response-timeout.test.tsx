import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GuiHarnessOption,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import type { TierGroup } from "@traycer/protocol/host/fallback-policy";
import type { HostRpcRegistry } from "@/lib/host";
import { CATALOG_LIST_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/catalog-list-response-timeout";

/**
 * The two fallback surfaces read model catalogues through `useHostQueries`;
 * each must hand it the catalog response allowance. Every collaborator is
 * mocked at the module seam (as in `fallback-catalog-options.test.tsx`), and
 * the mocked `useHostQueries` records the options it was given.
 */
interface CapturedCall {
  readonly responseTimeoutMs: number | undefined;
  readonly methods: ReadonlyArray<string>;
}

const fixture = vi.hoisted(
  (): {
    harnesses: readonly GuiHarnessOption[];
    captured: readonly CapturedCall[];
  } => ({ harnesses: [], captured: [] }),
);

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({}),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: (): { data: ListGuiHarnessesResponse } => ({
    data: { harnesses: [...fixture.harnesses] },
  }),
  useGuiHarnessesQueryForClient: (): { data: ListGuiHarnessesResponse } => ({
    data: { harnesses: [...fixture.harnesses] },
  }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ canExecute: true }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    readonly responseTimeoutMs: number | undefined;
    readonly requests: ReadonlyArray<{ readonly method: string }>;
    readonly combine:
      | ((results: ReadonlyArray<{ data: undefined }>) => unknown)
      | undefined;
  }): unknown => {
    fixture.captured = [
      ...fixture.captured,
      {
        responseTimeoutMs: args.responseTimeoutMs,
        methods: args.requests.map((request) => request.method),
      },
    ];
    const results = args.requests.map(() => ({
      data: undefined,
      isSuccess: false,
      isError: false,
    }));
    return args.combine === undefined ? results : args.combine(results);
  },
}));

import { useFallbackCatalogOptions } from "@/components/settings/panels/fallback/fallback-catalog-options";
import { useFallbackModelCatalogues } from "@/components/chat/fallback/fallback-identity";

function claudeHarness(): GuiHarnessOption {
  return {
    id: "claude",
    label: "claude",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
    authStatus: undefined,
  };
}

beforeEach(() => {
  fixture.harnesses = [claudeHarness()];
  fixture.captured = [];
});

afterEach(() => {
  cleanup();
});

describe("fallback catalogue reads carry the catalog response allowance", () => {
  it("useFallbackCatalogOptions", () => {
    const groups: readonly TierGroup[] = [
      {
        id: "g1",
        candidates: [
          { harnessId: "claude", modelFamily: "opus", reasoningEffort: null },
        ],
      },
    ];
    renderHook(() => useFallbackCatalogOptions(groups));

    const listModelsCalls = fixture.captured.filter((call) =>
      call.methods.includes("agent.gui.listModels"),
    );
    expect(listModelsCalls.length).toBeGreaterThan(0);
    for (const call of listModelsCalls) {
      expect(call.responseTimeoutMs).toBe(CATALOG_LIST_RESPONSE_TIMEOUT_MS);
    }
  });

  it("useFallbackModelCatalogues", () => {
    const client: HostClient<HostRpcRegistry> | null = null;
    renderHook(() => useFallbackModelCatalogues(client, ["claude"], true));

    const listModelsCalls = fixture.captured.filter((call) =>
      call.methods.includes("agent.gui.listModels"),
    );
    expect(listModelsCalls.length).toBeGreaterThan(0);
    for (const call of listModelsCalls) {
      expect(call.responseTimeoutMs).toBe(CATALOG_LIST_RESPONSE_TIMEOUT_MS);
    }
  });
});
