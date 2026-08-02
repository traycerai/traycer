/**
 * ONE RAW event row - exactly one captured event, never a fold - in ONE grammar
 * shared by every surface that lists events (the Communication timeline, the
 * pair detail, the agent detail).
 *
 * THE GRAMMAR, two tiers, identical for all four kinds (Request / Reply /
 * Notice / Created):
 *
 *   identity  SUBJECT ("Sender → Receiver", or the acting agent) …  time  [⌄]
 *   content   [KIND] primary text                  · muted qualifiers ·
 *
 * SUBJECT LEADS. The timestamp used to hold the first line on its own, which
 * ranked the least identifying fact in the row above the only one a reader scans
 * for; it now trails the subject as a `<time>`, quiet and small.
 *
 * Exactly one kind badge (Request / Reply / Notice / Created) from one
 * component, and every secondary qualifier in one trailing muted cluster
 * ("expects reply", the notice reason). Qualifiers are TEXT, never badges -
 * one badge per row is what makes the badge mean something.
 *
 * The detail panels keep that order but BREAK THE LINE - header above, body
 * below, header sticky on expansion. Every row defaults to the same two-line
 * plain-text preview; only a long/multiline body offers expansion, which swaps
 * the preview for one framed markdown body.
 *
 * NO RAW MARKDOWN OUTSIDE AN EXPANDED DETAIL BODY. Snippets and collapsed
 * previews run through `markdownToPlainText`, so a preview shows the message
 * rather than its source. The timeline never renders markdown at all.
 *
 * NO COALESCING, on any of these surfaces: five messages between the same pair
 * of agents are five rows, however alike they look. The log is an append-only
 * record and these lists render it one row per row.
 *
 * COLLAPSING IS NOT COALESCING: a collapsed row is still exactly one row, still
 * present, still counted. It is the body that is folded, never the event.
 */
import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn, formatSingleLine } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  commGraphRowKey,
  useCommGraphRowOpen,
  useSetCommGraphRowOpen,
} from "@/stores/epics/comm-graph-row-open-store";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import { markdownToPlainText } from "@/lib/markdown/markdown-to-plain-text";
import { CommGraphMarkdownAnchor } from "@/components/epic-canvas/comm-graph/comm-graph-markdown-anchor";
import {
  CommGraphDirectionLabel,
  type CommGraphEndpointAction,
} from "@/components/epic-canvas/comm-graph/comm-graph-direction-label";
import {
  commGraphEventDirection,
  type CommGraphEvent,
} from "@/lib/comm-graph/comm-graph-events";
import { commGraphJumpTarget } from "@/lib/comm-graph/comm-graph-jump";
import { commGraphNoticeReasonLabel } from "@/lib/comm-graph/comm-graph-labels";

export interface CommGraphEventRowProps {
  readonly event: CommGraphEvent;
  /** Scopes the per-row expand state, which is stored per epic. */
  readonly epicId: string;
  readonly agentNames: ReadonlyMap<string, string>;
  /** Prefix for this surface's row test ids. */
  readonly testIdPrefix: string;
  readonly canJump: boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  /** Sender-side jump to the "Sent message" card - see `CommGraphJump`. */
  readonly canJumpToSender: boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  /** Created-row jump to the child's transcript start - see `CommGraphJump`. */
  readonly canJumpToCreated: boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  /** Open an endpoint's tile when this row has no transcript anchor for it. */
  readonly onOpenAgent: (agentId: string) => void;
}

type CommGraphRowKind = "request" | "reply" | "notice" | "created";

const KIND_CHIP_LABELS: Readonly<Record<CommGraphRowKind, string>> = {
  request: "Request",
  reply: "Reply",
  notice: "Notice",
  created: "Created",
};

/**
 * Outline badges throughout, so weight comes from the border and not a solid
 * fill competing with the subject. Only a request is tinted - it is the row that
 * may still be owed an answer; a notice keeps amber because it is the broker
 * reporting a failure; a created row keeps sky, matching its canvas pulse -
 * lineage, not conversation.
 */
const KIND_CHIP_CLASSES: Readonly<Record<CommGraphRowKind, string>> = {
  request: "border-primary/25 bg-primary/5 text-primary",
  reply: "border-border/60 bg-transparent text-foreground/70",
  notice:
    "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  created: "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300",
};

/** `inReplyTo` is the only thing that separates an answer from a fresh ask. */
function rowKind(event: CommGraphEvent): CommGraphRowKind {
  if (event.kind === "a2a_notice") return "notice";
  if (event.kind === "agent_created") return "created";
  return event.inReplyTo === null ? "request" : "reply";
}

function CommGraphKindChip(props: {
  readonly kind: CommGraphRowKind;
  readonly testId: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid={props.testId}
      className={cn(
        "h-4 rounded-sm px-1 py-0 text-micro font-medium",
        KIND_CHIP_CLASSES[props.kind],
      )}
    >
      {KIND_CHIP_LABELS[props.kind]}
    </Badge>
  );
}

/**
 * The one surface override: this panel cannot resolve a workspace-relative path
 * from an arbitrary agent on an arbitrary host, so it does not pretend to.
 */
const COMM_GRAPH_MARKDOWN_COMPONENTS: Record<
  string,
  ComponentType<Record<string, unknown>>
> = { a: CommGraphMarkdownAnchor };

/**
 * The source-length guard catches messages deliberately shortened by
 * `previewText`. Rendered overflow is measured separately because a shorter
 * message can still wrap past the two-line clamp in a narrow panel.
 */
const PREVIEW_MAX_CHARS = 180;

/** Markdown projected to prose FIRST - see `markdownToPlainText`. */
function previewText(text: string): string {
  return formatSingleLine(markdownToPlainText(text), {
    maxLength: PREVIEW_MAX_CHARS,
    ellipsis: "…",
  });
}

/**
 * Keyed on the ORIGINAL SOURCE, deliberately, not on the projection. Expanding
 * reveals the rendered markdown - headings, list structure, a fenced diagram -
 * so a body whose projection is short can still be a screenful once open. A
 * newline counts under the length cap for the same reason.
 */
function bodyIsCollapsible(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_MAX_CHARS || trimmed.includes("\n");
}

export const CommGraphEventRow = memo(function CommGraphEventRow(
  props: CommGraphEventRowProps,
) {
  const {
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    epicId,
    event,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    testIdPrefix,
  } = props;
  return (
    <CommGraphSectionedRow
      event={event}
      agentNames={agentNames}
      epicId={epicId}
      kind={rowKind(event)}
      rowId={`${event.hostId}-${event.id}`}
      testIdPrefix={testIdPrefix}
      canJump={canJump}
      onJump={onJump}
      canJumpToSender={canJumpToSender}
      onJumpToSender={onJumpToSender}
      canJumpToCreated={canJumpToCreated}
      onJumpToCreated={onJumpToCreated}
      onOpenAgent={onOpenAgent}
    />
  );
});

/**
 * The two tiers, shared verbatim by every surface. `trailing` is the only slot
 * that differs.
 */
function CommGraphRowHeader(props: {
  readonly event: CommGraphEvent;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly kind: CommGraphRowKind;
  readonly testIdPrefix: string;
  readonly rowId: string;
  readonly trailing: ReactNode;
  readonly canJump: boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  readonly canJumpToSender: boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  readonly canJumpToCreated: boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  readonly onOpenAgent: (agentId: string) => void;
}) {
  const {
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    event,
    kind,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    rowId,
    testIdPrefix,
    trailing,
  } = props;
  const when = new Date(event.timestamp);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <CommGraphSubject
          event={event}
          agentNames={agentNames}
          canJump={canJump}
          onJump={onJump}
          canJumpToSender={canJumpToSender}
          onJumpToSender={onJumpToSender}
          canJumpToCreated={canJumpToCreated}
          onJumpToCreated={onJumpToCreated}
          onOpenAgent={onOpenAgent}
          testIdPrefix={`${testIdPrefix}-${rowId}`}
        />
        <time
          dateTime={when.toISOString()}
          className="shrink-0 text-micro font-normal tabular-nums text-muted-foreground/60"
        >
          {when.toLocaleTimeString()}
        </time>
        {trailing}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <CommGraphKindChip
          kind={kind}
          testId={`${testIdPrefix}-kind-${rowId}`}
        />
        <CommGraphQualifiers
          event={event}
          testIdPrefix={testIdPrefix}
          rowId={rowId}
        />
      </div>
    </div>
  );
}

const SUBJECT_CLASS =
  "min-w-0 flex-1 text-ui-sm font-medium text-foreground/90";

/**
 * WHICH ENDPOINT CAN SCROLL WHERE - the whole mapping, as data.
 *
 * Ordered, first match wins: a captured anchor beats one resolved at jump time.
 * A row not listed here is a PLAIN OPEN (↗) - reachable, claiming nothing. That
 * is the honest default, and it is where a notice's idle agent lands: the
 * broker OBSERVED it going quiet, so nothing in its transcript is this row.
 *
 * `endpoint` names a RAW log field, not the arrow's side - a notice reverses
 * the two for display (`commGraphEventDirection`).
 */
interface CommGraphScrollClaim {
  readonly jump: CommGraphJumpKind;
  readonly endpoint: "anchor" | "sender" | "receiver";
  /** Row kind this claim is limited to; null = any. */
  readonly rowKind: CommGraphEvent["kind"] | null;
  /** Named in the accessible label, so claim and landing cannot drift apart. */
  readonly landing: string;
}

type CommGraphJumpKind = "anchor" | "created" | "sender";

const SCROLL_CLAIMS: ReadonlyArray<CommGraphScrollClaim> = [
  {
    jump: "anchor",
    endpoint: "anchor",
    rowKind: null,
    landing: " and scroll to this message",
  },
  {
    jump: "created",
    endpoint: "receiver",
    rowKind: "agent_created",
    landing: " and scroll to the start",
  },
  {
    jump: "sender",
    endpoint: "sender",
    rowKind: "a2a_message",
    landing: " and scroll to this message",
  },
];

/**
 * The two endpoints, each reachable in the way its transcript can support - see
 * `SCROLL_CLAIMS` for which is which, and `CommGraphDirectionLabel` for the two
 * link species.
 *
 * A capability being on never by itself grants a claim: `canJump` is also true
 * for rows whose jump degrades to a plain tile open, so the claim must match
 * the ENDPOINT too. Claiming a landing the jump cannot deliver reads as broken
 * navigation, not honesty. An agent this epic does not project renders as plain
 * text - a dead-looking link is the one wrong answer.
 */
function CommGraphSubject(props: {
  readonly event: CommGraphEvent;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly canJump: boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  readonly canJumpToSender: boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  readonly canJumpToCreated: boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  readonly onOpenAgent: (agentId: string) => void;
  readonly testIdPrefix: string;
}) {
  const {
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    event,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    testIdPrefix,
  } = props;
  const { fromAgentId: senderId, toAgentId: receiverId } =
    commGraphEventDirection(event);
  const jumpTarget = canJump ? commGraphJumpTarget(event) : null;
  // The table's two lookups. `anchor` is the chat the captured origin ref points
  // at - null when the row has none, or when its jump degrades to a plain tile
  // open, which is what keeps `canJump` alone from granting a claim.
  const endpointIds: Readonly<
    Record<CommGraphScrollClaim["endpoint"], string | null>
  > = {
    anchor:
      jumpTarget !== null && jumpTarget.kind !== "agent"
        ? jumpTarget.chatId
        : null,
    sender: event.senderAgentId,
    receiver: event.receiverAgentId,
  };
  const jumps: Readonly<
    Record<
      CommGraphJumpKind,
      { readonly enabled: boolean; readonly open: () => void }
    >
  > = {
    anchor: { enabled: true, open: () => onJump(event) },
    created: {
      enabled: canJumpToCreated,
      open: () => onJumpToCreated(event),
    },
    sender: { enabled: canJumpToSender, open: () => onJumpToSender(event) },
  };
  const endpointAction = (agentId: string | null): CommGraphEndpointAction => {
    if (agentId === null || !agentNames.has(agentId)) {
      return { onOpen: null, scrollSuffix: null };
    }
    const claim = SCROLL_CLAIMS.find(
      (candidate) =>
        (candidate.rowKind === null || candidate.rowKind === event.kind) &&
        jumps[candidate.jump].enabled &&
        endpointIds[candidate.endpoint] === agentId,
    );
    if (claim === undefined) {
      return { onOpen: () => onOpenAgent(agentId), scrollSuffix: null };
    }
    return { onOpen: jumps[claim.jump].open, scrollSuffix: claim.landing };
  };
  return (
    <CommGraphDirectionLabel
      senderAgentId={senderId}
      receiverAgentId={receiverId}
      agentNames={agentNames}
      className={SUBJECT_CLASS}
      senderAction={endpointAction(senderId)}
      receiverAction={endpointAction(receiverId)}
      testIdPrefix={testIdPrefix}
    />
  );
}

/**
 * A detail-panel row: sticky header, body underneath, long bodies collapsed.
 *
 * STICKY because a single expanded report can be taller than the panel, and a
 * reader who has scrolled into the middle of one otherwise has nothing on screen
 * saying which message they are in. The panel's own header is a sibling OUTSIDE
 * the scroll container, so it stays above these without a z-index fight, and
 * successive headers displace each other in the ordinary way.
 *
 * The sticky header is deliberately OPAQUE (`bg-background`) rather than
 * carrying the notice row's amber wash: a translucent sticky element lets the
 * text it is pinned over bleed through it. A notice still reads as one - its
 * amber badge is in the header, so the signal travels with the part that stays
 * on screen.
 *
 * ONE ROW SPECIES, NOT TWO. Every row - short, long, message, notice - shows the
 * SAME clamped preview by default. Only expansion swaps it for the framed
 * markdown body. Previously a short body rendered straight into that frame while
 * a long one showed a preview, so a list of both read as two different kinds of
 * object and the eye had to re-learn the layout mid-scroll. A complete preview
 * that fits has no chevron; a visually clamped preview always does.
 */
function CommGraphSectionedRow(props: {
  readonly event: CommGraphEvent;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly epicId: string;
  readonly kind: CommGraphRowKind;
  readonly rowId: string;
  readonly testIdPrefix: string;
  readonly canJump: boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  readonly canJumpToSender: boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  readonly canJumpToCreated: boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  readonly onOpenAgent: (agentId: string) => void;
}) {
  const {
    agentNames,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    epicId,
    event,
    kind,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    rowId,
    testIdPrefix,
  } = props;
  const rowKey = commGraphRowKey(event.hostId, event.id);
  const open = useCommGraphRowOpen(epicId, rowKey);
  const setRowOpen = useSetCommGraphRowOpen();
  const handleOpenChange = useCallback(
    (next: boolean) => setRowOpen(epicId, rowKey, next),
    [epicId, rowKey, setRowOpen],
  );

  const text = event.messageText;
  const hasBody = text !== null && text.length > 0;
  const [previewElement, setPreviewElement] =
    useState<HTMLParagraphElement | null>(null);
  const [previewOverflows, setPreviewOverflows] = useState(false);
  useLayoutEffect(() => {
    if (previewElement === null) return;
    const measure = (): void => {
      setPreviewOverflows(
        previewElement.scrollHeight > previewElement.clientHeight + 1,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(previewElement);
    return () => observer.disconnect();
  }, [previewElement, text]);
  const collapsible =
    text !== null && (bodyIsCollapsible(text) || previewOverflows);

  const header = (trailing: ReactNode) => (
    <CommGraphRowHeader
      event={event}
      agentNames={agentNames}
      kind={kind}
      testIdPrefix={testIdPrefix}
      rowId={rowId}
      trailing={trailing}
      canJump={canJump}
      onJump={onJump}
      canJumpToSender={canJumpToSender}
      onJumpToSender={onJumpToSender}
      canJumpToCreated={canJumpToCreated}
      onJumpToCreated={onJumpToCreated}
      onOpenAgent={onOpenAgent}
    />
  );

  const body = hasBody ? (
    // Framed like chat's A2A body, so a long report reads as a quoted block
    // rather than as loose text abutting the next row. No max-height: the panel
    // is the scroller. ONLY ever rendered on expansion.
    <div className="mx-2.5 mb-2 rounded-md border border-border/40 bg-muted/15 px-2.5 py-2">
      <CommGraphMarkdownBody
        text={text}
        testId={`${testIdPrefix}-body-${rowId}`}
      />
    </div>
  ) : null;

  // The default presentation for EVERY row, collapsible or not.
  const preview =
    text === null || text.length === 0 ? null : (
      // Spacing lives on this wrapper, NEVER on the clamped element: padding on
      // a `line-clamp` box is inside the clamp's overflow, so the last visible
      // line gets sliced through its glyphs.
      <div className="px-2.5 pb-2">
        <p
          ref={setPreviewElement}
          data-testid={`${testIdPrefix}-preview-${rowId}`}
          className="m-0 line-clamp-2 text-ui-xs leading-4 text-foreground/75"
        >
          {previewText(text)}
        </p>
      </div>
    );

  // Nothing to collapse: the complete projected body fits in the rendered
  // preview. No chevron or toggle - the row is simply itself.
  if (!collapsible) {
    return (
      <div
        data-testid={`${testIdPrefix}-row-${rowId}`}
        data-selected="false"
        data-kind={event.kind}
        data-collapsible="false"
        className="w-full min-w-0 border-b border-border/60"
      >
        <div
          className={cn(
            "sticky top-0 z-10 flex min-w-0 items-stretch bg-background",
            // Elevated only when a preview sits under it - a bodyless notice
            // row has nothing to separate itself from.
            hasBody && "border-b border-border/30 shadow-sm",
          )}
        >
          <div className="min-w-0 flex-1 px-2.5 py-2">{header(null)}</div>
        </div>
        {preview}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-testid={`${testIdPrefix}-row-${rowId}`}
      data-selected="false"
      data-kind={event.kind}
      data-collapsible="true"
      className="w-full min-w-0 border-b border-border/60"
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex min-w-0 items-stretch bg-background",
          open && "border-b border-border/30 shadow-sm",
        )}
      >
        {/*
          THE HEADING IS NO LONGER THE TRIGGER. Its two agent names are buttons
          now, and a button inside a button is invalid HTML that browsers
          reparent and screen readers cannot describe. So the chevron became its
          own control and the heading is plain content beside it - the smaller
          hit target is the price of the endpoints being reachable at all.
        */}
        <div className="min-w-0 flex-1 px-2.5 py-2">{header(null)}</div>
        <CollapsibleTrigger
          data-testid={`${testIdPrefix}-toggle-${rowId}`}
          aria-label={open ? "Collapse message" : "Expand message"}
          className="group/comm-row flex shrink-0 items-start px-1.5 py-2.5 text-muted-foreground/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          <ChevronDown
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]/comm-row:rotate-180"
          />
        </CollapsibleTrigger>
      </div>
      {open ? null : preview}
      <CollapsibleContent className="overflow-hidden">
        {body}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The ONE trailing qualifier cluster. Every secondary fact lives here, in a
 * fixed order, for every kind - so no qualifier is a badge on one row and plain
 * text on another, or floated to the opposite end of the line.
 */
function CommGraphQualifiers(props: {
  readonly event: CommGraphEvent;
  readonly testIdPrefix: string;
  readonly rowId: string;
}) {
  const { event, rowId, testIdPrefix } = props;
  const parts: Array<{ readonly key: string; readonly node: ReactNode }> = [];

  if (event.kind === "a2a_message" && event.expectReply === true) {
    parts.push({
      key: "expects-reply",
      node: <span className="shrink-0">expects reply</span>,
    });
  }
  if (event.kind === "a2a_notice") {
    parts.push({
      key: "reason",
      node: (
        <span
          className="shrink-0"
          data-testid={`${testIdPrefix}-reason-${rowId}`}
        >
          {commGraphNoticeReasonLabel(event.noticeReason)}
        </span>
      ),
    });
  }

  if (parts.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-micro lowercase text-muted-foreground/65">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/30">
              ·
            </span>
          )}
          {part.node}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A DIV, not a span: `TraycerMarkdown` roots at a block element, and React flags
 * (and browsers reparent) block content inside phrasing content.
 */
function CommGraphMarkdownBody(props: {
  readonly text: string;
  readonly testId: string;
}) {
  return (
    <div data-testid={props.testId} className="min-w-0">
      <AgentReferenceMarkdown
        isStreaming={false}
        markdown={props.text}
        proseSize="compact"
        quotable={false}
        components={COMM_GRAPH_MARKDOWN_COMPONENTS}
      />
    </div>
  );
}
