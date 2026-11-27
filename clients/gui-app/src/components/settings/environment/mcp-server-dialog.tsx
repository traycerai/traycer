import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import {
  useConfigurationMcpServerSave,
  type EnvironmentMcpServer,
} from "@/hooks/environment/team/use-mcp-servers";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import type { EnvironmentMcpServerCredentialV11 } from "@traycer/protocol/host/environment/configuration-contracts";
import { useHostClient } from "@/lib/host";
import {
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";
import {
  initialMcpServerForm,
  mcpServerCredential,
  mcpServerSave,
  mcpServerReady,
  refusedSecret,
  type McpServerForm,
} from "./mcp-server-form";
import { McpServerSecretFields } from "./mcp-server-secret-fields";
import { useConfigurationName } from "./mcp-servers-model";
import { TeamReadFailed } from "./team-read-failed";
import {
  addServerReach,
  addServerTitle,
  custodySentence,
  editServerTitle,
  serverRefusal,
} from "./mcp-skills-copy";

type FormUpdate = (patch: Partial<McpServerForm>) => void;

/**
 * Add or edit one server. A remote server's Secret is one picked from the
 * configuration's (on a host that binds one) or a value typed here, both sent
 * only to the server's address; a command server is refused one.
 */
export function McpServerDialog(props: {
  readonly server: EnvironmentMcpServer | null;
  readonly onClose: () => void;
}): ReactNode {
  const { server } = props;
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  const client = useHostClient();
  const secrets = useEnvironmentSecretsQuery(client);
  const secretList = secrets.data?.secrets ?? [];
  // The pick is read apart from the server: while it is read, or once it
  // fails, the list is not "no secrets".
  let secretsRead: ReactNode = null;
  if (secrets.isError && !secrets.isFetching)
    secretsRead = (
      <TeamReadFailed
        message="Couldn't read the secrets to pick from."
        onRetry={() => void secrets.refetch()}
      />
    );
  else if (secrets.isLoading) secretsRead = <MutedAgentSpinner />;
  const [form, setForm] = useState<McpServerForm>(() =>
    initialMcpServerForm(server),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const update: FormUpdate = (patch) =>
    setForm((current) => ({ ...current, ...patch }));
  const credential = mcpServerCredential(form, server !== null, true);
  // Handed over once at send, so a typed value is never the mutation's variables.
  const submittedCredential =
    useSubmittedSecretInput<EnvironmentMcpServerCredentialV11>(
      "MCP server input is unavailable.",
    );
  const put = useConfigurationMcpServerSave(submittedCredential.read);
  const submit = (): void => {
    if (source.kind !== "pool" || credential === null) return;
    setProblem(null);
    const serverName = form.name.trim();
    const refusalSecret = refusedSecret(form, server, secretList);
    submittedCredential.set(credential);
    put.mutate(mcpServerSave(form, server, source.environmentId), {
      onSettled: submittedCredential.clear,
      onSuccess: (result) => {
        if (result.outcome === "saved") props.onClose();
        else if (result.outcome === "forbidden")
          setProblem("You no longer have access to change these settings.");
        else
          setProblem(
            serverRefusal(result.reason, {
              configuration: name,
              server: serverName,
              secret: refusalSecret,
            }),
          );
      },
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {server === null
              ? addServerTitle(name)
              : editServerTitle(server.name)}
          </DialogTitle>
          <DialogDescription>{addServerReach()}</DialogDescription>
        </DialogHeader>
        <div className="-m-1 flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-1">
          <Label htmlFor="mcp-server-name">Name</Label>
          <Input
            id="mcp-server-name"
            maxLength={128}
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
          />
          <McpServerTransportFields form={form} update={update} />
          <Label htmlFor="mcp-server-auth">Credential</Label>
          <Select
            value={form.auth}
            onValueChange={(value) => {
              if (value === "none" || value === "secret")
                update({ auth: value, authTouched: true });
            }}
          >
            <SelectTrigger id="mcp-server-auth" aria-label="Credential">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="secret">Secret</SelectItem>
            </SelectContent>
          </Select>
          {form.auth === "secret" ? (
            <McpServerSecretFields
              form={form}
              update={update}
              secrets={secretList}
              secretsRead={secretsRead}
              custody={custodySentence(personal, "This environment")}
              held={null}
              disabled={false}
            />
          ) : null}
          {problem === null ? null : (
            <p role="status" className="text-ui-xs text-warning-foreground">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!mcpServerReady(form, credential) || put.isPending}
            onClick={submit}
          >
            {server === null ? "Add" : "Save"}
            {put.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function McpServerTransportFields(props: {
  readonly form: McpServerForm;
  readonly update: FormUpdate;
}): ReactNode {
  const { form, update } = props;
  return (
    <>
      <Label htmlFor="mcp-server-transport">Server type</Label>
      <Select
        value={form.transport}
        onValueChange={(value) => {
          if (value === "http" || value === "stdio")
            update({ transport: value });
        }}
      >
        <SelectTrigger id="mcp-server-transport" aria-label="Server type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="http">Remote (URL)</SelectItem>
          <SelectItem value="stdio">Command</SelectItem>
        </SelectContent>
      </Select>
      {form.transport === "http" ? (
        <>
          <Label htmlFor="mcp-server-url">Web address</Label>
          <Input
            id="mcp-server-url"
            inputMode="url"
            value={form.url}
            onChange={(event) => update({ url: event.target.value })}
          />
        </>
      ) : (
        <>
          <Label htmlFor="mcp-server-command">Command</Label>
          <Input
            id="mcp-server-command"
            value={form.command}
            onChange={(event) => update({ command: event.target.value })}
          />
          <Label htmlFor="mcp-server-args">Arguments, one per line</Label>
          <Textarea
            id="mcp-server-args"
            value={form.args}
            onChange={(event) => update({ args: event.target.value })}
          />
        </>
      )}
    </>
  );
}
