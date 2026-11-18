import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  validateArtboardCss,
  browserSupportsCss,
} from "./artboard-css-validation";
import { useCanvasEditDraft } from "./use-canvas-edit-draft";

export function CanvasCodeTab({
  inlineStyle,
  disabled,
  pending,
  onApply,
  onMessage,
}: {
  readonly inlineStyle: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onApply: (edits: readonly ArtboardEdit[]) => Promise<boolean>;
  readonly onMessage: (message: string | null) => void;
}) {
  const draft = useCanvasEditDraft(inlineStyle);
  const text = draft.value;
  const apply = async (): Promise<void> => {
    const parsed = validateArtboardCss(text, browserSupportsCss);
    if (!parsed.ok) {
      onMessage(parsed.detail);
      return;
    }
    onMessage(null);
    const submission = draft.submit(text);
    if (submission === null) return;
    // One attribute-value splice preserves the exact declaration order,
    // including shorthand/longhand precedence, duplicates and comments.
    try {
      const saved = await onApply([
        {
          kind: "set-attribute",
          name: "style",
          value: text.trim() === "" ? null : text,
        },
      ]);
      if (!saved) draft.reject(submission);
    } catch {
      draft.reject(submission);
      onMessage("The change could not be saved. Try again.");
    }
  };
  return (
    <div className="grid gap-3">
      <Textarea
        aria-label="Element styles"
        font="mono"
        size="code"
        rows={10}
        value={text}
        disabled={disabled}
        onChange={(event) => draft.change(event.target.value)}
      />
      <Button
        size="sm"
        disabled={disabled || pending}
        onClick={() => {
          void apply();
        }}
      >
        Apply styles
      </Button>
    </div>
  );
}
