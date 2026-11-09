import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ConfirmDestructiveDialog,
  type ConfirmDestructiveDialogProps,
} from "@/components/ui/confirm-destructive-dialog";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicDeleteAgentSubtree } from "@/hooks/epic/use-epic-delete-agent-subtree";
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
  const [hasOpened, setHasOpened] = useState(props.open);
  if (props.open && !hasOpened) setHasOpened(true);
  if (!props.open && !hasOpened) return null;
  return <AgentDeleteConfirmDialogBody {...props} />;
}

function AgentDeleteConfirmDialogBody(props: AgentDeleteConfirmDialogProps) {
  const checkboxId = useId();
  const [includeNestedAgents, setIncludeNestedAgents] = useState(false);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    setIncludeNestedAgents(false);
  }
  const deletion = useEpicDeleteAgentSubtree();
  const { known, nestedCount, description } = useEpicStore(
    useShallow((state) => {
      const known = selectNestedAgentsKnown(state);
      const nestedCount =
        props.open && known
          ? Math.max(
              0,
              agentSubtreeDeleteIds(state.tree, props.nodeId).length - 1,
            )
          : 0;
      return {
        known,
        nestedCount,
        description:
          props.open && includeNestedAgents && known && nestedCount > 0
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
  const checked = includeNestedAgents && known && nestedCount > 0;
  const pending = props.isPending || deletion.isPending;
  return (
    <ConfirmDestructiveDialog
      {...props}
      description={description}
      actionLabel={
        checked ? `Delete ${nestedCount + 1} agents` : props.actionLabel
      }
      isPending={pending}
      onConfirm={() => {
        if (!checked) {
          props.onConfirm();
          return;
        }
        settleDetachedEpicMutation(
          (async () => {
            await deletion.deleteSubtree(props.nodeId);
            props.onOpenChange(false);
          })(),
          "sidebar tree",
          "delete nested agents",
        );
      }}
    >
      {!known || nestedCount > 0 ? (
        <div className="space-y-2 px-5 pb-5">
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={checked}
              disabled={!known || pending}
              onCheckedChange={(value) =>
                setIncludeNestedAgents(value === true)
              }
            />
            <Label htmlFor={checkboxId}>
              {known
                ? `Also delete all ${nestedCount} nested ${nestedCount === 1 ? "agent" : "agents"}`
                : "Also delete all nested agents"}
            </Label>
          </div>
          {!known ? (
            <p className="text-ui-sm text-muted-foreground">
              Nested agents are still loading.
            </p>
          ) : null}
        </div>
      ) : null}
    </ConfirmDestructiveDialog>
  );
}
