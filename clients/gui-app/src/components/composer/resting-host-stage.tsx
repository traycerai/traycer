import type { ReactNode } from "react";
import {
  useRestingHostStage,
  type RestingHostStageInput,
} from "@/components/composer/use-sandbox-staging";
import { useSandboxHostNotAnswering } from "@/hooks/sandboxes/use-resting-sandbox-host";

interface RestingHostStageProps extends RestingHostStageInput {
  /**
   * The surface has a sandbox of its own to stage, which is where its Send
   * goes: a draft's returned one, or a chip's pick. A child effect runs before
   * its parent's, so this stage would otherwise land first and keep that one
   * from going on.
   */
  readonly surfaceHoldsSandbox: boolean;
}

/**
 * `useRestingHostStage` while the host is a sandbox that isn't answering and
 * the surface has no sandbox of its own; nothing is read otherwise.
 */
export function RestingHostStage(props: RestingHostStageProps): ReactNode {
  const { surfaceHoldsSandbox, ...stage } = props;
  const notAnswering = useSandboxHostNotAnswering(stage.hostId);
  if (!notAnswering || surfaceHoldsSandbox) return null;
  return <RestingHostStageEffect {...stage} />;
}

function RestingHostStageEffect(props: RestingHostStageInput): ReactNode {
  useRestingHostStage(props);
  return null;
}
