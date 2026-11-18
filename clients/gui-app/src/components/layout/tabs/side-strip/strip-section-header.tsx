import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import {
  SIDE_STRIP_NEEDS_YOU_CHIP_ROW_CLASS,
  SIDE_STRIP_SECTION_HEADER_CLASS,
  SIDE_STRIP_STICKY_SECTION_HEADER_CLASS,
} from "./side-strip-tokens";
import { useStripSectionFolded } from "./strip-section-fold";
import { STRIP_SECTION_LABEL, type StripSection } from "./strip-sections";

/**
 * One Activity-view section's header: a button holding its name and how many
 * tasks it lists, which folds the section for the app session. It sits in the
 * tablist but is not a tab. Only Needs you is amber, the one header that asks
 * something of the person. The chevron eases over 120ms for a pointer and
 * not at all for a keyboard fold. Its row sticks to the top of the list, and
 * while it is the one stuck there with Needs you scrolled away above, the row
 * also holds the "↑ N need you" chip, a button of its own beside the fold.
 */
export function StripSectionHeader(props: {
  readonly section: StripSection;
  readonly count: number;
  /** The chip this row holds, or `null`. */
  readonly chip: ReactNode | null;
}): ReactNode {
  const { section } = props;
  const [folded, toggle] = useStripSectionFolded(section);
  const [viaPointer, setViaPointer] = useState(false);
  const motionEnabled = useMotionEnabled();
  return (
    <div
      data-strip-section-row={section}
      className={cn("relative", SIDE_STRIP_STICKY_SECTION_HEADER_CLASS)}
    >
      <button
        type="button"
        data-testid={`side-strip-section-${section}`}
        data-strip-section={section}
        aria-expanded={!folded}
        onClick={(event) => {
          // A keyboard click has no pointer position or click count.
          setViaPointer(event.detail > 0);
          toggle();
        }}
        className={cn(
          SIDE_STRIP_SECTION_HEADER_CLASS,
          section === "needs-you"
            ? "text-warning-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            !folded && "rotate-90",
            viaPointer &&
              motionEnabled &&
              "transition-transform duration-120 ease-out",
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          {STRIP_SECTION_LABEL[section]}
        </span>
        <span className="tabular-nums">{props.count}</span>
      </button>
      {props.chip === null ? null : (
        <span className={SIDE_STRIP_NEEDS_YOU_CHIP_ROW_CLASS}>
          <span className="pointer-events-auto flex">{props.chip}</span>
          {/* The count's own room, so the chip ends where the count starts. */}
          <span aria-hidden className="invisible tabular-nums">
            {props.count}
          </span>
        </span>
      )}
    </div>
  );
}
