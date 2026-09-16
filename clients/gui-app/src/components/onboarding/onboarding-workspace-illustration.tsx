import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useReducedMotion } from "motion/react";
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
  dioramaElapsedMs,
  setDioramaPaused,
  stepDioramaChapter,
  type DioramaChapter,
  type DioramaClock,
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
  const reducedMotion = useReducedMotion() === true;
  // One value so a segment click restarts the timer even when it names the
  // chapter that is already playing (a new object is a new dependency).
  const [chapter, setChapter] = useState({ index: 0, run: 0 });
  const active = DIORAMA_CHAPTERS[chapter.index] ?? DIORAMA_CHAPTERS[0];
  const clock = useRef<DioramaClock>({ startedAt: 0, pausedAt: null });
  /** Every live reason the tour is holding: hover, keyboard focus, hidden tab. */
  const holds = useRef(new Set<string>());
  const fills = useRef<(HTMLSpanElement | null)[]>([]);
  const segments = useRef<(HTMLButtonElement | null)[]>([]);

  // The fills are written straight to the DOM: a state update per frame would
  // re-render the whole window tree to move one clip-path edge.
  const paint = useCallback((index: number, ratio: number) => {
    fills.current.forEach((fill, position) => {
      if (!fill) return;
      let remaining = 100;
      if (position < index) remaining = 0;
      else if (position === index) remaining = (1 - ratio) * 100;
      fill.style.clipPath = `inset(0 ${remaining}% 0 0)`;
    });
  }, []);

  const hold = useCallback((reason: string, held: boolean) => {
    if (held) holds.current.add(reason);
    else holds.current.delete(reason);
    clock.current = setDioramaPaused(
      clock.current,
      holds.current.size > 0,
      performance.now(),
    );
  }, []);

  const select = useCallback((index: number) => {
    setChapter((current) => ({ index, run: current.run + 1 }));
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      hold("hidden", document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hold]);

  // One rAF loop per chapter, reading elapsed time off the clock rather than
  // counting frames, so a pause is exact and a resume loses nothing.
  useEffect(() => {
    if (reducedMotion) {
      paint(chapter.index, 1);
      return;
    }
    const started = performance.now();
    clock.current = {
      startedAt: started,
      pausedAt: holds.current.size > 0 ? started : null,
    };
    let frame = 0;
    const tick = () => {
      const elapsed = dioramaElapsedMs(clock.current, performance.now());
      const ratio = Math.min(1, elapsed / active.durationMs);
      paint(chapter.index, ratio);
      if (ratio === 1) {
        setChapter((current) => ({
          index: stepDioramaChapter(current.index, 1),
          run: current.run,
        }));
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [chapter, active, reducedMotion, paint]);

  return (
    <figure className="onboarding-workspace">
      <div className="diorama-scene" data-chapter={chapter.index + 1}>
        <div className="diorama-stage">
          <div
            className="diorama-frame"
            onPointerEnter={() => {
              hold("frame", true);
            }}
            onPointerLeave={() => {
              hold("frame", false);
            }}
          >
            <DioramaWindow active={active} run={chapter.run} />
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
        <div
          className="diorama-chapters"
          role="group"
          aria-label="Workspace chapters"
          onPointerEnter={() => {
            hold("strip", true);
          }}
          onPointerLeave={() => {
            hold("strip", false);
          }}
          onFocus={(event) => {
            // Only a keyboard landing holds the tour: a click already holds it
            // by hover, and would otherwise keep holding it after the pointer
            // has left the strip.
            hold("focus", event.target.matches(":focus-visible"));
          }}
          onBlur={() => {
            hold("focus", false);
          }}
        >
          {DIORAMA_CHAPTERS.map((entry, index) => {
            const current = index === chapter.index;
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  segments.current[index] = node;
                }}
                type="button"
                className="diorama-chapter"
                data-active={current}
                aria-pressed={current}
                aria-current={current ? "step" : undefined}
                tabIndex={current ? 0 : -1}
                onClick={() => {
                  select(index);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                    return;
                  event.preventDefault();
                  const next = stepDioramaChapter(
                    index,
                    event.key === "ArrowRight" ? 1 : -1,
                  );
                  select(next);
                  segments.current[next]?.focus();
                }}
              >
                <span className="diorama-chapter-track">
                  <span
                    ref={(node) => {
                      fills.current[index] = node;
                    }}
                    className="diorama-chapter-fill"
                  />
                </span>
                <span className="diorama-chapter-label">{entry.label}</span>
                <span className="diorama-chapter-caption">{entry.title}</span>
              </button>
            );
          })}
        </div>
      </div>
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

function DioramaWindow(props: {
  readonly active: DioramaChapter;
  readonly run: number;
}) {
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
      {/* Keyed so a jump replays the chapter from its first frame. The window
          itself stays mounted: its entrance belongs to the page's arrival, not
          to every segment click. */}
      <Fragment key={props.run}>
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
            className="diorama-task-tabs ml-1 flex h-full min-w-0 flex-1 items-end rounded-md px-0.75 pb-0.75"
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
            {/* The canvas is inset from the window edge and pads its tiles, the
              way the real app gutters them - which is also what gives both
              spotlight rings room to draw outside the region they ring. */}
            <div
              className="relative m-1.5 min-h-0 flex-1 overflow-hidden rounded-lg border border-canvas-border bg-canvas p-1.5"
              data-region="canvas"
              data-dim={dimOf(active, "canvas")}
              data-ring={ringOf(active, "canvas")}
            >
              <div className="diorama-tiled grid h-full grid-cols-2 gap-1.5">
                <DioramaPane kind="chat" />
                <div className="diorama-tiled-drop relative min-h-0">
                  <DioramaPane kind="artifact" />
                  <div
                    className="diorama-browser absolute inset-0 overflow-hidden rounded-md"
                    data-region="browser"
                    data-dim={dimOf(active, "browser")}
                    data-ring={ringOf(active, "browser")}
                  >
                    <OnboardingBrowserPreview />
                  </div>
                </div>
              </div>
              <div className="diorama-unsplit absolute inset-1.5">
                <DioramaPane kind="chat" />
              </div>
              <div className="diorama-drop-target pointer-events-none absolute inset-y-1.5 right-1.5 w-[48%] rounded-md border border-primary/50 bg-primary/10" />
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
      </Fragment>
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
  // `ml-1.5` is the spotlight ring's room: without it this row's left edge is
  // the window's own edge, which clips anything drawn outside it.
  return (
    <div
      className="ml-1.5 min-h-0 flex-1 rounded-md border-b border-border/60 px-2 pt-2"
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
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-md bg-background">
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
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden p-4 text-ui-sm leading-relaxed">
            <p className="diorama-chat-prompt ml-auto max-w-[90%] rounded-lg border border-border bg-foreground/5 px-3 py-1.5">
              Build the page from the launch plan.
            </p>
            <div className="flex items-center gap-2">
              <HarnessIcon harnessId="claude" className="size-4" />
              <span className="font-medium">Claude Code</span>
            </div>
            <p className="diorama-chat-reply">
              I’ll build the portfolio from the plan.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-ui-xs text-muted-foreground">
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
    <div className="mt-auto w-full shrink-0 bg-canvas px-4 pb-3 pt-3">
      <div className="@container mx-auto flex max-w-3xl flex-col gap-2">
        <div className="rounded-lg bg-foreground/3 ring-1 ring-inset ring-border">
          <div className="px-4 pt-3">
            <p className="min-h-9 text-ui leading-relaxed text-muted-foreground">
              <span className="@max-lg:hidden">
                Ask anything, @tag files/folder, or use / to show available
                commands
              </span>
              <span className="hidden @max-lg:inline">Ask anything…</span>
            </p>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-2.5 pb-2 pt-0.5 text-ui-sm text-muted-foreground">
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
          <span className="inline-flex h-6 max-w-[50%] shrink-0 items-center gap-1.5 rounded-lg px-1.5 font-medium">
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
