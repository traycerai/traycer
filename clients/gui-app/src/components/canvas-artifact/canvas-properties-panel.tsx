import { useId, useRef, useState, type ReactNode } from "react";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ARTBOARD_STYLE_FIELDS, styleFieldEdit } from "./artboard-style-fields";
import { browserSupportsCss } from "./artboard-css-validation";
import { CanvasCodeTab } from "./canvas-code-tab";
import { CanvasElementMenu } from "./canvas-element-menu";
import { CanvasStyleInput } from "./canvas-style-input";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { useArtboardEdit } from "./use-artboard-edit";

function SelectedElementProperties({
  selection,
  menuContent,
}: {
  readonly selection: CanvasSelection;
  readonly menuContent?: ReactNode;
}) {
  const hiddenId = useId();
  const mutation = useArtboardEdit(selection.artifactId);
  const [message, setMessage] = useState<string | null>(null);
  const styles = new Map(
    selection.element.computedStyles.map(({ property, value }) => [
      property,
      value,
    ]),
  );
  const shownDisplay = useRef(
    styles.get("display") === "none"
      ? "block"
      : (styles.get("display") ?? "block"),
  );
  const editable =
    selection.element.marker !== null || selection.element.tid !== null;
  const disabled = !editable;
  const apply = async (edits: readonly ArtboardEdit[]): Promise<boolean> => {
    setMessage(null);
    try {
      let target = selection;
      for (const edit of edits) {
        const response = await mutation.mutateAsync({
          selection: target,
          edit,
        });
        if (!response.ok) {
          setMessage(response.detail);
          return false;
        }
        if (response.tid !== null)
          target = {
            ...target,
            element: { ...target.element, tid: response.tid },
          };
      }
      return true;
    } catch {
      setMessage("The change could not be saved. Try again.");
      return false;
    }
  };
  const editStyle = (property: string, value: string): Promise<boolean> => {
    const edit = styleFieldEdit(property, value);
    if (edit.kind !== "set-style") return Promise.resolve(false);
    if (edit.value !== null && !browserSupportsCss(property, edit.value)) {
      setMessage(`Invalid value for ${property}.`);
      return Promise.resolve(false);
    }
    return apply([edit]);
  };
  return (
    <section
      aria-label="Element properties"
      aria-busy={mutation.isPending}
      className="grid min-w-0 gap-3 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-ui-sm font-medium">
          {selection.element.tagName}
        </span>
        <CanvasElementMenu
          disabled={disabled || mutation.isPending}
          onEdit={(edit) => {
            void apply([edit]);
          }}
        >
          {menuContent}
        </CanvasElementMenu>
      </div>
      {!editable ? (
        <p className="text-ui-sm text-muted-foreground">
          Ask the agent to change this element.
        </p>
      ) : null}
      <Tabs defaultValue="properties">
        <TabsList>
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        <TabsContent value="properties">
          <div className="grid grid-cols-2 gap-3">
            {ARTBOARD_STYLE_FIELDS.map(({ property, label }) => (
              <CanvasStyleInput
                key={property}
                label={label}
                value={styles.get(property) ?? ""}
                disabled={disabled}
                onCommit={(value) => editStyle(property, value)}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Label htmlFor={hiddenId}>Hide element</Label>
            <Switch
              id={hiddenId}
              checked={styles.get("display") === "none"}
              disabled={disabled || mutation.isPending}
              onCheckedChange={(hidden) => {
                if (hidden)
                  shownDisplay.current = styles.get("display") ?? "block";
                void apply([
                  {
                    kind: "set-style",
                    property: "display",
                    value: hidden ? "none" : shownDisplay.current,
                  },
                ]);
              }}
            />
          </div>
        </TabsContent>
        <TabsContent value="code">
          <CanvasCodeTab
            inlineStyle={selection.element.inlineStyle}
            disabled={disabled}
            pending={mutation.isPending}
            onApply={apply}
            onMessage={setMessage}
          />
        </TabsContent>
      </Tabs>
      {mutation.isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
      {message === null ? null : (
        <p role="status" className="text-ui-sm text-destructive">
          {message}
        </p>
      )}
    </section>
  );
}

export function CanvasPropertiesPanel({
  artifactId,
  menuContent,
}: {
  readonly artifactId: string;
  readonly menuContent?: ReactNode;
}) {
  const selection = useCanvasSelectionStore((state) => state.selection);
  if (selection?.artifactId !== artifactId) return null;
  return (
    <SelectedElementProperties
      key={`${selection.boardPath}:${selection.element.marker ?? selection.element.selector}`}
      selection={selection}
      menuContent={menuContent}
    />
  );
}
