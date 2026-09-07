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
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useOpenLink } from "@/lib/links/open-link";
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

// The task scroller fades its bottom edge rather than slicing a row against the footer's border.
const LIST_FADE_CLASS =
  "[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

/** Mounted only on mobile (see AppShell), so desktop is untouched. */
export function MobileNavDrawer(): ReactNode {
  const open = useMobileNavStore((state) => state.open);
  const setOpen = useMobileNavStore((state) => state.setOpen);
  const navigate = useNavigate();
  const profile = useAuthStore((state) => state.profile);
  const { openSettings } = useSystemTabModalActions();
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
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
    // Not lifted into the shared action, which would double-fire for the desktop callers that already track here.
    Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
      source: "direct_ui",
      section: "general",
    });
    openSettings({ section: null, resetToGeneral: true });
  };
  const handleManageSubscription = () => {
    close();
    void openLink(
      resolvePlatformBaseUrl(runnerHost.signInUrl),
      "account",
      null,
    );
    Analytics.getInstance().track(AnalyticsEvent.SubscriptionManagementOpened, {
      source: "direct_ui",
    });
  };

  // The panel is identical on both primitives; only the frame around it
  // differs, so it is built once rather than duplicated per branch.
  const panel = (
    <>
      {/* `px-5` is the nav rows' effective inset below (`p-2` + `px-3`), so the avatar shares a left edge with their
         glyphs; no bottom padding beyond `pb-2` because the `nav` supplies the rest of the gap. */}
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
          {/* Opens the confirm rather than signing out: unlike its neighbours this control doesn't `close` first, so
             cancelling puts the user back in the drawer where they were. */}
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
          // Visually a compact h-9 pill, but the tap target must still meet the 44px touch floor: the::after overlay
          // extends the hit area invisibly without growing the rendered button.
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
        /* A surface whose only dismissal is a drag would be a surface that window cannot close, so it takes the Sheet. */
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

// Single source of a row's display label; raw epic titles can be empty, so apply the source-aware "Untitled
// task" fallback (phases carry their own baked fallback and render verbatim).
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

/** Inline recent-task list under "New task". */
function DrawerTaskList(props: DrawerTaskListProps): ReactNode {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { openHistory } = useSystemTabModalActions();
  // One subscription to the shared 60s clock for the whole list, then the pure formatter per row - rather than a
  // per-row `useRelativeTimestamp`, which would take one subscription each to re-render the same list anyway.
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
            {/* The pin glyph appears only on pinned rows, where it IS the information - mirrors the list panel's pinned
               style (primary + filled). */}
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
            {/* Formatted here rather than by changing `updatedLabel`, which the landing list and the tray also read. */}
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
      // `pb-8` is the blank strip `LIST_FADE_CLASS` fades over, so a full scroll never leaves the last row
      // half-faded.
      className="flex flex-col gap-1 pb-8"
      data-testid="mobile-nav-task-list"
    >
      {/* Pinned while the rows scroll: the caption and the History entry stay reachable at any scroll depth. Solid
         drawer background (`bg-popover`) so rows slide under it rather than through it. */}
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
