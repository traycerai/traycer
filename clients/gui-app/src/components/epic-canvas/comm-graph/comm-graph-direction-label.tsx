/**
 * `sender → receiver` for one A2A row.
 *
 * Shared by both detail panels ON PURPOSE. The canvas edge is undirected, so
 * these lists are the ONLY places direction is expressed - if they rendered it
 * differently, a reader moving between them would have to re-learn it. One
 * component, one shape.
 *
 * BOTH ENDPOINTS ARE REACHABLE, and the affordance says WHICH KIND of
 * reachable. Two link species exist and they must not share one look - the
 * live pass proved that when they do, every link is read as the stronger one
 * and the weaker one reads as broken navigation:
 *
 * - a SCROLL link (plain underline-on-hover name) opens the agent's chat AND
 *   lands somewhere specific - a delivered message, a resolved "Sent message"
 *   card, the transcript's start or end. Its `scrollSuffix` names the landing
 *   in the accessible label.
 * - a PLAIN OPEN (name + ↗) only focuses the agent's tile. The glyph is the
 *   same "opens elsewhere" cue the detail panel's header button uses.
 *
 * An endpoint with no id, or one this epic does not project, renders as plain
 * text: a dead-looking link is the one wrong answer.
 */
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { commGraphAgentLabel } from "@/lib/comm-graph/comm-graph-labels";

/**
 * What one endpoint does when clicked. `onOpen: null` renders plain text;
 * `scrollSuffix: null` is a plain tile open (↗); a non-null suffix names the
 * scroll landing (" and scroll to this message" / " to the start" / ...).
 */
export interface CommGraphEndpointAction {
  readonly onOpen: (() => void) | null;
  readonly scrollSuffix: string | null;
}

export interface CommGraphDirectionLabelProps {
  readonly senderAgentId: string | null;
  readonly receiverAgentId: string | null;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly className: string | undefined;
  readonly senderAction: CommGraphEndpointAction;
  readonly receiverAction: CommGraphEndpointAction;
  /** Disambiguates the two endpoint controls' test ids per row. */
  readonly testIdPrefix: string | undefined;
}

const ENDPOINT_CLASS =
  "flex min-w-0 items-center rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

function CommGraphEndpoint(props: {
  readonly label: string;
  readonly action: CommGraphEndpointAction;
  readonly testId: string | undefined;
}) {
  const { action, label, testId } = props;
  if (action.onOpen === null) {
    return <span className="min-w-0 truncate font-medium">{label}</span>;
  }
  return (
    <button
      type="button"
      className={ENDPOINT_CLASS}
      aria-label={`Open ${label}${action.scrollSuffix ?? ""}`}
      data-testid={testId}
      onClick={action.onOpen}
    >
      <span className="min-w-0 truncate">{label}</span>
      {action.scrollSuffix === null ? (
        <ArrowUpRight
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/70"
        />
      ) : null}
    </button>
  );
}

export function CommGraphDirectionLabel(props: CommGraphDirectionLabelProps) {
  const {
    agentNames,
    className,
    receiverAction,
    receiverAgentId,
    senderAction,
    senderAgentId,
    testIdPrefix,
  } = props;
  const senderLabel = commGraphAgentLabel(senderAgentId, agentNames);
  const receiverLabel = commGraphAgentLabel(receiverAgentId, agentNames);
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <CommGraphEndpoint
        label={senderLabel}
        action={senderAction}
        testId={
          testIdPrefix === undefined ? undefined : `${testIdPrefix}-sender`
        }
      />
      <span aria-hidden className="shrink-0 text-muted-foreground">
        →
      </span>
      <CommGraphEndpoint
        label={receiverLabel}
        action={receiverAction}
        testId={
          testIdPrefix === undefined ? undefined : `${testIdPrefix}-receiver`
        }
      />
    </span>
  );
}
