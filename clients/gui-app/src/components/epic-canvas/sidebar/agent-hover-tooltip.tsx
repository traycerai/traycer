/**
 * THE agent hover, shared by the sidebar's Agents tree and the communication
 * graph's nodes.
 *
 * It was inline in `epic-sidebar-chat-tree`'s row until the graph needed the
 * same thing. Extracted rather than copied so the two cannot drift: an agent
 * hovered in the navigator and the same agent hovered on the canvas must say
 * the same things about it.
 *
 * Host facts come from the viewer's sandbox list or the task's authorized
 * summary. They survive an unreachable owner host; live workspace metadata
 * does not. A task summary never authorizes a read of the host's disk.
 * Without a sandbox projection or live metadata, the full name and any role
 * claims still remain readable in the plain tooltip.
 *
 * DATA COMES FROM THE EPIC SELECTORS, not from the caller. Both call sites pass
 * only the node's identity; everything SHOWN is read here, so neither surface
 * can hand it a different truth. `ownerHostUnreachable` is the one exception,
 * and it is not shown - it only chooses between the outcomes. See its own doc.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { HoverCard } from "@/components/ui/hover-card";
import { SandboxKeepDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";
import { AgentRoleHoverContent } from "@/components/epic-canvas/sidebar/agent-role-badges";
import { AgentHostSection } from "@/components/epic-canvas/sidebar/agent-host-section";
import { useAgentHostProjection } from "@/hooks/epic/use-agent-host-projection";

export interface AgentHoverTooltipProps {
  readonly trigger: ReactElement;
  readonly epicId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  /** `null` for a legacy record with no resolvable host - no metadata to read. */
  readonly hostId: string | null;
  /**
   * `null` for node kinds that own no worktree-bound process tree (specs,
   * tickets, …). Narrower than the resource-owner wire kind on purpose: only
   * these two have owner metadata to read.
   */
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly roleClaims: readonly RoleClaim[];
  /**
   * Whether the owner host can be reached right now.
   *
   * A PROP where everything else here is read internally, and the exception is
   * deliberate. The sidebar row already resolves this verdict for its own
   * offline lock, on the same host id - so passing it makes the lock and the
   * hover provably read the SAME answer instead of two subscriptions that
   * could momentarily disagree, and spares a long tree one extra directory
   * subscription per row. It is also the one input that is a fact about a
   * MACHINE rather than about the record, which is what the "read it here"
   * rule was written for.
   */
  readonly ownerHostUnreachable: boolean;
  /**
   * Which side the tooltip opens on. The sidebar opens right (the tree is a
   * left rail); the canvas opens up, because a node can sit anywhere and the
   * space below it is where the transport bar is.
   */
  readonly side: "top" | "right" | "bottom" | "left";
  /**
   * Extra lines to append under the card, for a surface that knows something
   * about the agent the shared selectors do not - the office floor's posture
   * ("Working", "At reception") and the size class its desk is drawn at.
   *
   * Appended rather than substituted: everything ABOVE it is still the one
   * shared description, so a surface can add to what an agent says about
   * itself without being able to contradict it.
   */
  readonly extraContent: ReactElement | null;
}

/** `null` when there are no claims - an empty roles card is worse than none. */
function agentRoleHoverContent(
  roleClaims: readonly RoleClaim[],
): ReactNode | null {
  if (roleClaims.length === 0) return null;
  return <AgentRoleHoverContent claims={roleClaims} />;
}

/**
 * What the plain tooltip shows when there is no owner card to hang content
 * under.
 *
 * The name must survive whatever else is shown: the office's line under it is
 * "Working · large model", which names nothing, and the floor's own tag is
 * truncated - so a card that dropped the title for the posture line would take
 * away the only place the full name was readable. The fallback supplies its
 * own header because the role content only carries roles and scopes.
 */
function fallbackTooltipLabel(
  nodeName: string,
  roleContent: ReactNode | null,
  extraContent: ReactElement | null,
): ReactNode {
  if (roleContent !== null || extraContent !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words">{nodeName}</span>
        {roleContent}
        {extraContent}
      </div>
    );
  }
  return nodeName;
}

export function AgentHoverTooltip(props: AgentHoverTooltipProps): ReactNode {
  const [keepSandbox, setKeepSandbox] = useState<SandboxSummary | null>(null);
  return (
    <>
      <AgentHoverTooltipContent {...props} onKeep={setKeepSandbox} />
      {keepSandbox === null ? null : (
        <SandboxKeepDialog
          sandbox={keepSandbox}
          open
          onOpenChange={(open) => {
            if (!open) setKeepSandbox(null);
          }}
        />
      )}
    </>
  );
}

function AgentHoverTooltipContent(
  props: AgentHoverTooltipProps & {
    readonly onKeep: (sandbox: SandboxSummary) => void;
  },
): ReactNode {
  const {
    epicId,
    hostId,
    nodeId,
    nodeName,
    ownerHostUnreachable,
    extraContent,
    ownerKind,
    roleClaims,
    side,
  } = props;
  const hostProjection = useAgentHostProjection(epicId, hostId);
  const hostSection =
    hostProjection === null ? null : (
      <AgentHostSection
        projection={hostProjection}
        epicId={epicId}
        nodeId={nodeId}
        ownerHostUnreachable={ownerHostUnreachable}
        onKeep={props.onKeep}
      />
    );
  const roleContent = agentRoleHoverContent(roleClaims);
  // `null` is the ONLY way to say "nothing to add", which is why the prop is
  // an element and not a `ReactNode`. `ReactNode` admits `undefined`, `false`
  // and `""`, all of which are absent to a reader and present to a `!== null`
  // test - and a non-null `supplemental` is what the owner card hangs a
  // section under, so each of them bought an empty section. The type makes
  // them unrepresentable instead of guarding for them.
  const supplemental =
    roleContent === null && extraContent === null ? null : (
      <>
        {roleContent}
        {extraContent}
      </>
    );

  if (
    hostId !== null &&
    ownerKind !== null &&
    !ownerHostUnreachable &&
    hostProjection?.kind !== "task"
  ) {
    return (
      <WorktreeOwnerMetadataTooltip
        trigger={props.trigger}
        title={nodeName}
        hostId={hostId}
        epicId={epicId}
        ownerId={nodeId}
        ownerKind={ownerKind}
        hostSection={hostSection}
        supplementalContent={supplemental}
        side={side}
      />
    );
  }
  if (hostSection !== null) {
    return (
      <HoverCard
        trigger={props.trigger}
        content={
          <div
            className="w-full max-w-md"
            data-testid={`agent-host-hover-${nodeId}`}
          >
            <div className="border-b border-border/70 px-3 py-2 text-ui-sm font-medium break-words">
              {nodeName}
            </div>
            {hostSection}
            {supplemental === null ? null : (
              <div className="border-t border-border px-3 py-2">
                {supplemental}
              </div>
            )}
          </div>
        }
        appearance="preview"
        semantics={{ role: "dialog", label: nodeName }}
        side={side}
        align="start"
        sideOffset={4}
        enabled
        open={null}
        onOpenChange={null}
        testId={null}
        className="max-w-md"
      />
    );
  }
  // Never a bare trigger: a row without roles or owner metadata still exposes
  // its FULL name on hover - sidebar rows and graph nodes truncate, and the
  // tooltip is the only place the complete title is readable (upstream pinned
  // this for selection mode; the shared component gives it everywhere).
  //
  // The same primitive as the owner card, in its label appearance, so a row
  // never switches primitive with its data and the tree's rows share one
  // clock whichever outcome each one has.
  return (
    <HoverCard
      trigger={props.trigger}
      content={fallbackTooltipLabel(nodeName, roleContent, extraContent)}
      appearance="tooltip"
      semantics={{ role: "tooltip" }}
      side={side}
      align="start"
      sideOffset={6}
      enabled
      open={null}
      onOpenChange={null}
      testId={null}
      className="max-w-xs px-3 py-1.5 text-ui-xs [overflow-wrap:anywhere]"
    />
  );
}
