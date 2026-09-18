import type { MouseEvent, ReactNode } from "react";
import { Copy, Trash2 } from "lucide-react";

import { ComposerContentPreview } from "@/components/chat/composer/composer-content-preview";
import { Badge } from "@/components/ui/badge";
import { CommandItem } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import { useRelativeTimestamp } from "@/lib/relative-time";

/**
 * Marks a row element for the list's keyboard scroll-into-view. The control
 * reads it back through `dataset.draftRowId`, so the two spellings of the same
 * attribute live next to each other.
 */
export const DRAFT_ROW_SELECTOR = "[data-draft-row-id]";

interface DraftRowProps {
  readonly row: DraftInventoryRow;
  /** Where the draft came from, or `null` when the list is already scoped. */
  readonly sourceChip: string | null;
  /** Phones swap the key hints for tappable trailing buttons (D22). */
  readonly mobile: boolean;
  readonly onHighlight: () => void;
  readonly onOpen: () => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}

/**
 * The draft's text, wrapped and clamped to three lines, then a metadata line
 * with the row's provenance and its age. (D13 originally drew a derived title
 * above a one-line preview; for the usual one-line draft that printed the
 * same words twice.) Hover or highlight trades the age for the three actions,
 * which is the same swap the prompt stash used - the metadata and the actions
 * occupy one cell and cross-fade, so the row never reflows under the pointer.
 */
export function DraftRow(props: DraftRowProps) {
  const { row, sourceChip, mobile, onHighlight, onOpen, onCopy, onDelete } =
    props;
  const relative = useRelativeTimestamp(row.lastTouchedAt);
  return (
    <CommandItem
      value={row.id}
      data-draft-row-id={row.id}
      className="group/draft-row flex cursor-pointer flex-col items-stretch gap-0.5 overflow-hidden [&>svg:last-child]:hidden"
      // Desktop keeps editor focus while the list is open; on a phone the tap
      // has to reach vaul's own pointer handling.
      onPointerDown={mobile ? undefined : (event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onSelect={onOpen}
    >
      <DraftRowBody
        row={row}
        sourceChip={sourceChip}
        trailing={
          <DraftRowTrailing
            mobile={mobile}
            relative={relative}
            onOpen={onOpen}
            onCopy={onCopy}
            onDelete={onDelete}
          />
        }
      />
    </CommandItem>
  );
}

/** Content and metadata shared by the start-page picker and avatar dialog. */
export function DraftRowBody(props: {
  readonly row: DraftInventoryRow;
  readonly sourceChip: string | null;
  readonly trailing: ReactNode;
}) {
  const { row, sourceChip, trailing } = props;
  return (
    <>
      {/* The same read-only renderer the queue and the sent message use, so
          mention, slash-command and image chips survive the round trip
          instead of flattening to `@epic:<id>`. `emptyLabel` is the per-kind
          fallback for a draft with no nodes at all. */}
      <ComposerContentPreview
        content={row.content}
        emptyLabel={row.preview}
        testId="draft-row-content"
        className="line-clamp-3 w-full text-ui-sm leading-5 break-words"
      />
      <span className="flex w-full min-w-0 items-center gap-1.5 text-ui-xs leading-5 text-muted-foreground">
        <span className="min-w-0 flex-1" />
        {sourceChip === null ? null : (
          <Badge variant="secondary" size="xs" className="min-w-0">
            <span className="max-w-40 truncate">{sourceChip}</span>
          </Badge>
        )}
        {row.open ? (
          <Badge variant="secondary" size="xs" className="shrink-0">
            Open
          </Badge>
        ) : null}
        {trailing}
      </span>
    </>
  );
}

export function DraftRowTrailing(props: {
  readonly mobile: boolean;
  readonly relative: string;
  readonly onOpen: () => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}) {
  const { mobile, relative, onOpen, onCopy, onDelete } = props;
  if (mobile) {
    return (
      <span className="pointer-events-none relative flex shrink-0 items-center gap-0.5">
        <span className="tabular-nums">{relative}</span>
        <DraftRowIconButton label="Copy draft" onPress={onCopy}>
          <Copy className="size-3.5" aria-hidden />
        </DraftRowIconButton>
        <DraftRowIconButton label="Delete draft" onPress={onDelete}>
          <Trash2 className="size-3.5" aria-hidden />
        </DraftRowIconButton>
      </span>
    );
  }
  return (
    // ONE grid cell holding both layers, not an absolute overlay over the
    // timestamp: the cell then measures the WIDER of the two, so the row
    // reserves the space the action cluster needs and the preview beside it
    // truncates. An absolutely-positioned cluster left the cell sized to the
    // timestamp alone and painted over the source and `Open` badges.
    <span className="grid shrink-0 items-center justify-items-end">
      <span className="col-start-1 row-start-1 tabular-nums transition-opacity group-hover/draft-row:opacity-0 group-data-[selected=true]/draft-row:opacity-0">
        {relative}
      </span>
      <span className="group/draft-keys col-start-1 row-start-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/draft-row:opacity-100 group-data-[selected=true]/draft-row:opacity-100">
        <DraftRowKeyButton
          label="Open draft"
          word="Open"
          glyph="↵"
          shortcut="Enter"
          onPress={onOpen}
        />
        <DraftRowKeyButton
          label="Copy draft"
          word="Copy"
          glyph="C"
          shortcut="C"
          onPress={onCopy}
        />
        <DraftRowKeyButton
          label="Delete draft"
          word="Delete"
          glyph="D"
          shortcut="D"
          onPress={onDelete}
        />
      </span>
    </span>
  );
}

/**
 * A key cap that names itself on hover. The cluster is what the pointer has to
 * be over, not the individual cap: three words at once is the legend, and
 * revealing them one at a time as the pointer crosses would make the row
 * twitch.
 */
function DraftRowKeyButton(props: {
  readonly label: string;
  readonly word: string;
  readonly glyph: string;
  readonly shortcut: string;
  readonly onPress: () => void;
}) {
  const { label, word, glyph, shortcut, onPress } = props;
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      className="inline-flex h-5 items-center gap-1 rounded px-0.5 text-ui-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      onPointerDown={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
    >
      {/* D14: hover OR highlight. The cluster hover is the pointer's way in;
          the row's own selected state is the keyboard's, and without it a
          user arrowing down a list sees three bare key caps and no words. */}
      <span className="max-w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/draft-keys:max-w-16 group-hover/draft-keys:opacity-100 group-data-[selected=true]/draft-row:max-w-16 group-data-[selected=true]/draft-row:opacity-100">
        {word}
      </span>
      <ShortcutHint>
        <Kbd variant="mono" size="xs">
          {glyph}
        </Kbd>
      </ShortcutHint>
    </button>
  );
}

function DraftRowIconButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const { label, onPress, children } = props;
  return (
    <button
      type="button"
      aria-label={label}
      className="pointer-events-auto inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
    >
      {children}
    </button>
  );
}
