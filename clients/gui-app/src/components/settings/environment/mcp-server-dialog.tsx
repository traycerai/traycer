import { useState, type ReactNode } from "react";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { negotiatedVersionMeetsRequirement } from "@traycer-clients/shared/host-transport/host-messenger";
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
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import {
  useConfigurationMcpServerMutations,
  type EnvironmentMcpServer,
} from "@/hooks/environment/team/use-mcp-servers";
import { useHostClient } from "@/lib/host";
import {
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";
import {
  initialMcpServerForm,
  mcpServerCredential,
  mcpServerPutRequest,
  mcpServerReady,
  pickableSecrets,
  refusedSecret,
  type McpServerForm,
} from "./mcp-server-form";
import { useConfigurationName } from "./mcp-servers-model";
import { TeamReadFailed } from "./team-read-failed";
import {
  addServerReach,
  addServerTitle,
  custodySentence,
  editServerTitle,
  secretOptionLine,
  serverRefusal,
  stdioSecretRefusal,
} from "./mcp-skills-copy";

/** `put@1.1` binds an existing secret; a 1.0 host takes a typed value only. */
const PICK_SECRET_REQUIRED_HOST_VERSION = {
  method: "environment.configuration.mcpServers.put",
  version: { major: 1, minor: 1 },
} as const;

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
  const putVersion = useHostNegotiatedMethodVersion(
    client,
    "environment.configuration.mcpServers.put",
  );
  const canPick =
    putVersion !== null &&
    putVersion !== false &&
    negotiatedVersionMeetsRequirement(
      putVersion,
      PICK_SECRET_REQUIRED_HOST_VERSION,
    );
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
  const { put } = useConfigurationMcpServerMutations();
  const [form, setForm] = useState<McpServerForm>(() =>
    initialMcpServerForm(server),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const update: FormUpdate = (patch) =>
    setForm((current) => ({ ...current, ...patch }));
  const credential = mcpServerCredential(form, server !== null, canPick);
  const submit = (): void => {
    if (source.kind !== "pool" || credential === null) return;
    setProblem(null);
    put.mutate(
      mcpServerPutRequest(form, server, source.environmentId, credential),
      {
        onSuccess: (result) => {
          if (result.outcome === "saved") props.onClose();
          else if (result.outcome === "forbidden")
            setProblem("You no longer have access to change these settings.");
          else
            setProblem(
              serverRefusal(result.reason, {
                configuration: name,
                server: form.name.trim(),
                secret: refusedSecret(form, server, secretList),
              }),
            );
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {server === null
              ? addServerTitle(name)
              : editServerTitle(server.name)}
          </DialogTitle>
          <DialogDescription>
            {addServerReach(personal, name)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
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
              canPick={canPick}
              secrets={secretList}
              secretsRead={secretsRead}
              custody={custodySentence(personal, name)}
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

/**
 * A remote server's Secret: the line, the pick (or Add only on a 1.0 host),
 * the value when added here, then the custody sentence. A command server's
 * Secret is refused by the field it names.
 */
function McpServerSecretFields(props: {
  readonly form: McpServerForm;
  readonly update: FormUpdate;
  readonly canPick: boolean;
  readonly secrets: readonly EnvironmentSecret[];
  /** Where the secrets read is, while it is read or once it fails. */
  readonly secretsRead: ReactNode;
  readonly custody: string;
}): ReactNode {
  const { form, update } = props;
  if (form.transport === "stdio") {
    const field = form.variable.trim();
    return (
      <>
        <Label htmlFor="mcp-server-variable">Variable name</Label>
        <Input
          id="mcp-server-variable"
          value={form.variable}
          onChange={(event) => update({ variable: event.target.value })}
        />
        <p role="status" className="text-ui-xs text-warning-foreground">
          {stdioSecretRefusal(field.length > 0 ? field : "this server")}
        </p>
      </>
    );
  }
  const adding = !props.canPick || form.secretChoice === "new";
  return (
    <>
      <p className="text-ui-xs text-muted-foreground">
        {secretOptionLine(props.canPick)}
      </p>
      {props.canPick ? (
        <Select
          value={form.secretChoice}
          onValueChange={(value) =>
            update({ secretChoice: value, authTouched: true })
          }
        >
          <SelectTrigger aria-label="Secret">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pickableSecrets(props.secrets, form.url).map((secret) => (
              <SelectItem key={secret.secretId} value={secret.secretId}>
                {secret.name}
              </SelectItem>
            ))}
            <SelectItem value="new">Add a secret</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {props.canPick ? props.secretsRead : null}
      {adding ? (
        <Input
          aria-label="Secret value"
          type="password"
          autoComplete="off"
          value={form.secretValue}
          onChange={(event) =>
            update({ secretValue: event.target.value, authTouched: true })
          }
        />
      ) : null}
      <p className="text-ui-xs text-muted-foreground">{props.custody}</p>
    </>
  );
}
