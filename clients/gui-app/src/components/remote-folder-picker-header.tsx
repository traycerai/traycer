import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { modLabel } from "@/lib/keybindings/platform";

export interface RemoteFolderPickerHeaderProps {
  /** Raw absolute path, exactly as browsing and Add will read it. */
  readonly pathValue: string;
  readonly onPathChange: (next: string) => void;
  /** Id of the highlighted row, or undefined when the listing is empty. */
  readonly activeOptionId: string | undefined;
  readonly addDisabled: boolean;
  readonly addLabel: string;
  readonly onAdd: () => void;
  readonly upDisabled: boolean;
  readonly onUp: () => void;
  /**
   * Bump to hand the keyboard back to the path field after an action
   * elsewhere took focus. A token rather than a ref: the element belongs to
   * this component, so nothing outside it needs to hold a handle on the DOM.
   */
  readonly focusPathToken: number;
  /** Focus the path input on mount (fine pointers only - see the dialog). */
  readonly autoFocusPath: boolean;
  readonly onFieldKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The editable path is the stable header and the combobox input. Its final
 * segment filters the current listing; opening a row appends to the same
 * value, so the path never moves behind a secondary affordance.
 */
export function RemoteFolderPickerHeader(
  props: RemoteFolderPickerHeaderProps,
): ReactNode {
  const pathRef = useRef<HTMLInputElement | null>(null);
  const changedByInputRef = useRef(false);
  const { focusPathToken, autoFocusPath, pathValue } = props;
  useEffect(() => {
    // 0 is "never asked"; every later value is one explicit request.
    if (focusPathToken === 0) return;
    pathRef.current?.focus();
  }, [focusPathToken]);
  useEffect(() => {
    if (!autoFocusPath) return;
    pathRef.current?.focus();
  }, [autoFocusPath]);
  useLayoutEffect(() => {
    if (changedByInputRef.current) {
      changedByInputRef.current = false;
      return;
    }
    const input = pathRef.current;
    if (input !== null) input.scrollLeft = input.scrollWidth;
  }, [pathValue]);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Up one folder"
        data-testid="remote-folder-picker-up"
        disabled={props.upDisabled}
        onClick={props.onUp}
      >
        <ArrowLeft aria-hidden className="size-4" />
      </Button>
      <input
        className="min-w-0 flex-1 bg-transparent py-1 font-mono text-ui-sm outline-none placeholder:text-muted-foreground"
        ref={pathRef}
        role="combobox"
        aria-label="Folder path"
        aria-controls="remote-folder-picker-listbox"
        // The listbox popup is always presented while the dialog is open
        // (it may be empty); only the active option comes and goes.
        aria-expanded
        aria-activedescendant={props.activeOptionId}
        data-testid="remote-folder-picker-path"
        value={pathValue}
        placeholder="/path/on/the/host"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => {
          changedByInputRef.current = true;
          props.onPathChange(event.target.value);
        }}
        onKeyDown={props.onFieldKeyDown}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="remote-folder-picker-add"
        disabled={props.addDisabled}
        onClick={props.onAdd}
      >
        {props.addLabel}
        <ShortcutHint>
          <KbdGroup aria-hidden>
            <Kbd>{modLabel()}</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
        </ShortcutHint>
      </Button>
    </div>
  );
}
