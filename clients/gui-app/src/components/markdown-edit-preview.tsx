import { useMemo, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCodeMirrorTheme } from "@/editor-core/use-code-mirror-theme";
import { TraycerMarkdown } from "@/markdown";

const MARKDOWN_EDITOR_EXTENSIONS = [
  markdown(),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--foreground)",
    },
    ".cm-scroller": {
      height: "100%",
      backgroundColor: "transparent",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--code-font-size, 0.8rem)",
    },
    ".cm-content": {
      minHeight: "100%",
      caretColor: "var(--foreground)",
    },
    ".cm-gutters": {
      backgroundColor: "color-mix(in oklab, var(--foreground) 5%, transparent)",
      border: "none",
      color: "var(--muted-foreground)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklab, var(--accent) 55%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in oklab, var(--primary) 25%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
  }),
];

const MARKDOWN_EDITOR_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  autocompletion: false,
};

type MarkdownEditPreviewView = "edit" | "preview";

export type MarkdownEditPreviewProps = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly placeholder: string | undefined;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly showPreview: boolean;
};

export function MarkdownPreview({ value }: { readonly value: string }) {
  return (
    <TraycerMarkdown
      className="px-3 py-2 text-foreground"
      proseSize="compact"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming={false}
    >
      {value}
    </TraycerMarkdown>
  );
}

export function MarkdownEditPreview({
  value,
  onChange,
  readOnly,
  placeholder,
  ariaLabel,
  testId,
  showPreview,
}: MarkdownEditPreviewProps) {
  const theme = useCodeMirrorTheme();
  const [view, setView] = useState<MarkdownEditPreviewView>("edit");
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

  const editor = (
    <CodeMirror
      value={value}
      onChange={onChange}
      editable={!readOnly}
      readOnly={readOnly}
      height="100%"
      theme={theme}
      placeholder={placeholder}
      basicSetup={MARKDOWN_EDITOR_BASIC_SETUP}
      extensions={extensions}
      data-testid={testId}
      className="h-full"
    />
  );

  if (!showPreview) return editor;

  return (
    <Tabs
      value={view}
      onValueChange={(next) => {
        if (next === "edit" || next === "preview") setView(next);
      }}
      className="h-full min-h-0"
    >
      <TabsList aria-label="Editor view" className="self-end">
        <TabsTrigger value="edit">Edit</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent
        value="edit"
        forceMount
        className="min-h-0 overflow-hidden data-[state=inactive]:hidden"
      >
        {editor}
      </TabsContent>
      <TabsContent
        value="preview"
        className="min-h-0 overflow-auto"
        data-testid={`${testId}-preview`}
      >
        <MarkdownPreview value={value} />
      </TabsContent>
    </Tabs>
  );
}
