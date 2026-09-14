/**
 * The one toolbar both document viewers (PDF, Word) render, so the two read
 * as the same surface: page navigation, zoom, fit-to-width and search in the
 * same places, folding the same way. What differs per viewer is declared,
 * not forked: an outline toggle and a rotate action exist only where the
 * renderer offers them (`outline`, `onRotate`), and search is withheld on an
 * engine that cannot paint it (`searchSupported`).
 *
 * Three tiers keyed on the TOOLBAR's own width (a container query - a narrow
 * split pane on a desktop has exactly the phone's problem, so the viewport
 * is the wrong thing to ask). Wide: every control inline. Narrow (under
 * `@lg`, 32rem): fit-width, rotate, outline and search move into one "More
 * actions" menu with the same labels. Narrowest (under `@sm`, 24rem - a tile
 * pane can be dragged to 240px): zoom folds into the menu too, leaving page
 * nav and the surface's own actions (Open Externally) inline - the escape
 * hatch must never fold away.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ListTree,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  Scan,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export interface DocumentOutlineToggle {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export interface DocumentPreviewToolbarProps {
  /** The landmark's accessible name, e.g. "PDF preview controls". */
  readonly ariaLabel: string;
  readonly fileName: string;
  readonly compact: boolean;
  readonly toolbarActions: ReactNode;
  readonly documentReady: boolean;
  /** 1-based; the viewer keeps it current as the user scrolls. */
  readonly pageNumber: number;
  /** `0` until the document is ready. */
  readonly pageCount: number;
  readonly onGoToPage: (page: number) => void;
  readonly scalePercent: number | null;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFitWidth: () => void;
  /** `null` on a renderer that cannot rotate pages. */
  readonly onRotate: (() => void) | null;
  /** `null` when the document has no outline to show. */
  readonly outline: DocumentOutlineToggle | null;
  /** `false` on an engine without document search - the control is not offered at all. */
  readonly searchSupported: boolean;
  readonly searchOpen: boolean;
  readonly onToggleSearch: () => void;
}

export function DocumentPreviewToolbar(
  props: DocumentPreviewToolbarProps,
): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label={props.ariaLabel}
      className="@container relative z-10 flex h-8 shrink-0 items-center justify-between gap-2 border-b border-canvas-border/70 px-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {props.outline === null ? null : (
          <TooltipWrapper
            label="Document outline"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={props.outline.open}
              onClick={props.outline.onToggle}
              aria-label="Document outline"
              className="@max-lg:hidden"
            >
              <ListTree className="size-4" />
            </Button>
          </TooltipWrapper>
        )}
        {props.compact ? null : (
          <StartTruncatedText className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
            {props.fileName}
          </StartTruncatedText>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <TooltipWrapper
          label="Previous page"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!props.documentReady || props.pageNumber <= 1}
            onClick={() => props.onGoToPage(props.pageNumber - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
        </TooltipWrapper>
        <PageNumberField
          documentReady={props.documentReady}
          pageNumber={props.pageNumber}
          pageCount={props.pageCount}
          onGoToPage={props.onGoToPage}
        />
        <TooltipWrapper
          label="Next page"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={
              !props.documentReady || props.pageNumber >= props.pageCount
            }
            onClick={() => props.onGoToPage(props.pageNumber + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </Button>
        </TooltipWrapper>
        <div
          className="mx-0.5 h-4 w-px bg-border @max-sm:hidden"
          aria-hidden="true"
        />
        <TooltipWrapper
          label="Zoom out"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!props.documentReady}
            onClick={props.onZoomOut}
            aria-label="Zoom out"
            className="@max-sm:hidden"
          >
            <Minus className="size-4" />
          </Button>
        </TooltipWrapper>
        <span
          className="min-w-9 whitespace-nowrap text-center text-ui-xs tabular-nums text-muted-foreground @max-sm:hidden"
          aria-label="Zoom level"
        >
          {props.scalePercent === null ? "–" : `${props.scalePercent}%`}
        </span>
        <TooltipWrapper
          label="Zoom in"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!props.documentReady}
            onClick={props.onZoomIn}
            aria-label="Zoom in"
            className="@max-sm:hidden"
          >
            <Plus className="size-4" />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Fit to width"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!props.documentReady}
            onClick={props.onFitWidth}
            aria-label="Fit to width"
            className="@max-lg:hidden"
          >
            <Scan className="size-4" />
          </Button>
        </TooltipWrapper>
        {props.onRotate === null ? null : (
          <TooltipWrapper
            label="Rotate 90°"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!props.documentReady}
              onClick={props.onRotate}
              aria-label="Rotate"
              className="@max-lg:hidden"
            >
              <RotateCw className="size-4" />
            </Button>
          </TooltipWrapper>
        )}
        {props.searchSupported ? (
          <>
            <div
              className="mx-0.5 h-4 w-px bg-border @max-lg:hidden"
              aria-hidden="true"
            />
            <TooltipWrapper
              label="Search document"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!props.documentReady}
                aria-pressed={props.searchOpen}
                onClick={props.onToggleSearch}
                aria-label="Search document"
                className="@max-lg:hidden"
              >
                <Search className="size-4" />
              </Button>
            </TooltipWrapper>
          </>
        ) : null}
        <DocumentPreviewOverflowMenu {...props} />
        {props.toolbarActions}
      </div>
    </div>
  );
}

interface PageNumberFieldProps {
  readonly documentReady: boolean;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly onGoToPage: (page: number) => void;
}

/**
 * The "n / N" field. While the user is typing, the field shows their draft;
 * otherwise it mirrors the viewer's current page. A commit (Enter or blur)
 * clamps the draft into range and hands it to the viewer - clamping here,
 * not only in the viewer, because a commit that lands on the page already
 * shown produces no page change to resync the field from, and "99" would
 * otherwise stay on a 5-page document.
 */
function PageNumberField(props: PageNumberFieldProps): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    const parsed = Number.parseInt(draft, 10);
    if (Number.isNaN(parsed)) return;
    props.onGoToPage(Math.min(Math.max(parsed, 1), props.pageCount));
  };

  // Empty until the document is ready - a "1" next to "/ –" reads as a
  // contradictory state, not a loading one.
  const shown = props.documentReady ? (draft ?? String(props.pageNumber)) : "";

  return (
    <div className="flex items-center gap-1 text-ui-xs text-muted-foreground">
      <Input
        value={shown}
        disabled={!props.documentReady}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        inputMode="numeric"
        aria-label="Page number"
        className="h-6 w-10 px-1 text-center text-ui-xs"
      />
      <span className="whitespace-nowrap">
        / {props.pageCount > 0 ? props.pageCount : "–"}
      </span>
    </div>
  );
}

/**
 * The narrow tiers' home for the folded controls. Always mounted (its
 * trigger is what the container query shows or hides) so the wide and
 * narrow tiers never drift - they render from the same props. Zoom is
 * listed unconditionally rather than only under the narrowest tier: the
 * menu content is portalled out of the toolbar, so no container query can
 * reach it, and a duplicate zoom entry in the 24-32rem band is harmless.
 */
function DocumentPreviewOverflowMenu(
  props: DocumentPreviewToolbarProps,
): ReactNode {
  // Picking Search opens a row whose input takes focus in the same commit.
  // Two Radix behaviors would steal it back: the close-time return of focus
  // to the trigger (prevented below), and - verified live - a MODAL menu's
  // focus trap, which stays armed through the close animation and yanks
  // focus back into the menu, leaving it on <body> once the menu unmounts.
  // Non-modal: no trap, and a toolbar menu needs no pointer lockdown.
  const keepFocusAwayRef = useRef(false);
  return (
    <DropdownMenu modal={false}>
      <TooltipWrapper
        label="More actions"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            className="hidden @max-lg:inline-flex"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (keepFocusAwayRef.current) {
            event.preventDefault();
            keepFocusAwayRef.current = false;
          }
        }}
      >
        {/* Zoom is a repeated gesture - keep the menu open across picks so
            three steps in is three clicks, not three menu reopenings. */}
        <DropdownMenuItem
          disabled={!props.documentReady}
          onSelect={(event) => {
            event.preventDefault();
            props.onZoomIn();
          }}
        >
          <Plus className="size-4" />
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!props.documentReady}
          onSelect={(event) => {
            event.preventDefault();
            props.onZoomOut();
          }}
        >
          <Minus className="size-4" />
          Zoom out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!props.documentReady}
          onSelect={props.onFitWidth}
        >
          <Scan className="size-4" />
          Fit to width
        </DropdownMenuItem>
        {props.onRotate === null ? null : (
          <DropdownMenuItem
            disabled={!props.documentReady}
            onSelect={props.onRotate}
          >
            <RotateCw className="size-4" />
            Rotate 90°
          </DropdownMenuItem>
        )}
        {props.outline === null ? null : (
          <DropdownMenuCheckboxItem
            checked={props.outline.open}
            onCheckedChange={props.outline.onToggle}
          >
            <ListTree className="size-4" />
            Document outline
          </DropdownMenuCheckboxItem>
        )}
        {props.searchSupported ? (
          <DropdownMenuCheckboxItem
            disabled={!props.documentReady}
            checked={props.searchOpen}
            onCheckedChange={() => {
              keepFocusAwayRef.current = !props.searchOpen;
              props.onToggleSearch();
            }}
          >
            <Search className="size-4" />
            Search document
          </DropdownMenuCheckboxItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
