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
    <section className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-ui font-semibold text-foreground">
            Notification hooks
          </h2>
          <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
            Run a script or POST to a URL when notifications fire. Each hook
            picks its own severities, the same ones as Interruptions above.
            Edits here and hand-edits to the file below are the same thing —
            both reload immediately.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          Refresh
        </Button>
      </div>
      {renderBody({
        data,
        errorMessage: error?.message ?? null,
        isLoading,
        testHook: props.testHook,
        saveHooks: props.saveHooks,
      })}
    </section>
  );
}

function renderBody(args: {
  readonly data: NotificationHooksStatusQuery["data"];
  readonly errorMessage: string | null;
  readonly isLoading: boolean;
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}): ReactNode {
  const { data, errorMessage, isLoading, testHook, saveHooks } = args;
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading hook status
      </div>
    );
  }
  if (errorMessage !== null || data === undefined) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        {errorMessage ?? "Connect to a host to see hook status."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ConfigPathRow configPath={data.configPath} />
      {data.configError === null ? (
        <HooksEditor
          hooks={data.hooks}
          testHook={testHook}
          saveHooks={saveHooks}
        />
      ) : (
        // The file is unparseable: there is no valid state to edit from, and
        // saving would replace whatever the author is mid-way through typing.
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Hooks are disabled and editing is unavailable until the file parses:{" "}
            {data.configError}.
          </span>
        </div>
      )}
    </div>
  );
}

function ConfigPathRow(props: { readonly configPath: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 truncate rounded bg-muted/60 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
        {props.configPath}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
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

type EditorState =
  | { readonly kind: "closed" }
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly hook: HookEntry };

function HooksEditor(props: {
  readonly hooks: readonly HookEntry[];
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}) {
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
    <div className="space-y-3">
      {props.hooks.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No hooks yet. Add one, or hand-edit the file above.
        </p>
      ) : (
        props.hooks.map((hook) => (
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
        ))
      )}

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
    </div>
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
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 px-3 py-2">
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
        {hook.lastResult === null ? null : (
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
              testId={undefined}
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
