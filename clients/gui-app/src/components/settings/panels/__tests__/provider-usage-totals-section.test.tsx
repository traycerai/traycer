import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderUsageTotalsSection } from "@/components/settings/panels/provider-usage-totals-section";
import type { UsageSummaryRequest } from "@/hooks/usage-analytics/use-usage-summary-query";

/**
 * Wave-5 review O1: the Usage tab's totals card must narrow to the provider
 * whose tab it is rendered under, not just to the selected profile.
 *
 * `profileId` alone cannot do that. The Default account is
 * `effectiveProfileId: null` on EVERY provider, so `profileWireId(null)`'s
 * `"ambient"` selects Claude + Grok + OpenCode facts as well - which is the
 * majority case, and the only case for a user with no managed profiles. The
 * fix is a second filter keyed by the vocabulary the facts actually carry
 * (`harnessId`), and this asserts the wire request the card issues, which is
 * the boundary the GUI owns. The aggregator's own exclusion behaviour is
 * pinned in `packages/common`'s `aggregate.test.ts`.
 */

const captured: UsageSummaryRequest[] = [];

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummaryProfileFilterSupported: () => true,
}));

vi.mock("@/hooks/usage-analytics/use-usage-summary-query", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/usage-analytics/use-usage-summary-query")
  >("@/hooks/usage-analytics/use-usage-summary-query");
  return {
    ...actual,
    useUsageSummaryForClient: (
      _client: unknown,
      request: UsageSummaryRequest,
    ) => {
      captured.push(request);
      return {
        data: undefined,
        error: null,
        isLoading: false,
        refetch: () => Promise.resolve({}),
      };
    },
  };
});

afterEach(() => {
  captured.length = 0;
  cleanup();
});

describe("ProviderUsageTotalsSection", () => {
  it("scopes the Default account's totals to this tab's harness, not to every provider's ambient facts", () => {
    render(
      <ProviderUsageTotalsSection
        hostId="host-1"
        providerId="claude-code"
        profileId={null}
      />,
    );

    expect(captured).toHaveLength(1);
    // `claude-code` is the provider-config id; the facts are keyed by the
    // harness id, and the card is the one place that translation happens.
    expect(captured[0].harnessId).toBe("claude");
    expect(captured[0].profileId).toBe("ambient");
  });

  it("keeps the harness filter for a managed profile too (a uuid is unique, the tab still is not)", () => {
    render(
      <ProviderUsageTotalsSection
        hostId="host-1"
        providerId="codex"
        profileId="profile-work"
      />,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].harnessId).toBe("codex");
    expect(captured[0].profileId).toBe("profile-work");
  });
});
