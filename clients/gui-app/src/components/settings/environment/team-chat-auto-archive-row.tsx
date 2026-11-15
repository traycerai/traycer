/**
 * Docs: see ../SETTINGS.md (Environment ▸ Storage).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { ChatAutoArchiveSetRequest } from "@traycer/protocol/host/chat-auto-archive/contracts";
import {
  TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS,
  type TeamChatAutoArchiveRecord,
} from "@traycer-clients/shared/host-client/team-chat-auto-archive";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import { ChatAutoArchiveRowView } from "@/components/settings/panels/chat-auto-archive-settings-row";
import { useQueuedAutoArchiveSave } from "@/hooks/chat-auto-archive/use-queued-auto-archive-save";
import { chatAutoArchiveDefaultIdleSeconds } from "@/components/settings/panels/chat-auto-archive-copy";
import {
  useTeamChatAutoArchiveQuery,
  useTeamChatAutoArchiveSetMutation,
} from "@/hooks/chat-auto-archive/use-team-chat-auto-archive";
import { trackSettingChanged } from "@/lib/analytics";
import { useHostBinding } from "@/lib/host";
import type { GrantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import { mayChangeConfiguration } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

// The team's setting is read from the account, not from a computer, so its
// failure names no host.
const TEAM_CHAT_AUTO_ARCHIVE_READ_ERROR = "Couldn't read this setting.";

/**
 * Environment ▸ Storage ▸ Archived chats ▸ "Archive idle agents
 * automatically" for a team (board C24): the team's own setting, which every
 * computer of the team follows. Read on the person's sign-in; an Admin or an
 * Editor changes it, and anyone else sees its value with the controls greyed
 * out. A team that never saved one shows it off.
 */
export function TeamChatAutoArchiveRow(props: {
  readonly environmentId: string;
  readonly role: GrantedEnvironmentRole | null;
}): ReactNode {
  const teamId =
    useEnvironmentListQuery(true).data?.environments.find(
      (descriptor) =>
        descriptor.environmentId === props.environmentId &&
        descriptor.ownerKind !== "user",
    )?.ownerId ?? null;
  if (teamId === null) return null;
  return (
    <TeamChatAutoArchiveRowBody
      teamId={teamId}
      canEdit={mayChangeConfiguration(props.role)}
    />
  );
}

function TeamChatAutoArchiveRowBody(props: {
  readonly teamId: string;
  readonly canEdit: boolean;
}): ReactNode {
  const auth = useHostBinding()?.auth ?? null;
  const query = useTeamChatAutoArchiveQuery(props.teamId);
  const setPolicy = useTeamChatAutoArchiveSetMutation(props.teamId);
  const record = query.data;
  const current = setPolicy.isPending
    ? setPolicy.variables.request
    : teamShownPolicy(record);
  const save = useQueuedAutoArchiveSave(
    current,
    (request, callbacks) => {
      // A read answered, so a sign-in exists; its era is taken now, at the
      // choice, not when the queued save's turn comes.
      if (auth === null) return;
      setPolicy.mutate({ request, era: auth.currentAuthEra() }, callbacks);
    },
    () => {
      trackSettingChanged("storage", "chatAutoArchive");
    },
  );
  const row = STORAGE.definitions.chatAutoArchive;
  return (
    <ChatAutoArchiveRowView
      row={row}
      status={
        query.isError ? (
          <div className="flex flex-col gap-1">
            <p>{row.description}</p>
            <p>{TEAM_CHAT_AUTO_ARCHIVE_READ_ERROR}</p>
          </div>
        ) : undefined
      }
      current={current}
      bounds={record === undefined ? null : TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS}
      disabled={record === undefined || !props.canEdit}
      pending={setPolicy.isPending}
      includeLabel="Include chats members started"
      includeHint="Terminal agent chats count as started by a member"
      save={save}
    />
  );
}

/** The saved setting, or off with the default threshold before any save. */
function teamShownPolicy(
  record: TeamChatAutoArchiveRecord | null | undefined,
): ChatAutoArchiveSetRequest {
  if (record === undefined || record === null) {
    return {
      enabled: false,
      includeUserCreated: false,
      idleSeconds: chatAutoArchiveDefaultIdleSeconds(
        TEAM_CHAT_AUTO_ARCHIVE_IDLE_SECONDS,
      ),
    };
  }
  return {
    enabled: record.enabled,
    includeUserCreated: record.includeUserCreated,
    idleSeconds: record.idleSeconds,
  };
}
