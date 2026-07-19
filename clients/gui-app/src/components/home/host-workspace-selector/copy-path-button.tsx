import { Check, Copy } from "lucide-react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";

/**
 * Copies the path a chat/terminal actually runs from (the adopted worktree
 * path, or the folder itself for local). Shared by the click-open folder rows
 * (`FolderRow`) and the workspace hover preview (`WorkspaceFolderHoverList`).
 *
 * Icon-only control: it carries a >=3:1 default-state cue (WCAG 2.2 non-text
 * contrast) via `text-muted-foreground` with no opacity attenuation, not just
 * on hover/focus.
 */
export function CopyPathButton(props: {
  readonly path: string;
  readonly testId: string;
}) {
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  return (
    <button
      type="button"
      aria-label="Copy folder path"
      title="Copy path"
      data-testid={props.testId}
      onClick={(event) => {
        event.stopPropagation();
        copy(props.path);
      }}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
