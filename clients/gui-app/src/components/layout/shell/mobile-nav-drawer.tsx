import { type ReactNode, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { LogOut, Pin, Settings, SquareArrowOutUpRight } from "lucide-react";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { MobileNavDrawerSurface } from "@/components/layout/shell/mobile-nav-drawer-surface";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { isMobileApp } from "@/lib/mobile-app";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useRunnerHost } from "@/providers/use-runner-host";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import {
  activateTabIntent,
  openPhaseMigrationIntent,
} from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { epicDisplayTitle } from "@/lib/display-title";
import { useAmbientHistorySearchState } from "@/hooks/home/use-history-search-state";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const ROW_CLASS = "h-11 w-full justify-start gap-3 px-3";

// The task scroller fades its bottom edge rather than slicing a row against the
// footer's border. The list carries matching bottom padding, so the gradient
// only ever covers blank space - at full scroll the last row stays crisp.
const LIST_FADE_CLASS =
  "[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

/**
 * Left hamburger drawer for the mobile shell. It re-homes the global controls
 * that the desktop header carries (Settings, identity / account) into a single
 * menu, plus a "New task" entry and an inline recent task list (the same
 * `useHistoryQuery` source the landing page renders), since the tab strip and
 * header right-cluster are hidden on phones. Manage subscription and Sign out
 * ride the identity row as icons; notifications stay in the header next to the
 * other status controls (`MobileNotificationsButton`). Every action reuses the
 * same helper the desktop surfaces call. Mounted only on mobile (see
 * AppShell), so desktop is untouched.
 */
export function MobileNavDrawer(): ReactNode {
  const open = useMobileNavStore((state) => state.open);
  const setOpen = useMobileNavStore((state) => state.setOpen);
  const navigate = useNavigate();
  const profile = useAuthStore((state) => state.profile);
  const { openSettings } = useSystemTabModalActions();
  const runnerHost = useRunnerHost();
  const [signOutOpen, setSignOutOpen] = useState(false);
  // Immutable after boot, so a plain read is stable for this component's
  // whole life - no resize can flip it the way the viewport hook flips.
  const installedApp = isMobileApp();

  const close = () => {
    setOpen(false);
  };
  const handleNewTask = () => {
    close();
    activateTabIntent(navigate, openNewEpicIntent(), undefined);
  };
  const handleSettings = () => {
    close();
    // Mirror the desktop user-menu call site's telemetry (user-menu.tsx). Not
    // lifted into the shared action, which would double-fire for the desktop
    // callers that already track here.
    Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
      source: "direct_ui",
      section: "general",
    });
    openSettings({ section: null, resetToGeneral: true });
  };
  const handleManageSubscription = () => {
    close();
    void runnerHost
      .openExternalLink(resolveManageSubscriptionUrl(runnerHost.authnBaseUrl))
      .then(() => {
        Analytics.getInstance().track(
          AnalyticsEvent.SubscriptionManagementOpened,
          { source: "direct_ui" },
        );
      });
  };

  // The panel is identical on both primitives; only the frame around it
  // differs, so it is built once rather than duplicated per branch.
  const panel = (
    <>
      {/* Identity plus the two account actions as icons beside the name -
            the same pair the desktop `UserMenu` offers behind the avatar, both
            one tap here. Manage subscription takes the slot the notification
            bell vacated when it moved to the header.

            `px-5` is the nav rows' effective inset below (`p-2` + `px-3`), so
            the avatar shares a left edge with their glyphs; no bottom padding
            beyond `pb-2` because the `nav` supplies the rest of the gap. */}
      {profile === null ? null : (
        <div className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-2">
          <Avatar size="sm">
            {profile.avatarUrl !== null ? (
              <AvatarImage src={profile.avatarUrl} alt="" />
            ) : null}
            <AvatarFallback>
              {computeInitials(profile.userName, profile.email)}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col pointer-coarse:touch-chrome">
            <span className="truncate text-ui-sm font-medium text-foreground">
              {profile.userName}
            </span>
            <span className="truncate text-ui-xs text-muted-foreground">
              {profile.email}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Manage subscription"
            data-testid="mobile-nav-manage-subscription"
            onClick={handleManageSubscription}
          >
            <SquareArrowOutUpRight className="size-4" />
          </Button>
          {/* Opens the confirm rather than signing out: unlike its
                neighbours this control doesn't `close()` first, so cancelling
                puts the user back in the drawer where they were. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Sign out"
            className="text-destructive hover:text-destructive"
            data-testid="mobile-nav-sign-out"
            onClick={() => {
              setSignOutOpen(true);
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      )}
      {/* "New task" sits outside the scroll container so it stays pinned
            while the recent-task list below it scrolls. */}
      <nav className="flex min-h-0 flex-1 flex-col p-2">
        <Button
          type="button"
          variant="default"
          // The drawer's ONE filled element: a compact accent pill separates
          // the create action from the flat history rows without spanning a
          // heavy full-height slab. Nothing else in this panel may take a
          // resting fill, or the distinction dies.
          // Visually a compact h-9 pill, but the tap target must still meet
          // the 44px touch floor: the ::after overlay extends the hit area
          // invisibly without growing the rendered button.
          className="relative h-9 w-full shrink-0 justify-center gap-2 rounded-md px-4 font-semibold after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']"
          data-testid="mobile-nav-new-task"
          onClick={handleNewTask}
        >
          <span>New task</span>
        </Button>
        <div
          className={cn("mt-1 min-h-0 flex-1 overflow-y-auto", LIST_FADE_CLASS)}
        >
          <DrawerTaskList onNavigate={close} />
        </div>
      </nav>
      <div className="flex shrink-0 flex-col gap-1 border-t border-border/60 p-2">
        <Button
          type="button"
          variant="ghost"
          className={ROW_CLASS}
          data-testid="mobile-nav-settings"
          onClick={handleSettings}
        >
          <Settings className="size-4" />
          <span className="flex-1 text-left">Settings</span>
        </Button>
      </div>
    </>
  );

  return (
    <>
      {/* Outside the drawer, so the confirm can't be unmounted out from under
          the user by an unrelated drawer close. */}
      <SignOutConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={close}
      />
      {installedApp ? (
        /* A hand-driven surface rather than a dialog primitive, for one
           reason: dismissal has to follow the finger and stay interruptible
           mid-flight. Every dialog primitive available here plays a canned
           exit the hand cannot catch or reverse, and no amount of
           configuration produces one - a panel that tracks a pointer 1:1 has
           to own its transform outright.

           Branched on the PRODUCT flag, not the viewport, because the drawer
           itself is mounted by form factor: a narrow desktop window renders
           this component too, and it has a pointer rather than a finger. A
           surface whose only dismissal is a drag would be a surface that
           window cannot close, so it takes the Sheet. */
        <MobileNavDrawerSurface open={open} onOpenChange={setOpen}>
          {panel}
        </MobileNavDrawerSurface>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="gap-0 p-0 pb-safe-bottom"
            data-testid="mobile-nav-drawer"
            data-mobile-shell-touch-scope=""
          >
            <SheetTitle className="sr-only">Menu</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

// Single source of a row's display label; raw epic titles can be empty, so
// apply the source-aware "Untitled task" fallback (phases carry their own
// baked fallback and render verbatim). Mirrors the landing list.
function drawerItemDisplayTitle(item: HistoryItem): string {
  return item.taskType === "phase"
    ? item.title
    : epicDisplayTitle({
        title: item.title,
        initialUserPrompt: item.initialUserPrompt,
      });
}

interface DrawerTaskListProps {
  readonly onNavigate: () => void;
}

/**
 * Inline recent-task list under "New task". Same data source as the landing
 * page's embedded list (`useHistoryQuery` → `useCloudEpicTasksQuery`) and the
 * same ambient search memory every history surface shares - the drawer shows
 * the list the way the user last filtered it, with no filter/sort/selection
 * chrome of its own; the full surface stays one tap away on the landing page.
 */
function DrawerTaskList(props: DrawerTaskListProps): ReactNode {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { openHistory } = useSystemTabModalActions();
  // One subscription to the shared 60s clock for the whole list, then the pure
  // formatter per row - rather than a per-row `useRelativeTimestamp`, which
  // would take one subscription each to re-render the same list anyway.
  const now = useSampledNow();
  const { search } = useAmbientHistorySearchState();
  const {
    data,
    isPending,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useHistoryQuery({ search, nowMs: null });
  const items = data?.items ?? [];

  const openItem = (item: HistoryItem) => {
    props.onNavigate();
    if (item.taskType === "phase") {
      activateTabIntent(
        navigate,
        openPhaseMigrationIntent({
          phaseId: item.epicId,
          name: item.title,
          focus: {
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            migrationSource: "phase",
          },
        }),
        undefined,
      );
      return;
    }
    // Passing the row's raw title threads it through tab creation so the
    // cold-open canvas skeleton renders the real epic title immediately.
    openEpicFromList(navigate, item.epicId, pathname, {
      title: item.title,
      source: "direct_ui",
    });
  };

  let body: ReactNode;
  if (error !== null) {
    body = (
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-ui-sm text-muted-foreground">
        <span>Couldn&apos;t load tasks</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="mobile-nav-task-list-retry"
          onClick={() => {
            void refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending) {
    body = (
      <div
        className="flex flex-col gap-1 px-1"
        data-testid="mobile-nav-task-list-loading"
        aria-busy="true"
        aria-label="Loading tasks"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <p className="px-3 py-2 text-ui-sm text-muted-foreground">No tasks yet</p>
    );
  } else {
    body = (
      <>
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className="h-10 w-full justify-start gap-3 px-3"
            data-testid="mobile-nav-task-row"
            onClick={() => {
              openItem(item);
            }}
          >
            {/* No leading icon on ordinary rows: every row in this list is a
                task, so a repeated glyph carried no information and cost the
                title ~28px. The pin glyph appears only on pinned rows, where
                it IS the information - mirrors the list panel's pinned style
                (primary + filled). */}
            {item.isPinned ? (
              <Pin
                aria-label="Pinned"
                data-testid="mobile-nav-task-pin"
                className="size-3.5 shrink-0 fill-current text-primary"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-left font-normal">
              {drawerItemDisplayTitle(item)}
            </span>
            {/* The shared `updatedLabel` ("about 1 month ago") spends ~100px on
                a secondary detail and is why titles truncated mid-word. The
                bucketed formatter the notification rows use says the same thing
                in a third of the width. Formatted here rather than by changing
                `updatedLabel`, which the landing list and the tray also read. */}
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {formatRelativeTimestamp(item.updatedAtMs, now)}
            </span>
          </Button>
        ))}
        {hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mx-auto"
            disabled={isFetchingNextPage}
            data-testid="mobile-nav-task-list-show-more"
            onClick={() => {
              fetchNextPage();
            }}
          >
            {isFetchingNextPage ? (
              <AgentSpinningDots
                variant="dots"
                className="text-muted-foreground"
                testId={undefined}
              />
            ) : null}
            Show more
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <div
      // `pb-8` is the blank strip `LIST_FADE_CLASS` fades over, so a full
      // scroll never leaves the last row half-faded. Grouping here is
      // whitespace rather than another rule: the drawer had four of them
      // (identity, New task, this list, footer) and only the footer's - which
      // separates the pinned actions from a moving list - earns its keep.
      className="flex flex-col gap-1 pb-8"
      data-testid="mobile-nav-task-list"
    >
      {/* Pinned while the rows scroll: the caption and the History entry
          stay reachable at any scroll depth. Solid drawer background
          (`bg-popover`) so rows slide under it rather than through it. */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-popover px-3 py-1">
        <span className="text-overline text-muted-foreground">
          Recent tasks
        </span>
        {/* Entry to the full history surface (search / filters / bulk
            actions) - the inline list is only the top of the feed. */}
        <button
          type="button"
          data-testid="mobile-nav-view-all-tasks"
          className="text-ui-xs text-muted-foreground transition-colors active:text-foreground"
          onClick={() => {
            props.onNavigate();
            openHistory();
          }}
        >
          View all
        </button>
      </div>
      {body}
    </div>
  );
}
