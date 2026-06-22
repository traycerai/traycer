import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import type {
  WorktreeBranchPickerAction,
  WorktreeBranchPickerPinnedRow,
  WorktreeBranchPickerRow,
} from "@/components/home/worktree/worktree-branch-picker-model";

interface PickerOptionButtonProps {
  readonly id: string;
  readonly option: WorktreeBranchPickerRow | WorktreeBranchPickerPinnedRow;
  readonly active: boolean;
  /** `-1` keeps the option out of the Tab order (listbox is arrow-navigated). */
  readonly tabIndex: number;
  readonly onActive: () => void;
  readonly onSelect: () => void;
}

export function PickerOptionButton(props: PickerOptionButtonProps) {
  const { option, active, onActive, onSelect } = props;
  const disabledTooltip =
    option.disabled && option.disabledReason !== null
      ? option.disabledReason
      : null;
  const button = (
    <button
      id={props.id}
      type="button"
      role="option"
      tabIndex={props.tabIndex}
      aria-selected={option.selected}
      data-active={active}
      data-selected={option.selected}
      data-testid={option.testId ?? undefined}
      disabled={option.disabled}
      className={cn(
        "group flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/60 data-[active=true]:bg-accent/70 data-[selected=true]:bg-accent/55 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        option.disabled ? "text-muted-foreground" : "text-foreground",
      )}
      onMouseEnter={onActive}
      onFocus={onActive}
      onClick={() => {
        if (option.disabled) return;
        onSelect();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* Full branch name on hover — the label truncates in the fixed-width
              row, so a Radix tooltip (not a native `title`, which the picker
              test forbids) surfaces the complete name. */}
          <TooltipWrapper
            label={option.primaryLabel}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <span className="min-w-0 truncate font-medium leading-5">
              {option.primaryLabel}
            </span>
          </TooltipWrapper>
          <PickerBadges badges={option.badges} />
        </span>
        {option.secondaryLabel === null ? null : (
          <TooltipWrapper
            label={
              <span className="block max-w-[min(80vw,28rem)] break-all text-left">
                {option.secondaryTitle ?? option.secondaryLabel}
              </span>
            }
            side="right"
            sideOffset={undefined}
            align={undefined}
          >
            <StartTruncatedText className="block text-ui-xs leading-5 text-muted-foreground">
              {option.secondaryLabel}
            </StartTruncatedText>
          </TooltipWrapper>
        )}
      </span>
      {option.selected ? (
        <Check className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : (
        <span className="mt-0.5 size-4 shrink-0" />
      )}
    </button>
  );
  return (
    <TooltipWrapper
      label={disabledTooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="block w-full">{button}</span>
    </TooltipWrapper>
  );
}

interface PickerBadgesProps {
  readonly badges: ReadonlyArray<string>;
}

function PickerBadges(props: PickerBadgesProps) {
  if (props.badges.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {props.badges.map((badge) => (
        <Badge
          key={badge}
          variant="secondary"
          className="h-4 rounded-sm px-1 text-[0.625rem] font-medium"
        >
          {badge}
        </Badge>
      ))}
    </span>
  );
}

interface PickerActionButtonProps {
  readonly id: string;
  readonly action: WorktreeBranchPickerAction;
  readonly active: boolean;
  readonly onActive: () => void;
  readonly onSelect: () => void;
}

export function PickerActionButton(props: PickerActionButtonProps) {
  const { action, active, onActive, onSelect } = props;
  const disabledTooltip =
    action.disabled && action.disabledReason !== null
      ? action.disabledReason
      : null;
  const button = (
    <button
      id={props.id}
      type="button"
      data-active={active}
      data-selected={action.selected}
      data-testid={action.testId ?? undefined}
      disabled={action.disabled}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[active=true]:bg-accent/70 data-[active=true]:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      onMouseEnter={onActive}
      onFocus={onActive}
      onClick={() => {
        if (action.disabled) return;
        onSelect();
      }}
    >
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.selected ? (
        <Check className="size-4 shrink-0 text-primary" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
    </button>
  );
  return (
    <TooltipWrapper
      label={disabledTooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="block w-full">{button}</span>
    </TooltipWrapper>
  );
}

interface PickerStateRowProps {
  readonly label: string;
}

export function PickerStateRow(props: PickerStateRowProps) {
  return (
    <div className="rounded-lg p-2 text-ui-sm text-muted-foreground">
      {props.label}
    </div>
  );
}
