import { useState, type ReactNode } from "react";
import type { NotificationHookConfig } from "@traycer/protocol/host/notifications/host-notifications";
import { AlertCircle, CheckCircle2, Copy, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  draftFromHook,
  emptyDraft,
  HOOK_SEVERITIES,
} from "@/components/settings/panels/notification-hook-draft";
import { NotificationHookEditorDialog } from "@/components/settings/panels/notification-hook-editor-dialog";
import { SettingsGroup } from "@/components/settings/settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import type {
  NotificationHooksSaveMutation,
  NotificationHooksStatusQuery,
  NotificationHooksTestMutation,
} from "@/hooks/host/use-notification-hooks-query";
import { cn } from "@/lib/utils";

type HookEntry = NonNullable<
  NotificationHooksStatusQuery["data"]
>["hooks"][number];

/**
 * Settings surface for the host's notification hooks. The JSON file on the
 * host stays the source of truth and remains hand-editable; this form is a
 * second editor over it. Each save rewrites the whole file from the hooks the
 * form last read, so a save built on a stale read wins over an outside edit
 * (last write wins - deliberate, see the hooks file docs).
 */
export function NotificationHooksSection(props: {
  readonly statusQuery: NotificationHooksStatusQuery;
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}) {
  const { data, error, isLoading, refetch } = props.statusQuery;
  return (
    <SettingsGroup
      title="Notification hooks"
      tone="default"
      dataTestId="notification-hooks-manager"
      fill
    >
      {renderManager({
        data,
        errorMessage: error?.message ?? null,
        isLoading,
        onRefresh: () => {
          void refetch();
        },
        testHook: props.testHook,
        saveHooks: props.saveHooks,
      })}
    </SettingsGroup>
  );
}

function renderManager(args: {
  readonly data: NotificationHooksStatusQuery["data"];
  readonly errorMessage: string | null;
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}): ReactNode {
  const { data, errorMessage, isLoading, onRefresh, testHook, saveHooks } =
    args;
  if (isLoading) {
    return (
      <ManagerShell
        count={null}
        configPath={null}
        addDisabled
        onAdd={() => undefined}
        onRefresh={onRefresh}
      >
        <div className="flex min-h-0 flex-1 items-center gap-2 px-4 py-3 text-ui-sm text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
          Loading hook status
        </div>
      </ManagerShell>
    );
  }
  if (errorMessage !== null || data === undefined) {
    return (
      <ManagerShell
        count={null}
        configPath={null}
        addDisabled
        onAdd={() => undefined}
        onRefresh={onRefresh}
      >
        <InlineManagerState
          tone={errorMessage === null ? "neutral" : "error"}
          title={
            errorMessage === null
              ? "Notification hooks unavailable"
              : "Couldn't load notification hooks"
          }
          detail={
            errorMessage ??
            "Reconnect to the current host to view and manage hooks."
          }
        />
      </ManagerShell>
    );
  }
  if (data.configError !== null) {
    return (
      <ManagerShell
        count={data.hooks.length}
        configPath={data.configPath}
        addDisabled
        onAdd={() => undefined}
        onRefresh={onRefresh}
      >
        {/* The file is unparseable: there is no valid state to edit from, and
            saving would replace whatever the author is mid-way through typing. */}
        <div className="flex min-h-0 flex-1 items-start gap-2 overflow-auto px-4 py-3 text-ui-sm text-destructive">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Hooks are disabled and editing is unavailable until the file parses:{" "}
            {data.configError}.
          </span>
        </div>
      </ManagerShell>
    );
  }
  return (
    <HooksEditor
      hooks={data.hooks}
      configPath={data.configPath}
      onRefresh={onRefresh}
      testHook={testHook}
      saveHooks={saveHooks}
    />
  );
}

function ManagerShell(props: {
  readonly count: number | null;
  readonly configPath: string | null;
  readonly addDisabled: boolean;
  readonly onAdd: () => void;
  readonly onRefresh: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HooksToolbar
        count={props.count}
        configPath={props.configPath}
        addDisabled={props.addDisabled}
        onAdd={props.onAdd}
        onRefresh={props.onRefresh}
      />
      {props.children}
    </div>
  );
}

function HooksToolbar(props: {
  readonly count: number | null;
  readonly configPath: string | null;
  readonly addDisabled: boolean;
  readonly onAdd: () => void;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {props.count === null
          ? "Current host"
          : `${props.count} ${props.count === 1 ? "hook" : "hooks"}`}
      </span>
      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {props.configPath === null ? null : (
          <ConfigPathAccess configPath={props.configPath} />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRefresh}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          Refresh
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.addDisabled}
          onClick={props.onAdd}
        >
          <Plus aria-hidden className="size-3.5" />
          Add hook
        </Button>
      </div>
    </div>
  );
}

function ConfigPathAccess(props: { readonly configPath: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
      <code className="min-w-0 flex-1 truncate rounded bg-foreground/8 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
        {props.configPath}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Copy config file path"
        onClick={() => {
          void navigator.clipboard.writeText(props.configPath).then(
            () => toast.success("Path copied to clipboard"),
            () => toast.error("Couldn't copy the path"),
          );
        }}
      >
        <Copy aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

function InlineManagerState(props: {
  readonly tone: "neutral" | "error";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-auto px-4 py-3">
      <div
        className={cn(
          "text-ui-sm font-medium",
          props.tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {props.title}
      </div>
      <p className="text-ui-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

type EditorState =
  | { readonly kind: "closed" }
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly hook: HookEntry };

function HooksEditor(props: {
  readonly hooks: readonly HookEntry[];
  readonly configPath: string;
  readonly onRefresh: () => void;
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}) {
  // Plain local state is enough here: `HostScopeGate` holds this section in a
  // hidden `<Activity>` through transient same-host disconnects, so an open
  // editor and its typed draft survive without being parked anywhere. A real
  // host switch remounts through the gate's key and correctly starts closed.
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [pendingDelete, setPendingDelete] = useState<HookEntry | null>(null);

  // Every write rebuilds the whole file from the hooks this render read, so
  // there is no long-lived draft of the entire file to drift out of date.
  const configs = props.hooks.map(toConfig);
  const saveAll = (hooks: readonly NotificationHookConfig[], done: string) => {
    props.saveHooks.mutate(
      { hooks: [...hooks] },
      {
        onSuccess: () => {
          setEditor({ kind: "closed" });
          setPendingDelete(null);
          toast.success(done);
        },
      },
    );
  };

  return (
    <ManagerShell
      count={props.hooks.length}
      configPath={props.configPath}
      addDisabled={props.saveHooks.isPending}
      onRefresh={props.onRefresh}
      onAdd={() => {
        setEditor({ kind: "add" });
      }}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {props.hooks.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 px-4 py-6 text-center"
            data-testid="notification-hooks-empty-state"
          >
            <div className="space-y-1">
              <div className="text-ui-sm font-medium text-foreground">
                No notification hooks
              </div>
              <p className="max-w-md text-ui-sm text-muted-foreground">
                Hooks run a script or send an HTTP request for enabled
                notification severities.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditor({ kind: "add" });
              }}
            >
              <Plus aria-hidden className="size-3.5" />
              Add hook
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {props.hooks.map((hook) => (
              <HookRow
                key={hook.id}
                hook={hook}
                testHook={props.testHook}
                saving={props.saveHooks.isPending}
                onEdit={() => {
                  setEditor({ kind: "edit", hook });
                }}
                onToggleEnabled={(enabled) => {
                  saveAll(
                    configs.map((entry) =>
                      entry.id === hook.id ? { ...entry, enabled } : entry,
                    ),
                    enabled ? "Hook enabled" : "Hook disabled",
                  );
                }}
                onDelete={() => {
                  setPendingDelete(hook);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {editor.kind === "closed" ? null : (
        <NotificationHookEditorDialog
          initialDraft={
            editor.kind === "add"
              ? emptyDraft()
              : draftFromHook(toConfig(editor.hook))
          }
          title={editor.kind === "add" ? "Add hook" : "Edit hook"}
          saving={props.saveHooks.isPending}
          onCancel={() => {
            setEditor({ kind: "closed" });
          }}
          onSave={(hook) => {
            const next =
              editor.kind === "add"
                ? [...configs, hook]
                : configs.map((entry) => (entry.id === hook.id ? hook : entry));
            saveAll(next, editor.kind === "add" ? "Hook added" : "Hook saved");
          }}
        />
      )}

      {pendingDelete === null ? null : (
        <ConfirmDestructiveDialog
          open
          title="Delete hook?"
          description={`"${pendingDelete.name ?? pendingDelete.id}" will be removed from the hooks file on the host.`}
          cascadeSummary={null}
          actionLabel="Delete"
          isPending={props.saveHooks.isPending}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          onConfirm={() => {
            saveAll(
              configs.filter((entry) => entry.id !== pendingDelete.id),
              "Hook deleted",
            );
          }}
        />
      )}
    </ManagerShell>
  );
}

function toConfig(hook: HookEntry): NotificationHookConfig {
  return {
    id: hook.id,
    name: hook.name,
    enabled: hook.enabled,
    severities: hook.severities,
    action: hook.action,
  };
}

function HookRow(props: {
  readonly hook: HookEntry;
  readonly testHook: NotificationHooksTestMutation;
  readonly saving: boolean;
  readonly onEdit: () => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onDelete: () => void;
}) {
  const { hook, testHook } = props;
  const testingThisHook =
    testHook.isPending && testHook.variables.hookId === hook.id;
  return (
    <div
      className="flex flex-wrap items-center gap-3 px-3 py-3"
      data-testid={`notification-hook-row-${hook.id}`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {hook.name ?? hook.id}
          </span>
          <Badge variant="outline">
            {hook.action.type === "http" ? "HTTP" : "Script"}
          </Badge>
          {hook.enabled ? null : <Badge variant="secondary">disabled</Badge>}
        </div>
        <p className="truncate font-mono text-ui-xs text-muted-foreground">
          {hook.action.type === "http"
            ? hook.action.url
            : [hook.action.command, ...hook.action.args].join(" ")}
        </p>
        <p className="truncate text-ui-xs text-muted-foreground">
          {severitySummary(hook.severities)}
        </p>
        {hook.lastResult === null ? (
          <p className="text-ui-xs text-muted-foreground">No test yet</p>
        ) : (
          <p
            className={cn(
              "flex items-center gap-1 text-ui-xs",
              hook.lastResult.ok ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {hook.lastResult.ok ? (
              <CheckCircle2 aria-hidden className="size-3" />
            ) : (
              <AlertCircle aria-hidden className="size-3" />
            )}
            <span className="truncate">{hook.lastResult.detail}</span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={hook.enabled}
          disabled={props.saving}
          aria-label={`${hook.name ?? hook.id} enabled`}
          onCheckedChange={props.onToggleEnabled}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hook.enabled || testHook.isPending}
          onClick={() => {
            testHook.mutate(
              { hookId: hook.id },
              {
                onSuccess: (result) => {
                  if (result.outcome === "ok") {
                    toast.success(`Hook "${hook.name ?? hook.id}" delivered`);
                  } else {
                    toast.error(`Test ${result.outcome}: ${result.detail}`);
                  }
                },
              },
            );
          }}
        >
          {testingThisHook ? (
            <AgentSpinningDots
              className={undefined}
              testId={`notification-hook-test-spinner-${hook.id}`}
              variant={undefined}
            />
          ) : null}
          Test
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.saving}
          onClick={props.onEdit}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.saving}
          onClick={props.onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** `null` in the file means "any severity" - name it rather than show blank. */
function severitySummary(severities: HookEntry["severities"]): string {
  if (severities === null) return "Every severity";
  return severities
    .map((id) => HOOK_SEVERITIES.find((entry) => entry.id === id)?.label ?? id)
    .join(", ");
}
