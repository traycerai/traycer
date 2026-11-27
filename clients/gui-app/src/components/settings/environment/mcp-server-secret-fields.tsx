import type { ReactNode } from "react";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { pickableSecrets, type McpServerForm } from "./mcp-server-form";
import { SECRET_OPTION_LINE, stdioSecretRefusal } from "./mcp-skills-copy";

/**
 * A remote server's Secret: the line, the pick, the value when added here, then the custody sentence. A command server's
 * Secret is refused by the field it names.
 */
export function McpServerSecretFields(props: {
  readonly form: McpServerForm;
  readonly update: (patch: Partial<McpServerForm>) => void;
  readonly secrets: readonly EnvironmentSecret[];
  /** Where the secrets read is, while it is read or once it fails. */
  readonly secretsRead: ReactNode;
  readonly custody: string;
  /**
   * The secret the server holds, by the name its list gives, offered even
   * when the secrets read does not list it as pickable at this address.
   */
  readonly held: { readonly secretId: string; readonly name: string } | null;
  readonly disabled: boolean;
}): ReactNode {
  const { form, update, held } = props;
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
          {stdioSecretRefusal(field.length > 0 ? field : null)}
        </p>
      </>
    );
  }
  const adding = form.secretChoice === "new";
  const pickable = pickableSecrets(props.secrets, form.url);
  return (
    <>
      <p className="text-ui-xs text-muted-foreground">{SECRET_OPTION_LINE}</p>
      <Select
        value={form.secretChoice}
        disabled={props.disabled}
        onValueChange={(value) =>
          update({ secretChoice: value, authTouched: true })
        }
      >
        <SelectTrigger aria-label="Secret">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {held === null ||
          pickable.some(
            (secret) => secret.secretId === held.secretId,
          ) ? null : (
            <SelectItem value={held.secretId}>{held.name}</SelectItem>
          )}
          {pickable.map((secret) => (
            <SelectItem key={secret.secretId} value={secret.secretId}>
              {secret.name}
            </SelectItem>
          ))}
          <SelectItem value="new">Add a secret</SelectItem>
        </SelectContent>
      </Select>
      {props.secretsRead}
      {adding ? (
        <Input
          aria-label="Secret value"
          type="password"
          autoComplete="off"
          disabled={props.disabled}
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
