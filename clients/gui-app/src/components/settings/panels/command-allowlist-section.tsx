import { useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Folder, Globe, Trash2 } from "lucide-react";
import type {
  CommandAllowRule,
  CommandAllowScope,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { useCommandAllowlist } from "@/hooks/command-allowlist/use-command-allowlist-query";
import { useCommandAllowlistRemove } from "@/hooks/command-allowlist/use-command-allowlist-remove-mutation";
import { useCommandAllowlistClear } from "@/hooks/command-allowlist/use-command-allowlist-clear-mutation";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

// Stable identity for a rule across list/remove (no id field on the wire shape).
function ruleKey(rule: CommandAllowRule): string {
  const scope =
    rule.scope.kind === "global" ? "global" : `workspace:${rule.scope.path}`;
  return `${scope}|${rule.match}|${rule.tokens.join(" ")}`;
}

// Identity for a clear target across the shared clear mutation: `undefined`
// scope is the all-scopes "Clear all", a `scope` is one card's "Clear".
function scopeKey(scope: CommandAllowScope | undefined): string {
  if (scope === undefined) return "all";
  return scope.kind === "global" ? "global" : `workspace:${scope.path}`;
}

// Plain text of what the rule allows, for aria labels.
function ruleDisplay(rule: CommandAllowRule): string {
  return rule.match === "prefix"
    ? `${rule.tokens.join(" ")} *`
    : rule.tokens.join(" ");
}

// Last path segment of a workspace scope, for a readable group heading
// (the full absolute path is shown beneath it).
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

// Split rules into the Global scope and one card per workspace. Bifurcating
// here keeps "applies everywhere" visibly distinct from per-workspace rules,
// and naturally handles many linked workspaces in one session. Workspaces that
// are currently open (linked in the composer / workspace folders) are flagged
// and sorted first, so the rules for the dirs in play surface at the top —
// closed-workspace rules stay listed (and removable) below, never hidden.
function partitionRules(
  rules: readonly CommandAllowRule[],
  openPaths: ReadonlySet<string>,
): {
  readonly global: readonly CommandAllowRule[];
  readonly activeWorkspaces: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    readonly rules: readonly CommandAllowRule[];
  }>;
  readonly otherWorkspaces: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    readonly rules: readonly CommandAllowRule[];
  }>;
} {
  const global = rules.filter((rule) => rule.scope.kind === "global");
  const workspacePaths = [
    ...new Set(
      rules.flatMap((rule) =>
        rule.scope.kind === "workspace" ? [rule.scope.path] : [],
      ),
    ),
  ];

  const workspaces = workspacePaths.map((path) => ({
    path,
    label: folderName(path),
    rules: rules.filter(
      (rule) => rule.scope.kind === "workspace" && rule.scope.path === path,
    ),
  }));

  return {
    global,
    activeWorkspaces: workspaces.filter((ws) => openPaths.has(ws.path)),
    otherWorkspaces: workspaces.filter((ws) => !openPaths.has(ws.path)),
  };
}

/**
 * Per-device command allowlist body: lists the "always allow" rules saved from
 * approval prompts. Rules are split into a Global scope (applies to every
 * workspace this host runs) and one card per workspace, so the global/workspace
 * bifurcation is visible at a glance even with several workspaces open in one
 * session. Lets the user delete one rule or clear all. The enclosing panel owns
 * the title/description; this renders the Clear-all action and the grouped list.
 * Host-scoped via the panel's re-provided host client.
 */
export function CommandAllowlistSection() {
  const query = useCommandAllowlist({ enabled: true, subscribed: true });
  const remove = useCommandAllowlistRemove();
  const clear = useCommandAllowlistClear();
  const rules = query.data?.rules ?? [];
  const busy = remove.isPending || clear.isPending;
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  // The open/linked workspace set (same source the chat composer mentions use),
  // so the panel can surface rules for the dirs currently in play.
  const openFolders = useWorkspaceFoldersStore((state) => state.folders);
  const openPaths = useMemo(() => new Set(openFolders), [openFolders]);
  // One mutation backs both "Clear all" and each scope's "Clear"; key the
  // in-flight target by its scope so only the clicked button spins.
  const clearingScopeKey = clear.isPending
    ? scopeKey(clear.variables.scope)
    : null;

  return (
    <div className="flex flex-col gap-4 p-5">
      {rules.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui-xs text-muted-foreground">
            {rules.length} saved {rules.length === 1 ? "command" : "commands"}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => setConfirmClearAll(true)}
          >
            {clearingScopeKey === "all" ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : (
              <Trash2 className="size-3.5" aria-hidden />
            )}
            Clear all
          </Button>
        </div>
      ) : null}
      <CommandAllowlistBody
        query={query}
        rules={rules}
        openPaths={openPaths}
        onRemove={(rule) => remove.mutate({ rule })}
        removingKey={remove.isPending ? ruleKey(remove.variables.rule) : null}
        onClearScope={(scope, onSuccess) =>
          clear.mutate({ scope }, { onSuccess })
        }
        clearingScopeKey={clearingScopeKey}
        busy={busy}
      />
      <ConfirmDestructiveDialog
        open={confirmClearAll}
        onOpenChange={setConfirmClearAll}
        title="Clear all saved commands?"
        description={`This removes all ${rules.length} always-allowed ${
          rules.length === 1 ? "command" : "commands"
        } across every scope on this host. Each will prompt for approval again.`}
        cascadeSummary={null}
        actionLabel="Clear all"
        isPending={clearingScopeKey === "all"}
        onConfirm={() =>
          clear.mutate(
            { scope: undefined },
            { onSuccess: () => setConfirmClearAll(false) },
          )
        }
      />
    </div>
  );
}

function CommandAllowlistBody(props: {
  readonly query: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "commandAllowlist.list">,
    HostRpcError
  >;
  readonly rules: readonly CommandAllowRule[];
  readonly openPaths: ReadonlySet<string>;
  readonly onRemove: (rule: CommandAllowRule) => void;
  readonly removingKey: string | null;
  readonly onClearScope: (
    scope: CommandAllowScope,
    onSuccess: () => void,
  ) => void;
  readonly clearingScopeKey: string | null;
  readonly busy: boolean;
}) {
  if (props.query.isPending) {
    return (
      <div className="flex items-center gap-2 py-3 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading rules
      </div>
    );
  }
  if (props.query.isError) {
    return (
      <div className="py-3 text-ui-sm text-destructive">
        Couldn't load saved commands. The host may need to be updated.
      </div>
    );
  }
  if (props.rules.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border/60 py-8 text-center">
        <p className="m-0 text-ui-sm font-medium text-foreground">
          No always-allowed commands yet
        </p>
        <p className="m-0 max-w-prose text-ui-xs text-muted-foreground">
          Choosing “Always allow” on an approval prompt saves the command here.
        </p>
      </div>
    );
  }

  const { global, activeWorkspaces, otherWorkspaces } = partitionRules(
    props.rules,
    props.openPaths,
  );
  return (
    <div className="flex flex-col gap-6">
      {global.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Global
            </h3>
          </div>
          <ScopeCard
            icon={
              <Globe className="size-3.5 text-muted-foreground" aria-hidden />
            }
            title="All Workspaces"
            subtitle="Applies to every workspace on this host"
            subtitleMono={false}
            scope={{ kind: "global" }}
            count={global.length}
            rules={global}
            onRemove={props.onRemove}
            removingKey={props.removingKey}
            onClear={props.onClearScope}
            clearing={props.clearingScopeKey === "global"}
            busy={props.busy}
          />
        </div>
      ) : null}
      {activeWorkspaces.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Active Workspaces
            </h3>
            <Badge
              variant="secondary"
              className="px-1.5 py-0 h-4 min-w-4 justify-center text-[10px] bg-muted/80"
            >
              {activeWorkspaces.length}
            </Badge>
          </div>
          <div className="flex flex-col gap-3">
            {activeWorkspaces.map((workspace) => (
              <ScopeCard
                key={workspace.path}
                icon={
                  <Folder
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                }
                title={workspace.label}
                subtitle={workspace.path}
                subtitleMono
                scope={{ kind: "workspace", path: workspace.path }}
                count={workspace.rules.length}
                rules={workspace.rules}
                onRemove={props.onRemove}
                removingKey={props.removingKey}
                onClear={props.onClearScope}
                clearing={
                  props.clearingScopeKey === `workspace:${workspace.path}`
                }
                busy={props.busy}
              />
            ))}
          </div>
        </div>
      ) : null}
      {otherWorkspaces.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Other Workspaces
            </h3>
            <Badge
              variant="secondary"
              className="px-1.5 py-0 h-4 min-w-4 justify-center text-[10px] bg-muted/80"
            >
              {otherWorkspaces.length}
            </Badge>
          </div>
          <div className="flex flex-col gap-3">
            {otherWorkspaces.map((workspace) => (
              <ScopeCard
                key={workspace.path}
                icon={
                  <Folder
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                }
                title={workspace.label}
                subtitle={workspace.path}
                subtitleMono
                scope={{ kind: "workspace", path: workspace.path }}
                count={workspace.rules.length}
                rules={workspace.rules}
                onRemove={props.onRemove}
                removingKey={props.removingKey}
                onClear={props.onClearScope}
                clearing={
                  props.clearingScopeKey === `workspace:${workspace.path}`
                }
                busy={props.busy}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScopeCard(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly subtitleMono: boolean;
  readonly scope: CommandAllowScope;
  readonly count: number;
  readonly rules: readonly CommandAllowRule[];
  readonly onRemove: (rule: CommandAllowRule) => void;
  readonly removingKey: string | null;
  readonly onClear: (scope: CommandAllowScope, onSuccess: () => void) => void;
  readonly clearing: boolean;
  readonly busy: boolean;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div className="group/card flex flex-col overflow-hidden rounded-md border border-border/50 bg-card shadow-sm">
      <div className="flex min-w-0 items-center gap-3 border-b border-border/40 bg-muted/20 px-3 py-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/50 border border-border/50">
          {props.icon}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ui-sm text-foreground/90">
              {props.title}
            </span>
            <Badge
              variant="secondary"
              className="px-1.5 py-0 h-4 leading-none text-[10px] min-w-4 justify-center bg-muted border-border/50 text-muted-foreground"
            >
              {props.count}
            </Badge>
          </div>
          <span
            className={
              props.subtitleMono
                ? "truncate font-mono text-[11px] text-muted-foreground/80 mt-0.5"
                : "truncate text-[11px] text-muted-foreground/80 mt-0.5"
            }
          >
            {props.subtitle}
          </span>
        </div>
        <TooltipWrapper
          label={`Clear ${props.title}`}
          side="left"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Clear all commands in ${props.title}`}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100 hover:text-destructive focus-visible:opacity-100"
            disabled={props.busy}
            onClick={() => setConfirmClear(true)}
          >
            {props.clearing ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : (
              <Trash2 className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipWrapper>
      </div>
      <ConfirmDestructiveDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Clear ${props.title}?`}
        description={`This removes all ${props.count} always-allowed ${
          props.count === 1 ? "command" : "commands"
        } in ${props.title}. Each will prompt for approval again.`}
        cascadeSummary={null}
        actionLabel="Clear"
        isPending={props.clearing}
        onConfirm={() =>
          props.onClear(props.scope, () => setConfirmClear(false))
        }
      />
      <ul className="m-0 flex list-none flex-col divide-y divide-border/30 bg-muted/5 p-0">
        {props.rules.map((rule) => (
          <RuleRow
            key={ruleKey(rule)}
            rule={rule}
            onRemove={props.onRemove}
            removing={props.removingKey === ruleKey(rule)}
            busy={props.busy}
          />
        ))}
      </ul>
    </div>
  );
}

function RuleRow(props: {
  readonly rule: CommandAllowRule;
  readonly onRemove: (rule: CommandAllowRule) => void;
  readonly removing: boolean;
  readonly busy: boolean;
}) {
  return (
    <li className="group flex items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-muted/30">
      <code className="min-w-0 truncate rounded-md bg-muted/40 border border-border/40 px-2 py-1 font-mono text-code-sm text-foreground/80 shadow-sm">
        {props.rule.tokens.join(" ")}
        {props.rule.match === "prefix" ? (
          <span className="text-primary font-bold"> *</span>
        ) : null}
      </code>
      <TooltipWrapper
        label="Remove"
        side="left"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${ruleDisplay(props.rule)}`}
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
          disabled={props.busy}
          onClick={() => props.onRemove(props.rule)}
        >
          {props.removing ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <Trash2 className="size-3.5" aria-hidden />
          )}
        </Button>
      </TooltipWrapper>
    </li>
  );
}
