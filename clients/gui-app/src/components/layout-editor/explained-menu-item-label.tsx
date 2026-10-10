import type { ReactNode } from "react";

/**
 * An off menu item's label with its reason under it (`explained-menu-item.ts`).
 * The reason is `aria-hidden`, so it stays out of the item's name;
 * `aria-describedby` still reads a hidden node's text, so it is heard after
 * the name.
 */
export function ExplainedMenuItemLabel(props: {
  readonly label: string;
  readonly reason: string | null;
  readonly reasonId: string;
}): ReactNode {
  const { label, reason, reasonId } = props;
  if (reason === null) return label;
  return (
    <span className="flex min-w-0 flex-col">
      {label}
      <span
        id={reasonId}
        aria-hidden
        className="text-ui-xs text-muted-foreground"
      >
        {reason}
      </span>
    </span>
  );
}
