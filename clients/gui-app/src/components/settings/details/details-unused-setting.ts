import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";

/** History can name an unused setting with either its key or its display label. */
export function unusedSettingLabel(item: string | null): string {
  const harnessId = item?.split(":")[0];
  const provider = ORDERED_PROVIDERS.find(
    (entry) =>
      entry.harnessId === harnessId ||
      item === `${providerDisplayName(entry.providerId)} key`,
  );
  const label =
    provider === undefined ? "Agent" : providerDisplayName(provider.providerId);
  return `${label} key`;
}
