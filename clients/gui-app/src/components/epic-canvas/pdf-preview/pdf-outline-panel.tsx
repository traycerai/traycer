/**
 * Document-outline sidebar for `PdfPreview` (the navigation pane every
 * serious PDF reader grows): renders the tree `PDFDocumentProxy.getOutline`
 * returns, and delegates navigation back to the viewer through a callback
 * so this component stays pure - no pdf.js import, which keeps it testable
 * outside the lazy chunk.
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Structural subset of pdf.js's outline nodes (`getOutline()` items) - the
 * fields navigation needs. `dest` is an internal destination for
 * `PDFLinkService.goToDestination`; `url` marks an external link instead.
 */
export interface PdfOutlineEntry {
  readonly title: string;
  readonly dest: string | unknown[] | null;
  readonly url: string | null;
  readonly items: readonly PdfOutlineEntry[];
}

/**
 * An outline never reorders within one document, so a tree-path key is
 * stable for the document's lifetime - titles alone cannot key the rows
 * (real outlines repeat titles like "Summary" per chapter).
 */
interface KeyedOutlineNode {
  readonly key: string;
  readonly entry: PdfOutlineEntry;
  readonly children: readonly KeyedOutlineNode[];
}

function keyOutline(
  items: readonly PdfOutlineEntry[],
  prefix: string,
): readonly KeyedOutlineNode[] {
  return items.map((entry, index) => ({
    key: `${prefix}${index}`,
    entry,
    children: keyOutline(entry.items, `${prefix}${index}.`),
  }));
}

function OutlineRow(props: {
  readonly node: KeyedOutlineNode;
  readonly depth: number;
  readonly onNavigate: (
    entry: PdfOutlineEntry,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}): ReactNode {
  const { node, depth, onNavigate } = props;
  // Mirror the browser viewers' default: top-level chapters open, deeper
  // levels collapsed until asked for.
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className="flex min-w-0 items-center"
        style={{ paddingInlineStart: `${depth * 0.75}rem` }}
      >
        {hasChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 shrink-0"
            aria-label={expanded ? "Collapse section" : "Expand section"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </Button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left text-ui-xs",
            "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
          )}
          onClick={(event) => onNavigate(node.entry, event)}
        >
          {node.entry.title}
        </button>
      </div>
      {hasChildren && expanded ? (
        <ul>
          {node.children.map((child) => (
            <OutlineRow
              key={child.key}
              node={child}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PdfOutlinePanel(props: {
  readonly items: readonly PdfOutlineEntry[];
  readonly onNavigate: (
    entry: PdfOutlineEntry,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}): ReactNode {
  const keyedItems = useMemo(() => keyOutline(props.items, ""), [props.items]);
  return (
    <nav
      aria-label="Document outline"
      className="h-full overflow-y-auto border-r border-canvas-border/70 py-1 pr-1"
      data-testid="pdf-outline-panel"
    >
      <ul>
        {keyedItems.map((node) => (
          <OutlineRow
            key={node.key}
            node={node}
            depth={0}
            onNavigate={props.onNavigate}
          />
        ))}
      </ul>
    </nav>
  );
}
