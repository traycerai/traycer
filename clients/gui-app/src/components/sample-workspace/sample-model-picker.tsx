import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  providerCliStateSchema,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { buildAllHarnessModelRows } from "@/components/home/data/harness-model-search";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import { HarnessModelPickerPanelBody } from "@/components/home/pickers/harness-model-picker-panel";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { SAMPLE_TOOLBAR_VALUES, sampleNoop } from "./sample-workspace-scene";

/**
 * The sample composer's model picker, open, while Model is hovered or
 * selected in the editor: the real picker body (search, provider rail,
 * account line, model list and footer) fed sample data only, so Reasoning
 * control and Model style change something on the canvas. Nothing here reads
 * the host catalog, the accounts or the user's own model choice.
 *
 * It is where the real popover opens (`HarnessModelPickerPanel`): the same
 * surface and size, right-aligned to the chip and 8px off it, flipped above
 * the chip as the composer's position flips the real one. Placed with CSS
 * anchor positioning on `--sample-model-chip`, the name `layout-editor.css`
 * gives the sample composer's Model region node, rather than by
 * Radix: a Radix popover would portal out of the canvas, take focus and claim
 * Escape. Both insets are set and the left margin is auto, so the width stops
 * at the popover's 30rem, or at the column's left edge in a narrow column.
 *
 * A PART of the Model region rather than a second node named for it:
 * clicking it selects Model, while every lookup of the Model region still
 * finds the chip. The picture inside is `inert` (no focus, no a11y tree, and
 * hit-testing falls to this box) and dims as passive content.
 */
export function SampleModelPicker(): ReactNode {
  const shown = useLayoutEditorStore(
    (state) =>
      state.session !== null &&
      (state.hovered === "model" || state.selected === "model"),
  );
  if (!shown) return null;
  return (
    <div
      data-layout-region-part="model"
      data-testid="sample-model-picker"
      className="absolute left-0 z-10 mb-2 ml-auto h-92 max-w-120 [position-anchor:--sample-model-chip]"
      style={SAMPLE_PICKER_INSETS}
    >
      {/* `PopoverContent`'s surface under its `panel` layout, the real
          picker's. `data-layout-passive-members` dims the parts and not the
          surface, which stays opaque over the queue. */}
      <div
        inert
        data-layout-passive-members
        className="flex size-full flex-col overflow-hidden rounded-xl bg-popover text-ui-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        <SampleModelPickerBody />
      </div>
    </div>
  );
}

function SampleModelPickerBody(): ReactNode {
  const idPrefix = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const selectedIndex = SAMPLE_ROWS.findIndex(
    (row) => row.value === SAMPLE_SELECTION.modelSlug,
  );
  const selectedRowId = SAMPLE_ROWS[selectedIndex]?.id ?? "";
  return (
    <HarnessModelPickerPanelBody
      hasQuery={false}
      listboxId={`${idPrefix}-listbox`}
      idPrefix={idPrefix}
      inputRef={inputRef}
      query=""
      onQueryChange={sampleNoop}
      activeProviderLabel={SAMPLE_ACTIVE_HARNESS.label}
      activeDescendant={undefined}
      catalogHarnesses={SAMPLE_HARNESSES}
      fallbackHarnesses={SAMPLE_HARNESSES}
      profilesByHarnessId={NO_PROFILES}
      resolvedActiveProviderId={SAMPLE_SELECTION.harnessId}
      activeProfileId={null}
      activeProfileIdByHarnessId={NO_ACTIVE_PROFILES}
      activeProviderProfiles={[]}
      profileEnablementPending={() => false}
      activeProviderState={SAMPLE_PROVIDER_STATE}
      lockedHarnessId={null}
      degradedHarnessIds={NO_HARNESS_IDS}
      preparingByHarnessId={NO_PREPARING}
      catalogHarnessesLoading={false}
      onEntryChange={sampleNoop}
      onRetryPack={sampleNoop}
      onProfileChange={sampleNoop}
      onRefreshCatalog={async () => {}}
      hostUnavailableLabel={null}
      onOpenProviderSettings={sampleNoop}
      onClosePicker={sampleNoop}
      listRef={listRef}
      listKey="sample"
      visibleRows={SAMPLE_ROWS}
      selectedRowId={selectedRowId}
      effectiveActiveRowId={selectedRowId}
      hoveredRowId=""
      initialTopMostItemIndex={{
        index: Math.max(selectedIndex, 0),
        align: "center",
        behavior: "auto",
      }}
      catalogHarnessesError={false}
      activeProvider={SAMPLE_ACTIVE_HARNESS}
      onHoverRow={sampleNoop}
      onActiveRow={sampleNoop}
      onSelectRow={sampleNoop}
      reasoningFooter={{
        value: SAMPLE_TOOLBAR_VALUES.reasoning,
        options: SAMPLE_REASONING_LEVELS,
        disabled: false,
        onChange: sampleNoop,
      }}
      reasoningPickerOpen
      serviceTierFooter={{
        selectedModel: SAMPLE_SELECTED_MODEL,
        value: SAMPLE_TOOLBAR_VALUES.serviceTier,
        onChange: sampleNoop,
      }}
      createProfileHostId={null}
      runTargetHostId={null}
      terminalLoginSurface={null}
      createProfileDisabled
      createProfileDisabledReason={undefined}
      profileAdmission={null}
    />
  );
}

/** Right-aligned to the chip, its bottom on the chip's top. */
const SAMPLE_PICKER_INSETS: CSSProperties = {
  right: "anchor(right)",
  bottom: "anchor(top)",
};

const SAMPLE_SELECTION = SAMPLE_TOOLBAR_VALUES.selection;

const SAMPLE_REASONING_LEVELS = [
  { id: "low", label: "Low", description: null },
  { id: "medium", label: "Medium", description: null },
  { id: "high", label: "High", description: null },
  { id: "xhigh", label: "Extra high", description: null },
];

function sampleModel(
  harnessId: GuiHarnessId,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: SAMPLE_REASONING_LEVELS,
    defaultServiceTier: null,
    supportedServiceTiers: [{ id: "fast", label: "Fast", description: null }],
    metadata: {},
  });
}

function sampleHarness(
  id: GuiHarnessId,
  label: string,
  models: ReadonlyArray<GuiAgentModelOption>,
): GuiHarnessCatalogEntry {
  return {
    ...guiHarnessOptionSchema.parse({
      id,
      label,
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
    }),
    models: [...models],
    modelsLoading: false,
    modelsError: null,
  };
}

const SAMPLE_SELECTED_MODEL = sampleModel(
  SAMPLE_SELECTION.harnessId,
  SAMPLE_SELECTION.modelSlug,
  "Sample model",
);

const SAMPLE_ACTIVE_HARNESS = sampleHarness(
  SAMPLE_SELECTION.harnessId,
  "Sample",
  [
    SAMPLE_SELECTED_MODEL,
    sampleModel(
      SAMPLE_SELECTION.harnessId,
      "sample-model-max",
      "Sample model max",
    ),
    sampleModel(
      SAMPLE_SELECTION.harnessId,
      "sample-model-mini",
      "Sample model mini",
    ),
  ],
);

const SAMPLE_HARNESSES: ReadonlyArray<GuiHarnessCatalogEntry> = [
  SAMPLE_ACTIVE_HARNESS,
  sampleHarness("codex", "Second sample", [
    sampleModel("codex", "sample-model", "Sample model"),
  ]),
];

const SAMPLE_ROWS = buildAllHarnessModelRows([
  { harness: SAMPLE_ACTIVE_HARNESS, models: SAMPLE_ACTIVE_HARNESS.models },
]);

/** The account line's one sample account. */
const SAMPLE_PROVIDER_STATE = providerCliStateSchema.parse({
  providerId: "claude-code",
  enabled: true,
  disabledBy: null,
  selected: { kind: "bundled" },
  candidates: [],
  authPending: false,
  checkedAt: null,
  apiKey: { supported: false, configured: false, source: null },
  auth: {
    status: "authenticated",
    badgeText: null,
    label: "Sample account",
    detail: null,
  },
});

const NO_PROFILES: ReadonlyMap<
  GuiHarnessId,
  ReadonlyArray<ProviderProfile>
> = new Map();
const NO_ACTIVE_PROFILES: ReadonlyMap<GuiHarnessId, string | null> = new Map();
const NO_HARNESS_IDS: ReadonlySet<GuiHarnessId> = new Set();
const NO_PREPARING: ReadonlyMap<GuiHarnessId, ProviderPackPreparing> =
  new Map();
