import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useAppliedProviderItemDetailsSubject } from "@/components/settings/details/use-provider-row-details-subject";

/** Native-only rows have no configuration history address. */
export function AppliedProviderItemDetails(props: {
  readonly kind: "managed_profile" | "env_override";
  readonly itemKey: string;
  readonly title: string;
}): ReactNode {
  const subject = useAppliedProviderItemDetailsSubject(
    props.kind,
    props.itemKey,
  );
  return subject === null ? null : (
    <SettingsDetailsButton
      subject={subject}
      title={props.title}
      controls={null}
    />
  );
}
