import { useState, type ComponentType } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Cookie,
  EllipsisVertical,
  ExternalLink,
  Minus,
  Monitor,
  PictureInPicture2,
  Plus,
  RotateCcw,
  RotateCw,
  SquareMousePointer,
  Smartphone,
  Tablet,
  VenetianMask,
} from "lucide-react";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import { registrableDomainForUrl } from "@traycer/protocol/host/browser/registrable-domain";

const BROWSER_PRIVATE_SESSION_SHIELD_COPY = {
  headline: "Private session",
  detail:
    "This session has its own throwaway jar. It starts signed out, shares no cookies with your other tabs, and everything in it is discarded when the session closes.",
} as const;

export interface BrowserPictureInPictureControl {
  readonly disabled: boolean;
  readonly convert: () => void;
}

const BROWSER_VIEWPORT_PRESETS: ReadonlyArray<{
  readonly id: BrowserViewViewportPresetId;
  readonly label: string;
  readonly description: string;
  readonly Icon: ComponentType<{
    readonly className?: string;
    readonly "aria-hidden"?: boolean;
  }>;
}> = [
  {
    id: "responsive",
    label: "Responsive",
    description: "Fill tile",
    Icon: Monitor,
  },
  {
    id: "mobile",
    label: "Mobile",
    description: "390 x 844",
    Icon: Smartphone,
  },
  {
    id: "tablet",
    label: "Tablet",
    description: "820 x 1180",
    Icon: Tablet,
  },
  {
    id: "desktop",
    label: "Desktop",
    description: "1440 x 900",
    Icon: Monitor,
  },
];

export function BrowserTileToolbar(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl | null;
}) {
  const controller = props.controller;
  const capabilities = controller.capabilities;
  const showNav =
    capabilities.back || capabilities.forward || capabilities.reload;
  const showAddress = capabilities.navigate;
  const showAdvanced =
    capabilities.zoom ||
    capabilities.viewportPreset ||
    capabilities.devtools ||
    capabilities.siteInfo;
  const showTrailing =
    capabilities.annotate ||
    props.pictureInPicture !== null ||
    controller.profile === "isolated" ||
    showAdvanced;
  if (!showNav && !showAddress && !showTrailing) return null;

  return (
    <div className="flex min-h-0 min-w-0 items-center gap-2 border-b border-border px-2 py-1.5 text-ui-sm">
      {showNav ? <BrowserTileToolbarNav controller={controller} /> : null}
      {showAddress ? (
        <BrowserTileToolbarAddress controller={controller} />
      ) : null}
      {showTrailing ? (
        <BrowserTileToolbarTrailing
          controller={controller}
          pictureInPicture={props.pictureInPicture}
        />
      ) : null}
    </div>
  );
}

/**
 * The touch-grade chrome: the same nav buttons, the address field, and the
 * page-loading spinner. No PiP and no more-menu - a coarse pointer has no
 * hover to reveal them and the tile has no room.
 */
export function BrowserTileToolbarCompact(props: {
  readonly controller: TileController;
  readonly loading: boolean;
  /** A read-only tier says so here: a finger cannot reach a tooltip (H12). */
  readonly readOnly: boolean;
}) {
  const url = props.controller.url;
  return (
    <div
      className="flex min-h-11 w-full shrink-0 items-center gap-1 border-b border-border px-2"
      data-testid="browser-tile-toolbar-compact"
    >
      <BrowserTileToolbarNav controller={props.controller} />
      {props.controller.capabilities.navigate ? (
        <BrowserTileToolbarAddress controller={props.controller} />
      ) : (
        <div className="min-w-0 flex-1 truncate px-1 text-ui-sm text-muted-foreground">
          {url === "" ? "New tab" : url}
        </div>
      )}
      {props.readOnly ? (
        <Badge variant="outline" className="shrink-0">
          View only
        </Badge>
      ) : null}
      {props.loading ? (
        <span role="status" aria-label="Page loading" className="shrink-0">
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="browser-tile-toolbar-compact-loading"
            variant={undefined}
          />
        </span>
      ) : null}
    </div>
  );
}

function BrowserTileToolbarNav(props: { readonly controller: TileController }) {
  const controller = props.controller;
  const capabilities = controller.capabilities;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {capabilities.back ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={controller.disabled || !controller.canGoBack}
          onClick={controller.onBack}
        >
          <ArrowLeft />
        </Button>
      ) : null}
      {capabilities.forward ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={controller.disabled || !controller.canGoForward}
          onClick={controller.onForward}
        >
          <ArrowRight />
        </Button>
      ) : null}
      {capabilities.reload ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          disabled={controller.disabled}
          onClick={controller.onReload}
        >
          <RotateCw />
        </Button>
      ) : null}
    </div>
  );
}

function BrowserTileToolbarAddress(props: {
  readonly controller: TileController;
}) {
  const {
    disabled,
    setAddressInput,
    addressValue,
    url,
    onNavigate,
    onAddressChange,
    onAddressFocusChange,
  } = props.controller;
  const canOpenExternally =
    useRunnerHostOrNull() !== null && isWebOriginUrl(url);
  return (
    <form className="flex min-w-0 flex-1 items-center" onSubmit={onNavigate}>
      <InputGroup className="group/address h-7 border-transparent bg-transparent shadow-none transition-[background-color,border-color,box-shadow] hover:border-input hover:bg-input/20 focus-within:bg-input/20 motion-reduce:transition-none dark:bg-transparent">
        <InputGroupInput
          ref={setAddressInput}
          // The rest of the toolbar already honours `disabled`; the address
          // field is where a `viewer` (H12), a peek tile with no host client,
          // or any other clientless tile would otherwise submit a nav frame
          // nothing can carry.
          disabled={disabled}
          aria-label="Browser address"
          value={addressValue}
          onChange={(event) => {
            onAddressChange(event.target.value);
          }}
          onFocus={() => onAddressFocusChange(true)}
          onBlur={() => onAddressFocusChange(false)}
          className="h-full truncate px-2 font-mono text-ui-sm"
          spellCheck={false}
        />
        {canOpenExternally ? (
          <InputGroupAddon align="inline-end">
            <BrowserOpenExternalButton url={url} />
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </form>
  );
}

function BrowserOpenExternalButton(props: { readonly url: string }) {
  const openExternalLink = useRunnerOpenExternalLink();
  return (
    <TooltipWrapper
      label="Open in default browser"
      side="top"
      sideOffset={6}
      align="center"
    >
      <InputGroupButton
        type="button"
        size="icon-xs"
        aria-label="Open in default browser"
        disabled={openExternalLink.isPending}
        className="pointer-events-none text-muted-foreground opacity-0 transition-[color,opacity] duration-150 group-hover/address:pointer-events-auto group-hover/address:opacity-100 group-focus-within/address:pointer-events-auto group-focus-within/address:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 motion-reduce:transition-none"
        onClick={() => openExternalLink.mutate(props.url)}
      >
        <ExternalLink aria-hidden />
      </InputGroupButton>
    </TooltipWrapper>
  );
}

function BrowserTileToolbarTrailing(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl | null;
}) {
  const controller = props.controller;
  const capabilities = controller.capabilities;
  // The confirm dialog lives here, not inside the menu: selecting the item
  // closes the dropdown, which would unmount a dialog rendered under it before
  // it could ever open.
  const [clearSiteConfirmOpen, setClearSiteConfirmOpen] = useState(false);
  const clearSite = browserClearSiteAction(controller);
  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
      {controller.profile === "isolated" ? (
        <BrowserPrivateSessionShield />
      ) : null}
      {capabilities.annotate && controller.annotation !== null ? (
        <BrowserAnnotateToggle controller={controller.annotation} />
      ) : null}
      {props.pictureInPicture === null ? null : (
        <BrowserPictureInPictureButton control={props.pictureInPicture} />
      )}
      {capabilities.zoom ||
      capabilities.viewportPreset ||
      capabilities.devtools ||
      capabilities.siteInfo ? (
        <BrowserMoreMenu
          controller={controller}
          clearSite={clearSite}
          onRequestClearSite={() => setClearSiteConfirmOpen(true)}
        />
      ) : null}
      {clearSite === null || clearSite.site === null ? null : (
        <ConfirmDestructiveDialog
          open={clearSiteConfirmOpen}
          onOpenChange={setClearSiteConfirmOpen}
          title={`Clear cookies for ${clearSite.site}?`}
          description={`You will be signed out of ${clearSite.site} in Traycer, everywhere this account is signed in. Other sites are untouched.`}
          cascadeSummary={null}
          actionLabel="Clear cookies"
          isPending={false}
          blockedReason={null}
          onConfirm={() => {
            setClearSiteConfirmOpen(false);
            clearSite.clear();
          }}
        />
      )}
    </div>
  );
}

/**
 * The clear-site action for one tile. `null` hides the item outright, for the
 * two tiles that have no jar of their own to clear: a private session, whose
 * partition dies with the session and is shared with nothing (spec §6.1), and
 * a screencast tile, which watches a context on the host.
 *
 * A `null` `site` keeps the item visible but disabled: the tile is on
 * `about:blank` or a devtools URL, so there is a jar but no site to name. That
 * is a state the user can leave by navigating, which is why it reads as
 * disabled rather than as an action that quietly disappeared.
 */
function browserClearSiteAction(
  controller: TileController,
): { readonly site: string | null; readonly clear: () => void } | null {
  const clear = controller.onClearSite;
  if (clear === null || controller.profile === "isolated") return null;
  const site = isWebOriginUrl(controller.url)
    ? registrableDomainForUrl(controller.url)
    : null;
  return { site, clear };
}

/**
 * The one shield a tile still shows. Saving logins is silent and always-on for
 * a `primary` tile - Chrome shows no badge for it either - so the only thing
 * left worth saying in the toolbar is that THIS session is private: it has
 * nothing to save, enable or clear, and closing it destroys the jar.
 */
function BrowserPrivateSessionShield() {
  const [open, setOpen] = useState(false);
  const copy = BROWSER_PRIVATE_SESSION_SHIELD_COPY;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={copy.headline}
        side="top"
        sideOffset={6}
        align="center"
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Saved logins: ${copy.headline}`}
            className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          >
            <VenetianMask aria-hidden />
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent align="end" className="w-[min(80vw,20rem)] min-w-0">
        <PopoverHeader>
          <PopoverTitle>{copy.headline}</PopoverTitle>
          <PopoverDescription className="text-ui-xs">
            {copy.detail}
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}

function BrowserMoreMenu(props: {
  readonly controller: TileController;
  readonly clearSite: { readonly site: string | null } | null;
  readonly onRequestClearSite: () => void;
}) {
  const controller = props.controller;
  const capabilities = controller.capabilities;
  const clearSite = props.clearSite;
  return (
    <DropdownMenu>
      <TooltipWrapper
        label="More browser controls"
        side="top"
        sideOffset={6}
        align="center"
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More browser controls"
            className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          >
            <EllipsisVertical aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        className="w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-64 overflow-y-auto"
      >
        {capabilities.viewportPreset ? (
          <BrowserViewportPresetMenu
            value={controller.viewportPreset}
            disabled={controller.disabled}
            onChange={controller.onViewportPresetChange}
          />
        ) : null}
        {capabilities.zoom ? (
          <BrowserZoomControls controller={controller} />
        ) : null}
        {capabilities.siteInfo ? (
          <BrowserSiteInfoMenu url={controller.url} />
        ) : null}
        {clearSite === null ? null : (
          <DropdownMenuItem
            aria-label={browserClearSiteLabel(clearSite.site)}
            disabled={controller.disabled || clearSite.site === null}
            onSelect={props.onRequestClearSite}
          >
            <Cookie aria-hidden />
            {browserClearSiteLabel(clearSite.site)}
          </DropdownMenuItem>
        )}
        {capabilities.devtools ? (
          <>
            <DropdownMenuLabel className="mt-1 text-overline uppercase tracking-wide">
              Developer
            </DropdownMenuLabel>
            <DropdownMenuItem
              aria-label="Open browser DevTools"
              disabled={controller.disabled}
              onSelect={controller.onOpenDevTools}
            >
              <Bug aria-hidden />
              Open DevTools
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function browserClearSiteLabel(site: string | null): string {
  return site === null
    ? "Clear cookies for this site"
    : `Clear cookies for ${site}`;
}

function BrowserZoomControls(props: { readonly controller: TileController }) {
  const controller = props.controller;
  const disabled = controller.disabled || controller.zoomLocked;
  return (
    <DropdownMenuGroup
      aria-label={`Zoom controls, current zoom ${String(controller.zoomPercent)}%`}
      className="-mx-1 my-1 flex items-center gap-1.5 border-y border-border px-2 py-2"
    >
      <span className="me-auto text-ui-sm">Zoom</span>
      <DropdownMenuItem
        aria-label="Zoom out"
        className="size-7 shrink-0 justify-center border border-border p-0"
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          controller.onZoomOut();
        }}
      >
        <Minus aria-hidden />
      </DropdownMenuItem>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="min-w-10 text-center text-ui-sm tabular-nums text-muted-foreground"
      >
        {controller.zoomPercent}%
      </span>
      <DropdownMenuItem
        aria-label="Zoom in"
        className="size-7 shrink-0 justify-center border border-border p-0"
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          controller.onZoomIn();
        }}
      >
        <Plus aria-hidden />
      </DropdownMenuItem>
      <DropdownMenuItem
        aria-label="Reset zoom"
        className="size-7 shrink-0 justify-center p-0 text-muted-foreground"
        disabled={disabled}
        onSelect={(event) => {
          event.preventDefault();
          controller.onResetZoom();
        }}
      >
        <RotateCcw aria-hidden />
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

export function BrowserPictureInPictureButton(props: {
  readonly control: BrowserPictureInPictureControl;
}) {
  return (
    <TooltipWrapper
      label="Convert to picture-in-picture"
      side="top"
      sideOffset={6}
      align="center"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Convert to picture-in-picture"
        data-testid="browser-convert-to-pip"
        disabled={props.control.disabled}
        onClick={props.control.convert}
      >
        <PictureInPicture2 />
      </Button>
    </TooltipWrapper>
  );
}

function BrowserAnnotateToggle(props: {
  readonly controller: BrowserAnnotationSessionController;
}) {
  const controller = props.controller;
  return (
    <TooltipWrapper
      label={controller.isActive ? "Stop annotating" : "Annotate page"}
      side="top"
      sideOffset={6}
      align="center"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Annotate page"
        aria-pressed={controller.isActive}
        disabled={!controller.canStart && !controller.isActive}
        onClick={controller.toggle}
        className={cn(controller.isActive && "bg-primary/15 text-primary")}
      >
        <SquareMousePointer aria-hidden />
      </Button>
    </TooltipWrapper>
  );
}

function BrowserViewportPresetMenu(props: {
  readonly value: BrowserViewViewportPresetId;
  readonly disabled: boolean;
  readonly onChange: (preset: BrowserViewViewportPresetId) => void;
}) {
  const [open, setOpen] = useState(false);
  const current =
    BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === props.value) ??
    BROWSER_VIEWPORT_PRESETS[0];
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        className="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-1.5 [&>svg:last-child]:m-0 [&>svg:last-child]:justify-self-end"
        disabled={props.disabled}
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 truncate">Viewport</span>
        <span className="min-w-0 truncate text-end text-ui-xs text-muted-foreground group-data-open:text-accent-foreground">
          {current.label}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        alignOffset={-4}
        className="w-[min(80vw,13rem)] min-w-0"
      >
        <DropdownMenuRadioGroup value={props.value}>
          {BROWSER_VIEWPORT_PRESETS.map((preset) => {
            const Icon = preset.Icon;
            return (
              <DropdownMenuRadioItem
                key={preset.id}
                value={preset.id}
                className="gap-2"
                onSelect={(event) => {
                  event.preventDefault();
                  props.onChange(preset.id);
                }}
              >
                <Icon className="size-4" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm">
                    {preset.label}
                  </span>
                  <span className="block truncate text-ui-xs text-muted-foreground">
                    {preset.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function BrowserSiteInfoMenu(props: { readonly url: string }) {
  const [open, setOpen] = useState(false);
  const isWebOrigin = isWebOriginUrl(props.url);
  const originTitle = isWebOrigin ? "Web page" : "Local page";
  const originDetail = isWebOrigin
    ? "Served over the network from this page's origin."
    : "Not loaded from a web address (for example, a blank tab or an internal page).";
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        aria-label={`Site information. ${originTitle}. ${originDetail}`}
        className="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-1.5 [&>svg:last-child]:m-0 [&>svg:last-child]:justify-self-end"
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 truncate">Site information</span>
        <span className="min-w-0 truncate text-end text-ui-xs text-muted-foreground group-data-open:text-accent-foreground">
          {originTitle}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        alignOffset={-4}
        className="w-[min(80vw,18rem)] min-w-0 space-y-3 p-3 text-ui-sm"
      >
        <BrowserSiteInfoRow title={originTitle} detail={originDetail} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function BrowserSiteInfoRow(props: {
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div>
      <div className="font-medium text-foreground">{props.title}</div>
      <div className="mt-0.5 text-ui-xs text-muted-foreground">
        {props.detail}
      </div>
    </div>
  );
}

function isWebOriginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
