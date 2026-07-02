import Fuse, { type IFuseOptions } from "fuse.js";
import {
  type HarnessModelSelection,
  type HarnessOption,
  type ModelOption,
  type ProviderId,
  modelDisplayLabel,
  modelMetadataString,
} from "@/components/home/data/landing-options";

export interface HarnessModelSource {
  readonly harness: HarnessOption;
  readonly models: ReadonlyArray<ModelOption>;
}

export interface HarnessModelRow {
  readonly id: string;
  readonly value: string;
  readonly harnessId: ProviderId;
  readonly harnessLabel: string;
  readonly label: string;
  /**
   * Primary text shown when browsing within a provider (no search query). For
   * grouped harnesses this drops the prefix `label` may carry, because the
   * provider/vendor is rendered as a group header instead (`Perplexity: Sonar` →
   * `Sonar` under a `Perplexity` header). Equal to `label` for ungrouped
   * harnesses and in search mode.
   */
  readonly browseLabel: string;
  /**
   * Stable group id this row groups under in browse mode - the host's declared
   * provider/vendor for grouped harnesses (OpenCode, OpenRouter). Section
   * boundaries key off this, NOT the display label, so two groups that happen to
   * share a name don't collapse into one. `null` for ungrouped harnesses.
   */
  readonly providerGroupId: string | null;
  /**
   * Display text for the group header (the provider's name, or its id when the
   * name is missing). `null` when `providerGroupId` is `null`.
   */
  readonly providerGroupLabel: string | null;
  readonly capacityLabel: string | null;
  /**
   * Human-readable sunset notice when the host's catalog flags this model as
   * deprecated (currently only the Traycer harness does). `null` for every
   * actively-recommended model, including every non-Traycer harness (the
   * field is optional on the wire - see `deprecationNotice` on
   * `GuiAgentModelOption`).
   */
  readonly deprecationNotice: string | null;
  readonly model: ModelOption;
  readonly searchLabel: string;
  readonly searchSlug: string;
  readonly searchProviderLabel: string;
  readonly searchProviderId: string;
  readonly searchOpenCodeProviderLabel: string;
  readonly searchOpenCodeProviderId: string;
}

export interface HarnessModelRowSection {
  readonly providerGroupId: string | null;
  readonly providerGroupLabel: string | null;
  readonly rows: ReadonlyArray<HarnessModelRow>;
}

const MODEL_ROW_FUSE_OPTIONS: IFuseOptions<HarnessModelRow> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [
    { name: "searchLabel", weight: 0.4 },
    { name: "searchSlug", weight: 0.3 },
    { name: "searchProviderLabel", weight: 0.15 },
    { name: "searchProviderId", weight: 0.1 },
    { name: "searchOpenCodeProviderLabel", weight: 0.03 },
    { name: "searchOpenCodeProviderId", weight: 0.02 },
  ],
};

export function buildHarnessModelRows(
  harness: HarnessOption,
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<HarnessModelRow> {
  // When the host declares per-model groups (OpenCode by provider, OpenRouter by
  // vendor), order by group so contiguous runs line up with the group headers
  // the picker renders. Reorder only when EVERY model is annotated: a partially
  // annotated list (a transitional/skewed host that tags only some models) keeps
  // host order rather than floating the unannotated models to the top. Ungrouped
  // harnesses keep host order too - the first model is preferred and stays first.
  const isGrouped =
    models.length > 0 &&
    models.every(
      (model) =>
        modelMetadataString(model.metadata.openCodeProviderId).length > 0,
    );
  const orderedModels = isGrouped ? sortByProviderGroup(models) : models;
  return orderedModels.map((model) => modelRow(harness, model));
}

export function buildAllHarnessModelRows(
  sources: ReadonlyArray<HarnessModelSource>,
): ReadonlyArray<HarnessModelRow> {
  return sources.flatMap((source) =>
    buildHarnessModelRows(source.harness, source.models),
  );
}

export function createModelRowSearchIndex(
  rows: ReadonlyArray<HarnessModelRow>,
): Fuse<HarnessModelRow> {
  return new Fuse(rows, MODEL_ROW_FUSE_OPTIONS);
}

export function filterModelRows(
  rows: ReadonlyArray<HarnessModelRow>,
  searchIndex: Fuse<HarnessModelRow>,
  query: string,
): ReadonlyArray<HarnessModelRow> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return rows;
  return searchIndex.search(trimmed).map((result) => result.item);
}

/**
 * Turns relevance-ranked rows into explicit provider sections. Section order is
 * ranked by each provider's best match, and rows inside a section keep their
 * Fuse order. This is a display policy for grouped providers, not a generic
 * search helper.
 */
export function sectionModelRowsByProviderRank(
  rows: ReadonlyArray<HarnessModelRow>,
): ReadonlyArray<HarnessModelRowSection> {
  const order: string[] = [];
  const groups = new Map<string, HarnessModelRow[]>();
  for (const row of rows) {
    const key = row.providerGroupId ?? row.id;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [row]);
      order.push(key);
    } else {
      existing.push(row);
    }
  }
  return order.flatMap((key) => {
    const sectionRows = groups.get(key);
    const firstRow = sectionRows?.at(0);
    if (sectionRows === undefined || firstRow === undefined) return [];
    return [
      {
        providerGroupId: firstRow.providerGroupId,
        providerGroupLabel: firstRow.providerGroupLabel,
        rows: sectionRows,
      },
    ];
  });
}

export function flattenModelRowSections(
  sections: ReadonlyArray<HarnessModelRowSection>,
): ReadonlyArray<HarnessModelRow> {
  return sections.flatMap((section) => section.rows);
}

export function selectedModelRowId(
  selection: HarnessModelSelection,
  rows: ReadonlyArray<HarnessModelRow>,
): string {
  const providerRows = rows.filter(
    (row) => row.harnessId === selection.harnessId,
  );
  // Empty slug is the transient "unresolved / catalog loading" marker - point
  // the highlight at the first (preferred) model for this provider.
  if (selection.modelSlug.length === 0) return providerRows.at(0)?.id ?? "";
  return (
    providerRows.find((row) => row.model.slug === selection.modelSlug)?.id ?? ""
  );
}

function modelRow(harness: HarnessOption, model: ModelOption): HarnessModelRow {
  const openCodeProviderLabel = modelMetadataString(
    model.metadata.openCodeProviderLabel,
  );
  const openCodeProviderId = modelMetadataString(
    model.metadata.openCodeProviderId,
  );
  // Group by the stable group id whenever the host declares one in the model
  // list (OpenCode by upstream provider, OpenRouter by vendor prefix) - the
  // renderer is harness-agnostic. Fall back to the id as header text when the
  // label is missing so such models still group rather than scattering.
  const providerGroupId =
    openCodeProviderId.length > 0 ? openCodeProviderId : null;
  const providerGroupLabel = openCodeGroupLabel(
    providerGroupId,
    openCodeProviderLabel,
  );
  const browseLabel =
    providerGroupLabel === null ? model.label : modelDisplayLabel(model);
  return {
    id: rowId(harness.id, model.slug),
    value: model.slug,
    harnessId: harness.id,
    harnessLabel: harness.label,
    label: model.label,
    browseLabel,
    providerGroupId,
    providerGroupLabel,
    capacityLabel: modelCapacityLabel(model),
    deprecationNotice: model.deprecationNotice ?? null,
    model,
    searchLabel: model.label,
    searchSlug: model.slug,
    searchProviderLabel: harness.label,
    searchProviderId: harness.id,
    searchOpenCodeProviderLabel: openCodeProviderLabel,
    searchOpenCodeProviderId: openCodeProviderId,
  };
}

function rowId(harnessId: ProviderId, value: string): string {
  return `${harnessId}:${value}`;
}

/**
 * Orders grouped models by group label, then group id, then model name - so the
 * picker's contiguous runs align with the (id-keyed) group headers. Sorting by
 * id within an equal label keeps two same-named groups as distinct adjacent
 * sections instead of interleaving them.
 */
function sortByProviderGroup(
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<ModelOption> {
  return models.toSorted((left, right) => {
    const leftLabel = modelMetadataString(left.metadata.openCodeProviderLabel);
    const rightLabel = modelMetadataString(
      right.metadata.openCodeProviderLabel,
    );
    if (leftLabel !== rightLabel) return leftLabel.localeCompare(rightLabel);
    const leftId = modelMetadataString(left.metadata.openCodeProviderId);
    const rightId = modelMetadataString(right.metadata.openCodeProviderId);
    if (leftId !== rightId) return leftId.localeCompare(rightId);
    return left.label.localeCompare(right.label);
  });
}

function openCodeGroupLabel(
  providerGroupId: string | null,
  providerLabel: string,
): string | null {
  if (providerGroupId === null) return null;
  return providerLabel.length > 0 ? providerLabel : providerGroupId;
}

function modelCapacityLabel(model: ModelOption): string | null {
  const context = formatTokenCount(model.contextWindow, "ctx");
  const output = formatTokenCount(model.maxOutputTokens, "out");
  if (context === null && output === null) return null;
  if (context === null) return output;
  if (output === null) return context;
  return `${context} · ${output}`;
}

function formatTokenCount(value: number | null, suffix: string): string | null {
  if (value === null || value <= 0) return null;
  if (value >= 1_000_000) {
    return `${trimDecimal(value / 1_000_000)}m ${suffix}`;
  }
  if (value >= 1_000) {
    return `${trimDecimal(value / 1_000)}k ${suffix}`;
  }
  const compact = String(value);
  return `${compact} ${suffix}`;
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
