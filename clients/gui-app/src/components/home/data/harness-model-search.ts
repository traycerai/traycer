import Fuse, { type IFuseOptions } from "fuse.js";
import {
  readableModelMatch,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";
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
   * provider/vendor for grouped harnesses (OpenCode, OpenRouter, Hugging Face).
   * Section
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

/** One subprovider (OpenCode/OpenRouter group) for the model-picker cascade. */
export interface HarnessSubproviderEntry {
  readonly providerGroupId: string;
  readonly providerGroupLabel: string;
  readonly modelCount: number;
  readonly capacityLabel: string | null;
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

/** Common vendor ids → display labels for slug-derived groups. */
const VENDOR_GROUP_LABELS: ReadonlyMap<string, string> = new Map([
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["google", "Google"],
  ["x-ai", "xAI"],
  ["meta", "Meta"],
  ["meta-llama", "Meta"],
  ["mistral", "Mistral"],
  ["mistralai", "Mistral"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["moonshot", "Moonshot"],
  ["moonshotai", "Moonshot AI"],
  ["minimax", "MiniMax"],
  ["cline-pass", "ClinePass"],
]);

/**
 * Hosts that never declare group metadata can still embed the vendor in the
 * model slug (OpenRouter ids are `<vendor>/<model>`). Derive the group from
 * the first slug segment. A leading "/" (absolute-path custom-endpoint slugs)
 * or a missing second segment means no group.
 */
function deriveSlugGroup(slug: string): string | null {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return null;
  return slug.slice(0, slash).toLowerCase();
}

function derivedGroupLabel(groupId: string): string {
  const known = VENDOR_GROUP_LABELS.get(groupId);
  if (known !== undefined) return known;
  return groupId.charAt(0).toUpperCase() + groupId.slice(1);
}

interface ModelGroupIdentity {
  readonly id: string;
  readonly label: string;
}

/** Group identity from host metadata, falling back to the slug vendor. */
function modelGroupIdentity(model: ModelOption): ModelGroupIdentity | null {
  const metadataId = modelMetadataString(model.metadata.openCodeProviderId);
  if (metadataId.length > 0) {
    const metadataLabel = modelMetadataString(
      model.metadata.openCodeProviderLabel,
    );
    return {
      id: metadataId,
      label: metadataLabel.length > 0 ? metadataLabel : metadataId,
    };
  }
  const derived = deriveSlugGroup(model.slug);
  return derived === null
    ? null
    : { id: derived, label: derivedGroupLabel(derived) };
}

/**
 * Display label for a slug-derived group row: drop the harness prefix
 * ("OpenRouter · ") and vendor prefix ("anthropic/") the label may carry
 * ("OpenRouter · anthropic/claude Fable 5" → "Claude Fable 5"). Falls back to
 * the untouched label when stripping would leave nothing.
 */
function stripDerivedGroupPrefixes(
  label: string,
  harnessLabel: string,
  groupId: string,
): string {
  let out = label;
  const harnessPrefix = `${harnessLabel} · `;
  if (out.toLowerCase().startsWith(harnessPrefix.toLowerCase())) {
    out = out.slice(harnessPrefix.length);
  }
  const vendorPrefix = `${groupId}/`;
  if (out.toLowerCase().startsWith(vendorPrefix.toLowerCase())) {
    out = out.slice(vendorPrefix.length);
  }
  // Vendor-prefixed names often keep a lowercase family from the slug
  // ("anthropic/claude Fable 5" → "claude Fable 5") — restore sentence case.
  if (out.length > 0 && out[0] === out[0].toLowerCase()) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out.length > 0 ? out : label;
}

export function buildHarnessModelRows(
  harness: HarnessOption,
  models: ReadonlyArray<ModelOption>,
): ReadonlyArray<HarnessModelRow> {
  // When the host declares per-model groups (OpenCode by provider, OpenRouter by
  // vendor, Hugging Face by org), order by group so contiguous runs line up
  // with the group headers
  // the picker renders. Reorder only when EVERY model is annotated: a partially
  // annotated list (a transitional/skewed host that tags only some models) keeps
  // host order rather than floating the unannotated models to the top. Ungrouped
  // harnesses keep host order too - the first model is preferred and stays first.
  // Group identity comes from host metadata, falling back to the slug vendor
  // (OpenRouter-style `<vendor>/<model>` ids carry no metadata).
  const isGrouped =
    models.length > 0 &&
    models.every((model) => modelGroupIdentity(model) !== null);
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

/**
 * Derives cascade level-1 entries from provider rows. Order is first-seen group
 * order (the builder already rank-orders grouped catalogs). Rows without a
 * `providerGroupId` are ignored. Each entry's `capacityLabel` is the first
 * non-null capacity among its models.
 */
export function buildSubproviderEntries(
  rows: ReadonlyArray<HarnessModelRow>,
): ReadonlyArray<HarnessSubproviderEntry> {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      providerGroupLabel: string;
      modelCount: number;
      capacityLabel: string | null;
    }
  >();
  for (const row of rows) {
    if (row.providerGroupId === null) continue;
    const existing = groups.get(row.providerGroupId);
    if (existing === undefined) {
      groups.set(row.providerGroupId, {
        providerGroupLabel: row.providerGroupLabel ?? row.providerGroupId,
        modelCount: 1,
        capacityLabel: row.capacityLabel,
      });
      order.push(row.providerGroupId);
    } else {
      existing.modelCount += 1;
      if (existing.capacityLabel === null && row.capacityLabel !== null) {
        existing.capacityLabel = row.capacityLabel;
      }
    }
  }
  return order.flatMap((providerGroupId) => {
    const entry = groups.get(providerGroupId);
    if (entry === undefined) return [];
    return [
      {
        providerGroupId,
        providerGroupLabel: entry.providerGroupLabel,
        modelCount: entry.modelCount,
        capacityLabel: entry.capacityLabel,
      },
    ];
  });
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
  // Read-only (which row is highlighted), so an ambiguous alias may resolve to
  // the first tied row. Resolving through the shared helper is what keeps a
  // canonical id persisted before the catalog decorated its row from showing
  // an empty highlight over a picker that clearly lists the model.
  const model = readableModelMatch(
    resolveModelBySlug(
      providerRows.map((row) => row.model),
      selection.modelSlug,
    ),
  );
  if (model === null) return "";
  return providerRows.find((row) => row.model === model)?.id ?? "";
}

function modelRow(harness: HarnessOption, model: ModelOption): HarnessModelRow {
  const openCodeProviderLabel = modelMetadataString(
    model.metadata.openCodeProviderLabel,
  );
  const openCodeProviderId = modelMetadataString(
    model.metadata.openCodeProviderId,
  );
  // Group by the stable group id whenever the host declares one in the model
  // list (OpenCode by upstream provider, OpenRouter by vendor prefix, Hugging
  // Face by `<org>` id prefix) - the
  // renderer is harness-agnostic. Fall back to the id as header text when the
  // label is missing so such models still group rather than scattering. Hosts
  // that declare nothing get one more chance via the slug vendor
  // (`anthropic/claude-fable-5` → group `anthropic`).
  const metadataGroupId =
    openCodeProviderId.length > 0 ? openCodeProviderId : null;
  const derivedGroupId =
    metadataGroupId === null ? deriveSlugGroup(model.slug) : null;
  const providerGroupId = metadataGroupId ?? derivedGroupId;
  const providerGroupLabel =
    derivedGroupId === null
      ? openCodeGroupLabel(metadataGroupId, openCodeProviderLabel)
      : derivedGroupLabel(derivedGroupId);
  let browseLabel = model.label;
  if (providerGroupId !== null) {
    browseLabel =
      derivedGroupId === null
        ? modelDisplayLabel(model)
        : stripDerivedGroupPrefixes(model.label, harness.label, derivedGroupId);
  }
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
    const leftGroup = modelGroupIdentity(left);
    const rightGroup = modelGroupIdentity(right);
    const leftLabel = leftGroup?.label ?? "";
    const rightLabel = rightGroup?.label ?? "";
    if (leftLabel !== rightLabel) return leftLabel.localeCompare(rightLabel);
    const leftId = leftGroup?.id ?? "";
    const rightId = rightGroup?.id ?? "";
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
