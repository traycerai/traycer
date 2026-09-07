import type { ReactNode } from "react";

/** Rendered as a span (not a button/anchor) because `SegmentCard`/`SegmentRow` already wrap the whole header in a Radix `CollapsibleTrigger` `<button>`; nesting buttons is invalid HTML. */
export function AgentHeaderLink(props: {
  readonly name: string;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  const { name, onOpen } = props;
  if (onOpen === null) {
    return (
      <span className="min-w-0 truncate font-medium text-foreground/85">
        {name}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className="min-w-0 truncate rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {name}
    </span>
  );
}
