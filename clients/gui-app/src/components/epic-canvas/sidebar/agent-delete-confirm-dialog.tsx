import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SidebarDialogMount } from "@/components/epic-canvas/sidebar/lazy-sidebar-confirm-dialog";
import {
  ConfirmDestructiveDialog,
  type ConfirmDestructiveDialogProps,
} from "@/components/ui/confirm-destructive-dialog";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicDeleteAgentSubtree } from "@/hooks/epic/use-epic-delete-agent-subtree";
import { useAgentSubtreeDeleteBlocker } from "@/hooks/epic/use-agent-subtree-delete-blocker";
import {
  agentSubtreeDeleteIds,
  describeTreeDeleteDisclosure,
  selectNestedAgentsKnown,
} from "@/lib/epic-tree-cascade";
import { settleDetachedEpicMutation } from "@/lib/artifacts/detached-epic-mutation";

interface AgentDeleteConfirmDialogProps extends ConfirmDestructiveDialogProps {
  readonly nodeId: string;
}

/** Keep mutation hooks and subtree reads off rows whose dialog never opens. */
export function AgentDeleteConfirmDialog(props: AgentDeleteConfirmDialogProps) {
  return (
    <SidebarDialogMount open={props.open}>
      <AgentDeleteConfirmDialogBody {...props} />
    </SidebarDialogMount>
  );
}

function AgentDeleteConfirmDialogBody(props: AgentDeleteConfirmDialogProps) {
  const checkboxId = useId();
  const [includeNestedAgents, setIncludeNestedAgents] = useState(false);
  const [wasOpen, setWasOpen] = useState(props.open);
  const deletion = useEpicDeleteAgentSubtree();
  const ids = useEpicStore(
    useShallow((state) =>
      props.open ? agentSubtreeDeleteIds(state.tree, props.nodeId) : [],
    ),
  );
  const blockedReason = useAgentSubtreeDeleteBlocker(ids);
  const { known, description } = useEpicStore(
    useShallow((state) => {
      const known = selectNestedAgentsKnown(state);
      return {
        known,
        description:
          props.open && includeNestedAgents
            ? describeTreeDeleteDisclosure({
                tree: state.tree,
                kind: "agent",
                nodeIds: [props.nodeId],
                nestedAgentsKnown: known,
                includeNestedAgents: true,
              }).description
            : props.description,
      };
    }),
  );
  const pending = props.isPending || deletion.isPending;
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    setIncludeNestedAgents(false);
  }
  if (
    !pending &&
    includeNestedAgents &&
    (blockedReason !== null || ids.length < 2)
  ) {
    setIncludeNestedAgents(false);
  }
  const nestedCount = ids.length === 0 ? 0 : ids.length - 1;
  return (
    <ConfirmDestructiveDialog
      {...props}
      onOpenChange={(open) => {
        if (!open) deletion.resetError();
        props.onOpenChange(open);
      }}
      description={description}
      actionLabel={
        includeNestedAgents ? `Delete ${ids.length} agents` : props.actionLabel
      }
      isPending={pending}
      blockedReason={
        includeNestedAgents
          ? (blockedReason ?? props.blockedReason)
          : props.blockedReason
      }
      onConfirm={() => {
        if (!includeNestedAgents) {
          props.onConfirm();
          return;
        }
        settleDetachedEpicMutation(
          (async () => {
            if (await deletion.deleteSubtree(props.nodeId, ids))
              props.onOpenChange(false);
          })(),
          "sidebar tree",
          "delete nested agents",
        );
      }}
    >
      <AgentSubtreeDeleteOption
        checkboxId={checkboxId}
        checked={includeNestedAgents}
        known={known}
        nestedCount={nestedCount}
        pending={pending}
        blockedReason={blockedReason}
        error={deletion.error}
        onCheckedChange={(checked) => {
          setIncludeNestedAgents(checked);
          deletion.resetError();
        }}
      />
      {props.children}
    </ConfirmDestructiveDialog>
  );
}

function AgentSubtreeDeleteOption(props: {
  readonly checkboxId: string;
  readonly checked: boolean;
  readonly known: boolean;
  readonly nestedCount: number;
  readonly pending: boolean;
  readonly blockedReason: string | null;
  readonly error: string | null;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  if (props.known && props.nestedCount === 0 && props.error === null)
    return null;
  return (
    <div className="space-y-2 px-5 pb-5">
      {!props.known || props.nestedCount > 0 ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={props.checkboxId}
            checked={props.checked}
            disabled={
              !props.known || props.blockedReason !== null || props.pending
            }
            onCheckedChange={(value) => props.onCheckedChange(value === true)}
          />
          <Label htmlFor={props.checkboxId}>
            {props.known
              ? `Also delete all ${props.nestedCount} nested ${props.nestedCount === 1 ? "agent" : "agents"}`
              : "Also delete all nested agents"}
          </Label>
        </div>
      ) : null}
      {props.blockedReason !== null ? (
        <p
          className="text-ui-sm text-muted-foreground wrap-anywhere"
          data-testid="agent-subtree-blocked-reason"
        >
          {props.blockedReason}
        </p>
      ) : null}
      {props.error !== null ? (
        <p role="alert" className="text-ui-sm text-destructive wrap-anywhere">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
