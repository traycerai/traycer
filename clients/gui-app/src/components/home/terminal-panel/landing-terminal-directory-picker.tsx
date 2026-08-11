import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Folder } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InputGroupButton } from "@/components/ui/input-group";
import { registerPrimaryFocusEndpoint } from "@/lib/focus/primary-focus-coordinator";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

export interface LandingTerminalDirectoryPickerProps {
  readonly requestKey: number;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly primaryWorkspacePath: string;
  readonly error: string | null;
  readonly onSelect: (workspacePath: string) => void;
  readonly onCancel: () => void;
}

/** Inline empty-terminal state matching the epic canvas pane opener. */
export function LandingTerminalDirectoryPicker(
  props: LandingTerminalDirectoryPickerProps,
): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selection, setSelection] = useState({
    primaryPath: props.primaryWorkspacePath,
    selectedPath: props.primaryWorkspacePath,
  });
  const selectedPath =
    selection.primaryPath === props.primaryWorkspacePath
      ? selection.selectedPath
      : props.primaryWorkspacePath;
  useLayoutEffect(
    () =>
      registerPrimaryFocusEndpoint(
        {
          kind: "landing-terminal-directory",
          requestId: props.requestKey,
        },
        {
          focus: () => inputRef.current?.focus(),
          containsActiveElement: (activeElement) =>
            activeElement === inputRef.current,
          isEligible: () => inputRef.current !== null,
        },
      ),
    [props.requestKey],
  );

  const cancel = (): void => {
    props.onCancel();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  return (
    <div
      data-testid="landing-terminal-directory-picker"
      className="flex h-full min-h-0 w-full flex-col"
    >
      <Command
        value={selectedPath}
        onValueChange={(nextPath) => {
          setSelection({
            primaryPath: props.primaryWorkspacePath,
            selectedPath: nextPath,
          });
        }}
        label="Create terminal in workspace"
        loop
        onKeyDown={handleKeyDown}
        className="h-full min-h-0 rounded-none bg-transparent"
      >
        <CommandInput
          ref={inputRef}
          aria-label="Create terminal in workspace"
          placeholder="Create terminal in workspace"
          leading={
            <InputGroupButton
              size="icon-xs"
              aria-label="Cancel terminal creation"
              onClick={cancel}
            >
              <ArrowLeft />
            </InputGroupButton>
          }
        />
        <CommandList className="max-h-none min-h-0 flex-1">
          <CommandEmpty>No matching directories.</CommandEmpty>
          <CommandGroup heading="Create terminal in workspace">
            {props.workspacePaths.map((workspacePath) => (
              <CommandItem
                key={workspacePath}
                value={workspacePath}
                onSelect={() => props.onSelect(workspacePath)}
                className="items-start py-2"
              >
                <Folder className="mt-0.5 size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">
                      {workspaceFolderName(workspacePath)}
                    </span>
                    {workspacePath === props.primaryWorkspacePath ? (
                      <Badge variant="outline" className="h-4 px-1">
                        Primary
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block truncate text-ui-xs text-muted-foreground">
                    {workspacePath}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
        {props.error === null ? null : (
          <div
            role="status"
            className="border-t border-border/60 px-3 py-2 text-ui-xs text-destructive"
          >
            {props.error}
          </div>
        )}
      </Command>
    </div>
  );
}
