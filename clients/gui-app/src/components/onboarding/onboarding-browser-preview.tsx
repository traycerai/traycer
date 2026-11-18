import { memo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  EllipsisVertical,
  MonitorSmartphone,
  MousePointer2,
  RotateCw,
} from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";

/**
 * The browser's chrome and its page. The tab above it belongs to the tile, not
 * to this preview: the tile carries both "Launch plan" and "Website preview".
 * Memoised - it reads nothing from the tour's beat.
 */
export const OnboardingBrowserPreview = memo(
  function OnboardingBrowserPreview() {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 text-muted-foreground">
          <ArrowLeft className="size-3.5" />
          <ArrowRight className="size-3.5 opacity-40" />
          <RotateCw className="size-3.5" />
          <span className="min-w-0 flex-1 truncate px-1 font-mono text-ui-xs">
            localhost:3000
          </span>
          <div className="flex items-center gap-3 border-l border-border pl-3">
            <MonitorSmartphone className="size-3.5" />
            <EllipsisVertical className="size-3.5" />
          </div>
        </div>
        <div className="diorama-browser-page relative min-h-0 flex-1 overflow-hidden bg-background text-foreground">
          <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-5 p-6">
            <div className="flex items-center gap-5 text-ui-xs">
              <span className="mr-auto text-sm font-semibold tracking-tight">
                Fieldwork
              </span>
              <span className="diorama-browser-work rounded-sm px-1 py-0.5">
                Work
              </span>
              <span className="text-muted-foreground">About</span>
            </div>
            <h2 className="max-w-[12ch] text-[2rem] font-medium leading-[1.1] tracking-tight text-balance">
              Spaces for good work.
            </h2>
            <div className="min-h-0 overflow-hidden rounded-lg bg-primary/8">
              <svg
                viewBox="0 0 420 200"
                className="h-full w-full text-primary"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m52 147 143-77 169 55-142 77Z"
                  fill="currentColor"
                  opacity=".08"
                />
                <path
                  d="M85 132V68l107-48v95Zm107-112 125 44v87l-125-36Z"
                  fill="var(--background)"
                />
                <path
                  d="M85 132V68l107-48 125 44v87l-125-36Zm107-112v95m0-44 125 44M85 98l107-48m38-17v95m44-79v95"
                  stroke="currentColor"
                  strokeOpacity=".45"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="m113 146 58-30 85 29-56 32Z"
                  fill="currentColor"
                  opacity=".2"
                />
                <path
                  d="m113 146 58-30 85 29-56 32Zm87 31v13m-87-44v13m143-14v13"
                  stroke="currentColor"
                  strokeOpacity=".65"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M293 132v-18m0 8c-21 0-18-21-9-21 2-13 21-11 20 1 14 5 6 20-11 20Z"
                  stroke="currentColor"
                  strokeOpacity=".55"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="flex items-center justify-between gap-3 text-ui-xs">
              <span className="text-muted-foreground">The garden studio</span>
              <span className="diorama-browser-project inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground px-3 py-2 text-background">
                View project
                <ArrowUpRight className="size-3.5" />
              </span>
            </div>
          </div>
          <div className="diorama-browser-cursor diorama-browser-cursor--claude pointer-events-none absolute left-0 top-0 flex items-start gap-1 text-primary">
            <MousePointer2 className="size-4 shrink-0 fill-current drop-shadow-sm" />
            <span className="mt-2 inline-flex items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 text-ui-xs text-primary-foreground shadow-sm">
              <HarnessIcon harnessId="claude" className="size-3" />
              Claude
            </span>
          </div>
          <div className="diorama-browser-cursor diorama-browser-cursor--codex pointer-events-none absolute left-0 top-0 flex items-start gap-1 text-foreground">
            <MousePointer2 className="size-4 shrink-0 fill-current drop-shadow-sm" />
            <span className="mt-2 inline-flex items-center gap-1 rounded-sm bg-foreground px-1.5 py-0.5 text-ui-xs text-background shadow-sm">
              <HarnessIcon harnessId="codex" className="size-3" />
              Codex
            </span>
          </div>
        </div>
      </div>
    );
  },
);
