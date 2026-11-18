import type { ReactNode } from "react";

// This module imports nothing but React. cloud-ui-v2's homepage demo renders
// `AgentHeaderLink` from source, on the server too, where a store reached
// from here throws at import. Anything that reads app state goes in its own
// module, as `a2a-peer-picture.tsx` does.

/**
 * Clickable agent name used inside an A2A send/received segment header.
 * Rendered as a span (not a button/anchor) because `SegmentCard`/`SegmentRow`
 * already wrap the whole header in a Radix `CollapsibleTrigger` `<button>`;
 * nesting buttons is invalid HTML. `role="button"` + keydown keep it
 * keyboard-operable as a link. Falls back to plain text when `onOpen` is
 * null (no resolvable target - e.g. a cross-host agent not in this epic's
 * projection).
 */
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
