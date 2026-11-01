import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Fragment, type ReactNode, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * The picker's Ultracode row through the real panel body, with the global
 * unreleased switch off as in the production build: the row appears whenever
 * the panel is given its config, and nowhere else. It sits in the model-list
 * column after the list and before the effort footer, and its switch reports
 * the new request. Nothing reads a build constant to decide that.
 */

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/host-connection-registry")
    >()),
    readHostDirectoryEntry: () => null,
    subscribeHostRowChanged: () => () => undefined,
  }),
);

// jsdom has no layout, so the virtualised list renders no rows: render them all.
vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    readonly id: string | undefined;
    readonly role: string | undefined;
    readonly totalCount: number | undefined;
    readonly itemContent:
      | ((index: number, item: undefined) => ReactNode)
      | undefined;
  }) => (
    <div id={props.id} role={props.role}>
      {Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
        <Fragment key={index}>{props.itemContent?.(index, undefined)}</Fragment>
      ))}
    </div>
  ),
}));

import {
  HarnessModelPickerPanelBody,
  type HarnessModelPickerPanelBodyProps,
} from "@/components/home/pickers/harness-model-picker-panel";
import type { UltracodeFooterConfig } from "@/components/home/pickers/ultracode-footer-button";
import type { ReasoningFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const HOST_ID = "host-1";

function model(harnessId: GuiHarnessId): ModelOption {
  return {
    harnessId,
    slug: `${harnessId}-model`,
    label: `${harnessId} model`,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
  };
}

function catalogEntry(id: GuiHarnessId): GuiHarnessCatalogEntry {
  return {
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
    authStatus: undefined,
    sandboxCredentialMode: null,
    sandboxCredentialNote: null,
    models: [model(id)],
    modelsLoading: false,
    modelsError: null,
  };
}

function rowOf(harnessId: GuiHarnessId): HarnessModelRow {
  const option = model(harnessId);
  return {
    id: `${harnessId}:${option.slug}`,
    value: option.slug,
    harnessId,
    harnessLabel: harnessId,
    label: option.label,
    browseLabel: option.label,
    providerGroupId: null,
    providerGroupLabel: null,
    capacityLabel: null,
    deprecationNotice: null,
    model: option,
    searchLabel: option.label,
    searchSlug: option.slug,
    searchProviderLabel: harnessId,
    searchProviderId: harnessId,
    searchOpenCodeProviderLabel: "",
    searchOpenCodeProviderId: "",
  };
}

const CATALOG: ReadonlyArray<GuiHarnessCatalogEntry> = [catalogEntry("claude")];

const noop = (): void => undefined;

const EFFORT_FOOTER: ReasoningFooterConfig = {
  value: "high",
  options: [
    { id: "low", label: "Low", description: null },
    { id: "high", label: "High", description: null },
  ],
  disabled: false,
  onChange: noop,
};

function renderPanel(
  ultracodeFooter: UltracodeFooterConfig | null,
  reasoningFooter: ReasoningFooterConfig | null,
): void {
  const browsed: GuiHarnessId = "claude";
  const inputRef: RefObject<HTMLInputElement | null> = { current: null };
  const listRef: RefObject<VirtuosoHandle | null> = { current: null };
  const active = CATALOG.find((entry) => entry.id === browsed) ?? null;
  const props: HarnessModelPickerPanelBodyProps = {
    hasQuery: false,
    listboxId: "listbox",
    idPrefix: "picker",
    inputRef,
    query: "",
    onQueryChange: noop,
    activeProviderLabel: browsed,
    activeDescendant: undefined,
    catalogHarnesses: CATALOG,
    fallbackHarnesses: CATALOG,
    offeredAgents: null,
    profilesByHarnessId: new Map<
      GuiHarnessId,
      ReadonlyArray<ProviderProfile>
    >(),
    resolvedActiveProviderId: browsed,
    activeProfileId: null,
    activeProfileIdByHarnessId: new Map<GuiHarnessId, string | null>(),
    activeProviderProfiles: [],
    profileEnablementPending: () => false,
    activeProviderState: null,
    lockedHarnessId: null,
    degradedHarnessIds: new Set<GuiHarnessId>(),
    preparingByHarnessId: new Map<GuiHarnessId, ProviderPackPreparing>(),
    catalogHarnessesLoading: false,
    onEntryChange: noop,
    onRetryPack: noop,
    onProfileChange: noop,
    onRefreshCatalog: () => Promise.resolve(),
    hostUnavailableLabel: null,
    onOpenProviderSettings: noop,
    onClosePicker: noop,
    listRef,
    listKey: "list",
    visibleRows: [rowOf(browsed)],
    selectedRowId: "",
    effectiveActiveRowId: "",
    hoveredRowId: "",
    initialTopMostItemIndex: { index: 0, align: "center", behavior: "auto" },
    catalogHarnessesError: false,
    restingModelPrompt: null,
    activeProvider: active,
    onHoverRow: noop,
    onActiveRow: noop,
    onSelectRow: noop,
    reasoningFooter,
    ultracodeFooter,
    reasoningPickerOpen: true,
    serviceTierFooter: null,
    createProfileHostId: HOST_ID,
    runTargetHostId: HOST_ID,
    terminalLoginSurface: null,
    createProfileDisabled: false,
    createProfileDisabledReason: undefined,
    profileAdmission: null,
  };
  render(<HarnessModelPickerPanelBody {...props} />);
}

describe("the picker panel's Ultracode row with the global switch off", () => {
  beforeEach(() => {
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });
  afterEach(() => {
    cleanup();
  });

  it("sits after the model list and directly before the effort footer, and reports a toggle", () => {
    const onChange = vi.fn<(next: boolean) => void>();
    renderPanel(
      {
        requested: false,
        offered: true,
        carried: true,
        modelLabel: "claude model",
        onChange,
      },
      EFFORT_FOOTER,
    );

    const row = screen.getByTestId("picker-ultracode-row");
    const list = screen.getByRole("option").closest("[role='listbox']");
    const effort = screen.getByRole("group", { name: "Thinking effort" });
    expect(list).not.toBeNull();
    expect(
      list !== null &&
        (list.compareDocumentPosition(row) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
    expect(effort.closest("[class*='border-t']")?.previousElementSibling).toBe(
      row,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Ultracode" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows no row without a config", () => {
    renderPanel(null, EFFORT_FOOTER);
    expect(screen.queryByTestId("picker-ultracode-row")).toBeNull();
  });
});
