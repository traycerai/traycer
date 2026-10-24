import type { ReactNode } from "react";
import { usePersonalHostState } from "@/components/settings/personal/personal-page-context";
import { ProviderRowDetails } from "@/components/settings/details/provider-row-details";

/** Native-only rows have no configuration history address. */
export function AppliedProviderItemDetails(props: {
  readonly kind: "managed_profile" | "env_override";
  readonly itemKey: string;
  readonly title: string;
}): ReactNode {
  const state = usePersonalHostState();
  const recorded =
    state?.kind === "ready" &&
    state.status.items.some(
      (item) => item.kind === props.kind && item.key === props.itemKey,
    );
  return recorded ? (
    <ProviderRowDetails
      kind={props.kind}
      itemKey={props.itemKey}
      title={props.title}
    />
  ) : null;
}
