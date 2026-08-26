import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { computeInitials } from "@/lib/auth/compute-initials";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { ExternalLink, LogOut, Settings } from "lucide-react";
import { useState } from "react";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

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
  const runnerHost = useRunnerHost();
  const [open, setOpen] = useState<boolean>(false);
  const [signOutOpen, setSignOutOpen] = useState<boolean>(false);
  const settingsChord = useBindingForAction("app.settings.open");
  useTitleBarDragSuppression("user-menu", open);
  const initials = computeInitials(props.userName, props.email);
  const manageSubscriptionUrl = resolvePlatformBaseUrl(runnerHost.signInUrl);
  return (
    <>
      {/* Outside the menu, which Radix unmounts on select - the confirm has to
          outlive the item that opened it. */}
      <SignOutConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={() => {
          setOpen(false);
        }}
      />
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
              {settingsChord === null ? null : (
                <DropdownMenuShortcut>
                  {formatChordForDisplay(settingsChord)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            data-testid="user-menu-manage-subscription"
            onSelect={() => {
              setOpen(false);
              void runnerHost
                .openExternalLink(manageSubscriptionUrl)
                .then(() => {
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
              setSignOutOpen(true);
            }}
          >
            <LogOut className="size-3.5" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
