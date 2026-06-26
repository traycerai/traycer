import type { ReactNode } from "react";
import { RefreshCw, Undo2 } from "lucide-react";

type AgentSelectionGuideDefaultActionKind =
  | "checking"
  | "current-default"
  | "restore"
  | "update";

type AgentSelectionGuideDefaultActionMode =
  | "missing-guide-draft"
  | "saved-guide";

type AgentSelectionGuideDefaultActionState = {
  readonly kind: AgentSelectionGuideDefaultActionKind;
  readonly buttonLabel: string;
  readonly buttonIcon: ReactNode;
  readonly buttonTooltip: string | null;
  readonly confirmationTitle: string;
  readonly confirmationDescription: string;
  readonly confirmationActionLabel: string;
};

export function resolveAgentSelectionGuideDefaultAction(input: {
  readonly value: string;
  readonly generatedDefaultContent: string;
  readonly recognizedDefaultContents: readonly string[];
  readonly providersSettled: boolean;
  readonly mode: AgentSelectionGuideDefaultActionMode;
}): AgentSelectionGuideDefaultActionState {
  if (!input.providersSettled) {
    return {
      ...restoreActionCopy(),
      kind: "checking",
      buttonLabel: "Checking",
      buttonIcon: null,
      buttonTooltip: null,
    };
  }
  if (input.value === input.generatedDefaultContent) {
    return {
      ...restoreActionCopy(),
      kind: "current-default",
      buttonLabel: "Restore",
      buttonIcon: <Undo2 className="size-3.5" />,
      buttonTooltip: null,
    };
  }
  if (
    input.mode === "saved-guide" &&
    input.recognizedDefaultContents.includes(input.value)
  ) {
    return {
      ...updateActionCopy(),
      kind: "update",
      buttonLabel: "Update",
      buttonIcon: <RefreshCw className="size-3.5" />,
      buttonTooltip: "Update this guide to the current provider defaults.",
    };
  }
  return {
    ...restoreActionCopy(),
    kind: "restore",
    buttonLabel: "Restore",
    buttonIcon: <Undo2 className="size-3.5" />,
    buttonTooltip:
      "Replace custom global instructions with the current provider defaults.",
  };
}

function updateActionCopy(): Pick<
  AgentSelectionGuideDefaultActionState,
  "confirmationActionLabel" | "confirmationDescription" | "confirmationTitle"
> {
  return {
    confirmationTitle: "Update default instructions?",
    confirmationDescription:
      "This updates your global agent selection instructions to the current provider defaults for this device. Workspace-specific instructions are not affected.",
    confirmationActionLabel: "Update",
  };
}

function restoreActionCopy(): Pick<
  AgentSelectionGuideDefaultActionState,
  "confirmationActionLabel" | "confirmationDescription" | "confirmationTitle"
> {
  return {
    confirmationTitle: "Restore default instructions?",
    confirmationDescription:
      "This replaces your custom global instructions with the current provider defaults for this device. Custom edits in this guide will be lost. Workspace-specific instructions are not affected.",
    confirmationActionLabel: "Restore",
  };
}
