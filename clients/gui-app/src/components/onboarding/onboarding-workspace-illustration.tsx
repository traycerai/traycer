import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  History,
  House,
  ImagePlus,
  ListFilter,
  MessageSquare,
  Menu,
  Mic,
  MoreHorizontal,
  MousePointer2,
  Plus,
  Split,
  SplitSquareHorizontal,
  SquareStack,
  Terminal,
  UnlockKeyhole,
  UserCircle,
  X,
} from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TabChromeBackground } from "@/components/layout/tabs/tab-chrome-background";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { OnboardingBrowserPreview } from "@/components/onboarding/onboarding-browser-preview";
import { cn } from "@/lib/utils";
import {
  DIORAMA_CHAPTERS,
  type DioramaChapter,
  type DioramaRegionId,
} from "@/components/onboarding/onboarding-diorama-chapters";
import "./onboarding-diorama.css";

export function OnboardingWorkspaceIllustration(props: {
  readonly mobile: boolean;
}) {
  if (props.mobile) {
    return (
      <figure className="onboarding-workspace onboarding-workspace--mobile">
        <MobileWorkspace />
        <figcaption className="sr-only">
          Tasks in the menu, conversations in the task switcher.
        </figcaption>
      </figure>
    );
  }
  return <WorkspaceDiorama />;
}

function WorkspaceDiorama() {
  // One value so a dot click restarts the timer even when it names the chapter
  // that is already playing (a new object is a new dependency).
  const [chapter, setChapter] = useState({ index: 0, run: 0 });
  const active = DIORAMA_CHAPTERS[chapter.index] ?? DIORAMA_CHAPTERS[0];

  useEffect(() => {
    if (chapter.index >= DIORAMA_CHAPTERS.length - 1) return;
    const timer = window.setTimeout(() => {
      setChapter((current) => ({
        index: current.index + 1,
        run: current.run,
      }));
    }, active.durationMs);
    return () => window.clearTimeout(timer);
  }, [chapter, active]);

  return (
    <figure className="onboarding-workspace">
      <div className="diorama-scene" data-chapter={chapter.index + 1}>
        <div className="diorama-stage">
          {/* Keyed so a jump replays the chapter from its first frame. */}
          <div key={chapter.run} className="diorama-frame">
            <DioramaWindow active={active} />
            {DIORAMA_CHAPTERS.map((entry, index) => (
              <DioramaCallout
                key={entry.id}
                chapter={entry}
                number={index + 1}
                active={index === chapter.index}
              />
            ))}
          </div>
        </div>
      </div>
      <nav className="diorama-chapters" aria-label="Workspace tour chapters">
        {DIORAMA_CHAPTERS.map((entry, index) => {
          const current = index === chapter.index;
          return (
            <button
              key={entry.id}
              type="button"
              className="diorama-chapter"
              data-active={current}
              aria-current={current ? "step" : undefined}
              onClick={() => {
                setChapter((value) => ({ index, run: value.run + 1 }));
              }}
            >
              {entry.label}
              <span className="diorama-chapter-track">
                {current ? (
                  <span
                    key={chapter.run}
                    className="diorama-chapter-line"
                    style={
                      {
                        "--diorama-chapter-duration": `${entry.durationMs}ms`,
                      } as CSSProperties
                    }
                  />
                ) : null}
              </span>
            </button>
          );
        })}
      </nav>
      <figcaption className="sr-only">
        Tasks live in horizontal tabs. Drag sidebar items onto the canvas to
        tile them. Click a sidebar item to open it. Agents can work on the same
        browser page.
      </figcaption>
    </figure>
  );
}

function DioramaCallout(props: {
  readonly chapter: DioramaChapter;
  readonly number: number;
  readonly active: boolean;
}) {
  return (
    <div
      className="diorama-callout"
      data-place={props.chapter.place}
      data-active={props.active}
      aria-hidden="true"
      style={
        {
          "--diorama-pin-x": props.chapter.x,
          "--diorama-pin-y": props.chapter.y,
        } as CSSProperties
      }
    >
      <span className="diorama-connector" />
      <span className="diorama-pin">{props.number}</span>
      <span className="diorama-label">
        <span className="diorama-label-title">{props.chapter.title}</span>
        <span className="diorama-label-line">{props.chapter.line}</span>
      </span>
    </div>
  );
}

/** Regions outside the chapter's spotlight fade back to .6. */
function dimOf(
  active: DioramaChapter,
  id: DioramaRegionId,
): "true" | undefined {
  return active.lit.includes(id) ? undefined : "true";
}

function ringOf(
  active: DioramaChapter,
  id: DioramaRegionId,
): "true" | undefined {
  return active.ring === id ? "true" : undefined;
}

function DioramaWindow(props: { readonly active: DioramaChapter }) {
  // `will-change: transform` is a rasterisation hint, not a style: it stays on
  // only for the entrance so Chromium re-rasters the text sharp afterwards.
  const [entered, setEntered] = useState(false);
  const active = props.active;
  return (
    <div
      className="diorama-window font-sans text-foreground"
      data-entered={entered}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntered(true);
      }}
    >
      <header
        className={cn(
          APP_HEADER_HEIGHT_CLASS,
          "relative flex shrink-0 items-center gap-3 border-b border-border bg-canvas px-3 text-canvas-foreground",
        )}
      >
        <ArrowLeft className="size-4 text-muted-foreground" />
        <ArrowRight className="size-4 text-muted-foreground" />
        <House className="ml-4 size-4 text-muted-foreground" />
        <div
          className="diorama-task-tabs ml-1 flex h-full min-w-0 flex-1 items-end rounded-md"
          data-region="tabs"
          data-dim={dimOf(active, "tabs")}
          data-ring={ringOf(active, "tabs")}
        >
          {["Launch website", "Mobile app", "API cleanup"].map(
            (label, index) => (
              <div
                key={label}
                className={cn(
                  "relative flex h-9 min-w-0 flex-1 items-center gap-2 px-6 text-ui-sm",
                  index === 0
                    ? "diorama-active-tab -mb-px z-10"
                    : "text-muted-foreground",
                )}
              >
                {index === 0 ? (
                  <TabChromeBackground
                    fill="var(--background)"
                    borderColor="var(--border)"
                    coversBaseline
                    className={undefined}
                  />
                ) : null}
                <MessageSquare className="relative size-3.5 shrink-0" />
                <span className="relative min-w-0 flex-1 truncate">
                  {label}
                </span>
                <X className="relative size-3 text-muted-foreground" />
              </div>
            ),
          )}
          <Plus className="mx-3 size-4 self-center text-muted-foreground" />
        </div>
        <History className="size-4 text-muted-foreground" />
        <Bell className="size-4 text-muted-foreground" />
        <UserCircle className="size-5 text-muted-foreground" />
      </header>
      <div className="relative grid min-h-0 flex-1 grid-cols-[22%_78%]">
        <aside className="flex min-h-0 flex-col bg-background">
          <div className="flex h-10 shrink-0 items-center justify-around px-3 text-muted-foreground">
            <MessageSquare className="size-4 text-foreground" />
            <Terminal className="size-4" />
            <GitBranch className="size-4" />
            <GitPullRequest className="size-4" />
            <Folder className="size-4" />
          </div>
          <SidebarSection
            title="Agents"
            icon={<MessageSquare className="size-3.5" />}
            active={active}
            regionId="agents"
          >
            <div className="diorama-sidebar-row bg-foreground/8">
              <MessageSquare className="size-3.5 text-info-foreground" />
              <span>Build the page</span>
              <span className="ml-auto text-ui-xs text-muted-foreground">
                2m
              </span>
            </div>
            <div className="diorama-sidebar-row">
              <MessageSquare className="size-3.5 text-info-foreground" />
              <span>Review changes</span>
              <span className="ml-auto text-ui-xs text-muted-foreground">
                5m
              </span>
            </div>
          </SidebarSection>
          <SidebarSection
            title="Browsers"
            icon={<Globe className="size-3.5" />}
            active={active}
            regionId="browsers"
          >
            <div className="diorama-sidebar-row diorama-browser-row">
              <Globe className="size-3.5 text-muted-foreground" />
              <span>Website preview</span>
            </div>
          </SidebarSection>
          <SidebarSection
            title="Artifacts"
            icon={<FileText className="size-3.5" />}
            active={active}
            regionId="artifacts"
          >
            <div className="diorama-sidebar-row diorama-source-row">
              <FileText className="size-3.5 text-success-foreground" />
              <span>Launch plan</span>
            </div>
            <div className="diorama-sidebar-row">
              <FileText className="size-3.5 text-muted-foreground" />
              <span>Design notes</span>
            </div>
          </SidebarSection>
        </aside>
        <div className="flex min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-end gap-3 px-3 text-muted-foreground">
            <span className="size-1 rounded-full bg-success" />
            <MoreHorizontal className="size-4" />
          </div>
          <div
            className="relative min-h-0 flex-1 overflow-hidden rounded-tl-lg border-l border-t border-canvas-border bg-canvas"
            data-region="canvas"
            data-dim={dimOf(active, "canvas")}
            data-ring={ringOf(active, "canvas")}
          >
            <div className="diorama-tiled grid h-full grid-cols-2">
              <DioramaPane kind="chat" />
              <div className="diorama-tiled-drop relative min-h-0 overflow-hidden border-l border-canvas-border">
                <DioramaPane kind="artifact" />
                <div
                  className="diorama-browser absolute inset-0"
                  data-region="browser"
                  data-dim={dimOf(active, "browser")}
                  data-ring={ringOf(active, "browser")}
                >
                  <OnboardingBrowserPreview />
                </div>
              </div>
            </div>
            <div className="diorama-unsplit absolute inset-0">
              <DioramaPane kind="chat" />
            </div>
            <div className="diorama-drop-target pointer-events-none absolute inset-y-2 right-2 w-[48%] rounded-md border border-primary/50 bg-primary/10" />
          </div>
        </div>
        <div className="diorama-cursor diorama-cursor--open pointer-events-none absolute">
          <MousePointer2 className="size-4 fill-foreground text-background drop-shadow-sm" />
        </div>
        <div className="diorama-drag pointer-events-none absolute">
          <span className="diorama-drag-card flex items-center gap-2 rounded-md bg-popover px-3 py-2 text-ui-sm text-popover-foreground shadow-lg ring-1 ring-border">
            <FileText className="size-4 text-success-foreground" />
            Launch plan
          </span>
          <MousePointer2 className="absolute -bottom-3 left-8 size-4 fill-foreground text-background drop-shadow-sm" />
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-background px-3 text-ui-xs text-muted-foreground">
        <HarnessIcon harnessId="claude" className="size-3" />
        <span>Claude Code</span>
        <span className="opacity-50">12% used</span>
        <span className="ml-auto">cpu 1% &nbsp; mem 240 MB</span>
      </div>
    </div>
  );
}

function MobileWorkspace() {
  return (
    <div
      className="diorama-mobile relative flex flex-col overflow-hidden rounded-2xl border border-border bg-background font-sans text-foreground"
      aria-hidden="true"
    >
      <header
        className={cn(
          APP_HEADER_HEIGHT_CLASS,
          "flex shrink-0 items-center gap-3 border-b border-border px-3",
        )}
      >
        <Menu className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">Launch website</span>
        <History className="size-4 text-muted-foreground" />
        <Bell className="size-4 text-muted-foreground" />
        <SquareStack className="size-4" />
      </header>
      <div className="min-h-0 flex-1">
        <DioramaPane kind="chat" />
      </div>
      <div className="diorama-mobile-sheet absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-popover p-4 text-popover-foreground shadow-2xl">
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-foreground/20" />
        <h2 className="mb-4 text-base font-medium">Tabs</h2>
        <div className="mb-4 flex items-center gap-5 border-b border-border pb-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Agents</span>
          <span>Terminals</span>
          <span>Browsers</span>
          <span>Artifacts</span>
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-foreground/8 p-3 text-sm">
          <MessageSquare className="size-4 text-info-foreground" />
          <span className="flex-1">Build the page</span>
          <HarnessIcon harnessId="claude" className="size-4" />
        </div>
        <div className="mt-1 flex items-center gap-3 rounded-lg p-3 text-sm">
          <MessageSquare className="size-4 text-info-foreground" />
          <span className="flex-1">Review changes</span>
          <HarnessIcon harnessId="codex" className="size-4" />
        </div>
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Plus className="size-4" />
          New agent
        </div>
      </div>
    </div>
  );
}

function SidebarSection(props: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly active: DioramaChapter;
  readonly regionId: DioramaRegionId;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="min-h-0 flex-1 rounded-md border-b border-border/60 px-2 pt-2"
      data-region={props.regionId}
      data-dim={dimOf(props.active, props.regionId)}
      data-ring={ringOf(props.active, props.regionId)}
    >
      <div className="flex h-8 items-center gap-1.5 px-1 text-ui-xs text-muted-foreground">
        <ChevronDown className="size-3" />
        {props.icon}
        <span className="flex-1 uppercase">{props.title}</span>
        <Plus className="size-3.5" />
        <MoreHorizontal className="size-3.5" />
        <ListFilter className="size-3.5" />
      </div>
      {props.children}
    </div>
  );
}

function DioramaPane(props: { readonly kind: "chat" | "artifact" }) {
  const chat = props.kind === "chat";
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="diorama-pane-tabs flex h-9 shrink-0 items-stretch border-b border-canvas-border/70 bg-canvas">
        <div className="relative flex min-w-0 items-center gap-1.5 border-r border-canvas-border/70 bg-background px-3 text-ui-sm">
          <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
          {chat ? (
            <MessageSquare className="size-3.5 text-info-foreground" />
          ) : (
            <FileText className="size-3.5 text-success-foreground" />
          )}
          <span className="truncate">
            {chat ? "Build the page" : "Launch plan"}
          </span>
          <X className="ml-2 size-3 text-muted-foreground" />
        </div>
        <div className="ml-auto flex items-center gap-3 px-2 text-muted-foreground">
          <SplitSquareHorizontal className="size-4" />
          <X className="size-4" />
        </div>
      </div>
      {chat ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden p-5 text-ui-sm leading-relaxed">
            <p className="ml-auto max-w-[90%] rounded-lg border border-border bg-foreground/5 px-3 py-2">
              Build the page from the launch plan.
            </p>
            <div className="flex items-center gap-2">
              <HarnessIcon harnessId="claude" className="size-4" />
              <span className="font-medium">Claude Code</span>
            </div>
            <p>I’ll build the portfolio from the plan.</p>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-ui-xs text-muted-foreground">
              <ChevronDown className="size-3" />
              <FileText className="size-3" />
              Read Launch plan
            </div>
            <p>The page is ready to preview.</p>
          </div>
          <DioramaComposer />
        </>
      ) : (
        <article className="min-h-0 flex-1 overflow-hidden p-6 text-ui-sm leading-relaxed">
          <h2 className="mb-6 text-xl font-semibold">Launch plan</h2>
          <h3 className="mb-2 font-medium">Portfolio website</h3>
          <p className="mb-6 text-muted-foreground">
            Selected projects and a way to get in touch.
          </p>
          <h3 className="mb-3 font-medium">Page sections</h3>
          <ul className="list-disc space-y-3 pl-4 text-muted-foreground">
            <li>Work</li>
            <li>About</li>
            <li>Contact</li>
          </ul>
        </article>
      )}
    </div>
  );
}

function DioramaComposer() {
  return (
    <div className="mt-auto w-full shrink-0 bg-canvas px-4 pb-4 pt-4">
      <div className="@container mx-auto flex max-w-3xl flex-col gap-3">
        <div className="rounded-lg bg-foreground/3 ring-1 ring-inset ring-border">
          <div className="px-4 pt-4">
            <p className="min-h-10 text-ui leading-relaxed text-muted-foreground">
              <span className="@max-lg:hidden">
                Ask anything, @tag files/folder, or use / to show available
                commands
              </span>
              <span className="hidden @max-lg:inline">Ask anything…</span>
            </p>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-2.5 pb-2.5 pt-1 text-ui-sm text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full">
                <ImagePlus className="size-4" />
              </span>
              <span className="inline-flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
                <UnlockKeyhole className="size-4 shrink-0" />
                <span className="truncate whitespace-nowrap @max-lg:hidden">
                  Full access
                </span>
                <ChevronDown className="size-3.5 shrink-0 @max-lg:hidden" />
              </span>
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1">
              <span className="inline-flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 @max-lg:size-8 @max-lg:justify-center @max-lg:px-0">
                <HarnessIcon harnessId="claude" />
                <span className="truncate whitespace-nowrap @max-lg:hidden">
                  Sonnet 4.5
                </span>
                <span className="text-muted-foreground/70 @max-lg:hidden">
                  ·
                </span>
                <span className="shrink-0 @max-lg:hidden">High</span>
                <ChevronDown className="size-3.5 shrink-0 @max-lg:hidden" />
              </span>
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full">
                <Mic className="size-4" />
              </span>
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8 opacity-50">
                <ArrowUp className="size-4" />
              </span>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden text-ui-sm text-muted-foreground">
          <span className="inline-flex h-7 max-w-[50%] shrink-0 items-center gap-1.5 rounded-lg px-1.5 font-medium">
            <span className="min-w-0 truncate">My Mac</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </span>
          <span className="inline-flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 opacity-70">
            <Split className="size-3.5 shrink-0 rotate-90" />
            <span className="min-w-0 truncate">website</span>
            <span className="shrink-0 text-lg leading-none text-current/70">
              ·
            </span>
            <span className="min-w-0 truncate">launch-page</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </span>
        </div>
      </div>
    </div>
  );
}
