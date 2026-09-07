/** Modelled on `provider-rail-filter.ts` - the rule lives here rather than in the tab so it is testable without
 * rendering the pane, and so the rows. */
import type { ModelProviderEntry } from "@traycer/protocol/host/provider-native-schemas";

export const MODEL_PROVIDER_METHOD_FILTER = {
  All: "all",
  Oauth: "oauth",
} as const;

export type ModelProviderMethodFilter =
  (typeof MODEL_PROVIDER_METHOD_FILTER)[keyof typeof MODEL_PROVIDER_METHOD_FILTER];

export const MODEL_PROVIDER_METHOD_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: ModelProviderMethodFilter;
  readonly label: string;
}> = [
  { value: MODEL_PROVIDER_METHOD_FILTER.All, label: "All" },
  { value: MODEL_PROVIDER_METHOD_FILTER.Oauth, label: "Browser sign-in" },
];

/** A separate phrase per option rather than the label interpolated into one sentence: "offer Browser sign-in
 * sign-in" is what that shortcut produces, and lowercasing "API key" to fit a template is no better. */
export function modelProviderMethodFilterEmptyDescription(
  filter: ModelProviderMethodFilter,
): string {
  switch (filter) {
    case MODEL_PROVIDER_METHOD_FILTER.Oauth:
      return "No providers on this host advertise a browser sign-in.";
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

export function supportsOauthSignIn(entry: ModelProviderEntry): boolean {
  return entry.methods.some((method) => method.type === "oauth");
}

/** A method the host cannot execute is still shown in the connect dialog with a reason, so hiding its row from
 * the filter would contradict the surface that explains it. */
export function matchesModelProviderMethodFilter(
  entry: ModelProviderEntry,
  filter: ModelProviderMethodFilter,
): boolean {
  switch (filter) {
    case MODEL_PROVIDER_METHOD_FILTER.All:
      return true;
    case MODEL_PROVIDER_METHOD_FILTER.Oauth:
      return supportsOauthSignIn(entry);
  }
}

/** Returns the input array unchanged (same identity) while the filter is `all`, so the common case costs
 * nothing and memoized consumers don't churn. */
export function filterModelProvidersByMethod(
  entries: readonly ModelProviderEntry[],
  filter: ModelProviderMethodFilter,
): readonly ModelProviderEntry[] {
  if (filter === MODEL_PROVIDER_METHOD_FILTER.All) return entries;
  return entries.filter((entry) =>
    matchesModelProviderMethodFilter(entry, filter),
  );
}
