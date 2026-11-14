import type { AccountNotificationSettingsResponse } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NotificationHooksLocalOnlyError } from "@traycer-clients/shared/environment/account-notifications";
import { accountHooksForEditor } from "@traycer-clients/shared/environment/notification-hook-values";
import { useAccountNotificationHooksSave } from "@/hooks/notifications/use-account-notification-settings";
import { ACCOUNT_NOTIFICATIONS_COPY } from "./cloud-notification-copy";
import { CloudNotificationHooksSection } from "./cloud-notification-hooks-section";

/** Cloud editing drops only legacy hooks whose execution remains in computer files. */
export function AccountNotificationHooksSection(props: {
  readonly account: AccountNotificationSettingsResponse;
}) {
  const save = useAccountNotificationHooksSave();
  const localOnly = save.error instanceof NotificationHooksLocalOnlyError;
  return (
    <CloudNotificationHooksSection
      scope="account"
      snapshot={{
        hooks: accountHooksForEditor(props.account.settings?.hooks ?? []),
        revision: props.account.revision,
      }}
      saving={save.isPending}
      error={save.error?.message ?? null}
      editorProblem={
        localOnly ? ACCOUNT_NOTIFICATIONS_COPY.localOnly("$NAME") : null
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
