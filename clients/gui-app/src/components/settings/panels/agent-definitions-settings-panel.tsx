import { useState, type ReactNode } from "react";
import type { AgentDefinition } from "@traycer/protocol/host/environment-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_DEFINITIONS } from "@/components/settings/panels/agent-definitions.definitions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { noticeWriteOutcome } from "@/lib/environment/write-outcome";
import { useHostClient } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "@/components/settings/environment/configuration-write-issue";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentAgentDefinitionsQuery } from "@/hooks/environment/team/use-agent-definitions-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";

const LIST = "environment.agentDefinitions.list";

export function AgentDefinitionsSettingsPanel(): ReactNode {
  const source = useConfigurationSource();
  const hostId = useAddressableHostId();
  const supported = useHostMethodSupport(hostId, LIST);
  return (
    <SettingsPanelShell
      title={AGENT_DEFINITIONS.page.label}
      description={AGENT_DEFINITIONS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {source.kind === "pool" || supported === true ? (
        <AgentDefinitionsBody />
      ) : null}
      {source.kind === "host" && supported === false ? (
        <p className="text-ui-sm text-muted-foreground">
          Update this host to use agent definitions.
        </p>
      ) : null}
    </SettingsPanelShell>
  );
}

function useAgentDefinitionWrites() {
  const client = useHostClient();
  // An agent definition is content an agent runs, so a save carries the grant.
  const grant = useExecutableWriteGrant();
  const put = useHostScopedMutationForClient(client, {
    method: "environment.agentDefinitions.put",
    prepareRequest: grant,
    mutationKey: environmentMutationKeys.agentDefinitionsPut(),
    errorMessage: "Couldn't save the agent definition.",
    invalidateMethods: [LIST, "environment.status", "environment.review"],
    onSuccess: noticeWriteOutcome,
  });
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.agentDefinitions.delete",
    mutationKey: environmentMutationKeys.agentDefinitionsDelete(),
    errorMessage: "Couldn't delete the agent definition.",
    invalidateMethods: [LIST, "environment.status", "environment.review"],
    onSuccess: noticeWriteOutcome,
  });
  return { put, remove };
}

function AgentDefinitionsBody(): ReactNode {
  const query = useEnvironmentAgentDefinitionsQuery(true);
  const canEdit = useCanEditConfiguration();
  const [conflict, setConflict] = useState<ConfigurationWriteIssue>(null);
  if (query.isPending) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (query.isError) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Couldn't read these agent definitions.
      </p>
    );
  }
  const definitions = query.data.definitions;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-definitions">
      <ConfigurationWriteFeedback issue={conflict} />
      {definitions.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No agent definitions yet.
        </p>
      ) : (
        definitions.map((definition) => (
          // Keyed by revision: a re-read after any save remounts the editor
          // on the text it now has.
          <AgentDefinitionEditor
            key={`${definition.name}:${definition.revision}`}
            definition={definition}
            onOutcome={setConflict}
          />
        ))
      )}
      {canEdit ? (
        <NewAgentDefinition
          existingNames={definitions.map((definition) => definition.name)}
          onOutcome={setConflict}
        />
      ) : null}
    </div>
  );
}

function AgentDefinitionEditor(props: {
  readonly definition: AgentDefinition;
  readonly onOutcome: (conflict: ConfigurationWriteIssue) => void;
}): ReactNode {
  const { definition } = props;
  const source = useConfigurationSource();
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
        executableWriteGrant: null,
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
        description={
          source.kind === "pool"
            ? `Delete “${definition.name}” from this team?`
            : `Delete “${definition.name}” from every host you use?`
        }
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={deleting}
        blockedReason={null}
        onConfirm={deleteDefinition}
      />
    </section>
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
          executableWriteGrant: null,
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
