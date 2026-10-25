import type { ReactNode } from "react";
import { useHostClient } from "@/lib/host";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";

export function ProviderRowDetails(props: {
  readonly kind: string;
  readonly itemKey: string;
  readonly title: string;
}): ReactNode {
  const client = useHostClient();
  const environmentId = useDetailsEnvironmentId(client);
  if (environmentId === null) return null;
  return (
    <SettingsDetailsButton
      subject={{ environmentId, kind: props.kind, key: props.itemKey }}
      title={props.title}
      controls={null}
    />
  );
}
