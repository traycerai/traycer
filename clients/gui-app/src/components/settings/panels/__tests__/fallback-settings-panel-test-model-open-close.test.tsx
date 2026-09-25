import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
} from "@traycer/protocol/host/fallback-policy";

/**
 * Ticket 05, clause 7: the Test a model button's `patterns`-gated presence,
 * open/close, and focus return - through the REAL `FallbackPolicyEditor`, the
 * same rendering the earlier suites in this directory use.
 *
 * Everything the Test panel's own hooks touch (`useHostClient`,
 * `useAddressableHostId`, the harness/model catalog, the dry-run query) is
 * mocked at its own module boundary, exactly as `fallback-settings-panel.test.tsx`
 * mocks the editor's host-backed hooks - this suite never opens the panel far
 * enough to need a populated tuple, only far enough to test open, close and
 * focus.
 */

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});

const fallbackMocks = vi.hoisted(
  (): { queryData: ProvidersFallbackPolicyGetResponse | undefined } => ({
    queryData: undefined,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: fallbackMocks.queryData,
    refetch: () =>
      Promise.resolve({ isSuccess: true, data: fallbackMocks.queryData }),
  }),
}));

vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);

// The editor's OWN preview and the Test panel's dry-run query, each in its own
// module, are mocked inert since neither answer is this suite's subject (open,
// close and focus return only).
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: undefined,
      isFetching: false,
    }),
  }),
);
vi.mock("@/hooks/providers/use-fallback-policy-test-tier-groups-query", () => ({
  useFallbackPolicyTestTierGroupsQuery: () => ({
    data: undefined,
    isFetching: false,
    isError: false,
    refetch: () => {},
  }),
}));

vi.mock(
  "@/components/settings/panels/fallback/fallback-catalog-options",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/fallback/fallback-catalog-options")
      >();
    return {
      ...actual,
      useFallbackCatalogOptions: () => ({
        modelsFor: () => [],
        catalogFor: () => null,
        catalogsByHarness: new Map(),
        effortsFor: () => [],
      }),
    };
  },
);

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);

// The Test panel's own host-backed hooks - a fresh module boundary from the
// editor's own catalog/preview mocks above, since `FallbackTestModelPanel`
// reads the host directly rather than through the editor's props.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: undefined }),
  useGuiHarnessModelsWarmup: () => [],
}));

const patternLines = vi.hoisted(
  (): { patterns: boolean; blankPreviewRows: boolean } => ({
    patterns: true,
    blankPreviewRows: false,
  }),
);

vi.mock("@/hooks/providers/use-fallback-policy-pattern-lines", () => ({
  useFallbackPolicyPatternLines: () => patternLines,
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import {
  openFallbackTab,
  renderWithFallbackQueryClient,
} from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";
import { consumeSettingsEscape } from "@/components/settings/settings-escape-consumers";
import { settingsOverlayModule } from "@/stores/tabs/overlays/settings";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), enabled: true, ...overrides };
}

function respond(
  policyValue: FallbackPolicy,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: policyValue,
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function renderPanel() {
  return renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

beforeEach(() => {
  fallbackMocks.queryData = respond(policy({}));
  patternLines.patterns = true;
  patternLines.blankPreviewRows = false;
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - Test a model button presence", () => {
  it("is offered when the host reads patterns (get >= 1.1)", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    expect(screen.getByTestId("fallback-test-model-button")).toBeTruthy();
  });

  it("is ABSENT on a get 1.0 host (patternLines.patterns === false)", () => {
    patternLines.patterns = false;
    renderPanel();
    openFallbackTab("equivalentModels");
    expect(screen.queryByTestId("fallback-test-model-button")).toBeNull();
  });
});

describe("FallbackSettingsPanel - Test a model open, close and focus return", () => {
  it("has aria-expanded and opens the panel under the header on click", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByTestId("fallback-test-model-panel");
    expect(panel).toBeTruthy();
    // Under the header, inside the same section: the panel and the header
    // wrapper are siblings under the tier-groups container.
    const header = screen.getByTestId("fallback-tier-groups-header");
    expect(
      header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("closes via the close button and returns focus to the Test a model button", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");

    fireEvent.click(screen.getByTestId("fallback-test-model-close"));
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on Escape via the Settings tab's own keydown path, and returns focus", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    const panel = screen.getByTestId("fallback-test-model-panel");
    panel.focus();

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("consumeSettingsEscape closes the panel and returns true while focus is inside it", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");
    // A real focusable control inside the panel - the `<section>` itself has
    // no tabIndex, so `.focus()` on it is a no-op in jsdom.
    screen.getByTestId("fallback-test-model-close").focus();

    let handled = false;
    act(() => {
      handled = consumeSettingsEscape();
    });
    expect(handled).toBe(true);
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("consumeSettingsEscape returns false and leaves the panel open when focus is outside it", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");
    // Focus something outside the panel entirely.
    button.focus();

    const handled = consumeSettingsEscape();
    expect(handled).toBe(false);
    expect(screen.getByTestId("fallback-test-model-panel")).toBeTruthy();
  });
});

/**
 * The MODAL Escape seam (`stores/tabs/overlays/settings.tsx`), one level up
 * from the direct `consumeSettingsEscape()` calls above: the body control's
 * consumer is offered FIRST, before the settings-search clear, because it is
 * where the user's keyboard is. Deleting the module's
 * `if (consumeSettingsEscape()) return true;` line leaves every test above
 * green (they call `consumeSettingsEscape()` directly, never through the
 * overlay module), so this describe block is the only thing that would catch
 * that regression.
 */
describe("FallbackSettingsPanel - Test a model, through the modal Escape seam", () => {
  afterEach(() => {
    useSettingsSearchStore.getState().setQuery("");
  });

  it("closes the panel and returns focus to the button when focus is inside it", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");
    screen.getByTestId("fallback-test-model-close").focus();

    let handled = false;
    act(() => {
      handled = settingsOverlayModule.consumeEscape();
    });
    expect(handled).toBe(true);
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes the panel and leaves an active search query untouched, since the panel comes first", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");
    screen.getByTestId("fallback-test-model-close").focus();
    useSettingsSearchStore.getState().setQuery("x");

    let handled = false;
    act(() => {
      handled = settingsOverlayModule.consumeEscape();
    });
    expect(handled).toBe(true);
    expect(screen.queryByTestId("fallback-test-model-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
    // The panel's own consumer claimed the key, so the search clear this
    // module would otherwise fall through to never ran.
    expect(useSettingsSearchStore.getState().query).toBe("x");
  });

  it("returns false and leaves the panel open when focus is outside it and there is no query", () => {
    renderPanel();
    openFallbackTab("equivalentModels");
    const button = screen.getByTestId("fallback-test-model-button");
    fireEvent.click(button);
    screen.getByTestId("fallback-test-model-panel");
    button.focus();

    const handled = settingsOverlayModule.consumeEscape();
    expect(handled).toBe(false);
    expect(screen.getByTestId("fallback-test-model-panel")).toBeTruthy();
  });
});
