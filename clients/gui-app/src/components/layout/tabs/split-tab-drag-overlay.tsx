import { splitSlotLabel } from "./header-tab-presentation";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import { SplitFocusIcon, SplitTabLayout } from "./split-tab-chrome";
import {
  headerTabClassName,
  splitFillableMemberClassName,
  SPLIT_TAB_CONTROL_CLASS,
} from "./tab-chrome-tokens";
import {
  HeaderTabPreview,
  SplitFillableMemberVisual,
} from "./header-tab-visual";
import type { HeaderTabDragData } from "./header-tab-dnd";

interface SplitTabDragOverlayProps {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly width: number | null;
  readonly source: HeaderTabDragData;
  readonly isActive: boolean;
}

export function SplitTabDragOverlay(props: SplitTabDragOverlayProps) {
  const { item } = props;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const { tabKind, tabId } = props.source;
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const source = Array.from(
      document.querySelectorAll<HTMLElement>("[data-tab-kind]"),
    ).find((element) => element.dataset.testid === `tab-${tabKind}-${tabId}`);
    const frame = source?.closest<HTMLElement>("[data-strip-item-id]");
    // dnd-kit anchors to the grabbed member. Move only the preview's paint
    // back to the group origin without changing the measured drag rectangle.
    const offset =
      source === undefined || frame === null || frame === undefined
        ? 0
        : frame.getBoundingClientRect().left -
          source.getBoundingClientRect().left;
    overlay.style.transform = `translateX(${offset}px)`;
  }, [tabId, tabKind]);
  return (
    <div
      ref={overlayRef}
      data-testid="header-tab-drag-overlay"
      className="pointer-events-none relative w-[min(60vw,31rem)] cursor-grabbing select-none [container-type:inline-size]"
      style={props.width === null ? undefined : { width: props.width }}
    >
      <SplitTabLayout
        splitId={item.id}
        selectedSide={props.isActive ? item.focusedSide : null}
        control={
          <span
            className={cn(
              SPLIT_TAB_CONTROL_CLASS,
              props.isActive
                ? "text-blue-600 dark:text-blue-300"
                : "text-muted-foreground",
            )}
          >
            <SplitFocusIcon splitId={item.id} focusedSide={item.focusedSide} />
          </span>
        }
        left={
          <SplitMemberOverlay
            member={item.left}
            focused={props.isActive ? item.focusedSide === "left" : false}
          />
        }
        right={
          <SplitMemberOverlay
            member={item.right}
            focused={props.isActive ? item.focusedSide === "right" : false}
          />
        }
      />
    </div>
  );
}

function SplitMemberOverlay(props: {
  readonly member: HeaderStripMember;
  readonly focused: boolean;
}) {
  const { member, focused } = props;
  if (member.kind === "fillable") {
    return (
      <div className={splitFillableMemberClassName(focused)}>
        <SplitFillableMemberVisual
          focused={focused}
          label={splitSlotLabel(member.slot)}
        />
      </div>
    );
  }
  return (
    <div className={headerTabClassName("member", focused)}>
      <HeaderTabPreview tab={member.tab} chrome="member" isActive={focused} />
    </div>
  );
}
