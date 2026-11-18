import type { ReactNode } from "react";
import { TracyGlyph } from "@/components/bots/tracy-glyph";
import { cn } from "@/lib/utils";

/**
 * The Tracy entry's glyph as a tab's icon. `className` styles the wrapper
 * only: the glyph stays 16 px, its smallest whole-pixel size, in any slot.
 */
export function TracyTabIcon(props: {
  readonly className: string | undefined;
}): ReactNode {
  return (
    <span className={cn("inline-flex shrink-0", props.className)}>
      <TracyGlyph size="xs" className={undefined} />
    </span>
  );
}
