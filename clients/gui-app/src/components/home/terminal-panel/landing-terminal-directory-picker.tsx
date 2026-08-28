import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Folder } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { registerPrimaryFocusEndpoint } from "@/lib/focus/primary-focus-coordinator";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

export interface LandingTerminalDirectoryPickerProps {
  readonly requestKey: number;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly primaryWorkspacePath: string;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onSelect: (workspacePath: string) => void;
  readonly onCancel: () => void;
}

/** Inline chooser for the workspace directory a new landing terminal opens in. */
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
    if (props.isPending) return;
    props.onCancel();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (props.isPending) return;
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
        aria-busy={props.isPending}
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
              disabled={props.isPending}
            >
              <ArrowLeft />
            </InputGroupButton>
          }
        />
        {props.isPending ? (
          <div
            data-testid="landing-terminal-directory-picker-pending"
            role="status"
            className="flex items-center gap-2 px-2 py-1 text-ui-xs text-muted-foreground"
          >
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={undefined}
              variant={undefined}
            />
            Opening terminal…
          </div>
        ) : null}
        <CommandList className="max-h-none min-h-0 flex-1">
          <CommandEmpty>No matching directories.</CommandEmpty>
          <CommandGroup heading="Create terminal in workspace">
            {props.workspacePaths.map((workspacePath) => (
              <CommandItem
                key={workspacePath}
                value={workspacePath}
                onSelect={() => props.onSelect(workspacePath)}
                disabled={props.isPending}
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
                  {/* Same reason as the worktree list: these rows disable
                      themselves while a launch is in flight, and a disabled
                      CommandItem drops pointer events for the whole row. */}
                  <FilePathTooltip content={workspacePath} side="bottom">
                    <StartTruncatedText className="pointer-events-auto block text-ui-xs text-muted-foreground">
                      {workspacePath}
                    </StartTruncatedText>
                  </FilePathTooltip>
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
