import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronsUpDown,
  FolderGit2,
  FolderPlus,
  Globe,
} from "lucide-react";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
// A second local implementation would let the trigger's fallback title and the row title disagree about the
// same path the moment either one is tweaked.
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { cn } from "@/lib/utils";

/** A worktree is a first-class row, not a hidden consequence of which folder happened to be open: two worktrees
 * of one repo have near-identical basenames, so `branch` and the full path are what actually tell them apart. */
export interface McpScopeTarget {
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  /** A linked worktree rather than the repo's primary checkout. */
  readonly isWorktree: boolean;
}

// cmdk filters on `value`, and every other row's value is an absolute path, so these need values that cannot
// collide with a real path.
const GLOBAL_VALUE = "scope:global";
const BROWSE_VALUE = "action:add-workspace";

/** Global never named anything, so "where does this server go?" had no answer on screen. */
export function McpScopePicker(props: {
  /** False when the provider advertises only one scope for `list`. */
  readonly multiScope: boolean;
  readonly effectiveScope: ProviderNativeScope;
  readonly targets: readonly McpScopeTarget[];
  readonly workspaceRoot: string | null;
  readonly loading: boolean;
  /** Null when no host is bound to add folders to. */
  readonly onBrowse: (() => void) | null;
  readonly browsePending: boolean;
  readonly onSelectGlobal: () => void;
  readonly onSelectProject: (path: string) => void;
  /** Defaults to MCP wording so existing call sites stay correct; Plugins and Skills pass their own labels so the
   * control does not pretend to be MCP. */
  readonly locationLabel: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { contentRef, onOpenAutoFocus: coarseOpenAutoFocus } =
    useCoarsePointerOpenAutoFocus();
  const {
    multiScope,
    effectiveScope,
    targets,
    workspaceRoot,
    loading,
    onBrowse,
    browsePending,
    locationLabel,
  } = props;

  const active =
    effectiveScope === "project" && workspaceRoot !== null
      ? (targets.find((t) => t.path === workspaceRoot) ?? null)
      : null;
  const { title: triggerTitle, detail: triggerDetail } = triggerContent({
    effectiveScope,
    active,
    workspaceRoot,
    loading,
  });
  // Global has no path, so its tooltip would just repeat the inline subtitle.
  const triggerTooltip = effectiveScope === "global" ? null : workspaceRoot;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={triggerTooltip}
        side="bottom"
        sideOffset={undefined}
        align="start"
      >
        <PopoverTrigger
          // The destination is in the accessible name, not only the static role.
          aria-label={`${locationLabel}: ${triggerTitle}`}
          className={cn(
            "flex h-7 w-[min(100%,22rem)] min-w-0 items-center gap-2 rounded-sm border border-border bg-background px-2.5 text-left text-ui-sm transition-colors",
            "hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            "dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
          )}
        >
          {effectiveScope === "global" ? (
            <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium text-foreground">
            {triggerTitle}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {triggerDetail}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="start"
        className="w-[min(90vw,26rem)] p-0"
        ref={contentRef}
        onOpenAutoFocus={coarseOpenAutoFocus}
      >
        <Command>
          <CommandInput placeholder="Search workspaces…" />
          <CommandList>
            <CommandEmpty>
              {loading ? "Resolving workspaces…" : "No workspaces found."}
            </CommandEmpty>
            {multiScope ? (
              <CommandGroup heading="Everywhere">
                <CommandItem
                  value={GLOBAL_VALUE}
                  keywords={["global", "everywhere", "all workspaces"]}
                  onSelect={() => {
                    props.onSelectGlobal();
                    setOpen(false);
                  }}
                >
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui-sm">Global</span>
                    <span className="block text-ui-xs text-muted-foreground">
                      Every workspace on this host
                    </span>
                  </span>
                  {effectiveScope === "global" ? <SelectedCheck /> : null}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {targets.length > 0 ? (
              <CommandGroup heading="This host's workspaces">
                {targets.map((target) => (
                  <CommandItem
                    key={target.path}
                    value={target.path}
                    keywords={[
                      target.name,
                      ...(target.branch === null ? [] : [target.branch]),
                    ]}
                    onSelect={() => {
                      props.onSelectProject(target.path);
                      setOpen(false);
                    }}
                  >
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-ui-sm">
                          {target.name}
                        </span>
                        {target.isWorktree ? (
                          <Badge variant="outline" className="shrink-0">
                            worktree
                          </Badge>
                        ) : null}
                        {target.branch === null ? null : (
                          <BranchTag branch={target.branch} />
                        )}
                      </span>
                      <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
                        {target.path}
                      </StartTruncatedText>
                    </span>
                    {effectiveScope === "project" &&
                    workspaceRoot === target.path ? (
                      <SelectedCheck />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <NoWorkspacesNote loading={loading} />
            )}
            {onBrowse === null ? null : (
              <CommandGroup>
                {/* The list is drawn from folders this client has opened, which is legitimately empty on a fresh install or a
                   host whose work all happens elsewhere. */}
                <CommandItem
                  value={BROWSE_VALUE}
                  keywords={["add", "browse", "open", "folder", "workspace"]}
                  disabled={browsePending}
                  onSelect={() => {
                    setOpen(false);
                    onBrowse();
                  }}
                >
                  {browsePending ? (
                    <MutedAgentSpinner />
                  ) : (
                    <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-ui-sm">
                    Add a workspace folder…
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Says why the workspace group is missing instead of silently omitting it. Plain text rather than a
 * `CommandItem` on purpose - it is not selectable, and it only renders when there is nothing to filter anyway. */
function NoWorkspacesNote(props: { readonly loading: boolean }): ReactNode {
  return (
    <p className="px-3 py-2 text-ui-xs text-muted-foreground">
      {props.loading
        ? "Resolving this host's workspaces…"
        : "No workspaces added on this host yet."}
    </p>
  );
}

/** Global is a destination like any other, so it gets a name and a subtitle rather than being the one case that
 * describes nothing. */
function triggerContent(args: {
  readonly effectiveScope: ProviderNativeScope;
  readonly active: McpScopeTarget | null;
  readonly workspaceRoot: string | null;
  readonly loading: boolean;
}): { readonly title: string; readonly detail: string } {
  if (args.effectiveScope === "global") {
    return { title: "Global", detail: "Every workspace on this host" };
  }
  if (args.active !== null) {
    // Branch first: among a repo's worktrees it is the ONLY differing part
    // short of the full path, which the tooltip carries.
    return { title: args.active.name, detail: args.active.branch ?? "" };
  }
  if (args.workspaceRoot !== null) {
    // A stored selection that still validates but whose metadata has not resolved yet: name the path's own
    // basename rather than falling back to a scope word the user never chose.
    return { title: workspaceFolderName(args.workspaceRoot), detail: "" };
  }
  return {
    title: "Choose a workspace",
    detail: args.loading ? "Resolving workspaces…" : "",
  };
}

function SelectedCheck(): ReactNode {
  return <Check className="size-4 shrink-0 text-primary" aria-hidden />;
}

function BranchTag(props: { readonly branch: string }): ReactNode {
  return (
    <span className="truncate text-ui-xs text-muted-foreground">
      {props.branch}
    </span>
  );
}
