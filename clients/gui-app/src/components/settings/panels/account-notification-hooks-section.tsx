import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NotificationHookRefusalError } from "@traycer-clients/shared/environment/notification-hook-refusal";
import { accountHooksForEditor } from "@traycer-clients/shared/environment/notification-hook-values";
import { useAccountNotificationHooksSave } from "@/hooks/notifications/use-account-notification-settings";
import { ACCOUNT_NOTIFICATIONS_COPY } from "./cloud-notification-copy";
import { CloudNotificationHooksSection } from "./cloud-notification-hooks-section";

/** Cloud editing drops only legacy hooks whose execution remains in computer files. */
export function AccountNotificationHooksSection(props: {
  readonly account: AccountNotificationSettingsResponse;
}) {
  const save = useAccountNotificationHooksSave();
  const refusal =
    save.error instanceof NotificationHookRefusalError ? save.error : null;
  const refusedHookId =
    refusal !== null && refusal.index !== null
      ? (save.variables?.hooks[refusal.index]?.id ?? null)
      : null;
  return (
    <CloudNotificationHooksSection
      scope="account"
      teamName={null}
      snapshot={{
        hooks: accountHooksForEditor(props.account.settings?.hooks ?? []),
        revision: props.account.revision,
      }}
      saving={save.isPending}
      error={save.error?.message ?? null}
      refusedHookId={refusedHookId}
      editorProblem={
        refusal?.code === "hook_local_only"
          ? {
              hookId: refusedHookId,
              message: ACCOUNT_NOTIFICATIONS_COPY.localOnly("$NAME"),
            }
          : null
      }
      canEdit
      onClearProblem={() => {
        if (!save.isPending) save.reset();
      }}
      onSave={(hooks, revision, onSuccess) => {
        save.mutate(
          { hooks: hooks.map((hook) => ({ ...hook, held: false })), revision },
          { onSuccess },
        );
      }}
    />
  );
}
