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
import type { HeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";

interface SplitTabDragOverlayProps {
  readonly ghost: HeaderTabDragGhost | null;
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly width: number | null;
  readonly source: HeaderTabDragData;
  readonly isActive: boolean;
  readonly tearOff: boolean;
}

export function SplitTabDragOverlay(props: SplitTabDragOverlayProps) {
  const { item } = props;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const geometryRef = useRef<{
    offset: number;
    memberWidth: number | null;
  } | null>(null);
  const { tabKind, tabId } = props.source;
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    if (geometryRef.current === null) {
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
      geometryRef.current = {
        offset,
        memberWidth: source?.getBoundingClientRect().width ?? null,
      };
    }
    const geometry = geometryRef.current;
    overlay.style.transform = `translateX(${props.tearOff ? 0 : geometry.offset}px)`;
    const width = props.tearOff ? geometry.memberWidth : props.width;
    overlay.style.width = width === null ? "" : `${width}px`;
  }, [tabId, tabKind, props.tearOff, props.width]);
  const draggedMember = [item.left, item.right].find(
    (member) =>
      member.kind === "tab" &&
      member.tab.kind === tabKind &&
      member.tab.id === tabId,
  );
  const firstMember = [item.left, item.right].find(
    (member) => member.kind === "tab",
  );
  const firstTab = firstMember?.kind === "tab" ? firstMember.tab : null;
  return (
    <div
      ref={overlayRef}
      data-testid="header-tab-drag-overlay"
      className="pointer-events-none relative w-[min(60vw,31rem)] cursor-grabbing select-none [container-type:inline-size]"
      style={props.width === null ? undefined : { width: props.width }}
    >
      {props.tearOff && draggedMember?.kind === "tab" ? (
        <div className={headerTabClassName("own", true)}>
          <HeaderTabPreview
            tab={draggedMember.tab}
            ghost={props.ghost}
            chrome="own"
            isActive
          />
        </div>
      ) : (
        <SplitTabLayout
          color={firstTab?.appearance?.color ?? null}
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
              <SplitFocusIcon
                splitId={item.id}
                focusedSide={item.focusedSide}
              />
            </span>
          }
          left={
            <SplitMemberOverlay
              member={item.left}
              ghost={item.left === draggedMember ? props.ghost : null}
              focused={props.isActive ? item.focusedSide === "left" : false}
            />
          }
          right={
            <SplitMemberOverlay
              member={item.right}
              ghost={item.right === draggedMember ? props.ghost : null}
              focused={props.isActive ? item.focusedSide === "right" : false}
            />
          }
        />
      )}
    </div>
  );
}

function SplitMemberOverlay(props: {
  readonly ghost: HeaderTabDragGhost | null;
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
      <HeaderTabPreview
        tab={member.tab}
        ghost={props.ghost}
        chrome="member"
        isActive={focused}
      />
    </div>
  );
}
