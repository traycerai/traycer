import { OrganizationDetails } from "@/components/organization/organization-metadata";
import type { CSSProperties } from "react";
import type { ReactNode } from "react";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import { SplitMemberChrome } from "./split-tab-chrome";
import { TabChromeBackground, TabColorMark } from "./tab-chrome-background";
import { useHeaderTabTitle } from "./header-tab-presentation";
import { TAB_BOX_CLASS } from "./tab-chrome-tokens";
import {
  tabAppearance,
  type HeaderTab,
  type HeaderTabAppearance,
} from "@/stores/tabs/types";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";
import { TabLeadingIcon } from "./tab-leading-icon";

/**
 * The active session tab's label and icon (L-163).
 *
 * `headerTabClassName` gives every active tab `text-foreground`, which is the
 * one colour that cannot sit on this tab: its fill is `--warning-foreground`
 * at full strength. The pair here is that fill's own counterpart, and contrast
 * is symmetric, so the label has exactly the ratio the palette already
 * guarantees for warning text on the background - measured per palette in
 * `layout-editor/__tests__/layout-editor-contrast.test.ts`, which reads this
 * constant rather than restating it.
 *
 * On the content wrapper rather than in `headerTabClassName`, because that
 * helper takes no session input and four call sites pass its two, while this
 * element is inside the visual that already knows - so the drag overlay and
 * the split preview, which render the same visual, are right for free.
 */
export const SESSION_TAB_LABEL_CLASS = "text-background";

interface HeaderTabVisualProps {
  readonly tab: HeaderTab;
  readonly appearance: HeaderTabAppearance | null;
  readonly indicatorState: NotificationIndicatorState;
  readonly displayName: string;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
  /** Whether the active tab runs into its task's sheet; see `TabChromeBackground`. */
  readonly joined: boolean;
  readonly titleControl: ReactNode;
  readonly trailingControl: ReactNode;
  readonly leaderVisible: boolean;
}

/** Shared tab paint; activation, drag registration and controls belong to callers. */
export function HeaderTabVisual(props: HeaderTabVisualProps) {
  const epicId = props.tab.kind === "epic" ? props.tab.epicId : null;
  const titleGenerationPending = useRegisteredEpicTitleGenerating(epicId);
  const activityStatus = useEpicActivityStatus(epicId);
  const color = props.appearance?.color ?? null;
  const sessionColor = props.tab.kind === "sample-workspace" ? color : null;
  return (
    <>
      {props.chrome === "own" ? (
        <TabChrome
          isActive={props.isActive}
          joined={props.joined}
          color={color}
          session={sessionColor !== null}
        />
      ) : (
        <SplitMemberChrome focused={props.isActive} color={color} />
      )}
      {sessionColor === null ? null : (
        <SessionTabMark color={sessionColor} isActive={props.isActive} />
      )}
      <span
        className={cn(
          "relative z-20 flex min-w-0 flex-1 items-center justify-center gap-1.5 outline-none group-data-[tab-layout=shrink]/strip:overflow-hidden",
          sessionColor !== null && props.isActive && SESSION_TAB_LABEL_CLASS,
        )}
      >
        <TabLeadingIcon
          icon={props.tab.icon}
          identity={props.appearance}
          titleGenerationPending={titleGenerationPending}
          activityStatus={activityStatus}
          indicatorState={props.indicatorState}
          tabId={props.tab.id}
        />
        {props.titleControl ?? (
          <span
            className="header-tab-label relative flex min-w-0 flex-1 items-center gap-1.5 text-left"
            data-leader-visible={props.leaderVisible}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="block min-w-0 flex-1">
                    <span
                      data-testid={`tab-title-${props.tab.kind}-${props.tab.id}`}
                      className="header-tab-title block"
                    >
                      <span className="header-tab-title-text">
                        {props.displayName}
                      </span>
                    </span>
                  </span>
                }
              />
              <TooltipContent>
                <div className="space-y-2">
                  <p>{props.displayName}</p>
                  {epicId ? (
                    <OrganizationDetails taskId={epicId} fallback={undefined} />
                  ) : null}
                </div>
              </TooltipContent>
            </Tooltip>
            {props.trailingControl}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * The marker on the one tab that is a MODE rather than a place (L-87): while
 * the sample workspace tab is open the user is customizing the layout, and
 * this is the editor's own chrome rather than another tab's colour.
 *
 * `data-layout-session-tab` is the half `layout-editor.css` reads, and it is
 * the reason this element exists at all: the tab strip's scroller dims its
 * members while a session is live, and the member holding this marker is the
 * one that stays lit. Without it the one signal that says "you are
 * customizing" was drawn at 45% opacity and 45% saturation (L-132). `:has()`
 * matches a `display: none` element, so one marker covers both states.
 *
 * What it PAINTS depends on the state, because only one of the two leaves it
 * anything to draw (L-138). At rest the tab wears the colour as a cap inside
 * its bottom edge, and this is that cap. Active, `TabChrome` fills the tab's
 * own silhouette with the same colour, so there is nothing left here to draw.
 */
function SessionTabMark(props: {
  readonly color: string;
  readonly isActive: boolean;
}) {
  return (
    <span
      aria-hidden
      // The state names itself and `layout-editor.css` paints it, beside the
      // dim rule that reads this same attribute. The tab's colour is the one
      // runtime value here, so it travels as a custom property and every fill
      // is a rule rather than a string built in JS.
      data-layout-session-tab={props.isActive ? "filled" : "rest"}
      // Where every tab's colour mark sits (F4), at the cap's own weight.
      className="pointer-events-none absolute bottom-1 left-1/2 w-6 -translate-x-1/2 rounded-full"
      style={{ "--layout-session-tab-color": props.color } as CSSProperties}
    />
  );
}

export function HeaderTabPreview(props: {
  readonly tab: HeaderTab;
  readonly ghost: HeaderTabDragGhost | null;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
  readonly joined: boolean;
}) {
  const { displayName } = useHeaderTabTitle(props.tab);
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.tab.kind === "epic" ? props.tab.epicId : props.tab.id },
    null,
  );
  return (
    <HeaderTabVisual
      {...props}
      appearance={
        props.ghost === null ? tabAppearance(props.tab) : props.ghost.appearance
      }
      indicatorState={props.ghost?.indicatorState ?? indicatorState}
      displayName={displayName}
      titleControl={null}
      trailingControl={null}
      leaderVisible={false}
    />
  );
}

export function SplitFillableMemberVisual(props: {
  readonly label: string;
  readonly focused: boolean;
}) {
  return (
    <>
      <SplitMemberChrome focused={props.focused} color={null} />
      <span className="header-tab-title-text relative z-20 min-w-0 flex-1 text-left italic">
        {props.label}
      </span>
    </>
  );
}

export function TabChrome(props: {
  readonly isActive: boolean;
  readonly joined: boolean;
  readonly color: string | null;
  /** The layout editor's own tab (L-87, L-163). See `borderColor` below. */
  readonly session: boolean;
}) {
  if (!props.isActive) {
    return (
      <>
        {props.color !== null && !props.session ? (
          <TabColorMark color={props.color} />
        ) : null}
        <span
          aria-hidden
          data-testid="tab-hover-box"
          className={cn(
            TAB_BOX_CLASS,
            "bg-foreground/5 opacity-0 transition-opacity duration-150 ease-out group-focus-visible/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 group-hover/tab:opacity-100",
          )}
        />
      </>
    );
  }
  // The editor's own tab is a mode, not a place: it keeps its coloured box
  // and never joins the sheet.
  const joined = props.joined && !props.session;
  return (
    <>
      <TabChromeBackground
        // ACTIVE, the editor's tab is the colour and wears none of it on its
        // edge (L-163): the fill is the token at full strength and the stroke is
        // the sheets' border, so the frame around the screen owns the only
        // amber LINE while a session is live and this tab is the only amber
        // OBJECT. A dilution cannot do that job: every share of the token over
        // `--background` trades the tab reading as coloured against its own
        // label staying legible on it, and the largest that clears 4.5:1 on all
        // the built-in palettes is 4.5% - a tab indistinguishable from the strip
        // it sits in. Nor can a stroke in the colour, because the frame's dotted
        // run and the tab's top edge share a line to within a quarter of a pixel
        // and read as one broken stroke.
        // `layout-editor-contrast.test.ts` measures the label on this fill.
        fill={
          props.session
            ? (props.color ?? "var(--color-background)")
            : "var(--color-background)"
        }
        borderColor={
          props.session
            ? "var(--canvas-border)"
            : (props.color ?? "var(--canvas-border)")
        }
        joined={joined}
        className="transition-opacity duration-300 ease-spring"
      />
      {/* Joined, the box's edge is the sheet's, so the tab's colour moves to
        the mark every other tab wears it as. */}
      {joined && props.color !== null ? (
        <TabColorMark color={props.color} />
      ) : null}
    </>
  );
}
