import type { ReactNode } from "react";
import {
  useRestingHostStage,
  type RestingHostStageInput,
} from "@/components/composer/use-sandbox-staging";
import { useRestingSandboxHost } from "@/hooks/sandboxes/use-resting-sandbox-host";

interface RestingHostStageProps extends RestingHostStageInput {
  /**
   * The draft holds a returned sandbox, which is where its Send goes. A child
   * effect runs before its parent's, so this stage would otherwise land first
   * and keep the draft's own from restoring.
   */
  readonly draftHoldsSandbox: boolean;
}

/**
 * `useRestingHostStage` while the host rests and the draft has no sandbox of
 * its own; nothing is read otherwise.
 */
export function RestingHostStage(props: RestingHostStageProps): ReactNode {
  const { draftHoldsSandbox, ...stage } = props;
  const resting = useRestingSandboxHost(stage.hostId);
  if (resting === null || draftHoldsSandbox) return null;
  return <RestingHostStageEffect {...stage} />;
}

function RestingHostStageEffect(props: RestingHostStageInput): ReactNode {
  useRestingHostStage(props);
  return null;
}
