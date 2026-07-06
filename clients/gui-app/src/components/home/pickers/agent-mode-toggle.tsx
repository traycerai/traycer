import {
  findAgentModeOption,
  AGENT_MODE_OPTIONS,
  isAgentMode,
  nextAgentMode,
  type AgentMode,
} from "@/components/home/data/landing-options";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

const AGENT_MODE_READONLY_LABEL_CLASSNAME =
  "inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground opacity-70";
const AGENT_MODE_ICON_TRIGGER_CLASSNAME =
  "inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

interface AgentModeToggleProps {
  readonly value: AgentMode;
  readonly disabled: boolean;
  readonly showTooltip: boolean;
  readonly onChange: (next: AgentMode) => void;
}

interface AgentModeReadonlyLabelProps {
  readonly value: AgentMode;
}

interface AgentModeRadioItemsProps {
  readonly value: AgentMode;
  readonly onChange: (next: AgentMode) => void;
  readonly getTestId: ((mode: AgentMode) => string) | null;
  readonly keepOpenOnSelect: boolean;
}

export function AgentModeReadonlyLabel(props: AgentModeReadonlyLabelProps) {
  const current = findAgentModeOption(props.value);

  return (
    // `aria-label` on a non-interactive span is ignored by assistive tech, so
    // the active-state cue rides as visually-hidden text alongside the label.
    <span className={AGENT_MODE_READONLY_LABEL_CLASSNAME}>
      <span className="truncate">{current.label}</span>
      <span className="sr-only"> is active</span>
    </span>
  );
}

export function AgentModeRadioItems(props: AgentModeRadioItemsProps) {
  return (
    <DropdownMenuRadioGroup
      value={props.value}
      onValueChange={(next) => {
        if (isAgentMode(next)) props.onChange(next);
      }}
    >
      {AGENT_MODE_OPTIONS.map((option) => (
        <DropdownMenuRadioItemWithIcon
          key={option.id}
          option={option}
          testId={
            props.getTestId === null ? undefined : props.getTestId(option.id)
          }
          keepOpenOnSelect={props.keepOpenOnSelect}
        />
      ))}
    </DropdownMenuRadioGroup>
  );
}

function DropdownMenuRadioItemWithIcon(props: {
  readonly option: (typeof AGENT_MODE_OPTIONS)[number];
  readonly testId: string | undefined;
  readonly keepOpenOnSelect: boolean;
}) {
  const Icon = props.option.icon;

  return (
    <DropdownMenuRadioItem
      value={props.option.id}
      data-testid={props.testId}
      className="items-start gap-2 py-2 pl-2 pr-8 data-[state=checked]:bg-accent/70"
      onSelect={
        props.keepOpenOnSelect
          ? (event) => {
              event.preventDefault();
            }
          : undefined
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col items-start gap-1">
        <span className="text-ui-sm font-medium">{props.option.label}</span>
        <span className="text-ui-xs text-muted-foreground">
          {props.option.description}
        </span>
      </span>
    </DropdownMenuRadioItem>
  );
}

export function AgentModeToggle(props: AgentModeToggleProps) {
  const current = findAgentModeOption(props.value);
  const next = findAgentModeOption(nextAgentMode(props.value));
  const Icon = current.icon;
  const tooltipLabel = props.showTooltip
    ? agentModeToggleTooltipLabel(props.value)
    : null;

  return (
    <TooltipWrapper
      label={tooltipLabel}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        // The accessible name describes the action (the mode this switches TO),
        // matching the sibling service-tier toggle; the visible short label shows
        // the CURRENT mode, so the two differ by design.
        aria-label={`Switch to ${next.label}`}
        className={AGENT_MODE_ICON_TRIGGER_CLASSNAME}
        disabled={props.disabled}
        // Keep the caret in the composer editor: without this the button would
        // take focus on press and blur the textbox, leaving the user unable to
        // type after toggling the mode. preventDefault on mousedown blocks the
        // focus shift while the click handler still fires.
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => props.onChange(next.id)}
      >
        <Icon className="size-4 shrink-0" />
        <span className="whitespace-nowrap">{current.shortLabel}</span>
      </button>
    </TooltipWrapper>
  );
}

function agentModeToggleTooltipLabel(mode: AgentMode): string {
  if (mode === "regular") {
    return "Regular mode: general-purpose coding agent experience.";
  }
  return "Epic mode: plan and coordinate larger changes with Traycer artifacts.";
}
