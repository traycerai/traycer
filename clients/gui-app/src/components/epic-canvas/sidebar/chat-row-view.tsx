import type { ReactNode } from "react";

/**
 * What a chat row draws inside its row element: chevron, optional selection
 * box, the leading status glyph, then the title line with its badges.
 *
 * Presentational on purpose: the chat tree passes its store-bound pieces (the
 * status glyph, session and role badges, resource chip, idle time) as slots and
 * keeps every data and dnd concern, and the sample workspace's sidebar draws
 * the same row from sample data, so the two pictures of an agent row cannot
 * drift (F3).
 */
export function ChatRowView(props: {
  readonly chevron: ReactNode;
  readonly selection: ReactNode;
  readonly leadingIcon: ReactNode;
  readonly nodeName: string;
  readonly isArchived: boolean;
  /** Everything after the title, in the order the row shows it. */
  readonly badges: ReactNode;
}): ReactNode {
  return (
    <>
      {props.chevron}
      {props.selection}
      <ChatRowLeadingIconSlot>{props.leadingIcon}</ChatRowLeadingIconSlot>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {props.isArchived ? <ArchivedTitlePrefix /> : null}
          <span className="min-w-0 flex-1 truncate">{props.nodeName}</span>
          {props.badges}
        </span>
      </span>
    </>
  );
}

/**
 * Fixed-size slot the leading icon renders into, so every row's text column
 * starts at the same x regardless of which variant (chat glyph, harness brand
 * + terminal subscript, spinner, bot) fills it. Sized to the widest variant -
 * `SidebarAgentHarnessIcon`, whose subscript overhangs the 14px brand mark.
 *
 * The slot is only a WIDTH reservation: it carries no vertical alignment of
 * its own. Centering across the two-line card is the outer row's job
 * (`items-center`), which is why the slot must not grow to the card's height.
 */
export function ChatRowLeadingIconSlot(props: {
  readonly children: ReactNode;
}) {
  return (
    // NOT `aria-hidden`. This slot was hidden while a trailing status chip
    // existed, because the two announced the same state and a read-only row
    // said "Read-only agent" twice. The row now carries no trailing chip, so
    // this icon is the row's ONLY status surface (`ChatProgressIcon` for chats,
    // the spinner / rollup for agents) - hiding it would drop running,
    // approval, failure, and read-only from the a11y tree entirely rather than
    // de-duplicating them. The status elements inside own their own
    // `role="status"` and accessible names; nothing here is focusable.
    <span className="inline-flex h-3.5 w-[1.125rem] shrink-0 items-center">
      {props.children}
    </span>
  );
}

/**
 * Keeps the archival state attached to the title rather than competing with
 * timestamps and controls in the trailing metadata cluster.
 */
function ArchivedTitlePrefix(): ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
      data-testid="chat-row-archived-label"
    >
      <span className="font-semibold">Archived</span>
      <span aria-hidden="true">·</span>
    </span>
  );
}
