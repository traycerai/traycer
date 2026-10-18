import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";
import type { CanvasSelection } from "./canvas-selection-store";
import { canvasTextEditorStyle } from "./canvas-inline-text-geometry";
import "./canvas-editing.css";

export function CanvasInlineTextField({
  selection,
  value,
  disabled,
  inputRef,
  onChange,
  onKeyDown,
  onBlur,
  children,
}: {
  readonly selection: CanvasSelection;
  readonly value: string;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLTextAreaElement>;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
  readonly children: ReactNode;
}) {
  const geometry = canvasTextEditorStyle(selection);
  return (
    <div
      data-canvas-inline-text-editor=""
      className="absolute z-30 pointer-events-auto"
      style={
        {
          "--text-x": geometry["--text-x"],
          "--text-y": geometry["--text-y"],
          "--text-width": geometry["--text-width"],
          "--text-height": geometry["--text-height"],
          "--text-font": geometry["--text-font"],
          "--text-size": geometry["--text-size"],
          "--text-weight": geometry["--text-weight"],
          "--text-leading": geometry["--text-leading"],
          "--text-align": geometry["--text-align"],
          "--text-color": geometry["--text-color"],
          "--text-background": geometry["--text-background"],
          "--text-padding-top": geometry["--text-padding-top"],
          "--text-padding-right": geometry["--text-padding-right"],
          "--text-padding-bottom": geometry["--text-padding-bottom"],
          "--text-padding-left": geometry["--text-padding-left"],
        } as CSSProperties
      }
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={inputRef}
        aria-label="Edit element text"
        data-canvas-inline-text-input=""
        className="block h-full w-full resize-none outline-2 outline-primary"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {children}
    </div>
  );
}
