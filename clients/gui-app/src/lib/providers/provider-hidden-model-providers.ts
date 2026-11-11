import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const PROVIDERS_LIST_HIDDEN_MODEL_PROVIDERS_MAJOR = 10;
const PROVIDERS_LIST_HIDDEN_MODEL_PROVIDERS_MINOR = 10;

const NONE: ReadonlySet<string> = new Set();

/**
 * The `providers.list` line that PUBLISHES `hiddenModelProviders`: `10.10`.
 * The major is pinned rather than compared with `>`, like every other version
 * predicate in the tree. `null` - no handshake yet - reads as not reporting.
 */
export function providersListReportsHiddenModelProviders(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return (
    version.major === PROVIDERS_LIST_HIDDEN_MODEL_PROVIDERS_MAJOR &&
    version.minor >= PROVIDERS_LIST_HIDDEN_MODEL_PROVIDERS_MINOR
  );
}

/**
 * The model provider ids a harness's pickers leave out, read off that
 * harness's `providers.list` row. Empty when the row is missing or its host is
 * too old to carry the list, so an older host hides nothing.
 */
export function hiddenModelProvidersForHarness(
  states: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: GuiHarnessId,
): ReadonlySet<string> {
  const ids = states?.find(
    (state) => providerIdToGuiHarnessId(state.providerId) === harnessId,
  )?.hiddenModelProviders;
  return ids === undefined || ids.length === 0 ? NONE : new Set(ids);
}

/** The model's picker group id (OpenCode's provider id), or `null`. */
export function modelProviderGroupId(model: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): string | null {
  const id = model.metadata.openCodeProviderId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Whether the model's provider is one of the hidden ones. */
export function modelProviderHidden(
  model: { readonly metadata: Readonly<Record<string, unknown>> },
  hidden: ReadonlySet<string>,
): boolean {
  const groupId = modelProviderGroupId(model);
  return groupId !== null && hidden.has(groupId);
}

/**
 * The models whose provider is not hidden. When every model's provider is
 * hidden the list is returned whole, so a composer always has a model to
 * resolve against.
 */
export function withoutHiddenModelProviders<
  M extends { readonly metadata: Readonly<Record<string, unknown>> },
>(models: ReadonlyArray<M>, hidden: ReadonlySet<string>): ReadonlyArray<M> {
  if (hidden.size === 0) return models;
  const shown = models.filter((model) => !modelProviderHidden(model, hidden));
  return shown.length === 0 ? models : shown;
}

type ModelProviderGroupedRow = {
  readonly id: string;
  readonly providerGroupId: string | null;
};

/**
 * The picker rows left once hidden model providers are taken out, for the list
 * and for search alike. The selected row stays, so a chat already on a hidden
 * provider's model still shows what it runs on.
 */
export function withoutHiddenModelProviderRows<
  R extends ModelProviderGroupedRow,
>(
  rows: ReadonlyArray<R>,
  hidden: ReadonlySet<string>,
  selectedRowId: string,
): ReadonlyArray<R> {
  if (hidden.size === 0) return rows;
  return rows.filter(
    (row) =>
      row.providerGroupId === null ||
      !hidden.has(row.providerGroupId) ||
      row.id === selectedRowId,
  );
}

/** How many hidden model providers have models among `rows`. */
export function hiddenModelProviderCount(
  rows: ReadonlyArray<ModelProviderGroupedRow>,
  hidden: ReadonlySet<string>,
): number {
  if (hidden.size === 0) return 0;
  const present = new Set<string>();
  for (const row of rows) {
    if (row.providerGroupId !== null && hidden.has(row.providerGroupId)) {
      present.add(row.providerGroupId);
    }
  }
  return present.size;
}
