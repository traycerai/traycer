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
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { noticeWriteOutcome } from "@/lib/environment/write-outcome";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

const LIST = "environment.agentDefinitions.list";

/**
 * Settings > Personal > Agent definitions: the agent definition files every
 * host the person uses gets. Read and written through the window's own host,
 * which forwards each save to the person's settings; a save is compare-and-set
 * on the revision it was edited from, so one that lost to a change made
 * elsewhere says so and the page re-reads (`useRereadOnStaleWrite`).
 */
export function AgentDefinitionsSettingsPanel(): ReactNode {
  const hostId = useAddressableHostId();
  const supported = useHostMethodSupport(hostId, LIST);
  return (
    <SettingsPanelShell
      title={AGENT_DEFINITIONS.page.label}
      description={AGENT_DEFINITIONS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {supported === true ? <AgentDefinitionsBody /> : null}
      {supported === false ? (
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
  const query = useHostQuery<HostRpcRegistry, typeof LIST>({
    cacheKeyIdentity: undefined,
    client: useHostClient(),
    method: LIST,
    params: {},
    options: { enabled: true },
  });
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
        Couldn't read your agent definitions from this host.
      </p>
    );
  }
  const definitions = query.data.definitions;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-definitions">
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
          />
        ))
      )}
      <NewAgentDefinition
        existingNames={definitions.map((definition) => definition.name)}
      />
    </div>
  );
}

function AgentDefinitionEditor(props: {
  readonly definition: AgentDefinition;
}): ReactNode {
  const { definition } = props;
  const [text, setText] = useState(definition.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { put, remove } = useAgentDefinitionWrites();
  const changed = text !== definition.text;
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
        rows={8}
      />
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
          disabled={!changed || put.isPending}
          onClick={() =>
            put.mutate({
              name: definition.name,
              text,
              expectedRevision: definition.revision,
              executableWriteGrant: null,
            })
          }
        >
          Save
          {put.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
      <ConfirmDestructiveDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete agent definition"
        description={`Delete “${definition.name}” from every host you use?`}
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={remove.isPending}
        blockedReason={null}
        onConfirm={() =>
          remove.mutate(
            { name: definition.name, expectedRevision: definition.revision },
            { onSettled: () => setConfirmDelete(false) },
          )
        }
      />
    </section>
  );
}

function NewAgentDefinition(props: {
  readonly existingNames: readonly string[];
}): ReactNode {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const { put } = useAgentDefinitionWrites();
  const trimmed = name.trim();
  const taken = props.existingNames.includes(trimmed);
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
          disabled={trimmed.length === 0 || taken || put.isPending}
          onClick={() =>
            put.mutate(
              {
                name: trimmed,
                text,
                expectedRevision: null,
                executableWriteGrant: null,
              },
              {
                onSuccess: () => {
                  setName("");
                  setText("");
                },
              },
            )
          }
        >
          Add
          {put.isPending ? (
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
