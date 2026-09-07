import { ArrowRight } from "lucide-react";
import { AgentSelectionGuideEditorSurface } from "@/components/agent-selection-guide-editor-surface";
import { OnboardingHostUnavailableNotice } from "@/components/onboarding/onboarding-host-picker";
import {
  onboardingHostIsUsable,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * The tour's live agent-selection-guide editor and the draft state the page
 * owns for it. One definition, two homes: the desktop diorama floats it as a
 * modal inside the miniature, and the mobile tour puts it straight in the copy
 * rail, where a phone keyboard can reach it.
 */
export interface OnboardingAgentGuideState {
  readonly value: string;
  readonly generatedDefaultContent: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: boolean;
  readonly onValueChange: (value: string) => void;
  readonly onRevertToDefault: () => void;
}

export function OnboardingAgentGuidePane(props: {
  readonly agentGuide: OnboardingAgentGuideState;
  readonly hostPicker: OnboardingHostPicker;
}) {
  const { agentGuide, hostPicker } = props;
  const isAtDefault = agentGuide.value === agentGuide.generatedDefaultContent;
  return (
    // No host bar of its own: on desktop the picker is the title of the
    // mini-app window this card floats in (`DioramaScene`), and on the phone
    // rail `ActCopy` heads the editor with it. Drawing it here too put the
    // host's name twice on one screen.
    <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
      {onboardingHostIsUsable(hostPicker) ? (
        <AgentSelectionGuideEditorSurface
          titleId="onboarding-agent-selection-guide-heading"
          value={agentGuide.loading ? "" : agentGuide.value}
          onValueChange={agentGuide.onValueChange}
          onBlur={null}
          disabled={agentGuide.loading || agentGuide.saving}
          placeholder={agentGuide.loading ? "Loading…" : undefined}
          ariaLabel="Onboarding agent selection instructions"
          testId="onboarding-agent-guide-input"
          editorClassName="flex-1"
          className="min-h-0 flex-1 overflow-hidden p-4"
          revertDisabled={
            agentGuide.loading || agentGuide.saving || isAtDefault
          }
          onRevert={agentGuide.onRevertToDefault}
          revertTestId={undefined}
          status={<OnboardingAgentGuideStatus agentGuide={agentGuide} />}
        />
      ) : (
        <OnboardingHostUnavailableNotice picker={hostPicker} refusal={null} />
      )}
    </div>
  );
}

function OnboardingAgentGuideStatus(props: {
  readonly agentGuide: OnboardingAgentGuideState;
}) {
  if (props.agentGuide.error) {
    return <span className="text-code-xs text-destructive">Not saved</span>;
  }
  if (props.agentGuide.saving) {
    return (
      <span className="flex items-center gap-1 text-code-xs text-muted-foreground">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
        Saving
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-code-xs text-muted-foreground">
      <ArrowRight className="size-3" />
      Will save when you continue
    </span>
  );
}
