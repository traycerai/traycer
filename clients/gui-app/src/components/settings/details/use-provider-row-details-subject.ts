import { usePersonalHostState } from "@/components/settings/personal/personal-page-context";
import type { DetailsSubject } from "@/lib/settings-details-entry";
import { useDetailsEnvironmentId } from "./use-details-environment-id";

export function useProviderRowDetailsSubject(
  kind: string,
  itemKey: string,
): DetailsSubject | null {
  const environmentId = useDetailsEnvironmentId();
  return environmentId === null ? null : { environmentId, kind, key: itemKey };
}

/** Native-only rows have no configuration history address. */
export function useAppliedProviderItemDetailsSubject(
  kind: "managed_profile" | "env_override",
  itemKey: string,
): DetailsSubject | null {
  const state = usePersonalHostState();
  const subject = useProviderRowDetailsSubject(kind, itemKey);
  const recorded =
    state?.kind === "ready" &&
    state.status.items.some(
      (item) => item.kind === kind && item.key === itemKey,
    );
  return recorded ? subject : null;
}
