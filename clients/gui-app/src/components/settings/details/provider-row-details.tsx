import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useProviderRowDetailsSubject } from "./use-provider-row-details-subject";

export function ProviderRowDetails(props: {
  readonly kind: string;
  readonly itemKey: string;
  readonly title: string;
}): ReactNode {
  const subject = useProviderRowDetailsSubject(props.kind, props.itemKey);
  if (subject === null) return null;
  return (
    <SettingsDetailsButton
      subject={subject}
      title={props.title}
      controls={null}
    />
  );
}
