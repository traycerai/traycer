import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import "@/index.css";
import { mergeRefs } from "@/lib/merge-refs";
import { LandingTerminalTabStrip } from "@/components/home/terminal-panel/landing-terminal-tab-strip";
import type { LandingTerminalTabRef } from "@/stores/home/landing-panel-store";
import { SidebarReparentRowDropWrapper } from "@/components/epic-canvas/sidebar/sidebar-reparent-row-drop-wrapper";
import { ContextMenu } from "@/components/ui/context-menu";
import {
  AdaptiveContent,
  AdaptiveItem,
  AdaptiveTrigger,
} from "./context-menu-row-interaction-adapter";
import {
  extractPierreItemPathFromEvent,
  PIERRE_ITEM_PATH_ATTR,
  type PierreActivationEvent,
} from "@/components/epic-canvas/pierre-tree-adapter";
import { cn } from "@/lib/utils";

/**
 * Real-browser row-interaction measurement for D16's ContextMenu modal
 * question (5 interactions, 4 families - real components where feasible,
 * shape-faithful reproductions where a component's own deps make that
 * infeasible). Measures only; the driver writes a JSON report meant to be
 * diffed between a HEAD (Radix) and current (Base) run of this same file -
 * the current/HEAD API split lives in `context-menu-row-interaction-
 * adapter.tsx`, not here. Full rationale (per-family choices, the file-tree
 * provider blocker, the backdrop-cutout evidence):
 * epics/aa29fad9-261d-4fa5-af95-b74a4ba7215b/artifacts/radix-to-base-ui/
 * tickets/t07-overlay-wave-2/validation/context-menu-row-interaction-evidence/index.md
 */
const params = new URLSearchParams(location.search);
const family = params.get("family") ?? "landing-tabstrip";

declare global {
  interface Window {
    rowInteraction: {
      events: string[];
    };
  }
}
window.rowInteraction = { events: [] };
function record(event: string): void {
  window.rowInteraction.events.push(event);
}

const ROW_COUNT = 8;
const ROW_LABELS = Array.from({ length: ROW_COUNT }, (_, i) => `Row ${i}`);

function terminalTab(id: string, name: string): LandingTerminalTabRef {
  return {
    kind: "terminal",
    instanceId: id,
    sessionId: `session-${id}`,
    hostId: "host-1",
    cwd: "~",
    name,
    titleSource: "default",
  };
}

function LandingTabStripFamily(): React.ReactElement {
  const [tabs] = useState<LandingTerminalTabRef[]>(() =>
    ROW_LABELS.map((label, index) =>
      terminalTab(String.fromCharCode(97 + index), label),
    ),
  );
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>("a");
  return (
    <div className="w-96" data-testid="row-interaction-strip">
      <LandingTerminalTabStrip
        tabs={tabs}
        placeholder={null}
        activeInstanceId={activeInstanceId}
        addTooltip="Add"
        onAdd={() => record("add")}
        onActivate={(instanceId) => {
          record(`activate:${instanceId}`);
          setActiveInstanceId(instanceId);
        }}
        onClose={(tab) => record(`close:${tab.instanceId}`)}
        onDismissPlaceholder={() => record("dismiss-placeholder")}
        onCloseAll={() => record("close-all")}
        onRename={(instanceId, next) => record(`rename:${instanceId}:${next}`)}
        canRename={() => true}
        terminalViewModels={{}}
        browserViewModels={{}}
      />
    </div>
  );
}

/**
 * Faithful Root+Trigger reproduction of `tab-strip-item.tsx`'s per-row shape
 * - see the module doc comment for why the content is a stand-in and why
 * `finalFocus={false}` is kept.
 */
function HeaderTabStripFamily(): React.ReactElement {
  const [activeIndex, setActiveIndex] = useState(0);
  return (
    <div
      className="flex w-96 gap-px overflow-x-auto"
      data-testid="row-interaction-strip"
    >
      {ROW_LABELS.map((label, index) => (
        <ContextMenu key={label}>
          <AdaptiveTrigger
            render={
              <div
                role="tab"
                tabIndex={0}
                aria-selected={activeIndex === index}
                data-testid={`row-${index}`}
                onClick={() => {
                  record(`activate:${index}`);
                  setActiveIndex(index);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  record(`activate:${index}`);
                  setActiveIndex(index);
                }}
                className={cn(
                  "flex h-9 w-40 shrink-0 cursor-pointer items-center border-r border-canvas-border/70 px-3 text-ui-sm",
                  activeIndex === index
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </div>
            }
          />
          <AdaptiveContent finalFocus={false}>
            <AdaptiveItem
              onActivate={() => record(`item-close:${index}`)}
              testId={`row-${index}-close`}
            >
              Close
            </AdaptiveItem>
          </AdaptiveContent>
        </ContextMenu>
      ))}
    </div>
  );
}

function SidebarRowFamily(): React.ReactElement {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  return (
    <div
      className="flex h-48 w-80 flex-col gap-1 overflow-y-auto"
      data-testid="row-interaction-strip"
    >
      {ROW_LABELS.map((label, index) => (
        <SidebarReparentRowDropWrapper
          key={label}
          epicId="epic-1"
          viewTabId="tab-1"
          nodeId={`node-${index}`}
          panelId="chats"
          contextMenu={
            <AdaptiveContent finalFocus>
              <AdaptiveItem
                onActivate={() => record(`item-close:${index}`)}
                testId={`row-${index}-close`}
              >
                Close
              </AdaptiveItem>
            </AdaptiveContent>
          }
        >
          <button
            type="button"
            data-testid={`row-${index}`}
            onClick={() => {
              record(`activate:${index}`);
              setActiveIndex(index);
            }}
            className={cn(
              "flex h-8 w-full shrink-0 items-center rounded-md px-2 text-left text-ui-sm hover:bg-accent/70 hover:text-accent-foreground",
              activeIndex === index && "bg-accent text-foreground",
            )}
          >
            {label}
          </button>
        </SidebarReparentRowDropWrapper>
      ))}
    </div>
  );
}

/**
 * Real `open` shadow root, populated through a React portal. Pierre renders
 * its rows inside one - `extractPierreItemPathFromEvent` reads
 * `composedPath()` specifically (not `event.target`) because a listener
 * OUTSIDE a shadow boundary sees a retargeted `target` (the shadow host, not
 * the row), while `composedPath()` still lists the real internal path. A
 * light-DOM stand-in never exercises that retargeting, so it cannot prove
 * the capture still works across it - this must actually cross the
 * boundary. `adoptedStyleSheets` rejects a `<link>`/`<style>`-sourced
 * (non-constructed) `CSSStyleSheet` in Chromium, so the document's rules are
 * copied into one constructed sheet via `replaceSync` and that sheet is
 * adopted - interaction (3)'s hover check and the rows' own `h-8`
 * sizing/overflow both depend on these rules actually reaching the shadow
 * tree.
 */
const ShadowTreeHost = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { readonly children: ReactNode }
>(function ShadowTreeHost({ children, ...divProps }, forwardedRef) {
  // Base's `ContextMenuTrigger` merges its own onContextMenu/onPointerDown/
  // ref onto whatever `render` is via a plain element clone, so this must be
  // a real host div forwarding both - a non-forwarding component would
  // silently swallow the merged ref and handlers.
  const localRef = useRef<HTMLDivElement | null>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  useEffect(() => {
    const host = localRef.current;
    if (host === null) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const cssText = [...document.styleSheets]
      .map((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        } catch {
          // Cross-origin sheets refuse `cssRules` access; skip just that
          // one rather than failing the whole adoption.
          return "";
        }
      })
      .join("\n");
    const constructed = new CSSStyleSheet();
    constructed.replaceSync(cssText);
    root.adoptedStyleSheets = [constructed];
    setShadowRoot(root);
  }, []);
  return (
    <div
      ref={mergeRefs(localRef, forwardedRef)}
      data-testid="file-tree-shadow-host"
      {...divProps}
    >
      {shadowRoot === null ? null : createPortal(children, shadowRoot)}
    </div>
  );
});

/** See the module doc comment for why this is a reproduction, not the real
 * exported `FileTreeRowContextMenu`. */
function FileTreeFamily(): React.ReactElement {
  const [row, setRow] = useState<{ readonly treePath: string } | null>(null);
  const captureRow = (
    event: PierreActivationEvent & { readonly preventDefault: () => void },
  ): void => {
    const treePath = extractPierreItemPathFromEvent(event);
    if (treePath === null) {
      // Mirrors the real FileTreeRowContextMenu: a press that hit no row
      // must not open an empty menu over blank tree space.
      event.preventDefault();
      setRow(null);
      return;
    }
    setRow({ treePath });
  };
  return (
    <ContextMenu>
      <div
        className="h-48 w-64 overflow-y-auto"
        data-testid="row-interaction-strip"
      >
        <AdaptiveTrigger
          onContextMenu={captureRow}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse") return;
            captureRow(event);
          }}
          render={
            <ShadowTreeHost>
              <div className="flex flex-col">
                {ROW_LABELS.map((label, index) => (
                  <div
                    key={label}
                    {...{ [PIERRE_ITEM_PATH_ATTR]: `file-${index}.ts` }}
                    data-testid={`row-${index}`}
                    role="treeitem"
                    tabIndex={0}
                    onClick={() => record(`activate:${index}`)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      record(`activate:${index}`);
                    }}
                    className="flex h-8 items-center px-2 text-ui-sm text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground"
                  >
                    {label}
                  </div>
                ))}
              </div>
            </ShadowTreeHost>
          }
        />
      </div>
      {row === null ? null : (
        <AdaptiveContent finalFocus>
          <AdaptiveItem
            onActivate={() => record(`copy-path:${row.treePath}`)}
            testId={`file-tree-copy-path:${row.treePath}`}
          >
            Copy Path
          </AdaptiveItem>
        </AdaptiveContent>
      )}
    </ContextMenu>
  );
}

function familyFixture(): React.ReactElement {
  if (family === "header-tabstrip") return <HeaderTabStripFamily />;
  if (family === "sidebar-row") return <SidebarRowFamily />;
  if (family === "file-tree") return <FileTreeFamily />;
  return <LandingTabStripFamily />;
}

export function Fixture(): React.ReactElement {
  return (
    <div className="p-8" data-gate-outside tabIndex={-1}>
      {familyFixture()}
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<Fixture />);
