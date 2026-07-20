import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { BlockErrorBoundary } from "../shared/block-error-boundary";
import { MermaidBlockToolbar } from "./mermaid-block-toolbar";
import { MermaidExpandButton } from "./mermaid-expand-button";
import { MermaidFullscreenDialog } from "./mermaid-fullscreen-dialog";
import {
  deriveMermaidAriaLabel,
  deriveMermaidErrorMessage,
  ensureMermaidReady,
  parseMermaid,
  renderMermaidSvg,
  subscribeMermaidTheme,
} from "./mermaid-service";
import { useMermaidPngDownload } from "./use-mermaid-png-download";

/**
 * Code editor is loaded on first open - CodeMirror adds ~150 kB gzip so
 * holding it off the initial artifact render keeps the first paint fast.
 */
const MermaidCodeEditor = lazy(() =>
  import("./mermaid-code-editor").then((mod) => ({
    default: mod.MermaidCodeEditor,
  })),
);

const RENDER_DEBOUNCE_MS = 500;
const ATTR_DEBOUNCE_MS = 300;
const EMPTY_PLACEHOLDER = "graph TD\n  A --> B";

interface RenderState {
  readonly status: "idle" | "pending" | "ready" | "error";
  readonly svg: string;
  readonly error: string;
}

export function MermaidNodeView(props: NodeViewProps) {
  const { node, updateAttributes, selected, editor } = props;
  const rawCode = (node.attrs as { code?: string }).code ?? "";

  const editable = editor.isEditable;

  // Auto-open the editor when the node mounts empty - promoted from a
  // bare ` ```mermaid ``` ` fence the user clearly wants to author. The
  // lazy initializer runs exactly once at mount so no effect-driven
  // setState is needed.
  const [editing, setEditing] = useState<boolean>(
    () => editable && rawCode.trim().length === 0,
  );
  // Draft seeds from the current code (or the placeholder for the
  // auto-open case) and is pushed to the Yjs attr on a debounce.
  const [draft, setDraft] = useState<string>(() =>
    editable && rawCode.trim().length === 0 ? EMPTY_PLACEHOLDER : rawCode,
  );
  const [render, setRender] = useState<RenderState>({
    status: "idle",
    svg: "",
    error: "",
  });
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const activeCode = editing ? draft : rawCode;

  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Debounced attribute commit - writes flow to Yjs at most every 300ms.
  const attrTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!editing) return;
    if (draft === rawCode) return;
    if (attrTimerRef.current !== null)
      window.clearTimeout(attrTimerRef.current);
    attrTimerRef.current = window.setTimeout(() => {
      attrTimerRef.current = null;
      updateAttributes({ code: draftRef.current });
    }, ATTR_DEBOUNCE_MS);
    return () => {
      if (attrTimerRef.current !== null) {
        window.clearTimeout(attrTimerRef.current);
        attrTimerRef.current = null;
      }
    };
  }, [draft, editing, rawCode, updateAttributes]);

  // Debounced render - avoids reparsing on every keystroke.
  const renderTimerRef = useRef<number | null>(null);
  const renderTokenRef = useRef(0);

  const triggerRender = useCallback((code: string) => {
    const token = (renderTokenRef.current += 1);
    if (code.trim().length === 0) {
      setRender({ status: "idle", svg: "", error: "" });
      return;
    }
    setRender((prev) => ({ ...prev, status: "pending" }));
    void (async (): Promise<void> => {
      try {
        await parseMermaid(code);
        if (token === renderTokenRef.current) {
          const { svg } = await renderMermaidSvg(code);
          if (token === renderTokenRef.current) {
            setRender({ status: "ready", svg, error: "" });
          }
        }
      } catch (err) {
        if (token !== renderTokenRef.current) return;
        const message = deriveMermaidErrorMessage(err);
        setRender({ status: "error", svg: "", error: message });
      }
    })();
  }, []);

  useEffect(() => {
    if (renderTimerRef.current !== null) {
      window.clearTimeout(renderTimerRef.current);
    }
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      triggerRender(activeCode);
    }, RENDER_DEBOUNCE_MS);
    return () => {
      if (renderTimerRef.current !== null) {
        window.clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
    };
  }, [activeCode, triggerRender]);

  // Re-render when mermaid theme flips (dark mode toggle).
  useEffect(() => {
    const unsubscribe = subscribeMermaidTheme(() => {
      triggerRender(activeCode);
    });
    return unsubscribe;
  }, [activeCode, triggerRender]);

  // Prime mermaid load so the first render is snappier. Don't block on it.
  useEffect(() => {
    void ensureMermaidReady();
  }, []);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(activeCode).then(() => {
      toast.success("Mermaid source copied");
    });
  }, [activeCode]);

  const { downloadMermaidPng, isDownloading } = useMermaidPngDownload({
    svg: render.svg,
    enabled: render.status === "ready",
  });

  const handleToggleEdit = useCallback(() => {
    setEditing((prev) => {
      if (prev) {
        // Flush any pending debounce on close.
        if (attrTimerRef.current !== null) {
          clearTimeout(attrTimerRef.current);
          attrTimerRef.current = null;
        }
        if (draftRef.current !== rawCode) {
          updateAttributes({ code: draftRef.current });
        }
        return false;
      }
      // Opening - seed draft from current code (empty case handled above).
      setDraft(rawCode.length > 0 ? rawCode : EMPTY_PLACEHOLDER);
      return true;
    });
  }, [rawCode, updateAttributes]);

  const ariaLabel = useMemo(
    () => deriveMermaidAriaLabel(activeCode),
    [activeCode],
  );
  const renderedSvg = useMemo(
    () =>
      render.status === "ready"
        ? trustedMarkupToReactNodes(render.svg, "svg")
        : null,
    [render.status, render.svg],
  );

  return (
    <NodeViewWrapper
      className={cn("tc-node-mermaid", selected && "is-selected")}
      data-editing={editing ? "true" : "false"}
    >
      <BlockErrorBoundary title="Mermaid block crashed" onCopy={handleCopy}>
        <MermaidBlockToolbar
          editing={editing}
          editable={editable}
          onToggleEdit={handleToggleEdit}
          onCopyCode={handleCopy}
          onDownloadPng={downloadMermaidPng}
          downloadDisabled={render.status !== "ready" || isDownloading}
        />

        <figure
          className="tc-node-mermaid__preview m-0"
          role={render.status === "pending" ? "img" : undefined}
          aria-label={render.status === "pending" ? ariaLabel : undefined}
        >
          {render.status === "pending" && (
            <div className="tc-node-block__skeleton" aria-hidden="true">
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            </div>
          )}
          {render.status === "ready" && (
            <MermaidExpandButton
              ariaLabel={ariaLabel}
              onExpand={() => setFullscreenOpen(true)}
            >
              {renderedSvg}
            </MermaidExpandButton>
          )}
          {render.status === "error" && (
            <div className="tc-node-block__error" role="alert">
              <div className="tc-node-block__error-title">
                Mermaid parse error
              </div>
              <div className="tc-node-block__error-detail">{render.error}</div>
              <ReportIssueAction
                context={createReportIssueContext({
                  title: "Mermaid parse error",
                  message: null,
                  code: null,
                  source: "Artifact editor",
                })}
                presentation="icon"
                className={undefined}
              />
            </div>
          )}
          {render.status === "idle" && rawCode.trim().length === 0 && (
            <div className="tc-node-block__empty">Empty mermaid block</div>
          )}
        </figure>

        <MermaidFullscreenDialog
          open={fullscreenOpen}
          onOpenChange={setFullscreenOpen}
          svg={render.svg}
          code={activeCode}
          title={ariaLabel}
          onCopyCode={handleCopy}
          onDownloadPng={downloadMermaidPng}
          downloadDisabled={render.status !== "ready" || isDownloading}
        />

        {editing && editable ? (
          <div className="tc-node-mermaid__editor">
            <Suspense
              fallback={
                <div className="tc-node-block__skeleton" aria-hidden="true">
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                  />
                </div>
              }
            >
              <MermaidCodeEditor
                value={draft}
                onChange={setDraft}
                onCommit={handleToggleEdit}
                onCancel={handleToggleEdit}
                focusOnMount
                placeholder={EMPTY_PLACEHOLDER}
              />
            </Suspense>
          </div>
        ) : null}
      </BlockErrorBoundary>
    </NodeViewWrapper>
  );
}
