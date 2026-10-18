import { useId, useMemo, useEffect, useRef } from "react";
import {
  readRootCustomProperties,
  type RootCustomProperty,
} from "@traycer/html-source";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { describeCanvasLayer } from "./canvas-layer-model";
import { useCanvasEditAction } from "./use-canvas-edit-action";
import { canvasKnobValue } from "./canvas-tweak-value";
import { useCanvasEditDraft } from "./use-canvas-edit-draft";

export function CanvasTweakKnob(props: {
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => Promise<boolean>;
}) {
  const draft = useCanvasEditDraft(props.value);
  const id = useId();
  const shape = canvasKnobValue(props.value);
  const timer = useRef<number | null>(null);
  const commitRef = useRef<(value: string) => void>(() => undefined);
  const cancel = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const commit = async (value: string): Promise<void> => {
    cancel();
    const submission = draft.submit(value);
    if (submission === null) return;
    try {
      if (!(await props.onCommit(value))) draft.reject(submission);
    } catch {
      draft.reject(submission);
    }
  };
  useEffect(() => {
    commitRef.current = (value) => {
      if (draft.value === value) void commit(value);
    };
  });
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  let inputValue = draft.value;
  if (shape.kind === "number" && shape.unit && draft.value.endsWith(shape.unit))
    inputValue = draft.value.slice(0, -shape.unit.length);
  if (shape.kind === "color") inputValue = canvasKnobValue(draft.value).input;
  const inputType = shape.kind === "text" ? "text" : shape.kind;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{props.name}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          size="sm"
          type={inputType}
          step="any"
          value={inputValue}
          disabled={props.disabled}
          onChange={(event) => {
            const value =
              event.target.value +
              (event.target.value && shape.kind === "number" ? shape.unit : "");
            draft.change(value);
            cancel();
            timer.current = window.setTimeout(
              () => commitRef.current(value),
              450,
            );
          }}
          onBlur={() => {
            void commit(draft.value);
          }}
          onKeyDown={(event) => {
            if (event.code === "Enter") {
              event.preventDefault();
              void commit(draft.value);
            }
            if (event.code === "Escape") {
              cancel();
              draft.reset();
            }
          }}
        />
        {shape.unit ? (
          <span className="text-ui-xs text-muted-foreground">{shape.unit}</span>
        ) : null}
      </div>
    </div>
  );
}
export function CanvasTweaksPanel(props: {
  readonly artifactId: string;
  readonly boardPath: string;
  readonly document: CanvasBoardDocument;
  readonly registry: CanvasFrameRegistry;
}) {
  const action = useCanvasEditAction(props.artifactId);
  const result = useMemo(
    () => readRootCustomProperties(props.document.text),
    [props.document],
  );
  if (!result.ok || result.properties.length === 0) return null;
  const commit = async (name: string, value: string): Promise<boolean> => {
    const root = props.document.parsed.elements.find(
      (element) => element.isUniqueSource && element.startTag !== null,
    );
    if (root === undefined || root.startTag === null) return false;
    try {
      const target = await describeCanvasLayer(props, root.startTag.start);
      if (target === null) {
        action.setMessage("Wait for the artboard to finish loading.");
        return false;
      }
      return await action.apply(target, {
        kind: "set-css-variable",
        name,
        value: value === "" ? null : value,
      });
    } catch {
      action.setMessage("The change could not be saved. Try again.");
      return false;
    }
  };
  return (
    <CanvasTweaksSection
      properties={result.properties}
      pending={action.pending}
      message={action.message}
      onCommit={commit}
    />
  );
}

/** The same focus-preserving fields are used while the host serialises saves. */
export function CanvasTweaksSection(props: {
  readonly properties: readonly RootCustomProperty[];
  readonly pending: boolean;
  readonly message: string | null;
  readonly onCommit: (name: string, value: string) => Promise<boolean>;
}) {
  return (
    <section
      aria-label="Tweaks"
      aria-busy={props.pending}
      className="grid gap-3 border-t p-3"
    >
      <h3 className="text-ui-sm font-medium">Tweaks</h3>
      {props.properties.map((property) => (
        <CanvasTweakKnob
          key={property.name}
          name={property.name}
          value={property.value}
          disabled={false}
          onCommit={(value) => props.onCommit(property.name, value)}
        />
      ))}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
      {props.message === null ? null : (
        <p role="status" className="text-ui-xs text-destructive">
          {props.message}
        </p>
      )}
    </section>
  );
}
