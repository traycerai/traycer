import { useCallback, type ReactNode } from "react";
import { NeedsYouItem } from "@/components/notifications/needs-you-item";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import { cn } from "@/lib/utils";
import {
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import {
  useNeedsYouItems,
  type NeedsYouItem as NeedsYouItemData,
} from "@/stores/notifications/needs-you-items";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import {
  SAMPLE_NEEDS_YOU_ITEMS,
  sampleNoop,
} from "@/components/sample-workspace/sample-workspace-scene";
import { useLiveAgentsInStrip } from "./live-agents-slot-store";
import { SIDE_STRIP_SECTION_LABEL_CLASS } from "./side-strip-tokens";

/**
 * The Activity view's Needs you block (D10, D13), pinned under the nav rows:
 * the same items as the Notifications drawer's Needs you group, from the same selector, and
 * only while there is one. A row opens its chat on the pending card through
 * the notification's own activation; nothing is approved or answered here.
 *
 * On the layout editor's canvas the strip frames the sample scene, so the
 * block lists the scene's prompts and the person's own are never read (B1).
 */
export function SideStripNeedsYou(): ReactNode {
  const shown = useLiveAgentsInStrip();
  const sample = useSampleScene();
  if (!shown) return null;
  if (sample)
    return (
      <NeedsYouBlock items={SAMPLE_NEEDS_YOU_ITEMS} onActivate={sampleNoop} />
    );
  return <LiveNeedsYou />;
}

function LiveNeedsYou(): ReactNode {
  const items = useNeedsYouItems();
  const activate = useNeedsYouActivation();
  return <NeedsYouBlock items={items} onActivate={activate} />;
}

function NeedsYouBlock(props: {
  readonly items: ReadonlyArray<NeedsYouItemData>;
  readonly onActivate: (row: MergedNotificationRow) => void;
}): ReactNode {
  const { items } = props;
  if (items.length === 0) return null;
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
            onActivate={props.onActivate}
          />
        ))}
      </div>
    </section>
  );
}

function useNeedsYouActivation(): (row: MergedNotificationRow) => void {
  const { activate } = useNotificationActivation();
  const { markAsRead } = useMergedNotificationsActions();
  return useCallback(
    (row: MergedNotificationRow) => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: Date.now(),
        feedId: row.feedId,
        originHostId: row.originHostId,
        onResult: activationResultHandler({
          row,
          feedId: row.feedId,
          surface: "strip",
          markAsRead,
          onSuccess: null,
        }),
      });
    },
    [activate, markAsRead],
  );
}
