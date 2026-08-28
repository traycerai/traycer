import type { ComponentType, SyntheticEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Info,
  Monitor,
  PenLine,
  PictureInPicture2,
  RotateCw,
  Smartphone,
  Tablet,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { browserCookieDegradedMessage } from "@/lib/browser-view/browser-cookie-degraded-message";
import type {
  BrowserCookieCryptoState,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";

export interface BrowserPictureInPictureControl {
  readonly disabled: boolean;
  readonly convert: () => void;
}

const BROWSER_VIEWPORT_PRESETS: ReadonlyArray<{
  readonly id: BrowserViewViewportPresetId;
  readonly label: string;
  readonly description: string;
  readonly Icon: ComponentType<{ readonly className?: string }>;
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
  const showAddress = capabilities.navigate || capabilities.siteInfo;
  const showZoom = capabilities.zoom;
  const showTrailing =
    capabilities.viewportPreset ||
    capabilities.annotate ||
    capabilities.devtools ||
    props.pictureInPicture !== null;
  if (!showNav && !showAddress && !showZoom && !showTrailing) return null;

  return (
    <div className="flex min-h-0 items-center gap-2 border-b border-border px-2 py-1.5 text-ui-sm">
      {showNav ? <BrowserTileToolbarNav controller={controller} /> : null}
      {showAddress ? (
        <BrowserTileToolbarAddress controller={controller} />
      ) : null}
      {showZoom ? <BrowserTileToolbarZoom controller={controller} /> : null}
      {showTrailing ? (
        <BrowserTileToolbarTrailing
          controller={controller}
          pictureInPicture={props.pictureInPicture}
        />
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
  const controller = props.controller;
  const capabilities = controller.capabilities;
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={capabilities.navigate ? controller.onNavigate : preventSubmit}
    >
      {capabilities.siteInfo ? (
        <BrowserSiteInfoButton
          url={controller.url}
          cookieCryptoState={controller.cookieCryptoState}
        />
      ) : null}
      {capabilities.navigate ? (
        <Input
          aria-label="Browser address"
          value={controller.addressValue}
          onChange={(event) => {
            controller.onAddressChange(event.target.value);
          }}
          onFocus={() => controller.onAddressFocusChange(true)}
          onBlur={() => controller.onAddressFocusChange(false)}
          className="h-7 min-w-0 flex-1 truncate font-mono text-ui-sm"
          spellCheck={false}
        />
      ) : null}
    </form>
  );
}

function BrowserTileToolbarZoom(props: {
  readonly controller: TileController;
}) {
  const controller = props.controller;
  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        disabled={controller.disabled || controller.zoomLocked}
        onClick={controller.onZoomOut}
      >
        <ZoomOut />
      </Button>
      <button
        type="button"
        aria-label="Reset zoom"
        className="w-12 rounded-sm px-1 py-1 text-center text-ui-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        disabled={controller.disabled || controller.zoomLocked}
        onClick={controller.onResetZoom}
      >
        {controller.zoomPercent}%
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        disabled={controller.disabled || controller.zoomLocked}
        onClick={controller.onZoomIn}
      >
        <ZoomIn />
      </Button>
    </div>
  );
}

function BrowserTileToolbarTrailing(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl | null;
}) {
  const controller = props.controller;
  const capabilities = controller.capabilities;
  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
      {capabilities.viewportPreset ? (
        <BrowserViewportPresetMenu
          value={controller.viewportPreset}
          disabled={controller.disabled}
          onChange={controller.onViewportPresetChange}
        />
      ) : null}
      {capabilities.annotate && controller.annotation !== null ? (
        <BrowserAnnotateToggle controller={controller.annotation} />
      ) : null}
      {props.pictureInPicture === null ? null : (
        <BrowserPictureInPictureButton control={props.pictureInPicture} />
      )}
      {capabilities.devtools ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-ui-xs"
          aria-label="Open browser DevTools"
          disabled={controller.disabled}
          onClick={controller.onOpenDevTools}
        >
          <Bug className="size-3.5" />
          DevTools
        </Button>
      ) : null}
    </div>
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
        <PenLine />
      </Button>
    </TooltipWrapper>
  );
}

function preventSubmit(
  event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
): void {
  event.preventDefault();
}

function BrowserViewportPresetMenu(props: {
  readonly value: BrowserViewViewportPresetId;
  readonly disabled: boolean;
  readonly onChange: (preset: BrowserViewViewportPresetId) => void;
}) {
  const current =
    BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === props.value) ??
    BROWSER_VIEWPORT_PRESETS[0];
  const CurrentIcon = current.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-ui-xs"
          aria-label="Browser viewport preset"
          disabled={props.disabled}
        >
          <CurrentIcon className="size-3.5" />
          <span className="hidden sm:inline">{current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(80vw,13rem)]">
        {BROWSER_VIEWPORT_PRESETS.map((preset) => {
          const Icon = preset.Icon;
          return (
            <DropdownMenuItem
              key={preset.id}
              className="gap-2"
              onSelect={() => props.onChange(preset.id)}
            >
              <Icon className="size-4" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-sm">
                  {preset.label}
                </span>
                <span className="block truncate text-ui-xs text-muted-foreground">
                  {preset.description}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserSiteInfoButton(props: {
  readonly url: string;
  readonly cookieCryptoState: BrowserCookieCryptoState | null;
}) {
  const isWebOrigin = isWebOriginUrl(props.url);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Site information"
          className="shrink-0"
        >
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 text-ui-sm">
        <BrowserSiteInfoRow
          title={isWebOrigin ? "Web page" : "Local page"}
          detail={
            isWebOrigin
              ? "Served over the network from this page's origin."
              : "Not loaded from a web address (for example, a blank tab or an internal page)."
          }
        />
        {props.cookieCryptoState === null ? null : (
          <BrowserSiteInfoRow
            title={cookieCryptoHeadline(props.cookieCryptoState)}
            detail={cookieCryptoDetail(props.cookieCryptoState)}
          />
        )}
      </PopoverContent>
    </Popover>
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

function cookieCryptoHeadline(state: BrowserCookieCryptoState): string {
  if (state.persistence === "ephemeral") return "Logins aren't saved";
  return state.mode === "real"
    ? "Logins saved securely"
    : "Logins saved with basic protection";
}

function cookieCryptoDetail(state: BrowserCookieCryptoState): string {
  if (state.mode === "degraded" || state.persistence === "ephemeral") {
    return browserCookieDegradedMessage(state);
  }
  if (state.mode === "real") {
    return "Cookies and saved logins on this page are encrypted by your operating system.";
  }
  return "Cookies and saved logins on this page use basic, less secure encryption.";
}
