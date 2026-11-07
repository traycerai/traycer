import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { FileClock, LineChart, Paintbrush } from "lucide-react";
import { EpicStatusRow } from "@/components/epic-canvas/panels/epic-status-row";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The real `EpicStatusRow` with its real playback buttons, beside stand-ins of
 * the longest content the row ever carries: the connection pill at its longest
 * label, the write-commands and usage entries, "Export artifacts" and the
 * sweep action. Where the buttons stop fitting is real layout, which jsdom
 * cannot decide. The stand-ins use the same components and classes as the
 * originals, which need a host runtime this page has none of.
 *
 * The row's parent is the column the row sits in: `__playbackRowProbe.setColumnWidth`
 * narrows it, and the window is left alone. The build here has no tracks, so the
 * page gives `globalThis.runnerHost` the bridge a desktop build has, which is what
 * `soundtrackOffered()` reads, and turns Music and the option on.
 */
declare global {
  interface Window {
    __playbackRowProbe?: {
      readonly setColumnWidth: (pixels: number) => void;
    };
  }
}

Object.defineProperty(globalThis, "runnerHost", {
  configurable: true,
  value: {
    soundtrackSourceAvailable: true,
    readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" }),
  },
});
useSettingsStore.setState({
  soundtrackEnabled: true,
  soundtrackPlaybackControls: true,
});

function IconEntry(props: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.label}
      side="bottom"
      sideOffset={undefined}
      align="end"
    >
      <Button
        type="button"
        variant="muted"
        size="icon-xs"
        aria-label={props.label}
        data-testid={props.testId}
      >
        {props.children}
      </Button>
    </TooltipWrapper>
  );
}

export function Fixture(): ReactNode {
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    window.__playbackRowProbe = { setColumnWidth: setWidth };
  }, []);
  return (
    <TooltipProvider>
      <div data-testid="column" style={{ width }}>
        <EpicStatusRow>
          <button
            type="button"
            data-testid="stand-in-pill"
            className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-ui-xs font-medium text-destructive"
          >
            <span
              className="size-1.5 rounded-full bg-destructive"
              aria-hidden
            />
            Offline — new edits not backed up
          </button>
          <IconEntry label="2 pending changes" testId="stand-in-write-commands">
            <FileClock className="size-3.5" />
          </IconEntry>
          <IconEntry label="Usage" testId="stand-in-usage">
            <LineChart className="size-3.5" />
          </IconEntry>
          <Button
            type="button"
            size="inline-xs"
            variant="ghost"
            className="text-current underline underline-offset-2"
            data-testid="stand-in-export"
          >
            Export artifacts
          </Button>
          <IconEntry label="Sweep worktrees" testId="stand-in-sweep">
            <Paintbrush className="size-3.5" />
          </IconEntry>
        </EpicStatusRow>
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("no root element");
createRoot(root).render(<Fixture />);
