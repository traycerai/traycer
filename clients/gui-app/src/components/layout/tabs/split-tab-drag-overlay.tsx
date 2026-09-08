import { useLayoutEffect, useRef } from "react";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import {
  SplitFocusIcon,
  SplitMemberChrome,
  SplitTabLayout,
} from "./split-tab-chrome";
import {
  SPLIT_MEMBER_CLASS,
  SPLIT_TAB_CONTROL_CLASS,
  TAB_CLASS_BASE,
} from "./tab-chrome-tokens";
import type { HeaderTabDragData } from "./header-tab-dnd";

interface SplitTabDragOverlayProps {
  readonly item: Extract<HeaderStripItem, { readonly kind: "split" }>;
  readonly width: number | null;
  readonly source: HeaderTabDragData;
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
        selectedSide={item.focusedSide}
        control={
          <span
            className={cn(
              SPLIT_TAB_CONTROL_CLASS,
              "text-blue-600 dark:text-blue-300",
            )}
          >
            <SplitFocusIcon splitId={item.id} focusedSide={item.focusedSide} />
          </span>
        }
        left={
          <SplitMemberOverlay
            member={item.left}
            focused={item.focusedSide === "left"}
          />
        }
        right={
          <SplitMemberOverlay
            member={item.right}
            focused={item.focusedSide === "right"}
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
  const tab = member.kind === "tab" ? member.tab : null;
  const Icon = tab?.icon ?? null;
  const name = splitMemberTitle(member);
  return (
    <div
      className={cn(
        TAB_CLASS_BASE,
        SPLIT_MEMBER_CLASS,
        focused ? "z-10 text-foreground" : "text-muted-foreground",
        focused && tab !== null && "font-medium",
      )}
    >
      <SplitMemberChrome focused={focused} />
      <span className="relative z-20 flex min-w-0 flex-1 items-center gap-1.5">
        {Icon === null ? null : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            member.kind === "fillable" && "italic",
          )}
        >
          {name}
        </span>
      </span>
    </div>
  );
}

function splitMemberTitle(member: HeaderStripMember): string {
  if (member.kind === "fillable") {
    return member.slot.kind === "unavailable"
      ? member.slot.label
      : "Choose view";
  }
  return member.tab.kind === "epic"
    ? displayTitle(member.tab.name, "epic")
    : member.tab.name;
}
