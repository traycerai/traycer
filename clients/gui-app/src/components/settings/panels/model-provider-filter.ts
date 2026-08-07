/**
 * The sign-in-method filter behind the Model Providers search box.
 *
 * Modelled on `provider-rail-filter.ts` - the rule lives here rather than in
 * the tab so it is testable without rendering the pane, and so the rows, the
 * empty state and the result-count announcement all derive from ONE definition
 * of "matches".
 *
 * This exists because the catalog is ~180 rows and only about ten of them
 * advertise an OAuth method. Per-row badges were the other option and would
 * have lit "API key" on ~170 rows to say nothing - the same failure the removed
 * per-tab content dots had. A filter puts the rare, interesting answer one
 * click away and leaves the common case unmarked.
 */
import type { ModelProviderEntry } from "@traycer/protocol/host/provider-native-schemas";

export const MODEL_PROVIDER_METHOD_FILTER = {
  All: "all",
  Oauth: "oauth",
  ApiKey: "apiKey",
} as const;

export type ModelProviderMethodFilter =
  (typeof MODEL_PROVIDER_METHOD_FILTER)[keyof typeof MODEL_PROVIDER_METHOD_FILTER];

export const MODEL_PROVIDER_METHOD_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: ModelProviderMethodFilter;
  readonly label: string;
}> = [
  { value: MODEL_PROVIDER_METHOD_FILTER.All, label: "All" },
  { value: MODEL_PROVIDER_METHOD_FILTER.Oauth, label: "Browser sign-in" },
  { value: MODEL_PROVIDER_METHOD_FILTER.ApiKey, label: "API key" },
];

/**
 * The empty-state line for a filter that matched nothing.
 *
 * A separate phrase per option rather than the label interpolated into one
 * sentence: "offer Browser sign-in sign-in" is what that shortcut produces, and
 * lowercasing "API key" to fit a template is no better.
 */
export function modelProviderMethodFilterEmptyDescription(
  filter: ModelProviderMethodFilter,
): string {
  switch (filter) {
    case MODEL_PROVIDER_METHOD_FILTER.Oauth:
      return "No providers on this host advertise a browser sign-in.";
    case MODEL_PROVIDER_METHOD_FILTER.ApiKey:
      return "No providers on this host take an API key.";
    case MODEL_PROVIDER_METHOD_FILTER.All:
      return "No providers on this host.";
  }
}

export function modelProviderMethodFilterLabel(
  filter: ModelProviderMethodFilter,
): string {
  const match = MODEL_PROVIDER_METHOD_FILTER_OPTIONS.find(
    (option) => option.value === filter,
  );
  return match === undefined ? "All" : match.label;
}

/** A provider that advertises a browser sign-in. */
export function supportsOauthSignIn(entry: ModelProviderEntry): boolean {
  return entry.methods.some((method) => method.type === "oauth");
}

/**
 * A provider with a usable key path: either its models.dev env var (the plain
 * path) or an advertised `api` method that collects extra fields alongside it.
 *
 * A provider can satisfy BOTH this and {@link supportsOauthSignIn} - the two
 * filters are not a partition, and a row offering both should appear under
 * either. The handful with neither (multi-secret or service-account-file
 * credentials) match no filter and remain reachable under All, which is honest:
 * neither path is offered for them here.
 */
export function supportsApiKeySignIn(entry: ModelProviderEntry): boolean {
  if (entry.credentialKey === null) return false;
  return true;
}

/**
 * Filters by what the PROVIDER advertises, not by what this host can run. A
 * method the host cannot execute is still shown in the connect dialog with a
 * reason, so hiding its row from the filter would contradict the surface that
 * explains it.
 */
export function matchesModelProviderMethodFilter(
  entry: ModelProviderEntry,
  filter: ModelProviderMethodFilter,
): boolean {
  switch (filter) {
    case MODEL_PROVIDER_METHOD_FILTER.All:
      return true;
    case MODEL_PROVIDER_METHOD_FILTER.Oauth:
      return supportsOauthSignIn(entry);
    case MODEL_PROVIDER_METHOD_FILTER.ApiKey:
      return supportsApiKeySignIn(entry);
  }
}

/**
 * Returns the input array UNCHANGED (same identity) while the filter is `all`,
 * so the common case costs nothing and memoized consumers don't churn.
 */
export function filterModelProvidersByMethod(
  entries: readonly ModelProviderEntry[],
  filter: ModelProviderMethodFilter,
): readonly ModelProviderEntry[] {
  if (filter === MODEL_PROVIDER_METHOD_FILTER.All) return entries;
  return entries.filter((entry) =>
    matchesModelProviderMethodFilter(entry, filter),
  );
}
