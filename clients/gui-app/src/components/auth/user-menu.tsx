import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  ACTIVATE_HOST_HINT,
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  pickableHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useMakeActiveHost } from "@/components/settings/host-scope/use-host-scope";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useHostBinding } from "@/lib/host";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import { computeInitials } from "@/lib/auth/compute-initials";
import { usePlatformBillingUrl } from "@/hooks/auth/use-platform-billing-url";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  ExternalLink,
  LayersPlus,
  LogOut,
  RotateCcw,
  Settings,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

export interface UserMenuProps {
  readonly userName: string;
  readonly email: string;
  readonly avatarUrl: string | null;
  readonly showAppSettings: boolean;
  /**
   * The element that opens the menu, or `null` for the avatar button. A custom
   * trigger (the strip foot's account row) must be one focusable element that
   * takes a ref; the menu toggles it open through Radix's own trigger.
   */
  readonly trigger: ReactElement | null;
}

/** The signed-in person's avatar: their picture, or their initials. */
export function UserMenuAvatar(props: {
  readonly userName: string;
  readonly email: string;
  readonly avatarUrl: string | null;
}) {
  return (
    <Avatar size="sm">
      {props.avatarUrl !== null ? (
        <AvatarImage src={props.avatarUrl} alt="" />
      ) : null}
      <AvatarFallback>
        {computeInitials(props.userName, props.email)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Avatar-triggered identity menu. Controlled open state is intentional:
 * jsdom doesn't implement the full PointerEvent path Radix drives, so
 * without the explicit `open` the Radix trigger wouldn't fire under
 * tests. Outside-click + Escape dismissal still come from Radix.
 */
export function UserMenu(props: UserMenuProps) {
  const placement = useColumnOverlayPlacement("foot");
  const openLink = useOpenLink();
  const [open, setOpen] = useState<boolean>(false);
  const [signOutOpen, setSignOutOpen] = useState<boolean>(false);
  const settingsChord = useBindingForAction("app.settings.open");
  useTitleBarDragSuppression("user-menu", open);
  const manageSubscriptionUrl = usePlatformBillingUrl();
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
          side={placement?.side ?? "top"}
          sideOffset={6}
          align={placement?.align}
        >
          <DropdownMenuTrigger asChild>
            {props.trigger ?? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open user menu"
                // Non-editable chrome, dimmed while a layout session is live (4.2).
                data-layout-passive
                data-testid="user-menu-trigger"
                className="rounded-full"
                onClick={() => {
                  setOpen((value) => !value);
                }}
              >
                <UserMenuAvatar
                  userName={props.userName}
                  email={props.email}
                  avatarUrl={props.avatarUrl}
                />
              </Button>
            )}
          </DropdownMenuTrigger>
        </TooltipWrapper>
        <DropdownMenuContent
          side={placement?.side}
          align={placement?.align ?? "end"}
          sideOffset={6}
          // A menu's width, whatever a host is called: long names truncate
          // in their rows and read in full from a tooltip (G4).
          className="w-max max-w-64 whitespace-nowrap"
          data-testid="user-menu-content"
        >
          <div
            className="flex flex-col gap-0.5 px-1.5 py-1"
            data-testid="user-menu-identity"
          >
            <span className="truncate text-ui-sm font-medium text-foreground">
              {props.userName}
            </span>
            <span className="truncate text-ui-xs text-muted-foreground">
              {props.email}
            </span>
          </div>
          <DropdownMenuSeparator />
          <UserMenuHostSection tooltipSide={placement?.side ?? "left"} />
          <DropdownMenuItem
            onSelect={() => {
              setOpen(false);
              useDesktopDialogStore.getState().openDrafts("menu");
            }}
          >
            <LayersPlus className="size-3.5" />
            Drafts
          </DropdownMenuItem>
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
                  tab: null,
                  draft: null,
                  hostId: null,
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
          {/* Withheld in the installed mobile app: App Store guideline 3.1.1
              forbids linking out to a subscription that cannot be bought
              through Apple, and this item opens exactly that page. This menu
              does reach the phone - the mobile header only replaces the
              desktop one for the `app` variant, so `host-loading` renders
              `DesktopAppHeader`, identity menu included. Sign out and App
              settings are unaffected. */}
          {isMobileApp() ? null : (
            <DropdownMenuItem
              data-testid="user-menu-manage-subscription"
              onSelect={() => {
                setOpen(false);
                // Tracked on the RESOLVED open only: a failed OS handoff is not
                // a subscription-management visit (R11). The failure toast is
                // the link seam's, so the rejection is ignored here.
                void openLink(manageSubscriptionUrl, "account", null).then(
                  () =>
                    Analytics.getInstance().track(
                      AnalyticsEvent.SubscriptionManagementOpened,
                      { source: "direct_ui" },
                    ),
                  ignoreError,
                );
              }}
            >
              <ExternalLink className="size-3.5" />
              Manage subscription
            </DropdownMenuItem>
          )}
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

/**
 * One host in the account menu. Its tooltip says what a click does (the
 * activate hint, on a row that can take one) and, only when the menu's width
 * has truncated it, the host's full name (G4).
 */
/** Whether the account menu may switch to this host now: the shared bind rule,
 * and no switch already in flight. */
function isUserMenuHostPickable(
  host: HostScopeOption,
  activatingHostId: string | null,
): boolean {
  return (
    activatingHostId === null &&
    isHostOptionSelectable(host, "bind", AVAILABLE_HOST_ROW_SURFACE_STATE)
  );
}

function UserMenuHostRow(props: {
  readonly host: HostScopeOption;
  readonly active: boolean;
  readonly activatingHostId: string | null;
  readonly tooltipSide: "top" | "right" | "bottom" | "left";
}): ReactNode {
  const { host, active, activatingHostId } = props;
  const { ref: nameRef, isTruncated } = useIsTextTruncated<HTMLSpanElement>(
    host.name,
  );
  const selectable = isUserMenuHostPickable(host, activatingHostId);
  const hint = active || !selectable ? null : ACTIVATE_HOST_HINT;
  return (
    <TooltipWrapper
      label={
        isTruncated ? (
          <span className="flex flex-col gap-0.5">
            <span className="break-all">{host.name}</span>
            {hint}
          </span>
        ) : (
          hint
        )
      }
      side={props.tooltipSide}
      sideOffset={6}
      align={undefined}
    >
      {/* Inert rather than `disabled`: a disabled Radix item takes no
          pointer events, so an unpickable host's truncated name could never
          reveal itself. `aria-disabled` keeps the disabled look and the
          focus stop; the cancelled select keeps the row from being picked. */}
      <DropdownMenuRadioItem
        value={host.hostId}
        aria-disabled={selectable ? undefined : true}
        onSelect={(event) => {
          if (!selectable) event.preventDefault();
        }}
        data-testid={`user-menu-host-option-${host.hostId}`}
      >
        <HostOptionRow
          host={host}
          picked={active}
          active={active}
          intent="bind"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={null}
          nameRef={nameRef}
        />
        {host.hostId === activatingHostId ? (
          <AgentSpinningDots
            className="ml-auto"
            testId={`user-menu-host-activating-${host.hostId}`}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </DropdownMenuRadioItem>
    </TooltipWrapper>
  );
}

/**
 * The account menu's Host section (F5): every host, the check on the one this
 * window uses, and a click that switches to it. It is Settings' Activate in
 * another place - the same write through `useMakeActiveHost` - drawn with the
 * shared `HostOptionRow` under `bind`, so an unreachable host is inert and
 * says so in the row's own word. Mounted only while the menu is open, so the
 * host lists and their liveness poll run only while someone is looking. A
 * switch still in flight from any surface holds every row, and its own row
 * carries the spinner, so a reopened menu cannot start a second one.
 */
function UserMenuHostSection(props: {
  readonly tooltipSide: "top" | "right" | "bottom" | "left";
}): ReactNode {
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(true, binding?.directory ?? null);
  useRegisteredHostsPollLiveness();
  const {
    hosts: allHosts,
    activeHostId,
    isLoading,
    listsFailed,
    retryLists,
  } = useHostOptions();
  // A picker: no burst sandbox, and no sandbox the control plane has not yet
  // confirmed is not one. The active host always keeps its row.
  const hosts = pickableHostOptions(allHosts, activeHostId);
  const { makeActive, activatingHostId } = useMakeActiveHost(hosts);
  // A failed list (a sandbox list included, which hides every sandbox here)
  // is said, with the retry, rather than shown as the whole account.
  const showsRetry = listsFailed && !isLoading;
  if (hosts.length === 0 && !showsRetry) return null;
  return (
    <>
      <DropdownMenuLabel>Host</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={activeHostId ?? ""}
        onValueChange={(hostId) => {
          // Radix still reports the value of a row whose select was
          // cancelled, so an inert row is refused here too.
          const host = hosts.find((option) => option.hostId === hostId);
          if (
            hostId !== activeHostId &&
            host !== undefined &&
            isUserMenuHostPickable(host, activatingHostId)
          ) {
            makeActive(hostId);
          }
        }}
        data-testid="user-menu-host-section"
      >
        {hosts.map((host) => (
          <UserMenuHostRow
            key={host.hostId}
            host={host}
            active={host.hostId === activeHostId}
            activatingHostId={activatingHostId}
            tooltipSide={props.tooltipSide}
          />
        ))}
      </DropdownMenuRadioGroup>
      {showsRetry ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            retryLists();
          }}
          data-testid="user-menu-host-retry-lists"
        >
          <RotateCcw className="size-4" aria-hidden />
          {hosts.length === 0
            ? "Try loading hosts again"
            : "Some hosts may be missing"}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
    </>
  );
}
