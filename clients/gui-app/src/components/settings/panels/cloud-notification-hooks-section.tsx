import { useState } from "react";
import type { CloudNotificationHook } from "@traycer-clients/shared/environment/notification-hook-values";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  draftFromHook,
  emptyDraft,
  HOOK_SEVERITIES,
} from "./notification-hook-draft";
import { CloudNotificationHookEditorDialog } from "./notification-hook-editor-dialog";
import { CLOUD_NOTIFICATION_LIST_COPY } from "./cloud-notification-copy";
import { HOST_NOTIFICATIONS } from "./notifications-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";

export interface CloudHookSnapshot {
  readonly hooks: readonly CloudNotificationHook[];
  readonly revision: number | null;
}

interface HookEditorState {
  readonly hook: CloudNotificationHook | null;
  readonly snapshot: CloudHookSnapshot;
}

/** A cloud list's editor always saves against the snapshot the gesture opened. */
export function CloudNotificationHooksSection(props: {
  readonly scope: "account" | "team";
  readonly teamName: string | null;
  readonly snapshot: CloudHookSnapshot;
  readonly saving: boolean;
  readonly error: string | null;
  readonly editorProblem: string | null;
  readonly canEdit: boolean;
  readonly onSave: (
    hooks: readonly CloudNotificationHook[],
    revision: number | null,
    onSuccess: () => void,
  ) => void;
  readonly onClearProblem: () => void;
}) {
  const [editor, setEditor] = useState<HookEditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    readonly hook: CloudNotificationHook;
    readonly snapshot: CloudHookSnapshot;
  } | null>(null);
  const disabled = props.saving || !props.canEdit;
  const addHook = () => {
    props.onClearProblem();
    setEditor({ hook: null, snapshot: props.snapshot });
  };
  const save = (
    hooks: readonly CloudNotificationHook[],
    revision: number | null,
    done: string,
  ) => {
    props.onSave(hooks, revision, () => {
      setEditor(null);
      setPendingDelete(null);
      toast.success(done);
    });
  };
  return (
    <SettingsGroup
      group={HOST_NOTIFICATIONS.definitions.notificationHooks}
      showTitle
      tone="default"
      dataTestId="cloud-notification-hooks-manager"
      fill={false}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className="text-ui-xs text-muted-foreground">
          {props.snapshot.hooks.length}{" "}
          {props.snapshot.hooks.length === 1 ? "hook" : "hooks"}
        </span>
        {props.canEdit ? (
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={disabled}
            onClick={addHook}
          >
            <Plus aria-hidden className="size-3.5" />
            Add hook
          </Button>
        ) : null}
      </div>
      {props.error === null ||
      (props.editorProblem !== null && editor !== null) ? null : (
        <p role="alert" className="px-4 py-3 text-ui-sm text-destructive">
          {props.error}
        </p>
      )}
      {props.snapshot.hooks.length === 0 ? (
        CLOUD_NOTIFICATION_LIST_COPY.emptyState
      ) : (
        <div className="divide-y divide-border/40">
          {props.snapshot.hooks.map((hook) => (
            <div
              key={hook.id}
              className="flex flex-wrap items-center gap-3 px-3 py-3"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-ui-sm font-medium">
                    {hook.name ?? hook.id}
                  </span>
                  <Badge variant="outline">HTTP</Badge>
                  {hook.enabled ? null : (
                    <Badge variant="secondary">disabled</Badge>
                  )}
                </div>
                <p className="break-all font-mono text-ui-xs text-muted-foreground">
                  {hook.action.url}
                </p>
                <p className="text-ui-xs text-muted-foreground">
                  {hook.severities === null
                    ? "Every severity"
                    : hook.severities
                        .map(
                          (id) =>
                            HOOK_SEVERITIES.find((entry) => entry.id === id)
                              ?.label ?? id,
                        )
                        .join(", ")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  checked={hook.enabled}
                  disabled={disabled}
                  aria-label={`${hook.name ?? hook.id} enabled`}
                  onCheckedChange={(enabled) =>
                    save(
                      props.snapshot.hooks.map((entry) =>
                        entry.id === hook.id ? { ...entry, enabled } : entry,
                      ),
                      props.snapshot.revision,
                      enabled ? "Hook enabled" : "Hook disabled",
                    )
                  }
                />
                {props.canEdit ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        props.onClearProblem();
                        setEditor({ hook, snapshot: props.snapshot });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        setPendingDelete({ hook, snapshot: props.snapshot })
                      }
                    >
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {editor === null || !props.canEdit ? null : (
        <CloudNotificationHookEditorDialog
          scope={props.scope}
          initialDraft={
            editor.hook === null
              ? { ...emptyDraft(), actionType: "http" }
              : draftFromHook(editor.hook)
          }
          title={editor.hook === null ? "Add hook" : "Edit hook"}
          saving={props.saving}
          serverProblem={props.editorProblem}
          onChange={props.onClearProblem}
          onCancel={() => setEditor(null)}
          onSave={(hook) => {
            if (hook.action.type !== "http") return;
            const httpHook: CloudNotificationHook = {
              ...hook,
              action: hook.action,
            };
            save(
              editor.hook === null
                ? [...editor.snapshot.hooks, httpHook]
                : editor.snapshot.hooks.map((entry) =>
                    entry.id === hook.id ? httpHook : entry,
                  ),
              editor.snapshot.revision,
              editor.hook === null ? "Hook added" : "Hook saved",
            );
          }}
        />
      )}
      {pendingDelete === null || !props.canEdit ? null : (
        <ConfirmDestructiveDialog
          blockedReason={null}
          open
          title={CLOUD_NOTIFICATION_LIST_COPY.deleteTitle}
          description={CLOUD_NOTIFICATION_LIST_COPY.deleteDescription(
            pendingDelete.hook.name ?? pendingDelete.hook.id,
            props.teamName,
          )}
          cascadeSummary={null}
          actionLabel="Delete"
          isPending={props.saving}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          onConfirm={() =>
            save(
              pendingDelete.snapshot.hooks.filter(
                (hook) => hook.id !== pendingDelete.hook.id,
              ),
              pendingDelete.snapshot.revision,
              "Hook deleted",
            )
          }
        />
      )}
    </SettingsGroup>
  );
}
