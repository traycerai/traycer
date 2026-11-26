import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentDefinition } from "@traycer/protocol/host/environment-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { noticeWriteOutcome } from "@/lib/environment/write-outcome";
import { useHostClient } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useSettingsSave } from "@/hooks/environment/use-settings-save";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";

import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "@/components/settings/environment/configuration-write-issue";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useConfigurationName } from "@/components/settings/environment/team-pick-label";
import { ConfigurationReadFailed } from "@/components/settings/environment/team-read-failed";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useEnvironmentAgentDefinitionsQuery } from "@/hooks/environment/team/use-agent-definitions-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { OwnSlotRowNoteText } from "@/components/settings/personal/own-slot-row-note";
import { useOwnSlotRowNote } from "@/components/settings/personal/use-own-slot-row-note";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { hostNameFromLabel } from "@/lib/host/host-name";

const SAVED_KINDS = ["agent_definition"] as const;

const LIST = "environment.agentDefinitions.list";

/**
 * The Agents page's Definitions tab: one file per agent definition, read
 * through the host binding `EnvironmentHostBinding` re-provides above it, or
 * the team's configuration under a team pick.
 */
export function AgentDefinitionsTab(): ReactNode {
  const source = useConfigurationSource();
  const hostId = useAddressableHostId();
  const configurationKey = useConfigurationKey();
  const supported = useHostMethodSupport(hostId, LIST);
  return (
    <>
      {source.kind === "pool" || supported === true ? (
        // Keyed by configuration: a write's outcome and every draft belong
        // to the configuration they were made in.
        <AgentDefinitionsBody
          key={configurationKey}
          configurationKey={configurationKey}
          hostId={hostId}
        />
      ) : null}
      {source.kind === "host" && supported === false ? (
        <p className="text-ui-sm text-muted-foreground">
          Update this host to use agent definitions.
        </p>
      ) : null}
    </>
  );
}

function useAgentDefinitionWrites() {
  const client = useHostClient();
  const prepareSave = useSettingsSave(client, SAVED_KINDS);
  const cloudSource = useEnvironmentCloud();
  const queryClient = useQueryClient();
  // A write that authn holds shows in the review the app reads from authn.
  const rereadReview = () =>
    void invalidateEnvironmentReads(queryClient, ["environment.review"]);
  const put = useHostScopedMutationForClient(client, {
    method: "environment.agentDefinitions.put",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "environment.agentDefinitions.put", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: (answer) => answer.outcome !== "local_only",
    },
    mutationKey: environmentMutationKeys.agentDefinitionsPut(),
    errorMessage: "Couldn't save the agent definition.",
    invalidateMethods: [LIST, "environment.status", "environment.review"],
    onSuccess: noticeWriteOutcome,
    onSettled: rereadReview,
  });
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.agentDefinitions.delete",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "environment.agentDefinitions.delete", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: (answer) => answer.outcome !== "local_only",
    },
    mutationKey: environmentMutationKeys.agentDefinitionsDelete(),
    errorMessage: "Couldn't delete the agent definition.",
    invalidateMethods: [LIST, "environment.status", "environment.review"],
    onSuccess: noticeWriteOutcome,
    onSettled: rereadReview,
  });
  return { put, remove };
}

function AgentDefinitionsBody(props: {
  readonly configurationKey: string;
  readonly hostId: string | null;
}): ReactNode {
  const query = useEnvironmentAgentDefinitionsQuery(true);
  const read = useBoundedRead(query);
  const source = useConfigurationSource();
  const pick = useEnvironmentPick();
  const canEdit = useCanEditConfiguration();
  const [conflict, setConflict] = useState<ConfigurationWriteIssue>(null);
  if (query.isPending && !read.failed) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (query.isPending || query.isError) {
    return source.kind === "pool" ? (
      <ConfigurationReadFailed page="agent definitions" onRetry={read.retry} />
    ) : (
      <p className="text-ui-sm text-muted-foreground">
        Couldn't read these agent definitions.
      </p>
    );
  }
  const definitions = query.data.definitions;
  const absentRows =
    source.kind === "host" && pick.kind === "personal" ? (
      <AgentDefinitionAbsentRows
        definitions={definitions}
        hostId={props.hostId}
      />
    ) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-definitions">
      <ConfigurationWriteFeedback issue={conflict} />
      {definitions.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No agent definitions yet.
        </p>
      ) : (
        definitions.map((definition) => (
          // Keyed by configuration and revision: a re-read after any save
          // remounts the editor on the text it now has, and so does another
          // team, Personal or computer, whose definition may share this name
          // and revision but not this text.
          <AgentDefinitionEditor
            key={`${props.configurationKey}:${definition.name}:${definition.revision}`}
            definition={definition}
            hostId={props.hostId}
            onOutcome={setConflict}
          />
        ))
      )}
      {absentRows}
      {canEdit ? (
        <NewAgentDefinition
          existingNames={definitions.map((definition) => definition.name)}
          onOutcome={setConflict}
        />
      ) : null}
    </div>
  );
}

function AgentDefinitionAbsentRows(props: {
  readonly definitions: readonly AgentDefinition[];
  readonly hostId: string | null;
}): ReactNode {
  const client = useHostClient();
  const hostEntry = useHostDirectoryEntryForHostId(props.hostId);
  const personalHostName = usePersonalHostName();
  const hostName =
    props.hostId === null
      ? (personalHostName ?? "this computer")
      : hostNameFromLabel(hostEntry?.label ?? null, props.hostId);
  const ownSlots = useOwnSlotRowNote(
    { kind: "agent_definition", key: null, os: "any" },
    {
      client,
      hostId: props.hostId,
      hostName,
      enabled: props.hostId !== null,
    },
  );
  const existingNames = new Set(
    props.definitions.map((definition) => definition.name),
  );
  const absent = ownSlots.entries.filter(
    (entry) =>
      entry.kind === "agent_definition" &&
      entry.state === "absent" &&
      !existingNames.has(entry.key),
  );
  if (absent.length === 0) return null;
  return (
    <ul className="flex flex-col gap-4">
      {absent.map((entry) => (
        <li key={`${entry.kind}:${entry.key}:${entry.os}`}>
          <h3 className="text-ui-sm font-medium text-foreground">
            {entry.key}
          </h3>
          <p className="text-ui-xs text-muted-foreground">
            <OwnSlotRowNoteText
              entry={entry}
              hostName={ownSlots.hostName}
              valueDescription={null}
              disabled={ownSlots.disabled}
              onChange={ownSlots.change}
            />
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The delete confirm names where the definition stops starting: the team
 * (`teamName`), a Local row's computer (`local`), or Personal.
 */
function deleteDefinitionDescription(
  name: string,
  teamName: string | null,
  local: boolean,
): string {
  if (teamName !== null) {
    return `Delete “${name}” from ${teamName}? Harnesses on ${teamName}'s hosts can no longer start it.`;
  }
  if (local) return `Delete “${name}” from every host you use?`;
  return `Delete “${name}” from Personal? Harnesses on your computers and sandboxes can no longer start it.`;
}

function AgentDefinitionEditor(props: {
  readonly definition: AgentDefinition;
  readonly hostId: string | null;
  readonly onOutcome: (conflict: ConfigurationWriteIssue) => void;
}): ReactNode {
  const { definition } = props;
  const source = useConfigurationSource();
  const teamName = useConfigurationName();
  const pick = useEnvironmentPick();
  const canEdit = useCanEditConfiguration();
  const team = useConfigurationItemMutations();
  const [text, setText] = useState(definition.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { put, remove } = useAgentDefinitionWrites();
  const changed = text !== definition.text;
  const saving = source.kind === "pool" ? team.put.isPending : put.isPending;
  const deleting =
    source.kind === "pool" ? team.remove.isPending : remove.isPending;
  const save = (): void => {
    props.onOutcome(null);
    if (source.kind === "pool") {
      team.put.mutate(
        {
          environmentId: source.environmentId,
          kind: "agent_definition",
          key: definition.name,
          os: null,
          value: { text },
          revision: definition.revision,
        },
        {
          onSuccess: (result) =>
            props.onOutcome(configurationWriteIssue(result)),
        },
      );
    } else {
      put.mutate({
        name: definition.name,
        text,
        expectedRevision: definition.revision,
      });
    }
  };
  const deleteDefinition = (): void => {
    props.onOutcome(null);
    if (source.kind === "pool") {
      team.remove.mutate(
        {
          environmentId: source.environmentId,
          kind: "agent_definition",
          key: definition.name,
          os: null,
          revision: definition.revision,
        },
        {
          onSuccess: (result) =>
            props.onOutcome(configurationWriteIssue(result)),
          onSettled: () => setConfirmDelete(false),
        },
      );
    } else {
      remove.mutate(
        { name: definition.name, expectedRevision: definition.revision },
        { onSettled: () => setConfirmDelete(false) },
      );
    }
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      data-testid="agent-definition"
    >
      <h3 className="text-ui-sm font-medium text-foreground">
        {definition.name}
      </h3>
      {source.kind === "host" && pick.kind === "personal" ? (
        <AgentDefinitionOwnSlotNote
          name={definition.name}
          hostId={props.hostId}
          disabled={saving || deleting}
        />
      ) : null}
      <Textarea
        aria-label={`${definition.name} text`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        readOnly={!canEdit}
        rows={8}
      />
      {canEdit ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!changed || saving}
            onClick={save}
          >
            Save
            {saving ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        </div>
      ) : null}
      <ConfirmDestructiveDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete agent definition"
        description={deleteDefinitionDescription(
          definition.name,
          source.kind === "pool" && source.configuration === "team"
            ? teamName
            : null,
          pick.kind === "local",
        )}
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={deleting}
        blockedReason={null}
        onConfirm={deleteDefinition}
      />
    </section>
  );
}

function AgentDefinitionOwnSlotNote(props: {
  readonly name: string;
  readonly hostId: string | null;
  readonly disabled: boolean;
}): ReactNode {
  const client = useHostClient();
  const hostEntry = useHostDirectoryEntryForHostId(props.hostId);
  const personalHostName = usePersonalHostName();
  const hostName =
    props.hostId === null
      ? (personalHostName ?? "this computer")
      : hostNameFromLabel(hostEntry?.label ?? null, props.hostId);
  const ownSlot = useOwnSlotRowNote(
    { kind: "agent_definition", key: props.name, os: "any" },
    {
      client,
      hostId: props.hostId,
      hostName,
      enabled: props.hostId !== null,
    },
  );
  if (ownSlot.entry === null) return null;
  return (
    <p className="text-ui-xs text-muted-foreground">
      <OwnSlotRowNoteText
        entry={ownSlot.entry}
        hostName={ownSlot.hostName}
        valueDescription={
          ownSlot.entry.state === "absent" ? null : "its own version"
        }
        disabled={ownSlot.disabled || props.disabled}
        onChange={ownSlot.change}
      />
    </p>
  );
}

function NewAgentDefinition(props: {
  readonly existingNames: readonly string[];
  readonly onOutcome: (conflict: ConfigurationWriteIssue) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const team = useConfigurationItemMutations();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const { put } = useAgentDefinitionWrites();
  const trimmed = name.trim();
  const taken = props.existingNames.includes(trimmed);
  const saving = source.kind === "pool" ? team.put.isPending : put.isPending;
  const clear = (): void => {
    setName("");
    setText("");
  };
  const add = (): void => {
    props.onOutcome(null);
    if (source.kind === "pool") {
      team.put.mutate(
        {
          environmentId: source.environmentId,
          kind: "agent_definition",
          key: trimmed,
          os: null,
          value: { text },
          revision: null,
        },
        {
          onSuccess: (result) => {
            if (result.outcome === "saved") clear();
            props.onOutcome(configurationWriteIssue(result));
          },
        },
      );
    } else {
      put.mutate(
        {
          name: trimmed,
          text,
          expectedRevision: null,
        },
        { onSuccess: clear },
      );
    }
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 p-3"
      data-testid="new-agent-definition"
    >
      <h3 className="text-ui-sm font-medium text-foreground">
        New agent definition
      </h3>
      <Input
        aria-label="File name"
        placeholder="reviewer.md"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {taken ? (
        <p className="text-ui-xs text-muted-foreground">
          An agent definition with this name already exists.
        </p>
      ) : null}
      <Textarea
        aria-label="New agent definition text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={trimmed.length === 0 || taken || saving}
          onClick={add}
        >
          Add
          {saving ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
    </section>
  );
}
