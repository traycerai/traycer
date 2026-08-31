import { ArrowRight } from "lucide-react";
import { AgentSelectionGuideEditorSurface } from "@/components/agent-selection-guide-editor-surface";
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
}) {
  const { agentGuide } = props;
  const isAtDefault = agentGuide.value === agentGuide.generatedDefaultContent;
  return (
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
      className="size-full overflow-hidden rounded-lg border border-border bg-card p-4 shadow-2xl"
      revertDisabled={agentGuide.loading || agentGuide.saving || isAtDefault}
      onRevert={agentGuide.onRevertToDefault}
      revertTestId={undefined}
      status={<OnboardingAgentGuideStatus agentGuide={agentGuide} />}
    />
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
