import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  isAgentTabSurfacingMode,
  isBrowserLinkDefaultMode,
  isBrowserLinkOpenMode,
  useSettingsStore,
  type AgentTabSurfacingMode,
  type BrowserLinkDefaultMode,
  type BrowserLinkOpenMode,
} from "@/stores/settings/settings-store";

const BROWSER_LINK_DEFAULT_MODE_LABELS: Record<BrowserLinkDefaultMode, string> =
  {
    "in-app": "In app",
    external: "External",
    "per-kind": "Per kind",
  };
const BROWSER_LINK_OPEN_MODE_LABELS: Record<BrowserLinkOpenMode, string> = {
  "in-app": "In app",
  external: "External",
};
const AGENT_TAB_SURFACING_LABELS: Record<AgentTabSurfacingMode, string> = {
  pip: "Float (PiP)",
  tile: "Tile in canvas",
  off: "Off (background only)",
};

export function BrowserSettingsSection(): ReactNode {
  const browserLinkDefaultMode = useSettingsStore(
    (s) => s.browserLinkDefaultMode,
  );
  const setBrowserLinkDefaultMode = useSettingsStore(
    (s) => s.setBrowserLinkDefaultMode,
  );
  const terminalBrowserLinkOpenMode = useSettingsStore(
    (s) => s.terminalBrowserLinkOpenMode,
  );
  const setTerminalBrowserLinkOpenMode = useSettingsStore(
    (s) => s.setTerminalBrowserLinkOpenMode,
  );
  const markdownBrowserLinkOpenMode = useSettingsStore(
    (s) => s.markdownBrowserLinkOpenMode,
  );
  const setMarkdownBrowserLinkOpenMode = useSettingsStore(
    (s) => s.setMarkdownBrowserLinkOpenMode,
  );
  const agentTabSurfacingMode = useSettingsStore(
    (s) => s.agentTabSurfacingMode,
  );
  const setAgentTabSurfacingMode = useSettingsStore(
    (s) => s.setAgentTabSurfacingMode,
  );
  const browserDevOrigins = useSettingsStore((s) => s.browserDevOrigins);
  const removeBrowserDevOrigin = useSettingsStore(
    (s) => s.removeBrowserDevOrigin,
  );

  return (
    <SettingsGroup
      title="Browser"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <SettingsRow
        label="Web link default"
        description="Choose where http and https links open."
        control={
          <EnumSelect
            labels={BROWSER_LINK_DEFAULT_MODE_LABELS}
            isValue={isBrowserLinkDefaultMode}
            value={browserLinkDefaultMode}
            onValueChange={setBrowserLinkDefaultMode}
            ariaLabel="Web link default"
            triggerClassName="w-[min(42vw,11rem)]"
          />
        }
      />
      {browserLinkDefaultMode === "per-kind" ? (
        <>
          <SettingsRow
            label="Terminal links"
            description="Applies to plain terminal URLs and OSC-8 hyperlinks."
            control={
              <EnumSelect
                labels={BROWSER_LINK_OPEN_MODE_LABELS}
                isValue={isBrowserLinkOpenMode}
                value={terminalBrowserLinkOpenMode}
                onValueChange={setTerminalBrowserLinkOpenMode}
                ariaLabel="Link open mode"
                triggerClassName="w-[min(42vw,10rem)]"
              />
            }
          />
          <SettingsRow
            label="Markdown links"
            description="Applies to rendered markdown http and https anchors."
            control={
              <EnumSelect
                labels={BROWSER_LINK_OPEN_MODE_LABELS}
                isValue={isBrowserLinkOpenMode}
                value={markdownBrowserLinkOpenMode}
                onValueChange={setMarkdownBrowserLinkOpenMode}
                ariaLabel="Link open mode"
                triggerClassName="w-[min(42vw,10rem)]"
              />
            }
          />
        </>
      ) : null}
      <SettingsRow
        label="Agent tab surfacing"
        description="Choose what happens on your canvas when the agent opens a browser tab: float it picture-in-picture, place a tile, or keep it in the background (sidebar only)."
        control={
          <EnumSelect
            labels={AGENT_TAB_SURFACING_LABELS}
            isValue={isAgentTabSurfacingMode}
            value={agentTabSurfacingMode}
            onValueChange={setAgentTabSurfacingMode}
            ariaLabel="Agent tab surfacing"
            triggerClassName="w-[min(42vw,11rem)]"
          />
        }
      />
      {browserDevOrigins.length > 0 ? (
        <SettingsRow
          label="Detected dev origins"
          description="Terminal URLs with local hosts or explicit ports are kept for browser-origin classification."
          control={
            <BrowserDevOriginsControl
              origins={browserDevOrigins}
              onRemove={removeBrowserDevOrigin}
            />
          }
        />
      ) : null}
    </SettingsGroup>
  );
}

/**
 * One `Select` over a string-union setting: the labels record supplies both
 * the options and their order, and the union's own store guard narrows what
 * Radix hands back.
 */
function EnumSelect<T extends string>(props: {
  /**
   * Options and their order. Each caller declares its own constant as
   * `Record<Union, string>`, so member coverage is checked there.
   */
  readonly labels: Readonly<Record<string, string>>;
  readonly value: T;
  readonly isValue: (value: string) => value is T;
  readonly onValueChange: (value: T) => void;
  readonly ariaLabel: string;
  readonly triggerClassName: string;
}): ReactNode {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (props.isValue(value)) props.onValueChange(value);
      }}
    >
      <SelectTrigger
        aria-label={props.ariaLabel}
        className={props.triggerClassName}
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(props.labels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BrowserDevOriginsControl(props: {
  readonly origins: ReadonlyArray<string>;
  readonly onRemove: (origin: string) => void;
}): ReactNode {
  return (
    <div className="flex max-w-[min(48vw,24rem)] flex-col gap-2">
      {props.origins.map((origin) => (
        <div
          key={origin}
          className="flex min-w-0 items-center justify-end gap-2 text-ui-sm"
        >
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {origin}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              props.onRemove(origin);
            }}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
