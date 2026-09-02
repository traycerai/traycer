/**
 * The viewer's toolbar, in two tiers keyed on the TOOLBAR's own width (a
 * container query - a narrow split pane on a desktop has exactly the phone's
 * problem, so the viewport is the wrong thing to ask). Wide: every control
 * inline. Narrow (under `@lg`, 32rem): page nav, zoom and the surface's
 * own actions (Open Externally) stay inline - the escape hatch must never
 * fold away - while fit-width, rotate, outline and search move into one
 * "More actions" menu with the same labels.
 */
import { useRef, type ReactNode } from "react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export interface PdfPreviewToolbarProps {
  readonly fileName: string;
  readonly compact: boolean;
  readonly toolbarActions: ReactNode;
  readonly documentReady: boolean;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly pageInput: string;
  readonly onPageInputChange: (value: string) => void;
  readonly onPageInputCommit: () => void;
  readonly onGoToPage: (page: number) => void;
  readonly scalePercent: number | null;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFitWidth: () => void;
  readonly onRotate: () => void;
  readonly hasOutline: boolean;
  readonly outlineOpen: boolean;
  readonly onToggleOutline: () => void;
  readonly searchOpen: boolean;
  readonly onToggleSearch: () => void;
}

export function PdfPreviewToolbar(props: PdfPreviewToolbarProps): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="PDF preview controls"
      className="@container relative z-10 flex h-8 shrink-0 items-center justify-between gap-2 border-b border-canvas-border/70 px-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {props.hasOutline ? (
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
              aria-pressed={props.outlineOpen}
              onClick={props.onToggleOutline}
              aria-label="Document outline"
              className="@max-lg:hidden"
            >
              <ListTree className="size-4" />
            </Button>
          </TooltipWrapper>
        ) : null}
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
        <div className="flex items-center gap-1 text-ui-xs text-muted-foreground">
          <Input
            // Empty until pagesinit - a "1" next to "/ 0" reads as a
            // contradictory state, not a loading one.
            value={props.documentReady ? props.pageInput : ""}
            disabled={!props.documentReady}
            onChange={(event) => props.onPageInputChange(event.target.value)}
            onBlur={props.onPageInputCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onPageInputCommit();
            }}
            inputMode="numeric"
            aria-label="Page number"
            className="h-6 w-10 px-1 text-center text-ui-xs"
          />
          <span className="whitespace-nowrap">
            / {props.pageCount > 0 ? props.pageCount : "–"}
          </span>
        </div>
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
        <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
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
          >
            <Minus className="size-4" />
          </Button>
        </TooltipWrapper>
        <span
          className="min-w-9 whitespace-nowrap text-center text-ui-xs tabular-nums text-muted-foreground"
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
        <PdfPreviewOverflowMenu {...props} />
        {props.toolbarActions}
      </div>
    </div>
  );
}

/**
 * The narrow tier's home for the folded controls. Always mounted (its
 * trigger is what the container query shows or hides) so the wide and
 * narrow tiers never drift - they render from the same props.
 */
function PdfPreviewOverflowMenu(props: PdfPreviewToolbarProps): ReactNode {
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
        <DropdownMenuItem
          disabled={!props.documentReady}
          onSelect={props.onFitWidth}
        >
          <Scan className="size-4" />
          Fit to width
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!props.documentReady}
          onSelect={props.onRotate}
        >
          <RotateCw className="size-4" />
          Rotate 90°
        </DropdownMenuItem>
        {props.hasOutline ? (
          <DropdownMenuCheckboxItem
            checked={props.outlineOpen}
            onCheckedChange={props.onToggleOutline}
          >
            <ListTree className="size-4" />
            Document outline
          </DropdownMenuCheckboxItem>
        ) : null}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
