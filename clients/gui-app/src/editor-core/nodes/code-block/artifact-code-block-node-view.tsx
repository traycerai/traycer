import { Check, Copy } from "lucide-react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";

export function ArtifactCodeBlockNodeView(props: NodeViewProps): ReactNode {
  const code = props.node.textContent;
  const { copied, copy } = useClipboardCopy({
    resetMs: 2000,
    onSuccess: null,
    onError: null,
  });
  const handleCopy = useCallback(() => copy(code), [copy, code]);
  const preserveEditorSelection = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => event.preventDefault(),
    [],
  );

  return (
    <NodeViewWrapper className="group/artifact-code relative">
      <button
        type="button"
        contentEditable={false}
        onMouseDown={preserveEditorSelection}
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className={cn(
          "absolute top-1.5 right-1.5 z-10 inline-flex size-7 items-center justify-center rounded-md",
          "border border-border bg-popover text-muted-foreground shadow-sm transition-all",
          "opacity-0 group-hover/artifact-code:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
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
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
