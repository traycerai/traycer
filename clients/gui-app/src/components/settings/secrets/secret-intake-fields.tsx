import type { ReactNode } from "react";
import {
  SANDBOX_SECRET_MODES,
  SANDBOX_SECRET_SWAP_SITES,
  isSandboxDatabaseEngine,
  sandboxDatabaseConsentCopy,
  type SandboxConnectionDialect,
  type SandboxRouteProtocol,
  type SandboxSecretSwapSite,
} from "@traycer/protocol/host/secret-intake-catalogue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  SECRET_DATABASE_LOGIN_ADVICE,
  SECRET_DIALECT_LABEL,
  SECRET_MODE_CONSEQUENCE,
  SECRET_MODE_LABEL,
  SECRET_PROTOCOL_LABEL,
  secretKindProtocols,
  secretVariableDialects,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  nextVariableId,
  withSecretProtocol,
  type SecretFormState,
  type SecretFormVariable,
} from "@/lib/sandboxes/secret-intake-form";

type FormChange = (next: SecretFormState) => void;

const SWAP_SITE_LABEL: Readonly<Record<SandboxSecretSwapSite, string>> = {
  header: "Header",
  query: "Query string",
  body: "Body",
};

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}

function ProtocolField(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const protocols = secretKindProtocols(props.state.kind);
  if (protocols.length < 2) return null;
  return (
    <Field id="secret-protocol" label="Protocol" hint={null}>
      <Select
        value={props.state.protocol}
        onValueChange={(value) => {
          const next = protocols.find((protocol) => protocol === value);
          if (next !== undefined) {
            props.onChange(withSecretProtocol(props.state, next));
          }
        }}
      >
        <SelectTrigger
          id="secret-protocol"
          size="sm"
          className="w-full"
          data-testid="secret-form-protocol"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {protocols.map((protocol) => (
            <SelectItem key={protocol} value={protocol}>
              {SECRET_PROTOCOL_LABEL[protocol]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function DestinationFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,8rem)]">
      <Field
        id="secret-hosts"
        label="Host"
        hint="Separate several hosts with commas."
      >
        <Input
          id="secret-hosts"
          value={state.hosts}
          placeholder={
            state.kind === "database" ? "db.example.com" : "api.example.com"
          }
          onChange={(event) =>
            onChange({ ...state, hosts: event.currentTarget.value })
          }
          data-testid="secret-form-hosts"
        />
      </Field>
      <Field id="secret-port" label="Port" hint={null}>
        <Input
          id="secret-port"
          inputMode="numeric"
          value={state.port}
          placeholder="Default"
          onChange={(event) =>
            onChange({ ...state, port: event.currentTarget.value })
          }
          data-testid="secret-form-port"
        />
      </Field>
    </div>
  );
}

function DatabaseFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  if (state.kind !== "database") return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field
        id="secret-login"
        label="Login"
        hint={SECRET_DATABASE_LOGIN_ADVICE}
      >
        <Input
          id="secret-login"
          value={state.identity}
          autoComplete="off"
          onChange={(event) =>
            onChange({ ...state, identity: event.currentTarget.value })
          }
          data-testid="secret-form-login"
        />
      </Field>
      <Field id="secret-database" label="Database" hint="Leave empty for none.">
        <Input
          id="secret-database"
          value={state.database}
          onChange={(event) =>
            onChange({ ...state, database: event.currentTarget.value })
          }
          data-testid="secret-form-database"
        />
      </Field>
    </div>
  );
}

function ValueField(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  return (
    <Field
      id="secret-value"
      label={state.kind === "database" ? "Password" : "Value"}
      hint={null}
    >
      <Input
        id="secret-value"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={state.value}
        onChange={(event) =>
          onChange({ ...state, value: event.currentTarget.value })
        }
        data-testid="secret-form-value"
      />
    </Field>
  );
}

function SwapSiteFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  if (state.kind !== "api_key") return null;
  const toggle = (site: SandboxSecretSwapSite, checked: boolean): void => {
    const sites = checked
      ? [...state.swapSites, site]
      : state.swapSites.filter((entry) => entry !== site);
    onChange({
      ...state,
      swapSites: SANDBOX_SECRET_SWAP_SITES.filter((entry) =>
        sites.includes(entry),
      ),
    });
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-ui-sm font-medium">
        Where the key appears in a request
      </legend>
      <div className="flex flex-wrap gap-4">
        {SANDBOX_SECRET_SWAP_SITES.map((site) => (
          <div key={site} className="flex items-center gap-2 text-ui-sm">
            <Checkbox
              id={`secret-swap-${site}`}
              checked={state.swapSites.includes(site)}
              onCheckedChange={(checked) => toggle(site, checked === true)}
              data-testid={`secret-form-swap-${site}`}
            />
            <Label htmlFor={`secret-swap-${site}`}>
              {SWAP_SITE_LABEL[site]}
            </Label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function VariableRow(props: {
  readonly variable: SecretFormVariable;
  readonly dialects: readonly SandboxConnectionDialect[];
  readonly onChange: (next: SecretFormVariable | null) => void;
}): ReactNode {
  const { variable, dialects, onChange } = props;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Variable name"
        font="mono"
        className="min-w-0 flex-1"
        value={variable.name}
        onChange={(event) =>
          onChange({ ...variable, name: event.currentTarget.value })
        }
        data-testid="secret-form-variable-name"
      />
      <Select
        value={variable.dialect}
        onValueChange={(value) => {
          const dialect = dialects.find((entry) => entry === value);
          if (dialect !== undefined) onChange({ ...variable, dialect });
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Format"
          className="w-full sm:w-auto sm:min-w-48"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {dialects.map((dialect) => (
            <SelectItem key={dialect} value={dialect}>
              {SECRET_DIALECT_LABEL[dialect]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onChange(null)}
      >
        Remove
      </Button>
    </li>
  );
}

function VariableFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  const dialects = secretVariableDialects(state.protocol);
  const firstDialect = dialects.at(0);
  if (firstDialect === undefined) return null;
  const replaceAt = (index: number, next: SecretFormVariable | null): void => {
    const variables = state.variables.flatMap((variable, at) => {
      if (at !== index) return [variable];
      return next === null ? [] : [next];
    });
    onChange({ ...state, variables });
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-ui-sm font-medium">Variables</legend>
      <p className="text-ui-xs text-muted-foreground">
        The connection settings agents get, each in the format its tool reads.
      </p>
      <ul className="flex flex-col gap-2">
        {state.variables.map((variable, index) => (
          <VariableRow
            key={variable.id}
            variable={variable}
            dialects={dialects}
            onChange={(next) => replaceAt(index, next)}
          />
        ))}
      </ul>
      {state.variables.length < 16 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() =>
            onChange({
              ...state,
              variables: [
                ...state.variables,
                { id: nextVariableId(state), name: "", dialect: firstDialect },
              ],
            })
          }
        >
          Add a variable
        </Button>
      ) : null}
    </fieldset>
  );
}

function ModeFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-ui-sm font-medium">On a sandbox</legend>
      <RadioGroup
        value={state.mode}
        onValueChange={(value) => {
          const mode = SANDBOX_SECRET_MODES.find((entry) => entry === value);
          if (mode !== undefined) {
            onChange({ ...state, mode, plaintextConsent: false });
          }
        }}
      >
        {SANDBOX_SECRET_MODES.map((mode) => (
          <div key={mode} className="flex items-start gap-2 text-ui-sm">
            <RadioGroupItem
              id={`secret-mode-${mode}`}
              value={mode}
              data-testid={`secret-form-mode-${mode}`}
            />
            <div className="flex flex-col">
              <Label htmlFor={`secret-mode-${mode}`}>
                {SECRET_MODE_LABEL[mode]}
              </Label>
              <span className="text-ui-xs text-muted-foreground">
                {SECRET_MODE_CONSEQUENCE[mode]}
              </span>
            </div>
          </div>
        ))}
      </RadioGroup>
      <div className="flex items-center gap-2 text-ui-sm">
        <Switch
          id="secret-sandboxes-by-default"
          checked={state.sandboxesByDefault}
          onCheckedChange={(checked) =>
            onChange({ ...state, sandboxesByDefault: checked })
          }
          data-testid="secret-form-sandboxes-by-default"
        />
        <Label htmlFor="secret-sandboxes-by-default">
          Every sandbox gets it
        </Label>
      </div>
    </fieldset>
  );
}

function ConsentField(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  const engine: SandboxRouteProtocol = state.protocol;
  if (state.mode !== "brokered" || !isSandboxDatabaseEngine(engine)) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui-sm text-warning-foreground"
      data-testid="secret-form-consent"
    >
      {sandboxDatabaseConsentCopy(engine).map((line) => (
        <p key={line} className="max-w-[72ch]">
          {line}
        </p>
      ))}
      <div className="flex items-center gap-2">
        <Checkbox
          id="secret-consent"
          checked={state.plaintextConsent}
          onCheckedChange={(checked) =>
            onChange({ ...state, plaintextConsent: checked === true })
          }
          data-testid="secret-form-consent-check"
        />
        <Label htmlFor="secret-consent">I understand</Label>
      </div>
    </div>
  );
}

/** The add dialog's form for an API key, a model provider key or a database login. */
export function SecretIntakeFields(props: {
  readonly state: SecretFormState;
  readonly onChange: FormChange;
}): ReactNode {
  const { state, onChange } = props;
  return (
    <div className="flex flex-col gap-4">
      <Field
        id="secret-name"
        label="Name"
        hint="Capital letters, digits and underscores, like STRIPE_KEY."
      >
        <Input
          id="secret-name"
          font="mono"
          value={state.name}
          autoComplete="off"
          onChange={(event) =>
            onChange({ ...state, name: event.currentTarget.value })
          }
          data-testid="secret-form-name"
        />
      </Field>
      <ProtocolField state={state} onChange={onChange} />
      <DestinationFields state={state} onChange={onChange} />
      <DatabaseFields state={state} onChange={onChange} />
      <ValueField state={state} onChange={onChange} />
      <SwapSiteFields state={state} onChange={onChange} />
      <VariableFields state={state} onChange={onChange} />
      <ModeFields state={state} onChange={onChange} />
      <ConsentField state={state} onChange={onChange} />
    </div>
  );
}
