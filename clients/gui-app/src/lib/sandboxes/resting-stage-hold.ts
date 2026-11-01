import type { SandboxAgentGate } from "@/hooks/sandboxes/use-sandbox-agent-gate";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import { stagedSandboxCheckingNotice } from "@/lib/sandboxes/sandbox-agent-refusal";
import { CHECKING_SANDBOX_AGENTS } from "@/lib/sandboxes/sandbox-strings";

/**
 * Send on a resting sandbox with no stage yet. A surface shows this line and
 * disables Send until the stage lands: only a stage reaches that sandbox, so a
 * direct send would leave a task on a host that won't answer.
 */
export const RESTING_STAGE_HOLD: SandboxAgentGate = {
  blocked: true,
  hint: CHECKING_SANDBOX_AGENTS,
  notice: {
    kind: "mirror",
    message: CHECKING_SANDBOX_AGENTS,
    pending: true,
    action: null,
  },
};

/** What holds Send without a press: a stage's check, or the wait for a stage. */
export function sendHoldNotice(
  stage: StagedSandbox | null,
  check: (stage: StagedSandbox) => ComposerHostNoticeState | null,
  hostGate: SandboxAgentGate,
): ComposerHostNoticeState | null {
  return stage === null && hostGate === RESTING_STAGE_HOLD
    ? hostGate.notice
    : stagedSandboxCheckingNotice(stage, check);
}
