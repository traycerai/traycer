import { useState } from "react";
import {
  Bold,
  Italic,
  Underline,
  Link,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CanvasSelection } from "./canvas-selection-store";
import { useCanvasEditAction } from "./use-canvas-edit-action";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasBoardDocument } from "./canvas-board-document";
import {
  canvasRangeTags,
  canvasToolbarPosition,
  canvasHttpLink,
} from "./canvas-text-tools";
import { canvasRangeRefusal } from "./canvas-text-validation";

export function CanvasTextToolbar(props: {
  readonly selection: CanvasSelection;
  readonly document: CanvasBoardDocument | null;
  readonly inline?: boolean;
}) {
  const { selection } = props;
  const range = selection.textRange;
  const action = useCanvasEditAction(selection.artifactId);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  if (
    range === null ||
    range.start === range.end ||
    selection.element.generated
  )
    return null;
  const position = canvasToolbarPosition(range.rects, selection.element.box);
  const refusal = canvasRangeRefusal(props.document, selection);
  const active =
    props.document === null
      ? new Set<string>()
      : canvasRangeTags(props.document, selection);
  const format = (tag: "b" | "i" | "u" | "a", link: string | null): void => {
    if (refusal !== null) return;
    const edit: ArtboardEdit = active.has(tag)
      ? {
          kind: "unwrap-text-range",
          tag,
          start: range.start,
          end: range.end,
          expectedText: range.quote,
        }
      : {
          kind: "wrap-text-range",
          tag,
          start: range.start,
          end: range.end,
          href: link,
          expectedText: range.quote,
        };
    void action.apply(selection, edit);
  };
  return (
    <div
      className={cn(
        "z-20 max-w-full pointer-events-auto",
        !props.inline && "absolute",
      )}
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="flex flex-wrap items-center gap-1 rounded-md border bg-popover p-1 shadow-sm"
      >
        {(
          [
            { tag: "b", label: "Bold", Icon: Bold },
            { tag: "i", label: "Italic", Icon: Italic },
            { tag: "u", label: "Underline", Icon: Underline },
          ] as const
        ).map(({ tag, label, Icon }) => (
          <Button
            key={tag}
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={active.has(tag)}
            disabled={action.pending || refusal !== null}
            onClick={() => format(tag, null)}
          >
            <Icon />
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={active.has("a") ? "Remove link" : "Add link"}
          aria-pressed={active.has("a")}
          disabled={action.pending || refusal !== null}
          onClick={() =>
            active.has("a") ? format("a", null) : setLinkOpen(true)
          }
        >
          <Link />
        </Button>
        {(
          [
            { value: "left", label: "Align left", Icon: AlignLeft },
            { value: "center", label: "Align centre", Icon: AlignCenter },
            { value: "right", label: "Align right", Icon: AlignRight },
          ] as const
        ).map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={action.pending || refusal !== null}
            onClick={() => {
              if (refusal !== null) return;
              void action.apply(selection, {
                kind: "set-style",
                property: "text-align",
                value,
              });
            }}
          >
            <Icon />
          </Button>
        ))}
      </div>
      {linkOpen ? (
        <form
          aria-label="Link address"
          className="mt-1 flex items-center gap-1 rounded-md border bg-popover p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canvasHttpLink(href)) {
              setUrlError("Enter an http or https address.");
              return;
            }
            setUrlError(null);
            format("a", href);
            setLinkOpen(false);
          }}
        >
          <Input
            aria-label="Link URL"
            size="sm"
            type="url"
            value={href}
            onChange={(event) => setHref(event.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={action.pending || refusal !== null}
          >
            Apply link
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setUrlError(null);
              setLinkOpen(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {(refusal ?? urlError ?? action.message) ? (
        <p
          role="status"
          className="rounded border bg-popover p-2 text-ui-xs text-destructive"
        >
          {refusal ?? urlError ?? action.message}
        </p>
      ) : null}
    </div>
  );
}
