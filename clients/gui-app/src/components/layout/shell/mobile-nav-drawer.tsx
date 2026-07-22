import { type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  History,
  LogOut,
  Plus,
  Server,
  Settings,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useAuthService } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { openNewEpicDraft } from "@/lib/commands/actions/new-epic";
import { draftTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMergedNotificationUnreadCount } from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const ROW_CLASS = "h-11 w-full justify-start gap-3 px-3";

/**
 * Left hamburger drawer for the mobile shell. It re-homes the global controls
 * that the desktop header carries (History, Settings, notifications, identity /
 * account, host) into a single menu, plus a "New task" entry, since the tab
 * strip and header right-cluster are hidden on phones. Every action reuses the
 * same helper the desktop surfaces call. Mounted only on mobile (see AppShell),
 * so desktop is untouched.
 */
export function MobileNavDrawer(): ReactNode {
  const open = useMobileNavStore((state) => state.open);
  const setOpen = useMobileNavStore((state) => state.setOpen);
  const navigate = useNavigate();
  const profile = useAuthStore((state) => state.profile);
  const { openHistory, openSettings } = useSystemTabModalActions();
  const setNotificationsOpen = useNotificationsPopoverStore(
    (state) => state.setOpen,
  );
  const unread = useMergedNotificationUnreadCount();
  const runnerHost = useRunnerHost();
  const auth = useAuthService();

  const close = () => {
    setOpen(false);
  };
  const handleNewTask = () => {
    close();
    navigateToTabIntent(navigate, draftTabIntent(openNewEpicDraft()));
  };
  const handleHistory = () => {
    close();
    openHistory();
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
  const handleNotifications = () => {
    close();
    // Mirror the desktop bell's open telemetry (notifications-bell.tsx).
    Analytics.getInstance().track(AnalyticsEvent.NotificationCenterOpened, null);
    setNotificationsOpen(true);
  };
  const handleSwitchHost = () => {
    close();
    runnerHost.hostPicker.requestOpen();
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
  const handleSignOut = () => {
    close();
    Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
      source: "direct_ui",
    });
    void auth.signOut();
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="gap-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        data-testid="mobile-nav-drawer"
        data-mobile-shell-touch-scope=""
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {/* In-flow close (not the primitive's absolute one), so the top
            safe-area padding pushes it below the notch. Mirrors the pattern in
            notifications-mobile-sheet.tsx. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border/60 p-4">
          {profile === null ? null : (
            <>
              <Avatar size="sm">
                {profile.avatarUrl !== null ? (
                  <AvatarImage src={profile.avatarUrl} alt="" />
                ) : null}
                <AvatarFallback>
                  {computeInitials(profile.userName, profile.email)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-sm font-medium text-foreground">
                  {profile.userName}
                </span>
                <span className="truncate text-ui-xs text-muted-foreground">
                  {profile.email}
                </span>
              </div>
            </>
          )}
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close menu"
              data-testid="mobile-nav-close"
              className="ml-auto"
            >
              <X />
            </Button>
          </SheetClose>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-new-task"
            onClick={handleNewTask}
          >
            <Plus className="size-4" />
            <span className="flex-1 text-left">New task</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-history"
            onClick={handleHistory}
          >
            <History className="size-4" />
            <span className="flex-1 text-left">History</span>
          </Button>
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
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-notifications"
            onClick={handleNotifications}
          >
            <Bell className="size-4" />
            <span className="flex-1 text-left">Notifications</span>
            {unread > 0 ? (
              <Badge
                variant="destructive"
                className="h-5 min-w-5 px-1.5 text-overline tabular-nums"
                data-testid="mobile-nav-notifications-unread"
              >
                {unread > 99 ? "99+" : unread}
              </Badge>
            ) : null}
          </Button>
        </nav>
        <div className="flex shrink-0 flex-col gap-1 border-t border-border/60 p-2">
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-switch-host"
            onClick={handleSwitchHost}
          >
            <Server className="size-4" />
            <span className="flex-1 text-left">Switch host</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={ROW_CLASS}
            data-testid="mobile-nav-manage-subscription"
            onClick={handleManageSubscription}
          >
            <SquareArrowOutUpRight className="size-4" />
            <span className="flex-1 text-left">Manage subscription</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(ROW_CLASS, "text-destructive hover:text-destructive")}
            data-testid="mobile-nav-sign-out"
            onClick={handleSignOut}
          >
            <LogOut className="size-4" />
            <span className="flex-1 text-left">Sign out</span>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
