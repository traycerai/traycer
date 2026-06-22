import type { ReactNode } from "react";
import {
  AlignJustify,
  ChevronsDownUp,
  ChevronsUpDown,
  Diff,
  ExternalLink,
  EyeOff,
  type LucideIcon,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { DiffSplitIcon, DiffUnifiedIcon } from "./diff-mode-icons";
import type { GitDiffTileViewState } from "@/stores/epics/canvas/types";
import type {
  DiffViewerPreferences,
  GitDiffIndicatorStyle,
  GitDiffViewMode,
} from "@/lib/diff/diff-viewer-preferences";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

// @pierre/diffs gutter indicator styles, mapped to a representative icon.
const INDICATOR_OPTIONS: ReadonlyArray<{
  readonly value: GitDiffIndicatorStyle;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { value: "bars", label: "Bars", icon: AlignJustify },
  { value: "classic", label: "Plus / minus", icon: Diff },
  { value: "none", label: "Hidden", icon: EyeOff },
];

export type DiffTabToolbarView = DiffViewerPreferences & GitDiffTileViewState;

export type DiffTabToolbarViewPatch =
  | { readonly mode: GitDiffViewMode }
  | { readonly wordWrap: boolean }
  | { readonly ignoreWhitespace: boolean }
  | { readonly backgrounds: boolean }
  | { readonly lineNumbers: boolean }
  | { readonly indicatorStyle: GitDiffIndicatorStyle }
  | { readonly collapsedFilePaths: ReadonlyArray<string> };

interface DiffTabToolbarProps {
  readonly view: DiffTabToolbarView;
  readonly onViewPatch: (patch: DiffTabToolbarViewPatch) => void;
  // Collapse/expand every file in a bundle; null for single-file tiles.
  readonly collapseAll: {
    readonly allCollapsed: boolean;
    readonly filePaths: ReadonlyArray<string>;
  } | null;
  readonly refreshing: boolean;
  // `null` hides the refresh control entirely (snapshot diffs are immutable -
  // there is nothing to re-fetch).
  readonly onRefresh: (() => void) | null;
  // Editor-open action; null hides the row (e.g. bundle tiles with no single file).
  readonly onOpenFile: (() => void) | null;
  readonly openFileDisabled: boolean;
  readonly openFileOpening: boolean;
}

export function DiffTabToolbar(props: DiffTabToolbarProps) {
  const view = props.view;
  const isSplit = view.mode === "split";

  const collapseAll = props.collapseAll;
  const settings: ReadonlyArray<{
    readonly label: string;
    readonly checked: boolean;
    readonly patch: (checked: boolean) => DiffTabToolbarViewPatch;
  }> = [
    {
      label: "Backgrounds",
      checked: view.backgrounds,
      patch: (backgrounds) => ({ backgrounds }),
    },
    {
      label: "Line numbers",
      checked: view.lineNumbers,
      patch: (lineNumbers) => ({ lineNumbers }),
    },
    {
      label: "Word wrap",
      checked: view.wordWrap,
      patch: (wordWrap) => ({ wordWrap }),
    },
    {
      label: "Ignore whitespace",
      checked: view.ignoreWhitespace,
      patch: (ignoreWhitespace) => ({ ignoreWhitespace }),
    },
  ];

  return (
    <div className="flex items-center gap-0.5">
      {collapseAll !== null ? (
        <Button
          type="button"
          onClick={() =>
            props.onViewPatch({
              collapsedFilePaths: collapseAll.allCollapsed
                ? []
                : [...collapseAll.filePaths],
            })
          }
          variant="ghost"
          size="icon-sm"
          aria-label={collapseAll.allCollapsed ? "Expand all" : "Collapse all"}
          title={collapseAll.allCollapsed ? "Expand all" : "Collapse all"}
          className="text-muted-foreground hover:text-foreground"
        >
          {collapseAll.allCollapsed ? (
            <ChevronsUpDown className="size-4" />
          ) : (
            <ChevronsDownUp className="size-4" />
          )}
        </Button>
      ) : null}

      <Button
        type="button"
        onClick={() =>
          props.onViewPatch({ mode: isSplit ? "unified" : "split" })
        }
        variant="ghost"
        size="icon-sm"
        aria-label={isSplit ? "Switch to unified view" : "Switch to split view"}
        title={isSplit ? "Split view" : "Unified view"}
        className="text-muted-foreground hover:text-foreground"
      >
        {isSplit ? (
          <DiffSplitIcon className="size-4" />
        ) : (
          <DiffUnifiedIcon className="size-4" />
        )}
      </Button>

      {props.onRefresh !== null ? (
        <Button
          type="button"
          onClick={props.onRefresh}
          disabled={props.refreshing}
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh diff"
          title="Refresh diff"
          className="text-muted-foreground hover:text-foreground"
        >
          <RotateCcw
            className={cn("size-4", props.refreshing && "animate-spin")}
          />
        </Button>
      ) : null}

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Diff settings"
            title="Diff settings"
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(80vw,15rem)] gap-0 p-1">
          {settings.map((setting) => (
            <DiffSettingRow
              key={setting.label}
              label={setting.label}
              checked={setting.checked}
              onCheckedChange={(checked) =>
                props.onViewPatch(setting.patch(checked))
              }
            />
          ))}
          <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-ui-sm">
            <span>Indicator style</span>
            <IndicatorStyleControl
              value={view.indicatorStyle}
              onChange={(indicatorStyle) =>
                props.onViewPatch({ indicatorStyle })
              }
            />
          </div>
          {props.onOpenFile !== null ? (
            <>
              <Separator className="my-1" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onOpenFile}
                disabled={props.openFileDisabled}
                className="h-7 w-full justify-start font-normal text-foreground"
              >
                {props.openFileOpening ? (
                  <AgentSpinningDots
                    className="size-4 text-muted-foreground"
                    testId="diff-tab-open-editor-spinner"
                    variant={undefined}
                  />
                ) : (
                  <ExternalLink className="size-4 text-muted-foreground" />
                )}
                Open in editor
              </Button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DiffSettingRow(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (on: boolean) => void;
}): ReactNode {
  return (
    <Label className="cursor-pointer justify-between gap-3 rounded-md px-2 py-1.5 font-normal transition-colors hover:bg-accent">
      <span>{props.label}</span>
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </Label>
  );
}

// Segmented control with a sliding "magnetic" highlight (diffshub style): one
// pill slides between equal-width segments instead of each button toggling its
// own background. The highlight translates by whole segment widths, so its own
// width is the segment width and translateX(index * 100%) lands it exactly.
function IndicatorStyleControl(props: {
  readonly value: GitDiffIndicatorStyle;
  readonly onChange: (style: GitDiffIndicatorStyle) => void;
}): ReactNode {
  const activeIndex = INDICATOR_OPTIONS.findIndex(
    (option) => option.value === props.value,
  );

  return (
    <div
      role="radiogroup"
      aria-label="Indicator style"
      className="relative flex items-center rounded-md bg-muted p-0.5"
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 w-7 rounded-sm bg-background shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${Math.max(activeIndex, 0) * 100}%)` }}
      />
      {INDICATOR_OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = props.value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "relative z-10 flex size-7 items-center justify-center rounded-sm transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
