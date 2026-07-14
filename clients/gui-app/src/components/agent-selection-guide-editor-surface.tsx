import { useMemo, type ReactNode } from "react";
import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Button } from "@/components/ui/button";
import { useCodeMirrorTheme } from "@/editor-core/use-code-mirror-theme";
import { cn } from "@/lib/utils";

export const AGENT_SELECTION_GUIDE_TITLE = "Agent selection guide";
export const AGENT_SELECTION_GUIDE_DESCRIPTION =
  "Instructions for how Traycer agents choose child-agent harnesses, models, and reasoning effort.";

const MARKDOWN_EDITOR_EXTENSIONS = [
  markdown(),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": {
      height: "100%",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--code-font-size, 0.8rem)",
    },
    ".cm-content": { minHeight: "100%" },
  }),
];

const MARKDOWN_EDITOR_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  autocompletion: false,
};

type AgentSelectionGuideEditorSurfaceProps = {
  readonly titleId: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onBlur: (() => void) | null;
  readonly disabled: boolean;
  readonly placeholder: string | undefined;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly editorClassName: string;
  readonly className: string;
  readonly revertDisabled: boolean;
  readonly onRevert: () => void;
  readonly revertTestId: string | undefined;
  readonly status: ReactNode;
};

export function AgentSelectionGuideEditorSurface({
  titleId,
  value,
  onValueChange,
  onBlur,
  disabled,
  placeholder,
  ariaLabel,
  testId,
  editorClassName,
  className,
  revertDisabled,
  onRevert,
  revertTestId,
  status,
}: AgentSelectionGuideEditorSurfaceProps) {
  const theme = useCodeMirrorTheme();
  const extensions = useMemo(
    () => [
      ...MARKDOWN_EDITOR_EXTENSIONS,
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        role: "textbox",
        spellcheck: "false",
      }),
    ],
    [ariaLabel],
  );

  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex min-h-0 flex-col gap-3", className)}
    >
      <div className="min-w-0">
        <h2 id={titleId} className="text-ui-md font-semibold text-foreground">
          {AGENT_SELECTION_GUIDE_TITLE}
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {AGENT_SELECTION_GUIDE_DESCRIPTION}
        </p>
      </div>

      <div
        data-agent-selection-guide-editor-shell=""
        aria-disabled={disabled}
        className={cn(
          "relative min-h-0 overflow-hidden rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          disabled && "cursor-not-allowed opacity-50",
          editorClassName,
        )}
      >
        <CodeMirror
          value={value}
          onChange={onValueChange}
          onBlur={onBlur ?? undefined}
          editable={!disabled}
          readOnly={disabled}
          height="100%"
          theme={theme}
          placeholder={placeholder}
          basicSetup={MARKDOWN_EDITOR_BASIC_SETUP}
          extensions={extensions}
          data-testid={testId}
          className="h-full"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-[min(100%,18rem)] flex-1 text-ui-xs text-muted-foreground">
          For workspace-specific instructions, add a{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em]">
            .traycer/agent-selection-guide.md
          </code>{" "}
          file in a workspace. It layers on top of these global instructions.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={revertDisabled}
            onClick={onRevert}
            data-testid={revertTestId}
            className="h-7 px-2"
          >
            Revert to default
          </Button>
          {status}
        </div>
      </div>
    </section>
  );
}
