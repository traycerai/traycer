import { Plus } from "lucide-react";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { TerminalAgentWorktreeCreateInput } from "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate";
import { AddNodeDropdown } from "@/components/epic-canvas/add-node-dropdown";
import { CHAT_PANEL_EXCLUDED_TYPES } from "@/components/epic-canvas/add-node-options";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import { cn } from "@/lib/utils";
import { rowAddControlRevealClass } from "./epic-sidebar-tree-shared";

function resolveAddChildDisabledTooltip(
  isDisconnected: boolean,
): string | undefined {
  if (isDisconnected) return "Reconnect to make changes.";
  return undefined;
}

export function ChatAddChildButton(props: {
  readonly epicId: string;
  readonly nodeId: string;
  readonly canMutate: boolean;
  readonly addChildIsPending: boolean;
  readonly tuiAgentPending: boolean;
  readonly isDisconnected: boolean;
  readonly childHostUnavailable: boolean;
  readonly workspaceInheritanceBlocked: boolean;
  readonly addMenuOpen: boolean;
  readonly onAddMenuOpenChange: (open: boolean) => void;
  readonly onAdd: (type: EpicNodeKind) => void;
  readonly onAddTerminalAgent:
    ((input: TerminalAgentWorktreeCreateInput) => void) | undefined;
  readonly terminalAgentWorkspaceSeed: ForkWorkspaceSeed | null;
  readonly terminalAgentHostScope: HostWorkspaceControlsHostScope;
  readonly terminalAgentStagingKey: WorktreeStagingKey;
}) {
  const {
    epicId,
    nodeId,
    canMutate,
    addChildIsPending,
    tuiAgentPending,
    isDisconnected,
    childHostUnavailable,
    workspaceInheritanceBlocked,
    addMenuOpen,
    onAddMenuOpenChange,
    onAdd,
    onAddTerminalAgent,
    terminalAgentWorkspaceSeed,
    terminalAgentHostScope,
    terminalAgentStagingKey,
  } = props;
  // The "+" only creates children on the row's bound host. When that host
  // is offline there is no actionable target, so hide the control entirely
  // rather than render it disabled. A disabled ghost button would otherwise
  // stay visible at 50% opacity: `Button`'s base `disabled:opacity-50` rule
  // (a `:disabled` pseudo-class, specificity 0,2,0) outweighs the plain
  // `opacity-0` hover-reveal utility (0,1,0), defeating the hover-only intent.
  if (childHostUnavailable) return null;
  const disabled = !canMutate || addChildIsPending || tuiAgentPending;
  const disabledTooltip = resolveAddChildDisabledTooltip(isDisconnected);

  return (
    <AddNodeDropdown
      open={addMenuOpen}
      onOpenChange={onAddMenuOpenChange}
      epicId={epicId}
      menuTestId={`epic-sidebar-add-menu-${nodeId}`}
      itemTestId={(t) => `epic-sidebar-add-${t}-${nodeId}`}
      onAdd={onAdd}
      onAddTerminalAgent={onAddTerminalAgent}
      terminalAgentWorkspaceSeed={terminalAgentWorkspaceSeed}
      terminalAgentHostScope={terminalAgentHostScope}
      terminalAgentStagingKey={terminalAgentStagingKey}
      tuiAgentPending={tuiAgentPending}
      excludeTypes={CHAT_PANEL_EXCLUDED_TYPES}
      disabledTypes={workspaceInheritanceBlocked ? ["chat"] : undefined}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Add child chat or agent"
        data-testid={`epic-sidebar-add-${nodeId}`}
        className={cn(
          "absolute right-7 top-1/2 -translate-y-1/2",
          rowAddControlRevealClass(addChildIsPending),
        )}
        disabled={disabled}
      >
        {addChildIsPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : (
          <Plus className="size-3" />
        )}
      </Button>
    </AddNodeDropdown>
  );
}
