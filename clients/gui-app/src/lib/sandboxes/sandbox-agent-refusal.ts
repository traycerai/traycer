import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ComposerHostNoticeAction,
  ComposerHostNoticeState,
} from "@/components/home/composer/composer-host-notice";
import { openActiveModelPickerForHarness } from "@/lib/commands/active-model-picker-registry";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import {
  agentNotOfferedOnSandboxesLine,
  CANCEL_THE_MESSAGE,
  CHOOSE_ANOTHER_HOST,
  COULDNT_CHECK_SANDBOX_AGENTS,
  DETAILS,
  OPEN_TERMINAL_INSTEAD,
  RETRY,
} from "@/lib/sandboxes/sandbox-strings";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

/** Only the catalogue's transient wait is shown before a person presses Send. */
export function stagedSandboxCheckingNotice(
  stage: StagedSandbox | null,
  check: (stage: StagedSandbox) => ComposerHostNoticeState | null,
): ComposerHostNoticeState | null {
  const notice = stage === null ? null : check(stage);
  return notice?.pending === true ? notice : null;
}

/**
 * The catalogue read ended with nothing to go on - failed, timed out or never
 * allowed - so which agents sandboxes run is unknown. That is never permission:
 * Send is held, nothing is created or woken, and Retry reads the catalogue
 * again. A catalogue that answered without naming its agents (an older server)
 * is an answer, not this.
 */
export function sandboxAgentsUncheckedNotice(
  onRetry: () => void,
): ComposerHostNoticeState {
  return {
    kind: "refused",
    message: COULDNT_CHECK_SANDBOX_AGENTS,
    action: { label: RETRY, onAction: onRetry },
  };
}

export interface SandboxAgentRemedies {
  /** Opens a model picker on the agents sandboxes offer (`null`: unknown). */
  readonly onChooseModel?: (
    offeredAgents: ReadonlyArray<string> | null,
  ) => void;
  readonly onOpenTerminalInstead?: () => void;
  readonly onChooseAnotherHost?: () => void;
  /** Withdraws the refused message: nothing is sent, kept or saved. */
  readonly onCancelMessage?: () => void;
  /** The sandbox's details, for a chat bound to one. */
  readonly onDetails?: () => void;
}

export function sandboxAgentSecondaryActions(
  remedies: SandboxAgentRemedies,
): readonly ComposerHostNoticeAction[] {
  const actions: ComposerHostNoticeAction[] = [];
  if (remedies.onOpenTerminalInstead !== undefined) {
    actions.push({
      label: OPEN_TERMINAL_INSTEAD,
      onAction: remedies.onOpenTerminalInstead,
    });
  }
  if (remedies.onChooseAnotherHost !== undefined) {
    actions.push({
      label: CHOOSE_ANOTHER_HOST,
      onAction: remedies.onChooseAnotherHost,
    });
  }
  if (remedies.onCancelMessage !== undefined) {
    actions.push({
      label: CANCEL_THE_MESSAGE,
      onAction: remedies.onCancelMessage,
    });
  }
  if (remedies.onDetails !== undefined) {
    actions.push({ label: DETAILS, onAction: remedies.onDetails });
  }
  return actions;
}

export function sandboxAgentDisplayName(harnessId: GuiHarnessId): string {
  const providerId = guiHarnessIdToProviderId(harnessId);
  return providerId === null ? harnessId : providerDisplayName(providerId);
}

/**
 * A rejected pick stays selected until the person chooses its replacement.
 * "Choose a model" opens on what sandboxes offer (`offeredAgents`, the cloud
 * catalogue's list), never on the rail of the host the picker reads.
 */
export function sandboxAgentNotOfferedNotice(
  harnessId: GuiHarnessId,
  offeredAgents: ReadonlyArray<string> | null,
  remedies: SandboxAgentRemedies,
): ComposerHostNoticeState {
  const chooseModel =
    remedies.onChooseModel ??
    ((offered: ReadonlyArray<string> | null) => {
      openActiveModelPickerForHarness("traycer", null, offered);
    });
  return {
    kind: "refused",
    message: agentNotOfferedOnSandboxesLine(sandboxAgentDisplayName(harnessId)),
    action: {
      label: "Choose a model",
      onAction: () => chooseModel(offeredAgents),
    },
    secondaryActions: sandboxAgentSecondaryActions(remedies),
  };
}
