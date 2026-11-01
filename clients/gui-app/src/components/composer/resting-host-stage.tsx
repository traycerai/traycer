import type { ReactNode } from "react";
import {
  useRestingHostStage,
  type RestingHostStageInput,
} from "@/components/composer/use-sandbox-staging";
import { useRestingSandboxHost } from "@/hooks/sandboxes/use-resting-sandbox-host";

/**
 * `useRestingHostStage` while the host rests; nothing is read on any other
 * host.
 */
export function RestingHostStage(props: RestingHostStageInput): ReactNode {
  const resting = useRestingSandboxHost(props.hostId);
  return resting === null ? null : <RestingHostStageEffect {...props} />;
}

function RestingHostStageEffect(props: RestingHostStageInput): ReactNode {
  useRestingHostStage(props);
  return null;
}
