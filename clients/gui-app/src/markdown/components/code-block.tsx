import { Check, Copy } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import { useShikiHighlighter } from "../shiki-highlighter";
import { useIsMarkdownStreaming } from "../shiki-streaming-context";
import { useThrottledCodeHighlight } from "../use-throttled-code-highlight";
import { extractText } from "./extract-react-node-text";

interface CodeBlockProps {
  children?: ReactNode;
  className?: string;
  containerClassName?: string;
  node?: unknown;
  [key: string]: unknown;
}

export function CodeBlock({
  children,
  className,
  containerClassName,
}: CodeBlockProps) {
  const langMatch = className?.match(/language-(\S+)/);
  const language = langMatch?.[1] ?? "";

  const codeStr = extractText(children);
  const isInline = !className && !codeStr.includes("\n");

  if (isInline) {
    return <InlineCode>{children}</InlineCode>;
  }

  return (
    <FencedCodeBlock
      language={language}
      code={codeStr}
      containerClassName={containerClassName}
    />
  );
}

function InlineCode({ children }: { children?: ReactNode }) {
  return <code>{children}</code>;
}

function FencedCodeBlock({
  language,
  code,
  containerClassName,
}: {
  language: string;
  code: string;
  containerClassName: string | undefined;
}) {
  const { highlighter, theme, themesVersion } = useShikiHighlighter();
  const isStreaming = useIsMarkdownStreaming();
  const { copied, copy } = useClipboardCopy({
    resetMs: 2000,
    onSuccess: null,
    onError: null,
  });

  const highlightedNodes = useThrottledCodeHighlight({
    highlighter,
    theme,
    themesVersion,
    code,
    language,
    isStreaming,
  });

  const handleCopy = useCallback(() => copy(code), [copy, code]);

  const displayLang = language || "text";

  return (
    <div
      data-quote-code-block=""
      data-language={language}
      className={cn(
        "group/code relative my-3 overflow-hidden rounded-lg border border-border/60",
        "bg-[color-mix(in_oklch,var(--color-muted)_55%,transparent)]",
        "shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-foreground)_3%,transparent)]",
        containerClassName,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 px-3 py-1.5",
          "border-b border-border/40",
          "bg-[color-mix(in_oklch,var(--color-foreground)_3%,transparent)]",
        )}
      >
        <span className="select-none font-mono text-code-xs font-medium text-muted-foreground/85">
          {displayLang}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
            "text-muted-foreground/70 transition-all",
            "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>

      <div className="overflow-x-auto px-3.5 py-3 font-mono text-code">
        {highlightedNodes !== null ? (
          <div className="traycer-md-shiki">{highlightedNodes}</div>
        ) : (
          <pre className="m-0 bg-transparent p-0">
            <code className="font-mono text-code text-foreground">{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function PreBlock({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
