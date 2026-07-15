import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useAuthService } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { ExternalLink, LogOut, Settings } from "lucide-react";
import { useState } from "react";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface UserMenuProps {
  readonly userName: string;
  readonly email: string;
  readonly avatarUrl: string | null;
  readonly showAppSettings: boolean;
}

/**
 * Avatar-triggered identity menu. Controlled open state is intentional:
 * jsdom doesn't implement the full PointerEvent path Radix drives, so
 * without the explicit `open` the Radix trigger wouldn't fire under
 * tests. Outside-click + Escape dismissal still come from Radix.
 */
export function UserMenu(props: UserMenuProps) {
  const auth = useAuthService();
  const runnerHost = useRunnerHost();
  const [open, setOpen] = useState<boolean>(false);
  useTitleBarDragSuppression("user-menu", open);
  const initials = computeInitials(props.userName, props.email);
  const manageSubscriptionUrl = resolveManageSubscriptionUrl(
    runnerHost.authnBaseUrl,
  );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={open ? null : props.userName}
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open user menu"
            data-testid="user-menu-trigger"
            className="rounded-full"
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            <Avatar size="sm">
              {props.avatarUrl !== null ? (
                <AvatarImage src={props.avatarUrl} alt="" />
              ) : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-max whitespace-nowrap"
        data-testid="user-menu-content"
      >
        <div
          className="flex flex-col gap-0.5 px-1.5 py-1"
          data-testid="user-menu-identity"
        >
          <span className="text-ui-sm font-medium text-foreground">
            {props.userName}
          </span>
          <span className="text-ui-xs text-muted-foreground">
            {props.email}
          </span>
        </div>
        <DropdownMenuSeparator />
        {props.showAppSettings ? (
          <DropdownMenuItem
            data-testid="user-menu-app-settings"
            onSelect={() => {
              setOpen(false);
              Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
                source: "direct_ui",
                section: "general",
              });
              getSystemTabModalApi()?.openSettings({
                section: null,
                resetToGeneral: true,
              });
            }}
          >
            <Settings className="size-3.5" />
            App settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-testid="user-menu-manage-subscription"
          onSelect={() => {
            setOpen(false);
            void runnerHost.openExternalLink(manageSubscriptionUrl).then(() => {
              Analytics.getInstance().track(
                AnalyticsEvent.SubscriptionManagementOpened,
                { source: "direct_ui" },
              );
            });
          }}
        >
          <ExternalLink className="size-3.5" />
          Manage subscription
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="user-menu-sign-out"
          variant="destructive"
          onSelect={() => {
            setOpen(false);
            Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
              source: "direct_ui",
            });
            void auth.signOut();
          }}
        >
          <LogOut className="size-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
