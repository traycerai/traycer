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
  CHOOSE_ANOTHER_HOST,
  OPEN_TERMINAL_INSTEAD,
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

export interface SandboxAgentRemedies {
  /** Opens a model picker on the agents sandboxes offer (`null`: unknown). */
  readonly onChooseModel?: (offeredAgents: ReadonlyArray<string> | null) => void;
  readonly onOpenTerminalInstead?: () => void;
  readonly onChooseAnotherHost?: () => void;
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
