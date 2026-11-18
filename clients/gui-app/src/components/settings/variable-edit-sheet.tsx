import { useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";

export function VariablePhoneRow(props: {
  readonly name: string;
  readonly value: ReactNode;
  readonly badge: ReactNode;
  readonly disabled: boolean;
  readonly onEdit: (() => void) | null;
}): ReactNode {
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-ui-xs font-semibold">
            {props.name}
          </span>
          {props.badge}
        </span>
        <span className="truncate font-mono text-ui-xs text-muted-foreground">
          {props.value}
        </span>
      </span>
      {props.onEdit === null ? null : (
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
    </>
  );
  if (props.onEdit === null)
    return (
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">{content}</div>
    );
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onEdit}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-foreground/8 disabled:opacity-50"
    >
      {content}
    </button>
  );
}

export function VariableEditSheet(props: {
  readonly open: boolean;
  readonly title: string;
  readonly busy: boolean;
  readonly saveDisabled: boolean;
  readonly removeLabel: string;
  readonly onSave: (() => void) | null;
  readonly onRemove: (() => void) | null;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const fields = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const { resolvedTheme, themePreset } = useResolvedTheme();
  return (
    <Drawer
      direction="bottom"
      open={props.open}
      dismissible={!props.busy}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onDismiss();
      }}
    >
      <DrawerContent
        aria-describedby={undefined}
        data-theme={themePreset}
        className={cn("max-h-[85dvh]", resolvedTheme === "dark" && "dark")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          fields.current
            ?.querySelector<HTMLElement>("input, textarea, button")
            ?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <DrawerHeader>
          <DrawerTitle>{props.title}</DrawerTitle>
        </DrawerHeader>
        <div
          ref={fields}
          className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4"
        >
          {props.children}
        </div>
        <div className="flex items-center gap-2 p-4 pb-safe-bottom-gutter">
          {props.onRemove === null ? null : (
            <Button
              type="button"
              variant="destructive-ghost"
              disabled={props.busy}
              aria-label={props.removeLabel}
              onClick={props.onRemove}
            >
              Remove
            </Button>
          )}
          <div className="flex-1" />
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={props.onDismiss}
          >
            Cancel
          </Button>
          {props.onSave === null ? null : (
            <Button
              type="button"
              disabled={props.busy || props.saveDisabled}
              onClick={props.onSave}
            >
              Save
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
