import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { MermaidBlockToolbar } from "@/editor-core/nodes/mermaid/mermaid-block-toolbar";
import { MermaidFullscreenDialog } from "@/editor-core/nodes/mermaid/mermaid-fullscreen-dialog";
import {
  deriveMermaidAriaLabel,
  deriveMermaidErrorMessage,
  ensureMermaidReady,
  parseMermaid,
  renderMermaidSvg,
} from "@/editor-core/nodes/mermaid/mermaid-service";
import { useMermaidPngDownload } from "@/editor-core/nodes/mermaid/use-mermaid-png-download";
import { useMermaidThemeKey } from "@/editor-core/nodes/mermaid/use-mermaid-theme-key";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const RENDER_DEBOUNCE_MS = 500;

interface MermaidBlockProps {
  "data-code"?: string;
  [key: string]: unknown;
}

interface RenderState {
  status: "pending" | "ready" | "error";
  svg: string;
  error: string;
}

const INITIAL_RENDER: RenderState = {
  status: "pending",
  svg: "",
  error: "",
};

function decodeMermaidCode(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

export function MermaidBlock(props: MermaidBlockProps) {
  const code = decodeMermaidCode(props["data-code"] ?? "");
  if (code.length === 0) {
    return (
      <div className="tc-node-mermaid">
        <div className="tc-node-block__empty">Empty mermaid block</div>
      </div>
    );
  }
  return <MermaidRenderer code={code} />;
}

function MermaidRenderer({ code }: { code: string }) {
  const debouncedCode = useDebouncedValue(code, RENDER_DEBOUNCE_MS);
  const themeKey = useMermaidThemeKey();
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  return (
    <MermaidRenderSession
      key={debouncedCode}
      renderCode={debouncedCode}
      sourceCode={code}
      themeKey={themeKey}
      fullscreenOpen={fullscreenOpen}
      onFullscreenOpenChange={setFullscreenOpen}
    />
  );
}

function MermaidRenderSession(props: {
  readonly renderCode: string;
  readonly sourceCode: string;
  readonly themeKey: number;
  readonly fullscreenOpen: boolean;
  readonly onFullscreenOpenChange: (open: boolean) => void;
}) {
  const {
    renderCode,
    sourceCode,
    themeKey,
    fullscreenOpen,
    onFullscreenOpenChange,
  } = props;
  const [render, setRender] = useState<RenderState>(INITIAL_RENDER);

  // Prime the mermaid bundle on mount; idempotent across instances.
  useEffect(() => {
    void ensureMermaidReady();
  }, []);

  /*
   * Async parse + render. `AbortController` invalidates in-flight work on
   * dependency change or unmount so a stale resolve can't race past a
   * newer one and overwrite state. Standard async-effect cancellation
   * idiom; integrates with `fetch` and `addEventListener` if those land
   * here later.
   */
  useEffect(() => {
    const ctrl = new AbortController();
    const isAborted = (): boolean => ctrl.signal.aborted;
    void (async (): Promise<void> => {
      try {
        await parseMermaid(renderCode);
        if (isAborted()) return;
        const { svg } = await renderMermaidSvg(renderCode);
        if (isAborted()) return;
        setRender({ status: "ready", svg, error: "" });
      } catch (err: unknown) {
        if (isAborted()) return;
        setRender({
          status: "error",
          svg: "",
          error: deriveMermaidErrorMessage(err),
        });
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [renderCode, themeKey]);

  const ariaLabel = useMemo(
    () => deriveMermaidAriaLabel(sourceCode),
    [sourceCode],
  );

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(sourceCode).then(() => {
      toast.success("Mermaid source copied");
    });
  }, [sourceCode]);

  const { downloadMermaidPng, isDownloading } = useMermaidPngDownload({
    svg: render.svg,
    enabled: render.status === "ready",
  });

  const downloadDisabled = render.status !== "ready" || isDownloading;
  const fullscreenDisabled = render.status !== "ready";
  const renderedSvg = useMemo(
    () =>
      render.status === "ready"
        ? trustedMarkupToReactNodes(render.svg, "svg")
        : null,
    [render.status, render.svg],
  );

  return (
    <div className="tc-node-mermaid">
      <MermaidBlockToolbar
        editing={false}
        editable={false}
        onToggleEdit={noop}
        onCopyCode={handleCopy}
        onDownloadPng={downloadMermaidPng}
        onOpenFullscreen={() => onFullscreenOpenChange(true)}
        downloadDisabled={downloadDisabled}
        fullscreenDisabled={fullscreenDisabled}
      />

      <figure
        className="tc-node-mermaid__preview m-0"
        role="img"
        aria-label={ariaLabel}
      >
        {render.status === "pending" ? (
          <div className="tc-node-block__skeleton" aria-hidden="true">
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          </div>
        ) : null}
        {render.status === "ready" ? (
          <div className="tc-node-mermaid__svg">{renderedSvg}</div>
        ) : null}
        {render.status === "error" ? (
          <div className="tc-node-block__error" role="alert">
            <div className="tc-node-block__error-title">
              Mermaid parse error
            </div>
            <div className="tc-node-block__error-detail">{render.error}</div>
          </div>
        ) : null}
      </figure>

      <MermaidFullscreenDialog
        open={fullscreenOpen}
        onOpenChange={onFullscreenOpenChange}
        svg={render.svg}
        code={sourceCode}
        title={ariaLabel}
        onCopyCode={handleCopy}
        onDownloadPng={downloadMermaidPng}
        downloadDisabled={downloadDisabled}
      />
    </div>
  );
}

function noop(): void {}
