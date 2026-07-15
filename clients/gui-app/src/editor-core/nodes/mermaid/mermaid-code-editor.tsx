import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
  EditorView,
  keymap,
} from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { useCodeMirrorTheme } from "@/editor-core/use-code-mirror-theme";
import { mermaidStreamLanguage } from "./mermaid-simple-mode";

export interface MermaidCodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  /**
   * When `true`, the editor grabs focus on mount. We do this imperatively
   * via a `ref` + `requestAnimationFrame` rather than CodeMirror's
   * `autoFocus` prop so we don't trip the `jsx-a11y/no-autofocus` rule -
   * the effect still runs on mount, but the intent is deliberate (the
   * user opened the edit panel themselves).
   */
  readonly focusOnMount: boolean;
  readonly placeholder: string;
}

/**
 * CodeMirror-backed editor for the Mermaid source. Kept deliberately small -
 * no gutter, no line numbers, no folding. The focus here is a keymap that
 * mirrors the reference Traycer views behaviour:
 *
 *   - `Mod-Enter` commits and closes the panel.
 *   - `Escape`    closes without requiring an additional save step (the
 *                 live `onChange` has already pushed the latest text).
 *   - `Tab`       inserts two spaces; indent is significant in a few
 *                 mermaid dialects (`classDiagram` body, `subgraph`).
 *   - `Mod-z` / `Mod-Shift-z` fall through to CodeMirror's local history,
 *                 which is correct: the enclosing Yjs undo manager owns
 *                 the artifact's history, but while the panel is open the
 *                 user wants source-level undo, not a full code-block
 *                 revert.
 *
 * The parent owns the `value`; we forward every change via `onChange` so
 * the Tiptap node attr stays authoritative.
 */
export function MermaidCodeEditor(props: MermaidCodeEditorProps) {
  const { value, onChange, onCommit, onCancel, focusOnMount, placeholder } =
    props;

  const ref = useRef<ReactCodeMirrorRef>(null);
  const latestValueRef = useRef(value);
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const cmTheme = useCodeMirrorTheme();

  // Imperative focus on mount. Tied to a `ref` - the CodeMirror view is
  // attached in the first render pass but `.view` is only populated after
  // the mount commit, so we jump to the next frame.
  useEffect(() => {
    if (!focusOnMount) return;
    const raf = window.requestAnimationFrame(() => {
      ref.current?.view?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [focusOnMount]);

  const updateCode = useCallback(
    (next: string) => {
      onChange(next);
    },
    [onChange],
  );

  // Precedence-high keymap so our bindings win over CodeMirror defaults.
  const extensions = useMemo(
    () => [
      mermaidStreamLanguage,
      EditorView.lineWrapping,
      Prec.high(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              onCommit();
              return true;
            },
          },
          {
            key: "Escape",
            preventDefault: true,
            run: () => {
              onCancel();
              return true;
            },
          },
          {
            key: "Tab",
            preventDefault: true,
            run: (view) => {
              view.dispatch(view.state.replaceSelection("  "));
              return true;
            },
          },
        ]),
      ),
    ],
    [onCancel, onCommit],
  );

  return (
    <div className="tc-node-mermaid__codemirror">
      <CodeMirror
        ref={ref}
        value={value}
        height="100%"
        theme={cmTheme}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          indentOnInput: false,
        }}
        extensions={extensions}
        onChange={updateCode}
      />
    </div>
  );
}
