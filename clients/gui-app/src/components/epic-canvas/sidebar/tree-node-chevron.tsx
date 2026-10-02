import type { MouseEvent, ReactNode } from "react";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { useChatTreeSurface } from "@/components/epic-canvas/sidebar/chat-tree-surface";

export interface NodeChevronProps {
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: (event: MouseEvent<HTMLSpanElement>) => void;
}

/**
 * The expand/collapse control of one tree row, shared by the local chat row
 * and the cloud chat row so a nested subagent looks and toggles the same
 * whichever list its parent arrived from.
 *
 * A childless row draws the spacer, which keeps its icon in the same column
 * as its siblings' chevrons.
 */
export function NodeChevron(props: NodeChevronProps): ReactNode {
  const { hasChildren, expanded, onToggle } = props;
  const surface = useChatTreeSurface();
  if (!hasChildren) return <TreeChevronSpacer />;
  if (surface === null) {
    return <TreeChevron expanded={expanded} onToggle={onToggle} />;
  }
  // Desktop's chevron is an 11.25px glyph INSIDE the row button, which is fine
  // for a cursor and not for a thumb: a near-miss lands on the row instead, and
  // on a surface that closes itself on activation that miss dismisses the sheet
  // rather than merely doing nothing. So the hit box grows and the glyph does
  // not - an absolutely-positioned pseudo takes no space in flow, so the column
  // stays desktop's exact width and the density ruling is untouched. `onToggle`
  // moves to this wrapper so one handler owns the whole enlarged box; it
  // already stops propagation, which is what keeps the row from opening.
  return (
    <span
      // Same `aria-hidden` the glyph inside already carries: this wrapper adds
      // hit area and nothing else, so exposing a second nameless control would
      // be noise rather than access.
      //
      // It does NOT claim keyboard reachability. Expansion in this tree is
      // pointer-only on BOTH form factors - desktop binds no ArrowRight/Left
      // and neither does the row button - so a keyboard-only user cannot open
      // a collapsed branch here. That gap is desktop's and predates this
      // mount; what the mount changed is that a phone now inherits it, where
      // the flat list it replaced had listed every descendant outright.
      aria-hidden="true"
      onClick={onToggle}
      className="relative inline-flex cursor-pointer before:absolute before:-inset-2 before:content-['']"
    >
      <TreeChevron expanded={expanded} onToggle={undefined} />
    </span>
  );
}
