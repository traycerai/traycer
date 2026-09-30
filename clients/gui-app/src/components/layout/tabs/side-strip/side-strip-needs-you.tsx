import type { ReactNode } from "react";
import { NeedsYouItem } from "@/components/notifications/needs-you-item";
import { cn } from "@/lib/utils";
import type { NeedsYouItem as NeedsYouItemData } from "@/stores/notifications/needs-you-items";
import { useStripPinnedNeedsYou } from "./strip-needs-you-context";
import { SIDE_STRIP_SECTION_LABEL_CLASS } from "./side-strip-tokens";
import { useNeedsYouActivation } from "./use-needs-you-activation";

/**
 * The Activity view's Needs you block (D10, D13), pinned under the nav rows:
 * the prompts of the Notifications drawer's Needs you group whose task has no
 * row in the strip, from the strip's one read; a task's own row nests the rest.
 * Shown only while there is one. A row opens its chat on the pending card
 * through the notification's own activation; nothing is approved or answered
 * here.
 */
export function SideStripNeedsYou(): ReactNode {
  const items = useStripPinnedNeedsYou();
  if (items.length === 0) return null;
  return <NeedsYouBlock items={items} />;
}

function NeedsYouBlock(props: {
  readonly items: ReadonlyArray<NeedsYouItemData>;
}): ReactNode {
  const { items } = props;
  const onActivate = useNeedsYouActivation();
  return (
    <section aria-label="Needs you" data-testid="side-strip-needs-you">
      <div
        className={cn(
          SIDE_STRIP_SECTION_LABEL_CLASS,
          "flex items-center text-muted-foreground",
        )}
      >
        <span className="min-w-0 flex-1">Needs you</span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      {/* Capped, so a long queue scrolls here and never pushes the tabs away. */}
      <div className="no-scrollbar flex max-h-[40vh] flex-col overflow-y-auto [-webkit-app-region:no-drag]">
        {items.map((item) => (
          <NeedsYouItem
            key={item.row.feedId}
            item={item}
            onActivate={onActivate}
          />
        ))}
      </div>
    </section>
  );
}
