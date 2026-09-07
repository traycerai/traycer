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
   * Focus on mount via rAF, not CodeMirror autoFocus (jsx-a11y/no-autofocus).
   */
  readonly focusOnMount: boolean;
  readonly placeholder: string;
}

/**
 * Small Mermaid source editor. `Mod-Enter` commits; `Escape` closes (live `onChange` already pushed). Undo is CodeMirror-local while the panel is open.
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
