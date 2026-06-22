import { type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared inline chip for the legacy `<traycer-*>` reference components. Mirrors
 * the visual treatment of the prior `TraycerFileReference` chip: a small inline
 * button with an icon and the model-authored label.
 *
 * When `onOpen` is `null` the reference is not openable (missing id, no epic
 * context, or an unresolved same-epic node) and the chip degrades to the plain
 * label text - no button, no dead click.
 */
export function TraycerReferenceChip(props: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly title: string | undefined;
  readonly refKind: "spec" | "ticket" | "chat" | "epic";
  readonly onOpen: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
}) {
  if (props.onOpen === null) {
    return <span>{props.children}</span>;
  }
  return (
    <button
      type="button"
      onClick={props.onOpen}
      title={props.title}
      data-traycer-ref={props.refKind}
      className={cn(
        "mx-px inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 align-baseline text-ui-sm font-medium text-foreground/90 no-underline",
        "transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {props.icon}
      </span>
      <span className="truncate">{props.children}</span>
    </button>
  );
}
