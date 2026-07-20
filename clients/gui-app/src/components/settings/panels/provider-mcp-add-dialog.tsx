import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import type {
  ProviderMcpAuthRead,
  ProviderMcpAuthType,
  ProviderMcpAuthWrite,
  ProviderMcpCapabilities,
  ProviderMcpOauthField,
  ProviderMcpServer,
  ProviderMcpServerTransportWrite,
  ProviderMcpTransport,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";
import { cn } from "@/lib/utils";

type TransportKind = "remote" | "local";
type RemoteTransportType = "http" | "sse";
type SecretRow = {
  readonly id: number;
  readonly name: string;
  readonly value: string;
};

const SECRET_REENTRY_HINT =
  "For your security the existing secret isn't shown; re-enter it to save.";

function transportKindFromServer(
  server: ProviderMcpServer | null,
  supportsRemote: boolean,
): TransportKind {
  if (server === null) return supportsRemote ? "remote" : "local";
  if (server.transport.type === "stdio") return "local";
  return "remote";
}

function urlFromServer(server: ProviderMcpServer | null): string {
  if (
    server !== null &&
    (server.transport.type === "http" || server.transport.type === "sse")
  ) {
    return server.transport.url;
  }
  return "";
}

function commandFromServer(server: ProviderMcpServer | null): string {
  if (server !== null && server.transport.type === "stdio") {
    return server.transport.command;
  }
  return "";
}

function remoteTransportTypeFromServer(
  server: ProviderMcpServer | null,
  remoteTransports: readonly RemoteTransportType[],
): RemoteTransportType {
  if (
    server !== null &&
    (server.transport.type === "http" || server.transport.type === "sse")
  ) {
    return server.transport.type;
  }
  return remoteTransports.includes("http")
    ? "http"
    : (remoteTransports[0] ?? "http");
}

function authTypeFromServer(
  server: ProviderMcpServer | null,
  fallback: ProviderMcpAuthType,
): ProviderMcpAuthType {
  if (server === null) return fallback;
  const auth = server.transport.type === "stdio" ? null : server.transport.auth;
  if (auth === null) return "none";
  return auth.type;
}

function computeEffectiveKind(
  multiTransport: boolean,
  kind: TransportKind,
  supportsRemote: boolean,
): TransportKind {
  if (multiTransport) return kind;
  return supportsRemote ? "remote" : "local";
}

function computeEffectiveRemoteTransportType(
  remoteTransports: readonly RemoteTransportType[],
  remoteTransportType: RemoteTransportType,
): RemoteTransportType {
  if (remoteTransports.length > 1) return remoteTransportType;
  return remoteTransports[0] ?? "http";
}

/** N1: prefill non-secret stdio env-var NAMES from the masked read; values
 * always start empty/masked. */
function envRowsFromServer(
  server: ProviderMcpServer | null,
  makeRow: (name: string, index: number) => SecretRow,
): SecretRow[] {
  if (
    server !== null &&
    server.transport.type === "stdio" &&
    server.transport.env !== null &&
    server.transport.env.length > 0
  ) {
    return server.transport.env.map((e, index) => makeRow(e.name, index));
  }
  return [{ id: 0, name: "", value: "" }];
}

function remoteAuthFromServer(
  server: ProviderMcpServer | null,
): ProviderMcpAuthRead | null {
  if (
    server === null ||
    (server.transport.type !== "http" && server.transport.type !== "sse")
  ) {
    return null;
  }
  return server.transport.auth;
}

/** N1: prefill the non-secret header NAME from the masked read; only the
 * first row is recoverable — the read model masks additional header rows. */
function headerRowsFromAuth(auth: ProviderMcpAuthRead | null): SecretRow[] {
  if (auth !== null && auth.type === "header") {
    return [{ id: 0, name: auth.name, value: "" }];
  }
  return [{ id: 0, name: "", value: "" }];
}

function envAuthNameFromAuth(auth: ProviderMcpAuthRead | null): string {
  return auth !== null && auth.type === "env" ? auth.name : "";
}

function dialogCopy(
  mode: "add" | "edit",
  providerLabel: string,
): { readonly title: string; readonly submitLabel: string } {
  if (mode === "edit") {
    return {
      title: `Edit MCP server — ${providerLabel}`,
      submitLabel: "Save changes",
    };
  }
  return {
    title: `Add MCP server — ${providerLabel}`,
    submitLabel: "Add server",
  };
}

interface ResetFormSetters {
  readonly setKind: (kind: TransportKind) => void;
  readonly setRemoteTransportType: (type: RemoteTransportType) => void;
  readonly setName: (name: string) => void;
  readonly setUrl: (url: string) => void;
  readonly setCommand: (command: string) => void;
  readonly setArgsText: (argsText: string) => void;
  readonly setEnvRows: (rows: SecretRow[]) => void;
  readonly setHeaderRows: (rows: SecretRow[]) => void;
  readonly setEnvAuthVarName: (name: string) => void;
  readonly setOauthClientId: (id: string) => void;
  readonly setOauthResource: (resource: string) => void;
  readonly setAuthType: (type: ProviderMcpAuthType) => void;
  readonly setFormError: (error: string | null) => void;
}

interface ResetInputs {
  readonly open: boolean;
  readonly mode: "add" | "edit";
  readonly initialServer: ProviderMcpServer | null;
  readonly supportsRemote: boolean;
  readonly defaultAuth: ProviderMcpAuthType;
  readonly remoteTransports: readonly RemoteTransportType[];
}

function resetInputsEqual(a: ResetInputs, b: ResetInputs): boolean {
  return (
    a.open === b.open &&
    a.mode === b.mode &&
    a.initialServer === b.initialServer &&
    a.supportsRemote === b.supportsRemote &&
    a.defaultAuth === b.defaultAuth &&
    a.remoteTransports === b.remoteTransports
  );
}

/**
 * Adjusts state during render (guarded by comparing against the last-applied
 * inputs) rather than in an effect, so reopening the dialog resets its fields
 * in the same commit instead of a cascading post-mount render - see
 * `useMountedTabIds` in epic-tab-host.tsx for the same pattern.
 */
function useResetFormOnReopen(args: {
  readonly open: boolean;
  readonly mode: "add" | "edit";
  readonly initialServer: ProviderMcpServer | null;
  readonly supportsRemote: boolean;
  readonly defaultAuth: ProviderMcpAuthType;
  readonly remoteTransports: readonly RemoteTransportType[];
  readonly setters: ResetFormSetters;
}): void {
  const {
    open,
    mode,
    initialServer,
    supportsRemote,
    defaultAuth,
    remoteTransports,
    setters,
  } = args;
  const resetInputs: ResetInputs = {
    open,
    mode,
    initialServer,
    supportsRemote,
    defaultAuth,
    remoteTransports,
  };
  const [seenResetInputs, setSeenResetInputs] = useState<ResetInputs | null>(
    null,
  );
  const resetInputsChanged =
    open &&
    (seenResetInputs === null ||
      !resetInputsEqual(seenResetInputs, resetInputs));
  if (!resetInputsChanged) return;
  setSeenResetInputs(resetInputs);
  const server = mode === "edit" ? initialServer : null;
  const auth = remoteAuthFromServer(server);
  setters.setKind(transportKindFromServer(server, supportsRemote));
  setters.setRemoteTransportType(
    remoteTransportTypeFromServer(server, remoteTransports),
  );
  setters.setName(server?.name ?? "");
  setters.setUrl(urlFromServer(server));
  setters.setCommand(commandFromServer(server));
  setters.setArgsText("");
  // Ids derived purely from index (negative, so they can never collide with
  // `nextRowId()`'s always-positive future output or the reserved `0`) -
  // `nextRowId()` itself reads a ref and must stay confined to event
  // handlers, not this render-time reset.
  setters.setEnvRows(
    envRowsFromServer(server, (name, index) => ({
      id: -(index + 1),
      name,
      value: "",
    })),
  );
  setters.setHeaderRows(headerRowsFromAuth(auth));
  setters.setEnvAuthVarName(envAuthNameFromAuth(auth));
  setters.setOauthClientId("");
  setters.setOauthResource("");
  setters.setAuthType(authTypeFromServer(server, defaultAuth));
  setters.setFormError(null);
}

export function ProviderMcpAddDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: "add" | "edit";
  readonly initialServer: ProviderMcpServer | null;
  readonly providerLabel: string;
  readonly capabilities: ProviderMcpCapabilities;
  readonly existingNames: readonly string[];
  readonly scopeTuple: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
  readonly onAdded:
    ((args: { name: string; requiresAuth: boolean }) => void) | null;
}): ReactNode {
  const {
    open,
    onOpenChange,
    mode,
    initialServer,
    providerLabel,
    capabilities,
    existingNames,
    scopeTuple,
    onAdded,
  } = props;

  const uid = useId();
  // Starts at 0 so the always-present initial row can use a fixed id without
  // touching the ref during render (`emptyHeaderRows` must stay ref-free —
  // it also runs as a useState lazy initializer). Rows added afterward (via
  // `addHeaderRow`, only ever called from an onClick handler) draw from the
  // ref-backed counter, which never collides with the fixed 0.
  const rowIdRef = useRef(0);
  const nextRowId = (): number => {
    rowIdRef.current += 1;
    return rowIdRef.current;
  };
  const emptyHeaderRows = (): SecretRow[] => [{ id: 0, name: "", value: "" }];
  const emptyEnvRows = (): SecretRow[] => [{ id: 0, name: "", value: "" }];

  const remoteTransports = useMemo(
    () =>
      capabilities.transports.filter(
        (t): t is RemoteTransportType => t === "http" || t === "sse",
      ),
    [capabilities.transports],
  );
  const supportsLocal = capabilities.transports.includes("stdio");
  const supportsRemote = remoteTransports.length > 0;
  const multiTransport = supportsLocal && supportsRemote;
  const defaultAuth = capabilities.authTypes[0] ?? "none";
  const oauthFields: readonly ProviderMcpOauthField[] =
    capabilities.oauthFields ?? [];
  const allowMultipleHeaders = capabilities.supportsMultipleHeaders === true;

  const [kind, setKind] = useState<TransportKind>(() =>
    transportKindFromServer(initialServer, supportsRemote),
  );
  const effectiveKind = computeEffectiveKind(
    multiTransport,
    kind,
    supportsRemote,
  );

  const [remoteTransportType, setRemoteTransportType] =
    useState<RemoteTransportType>(() =>
      remoteTransportTypeFromServer(initialServer, remoteTransports),
    );
  const effectiveRemoteTransportType = computeEffectiveRemoteTransportType(
    remoteTransports,
    remoteTransportType,
  );

  const [name, setName] = useState(initialServer?.name ?? "");
  const [url, setUrl] = useState(() => urlFromServer(initialServer));
  const [command, setCommand] = useState(() =>
    commandFromServer(initialServer),
  );
  const [argsText, setArgsText] = useState("");
  const [envRows, setEnvRows] = useState<SecretRow[]>(emptyEnvRows);
  const [headerRows, setHeaderRows] = useState<SecretRow[]>(emptyHeaderRows);
  const [envAuthVarName, setEnvAuthVarName] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthResource, setOauthResource] = useState("");
  const [authType, setAuthType] = useState<ProviderMcpAuthType>(() =>
    authTypeFromServer(initialServer, defaultAuth),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const mutate = useProvidersMcpMutate();

  const authOptions = useMemo(() => {
    if (effectiveKind === "local") return [] as ProviderMcpAuthType[];
    return capabilities.authTypes;
  }, [capabilities.authTypes, effectiveKind]);

  useResetFormOnReopen({
    open,
    mode,
    initialServer,
    supportsRemote,
    defaultAuth,
    remoteTransports,
    setters: {
      setKind,
      setRemoteTransportType,
      setName,
      setUrl,
      setCommand,
      setArgsText,
      setEnvRows,
      setHeaderRows,
      setEnvAuthVarName,
      setOauthClientId,
      setOauthResource,
      setAuthType,
      setFormError,
    },
  });

  const reset = (): void => {
    setName("");
    setUrl("");
    setCommand("");
    setArgsText("");
    setEnvRows(emptyEnvRows());
    setHeaderRows(emptyHeaderRows());
    setEnvAuthVarName("");
    setOauthClientId("");
    setOauthResource("");
    setAuthType(defaultAuth);
    setFormError(null);
    setKind(supportsRemote ? "remote" : "local");
    setRemoteTransportType(
      remoteTransportTypeFromServer(null, remoteTransports),
    );
  };

  const handleOpenChange = (next: boolean): void => {
    if (mutate.isPending) return;
    if (!next) {
      reset();
      // M8: clear the TanStack mutation cache immediately on close so a
      // submitted secret (header/env value) doesn't linger in
      // `mutate.variables` after the user is done with the dialog.
      mutate.reset();
    }
    onOpenChange(next);
  };

  const addHeaderRow = (): void => {
    setHeaderRows((rows) => [
      ...rows,
      { id: nextRowId(), name: "", value: "" },
    ]);
  };
  const removeHeaderRow = (id: number): void => {
    setHeaderRows((rows) => rows.filter((r) => r.id !== id));
  };
  const updateHeaderRow = (
    id: number,
    patch: { name: string } | { value: string },
  ): void => {
    setHeaderRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  };

  const addEnvRow = (): void => {
    setEnvRows((rows) => [...rows, { id: nextRowId(), name: "", value: "" }]);
  };
  const removeEnvRow = (id: number): void => {
    setEnvRows((rows) => rows.filter((r) => r.id !== id));
  };
  const updateEnvRow = (
    id: number,
    patch: { name: string } | { value: string },
  ): void => {
    setEnvRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  };

  const validate = (): ProviderMcpServerTransportWrite | null => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setFormError("Name is required.");
      return null;
    }
    if (mode === "add" && existingNames.includes(trimmedName)) {
      setFormError(
        `A server named “${trimmedName}” already exists in this scope.`,
      );
      return null;
    }

    if (effectiveKind === "remote") {
      const trimmedUrl = url.trim();
      if (trimmedUrl.length === 0) {
        setFormError("Server URL is required.");
        return null;
      }
      if (!isHttpUrl(trimmedUrl)) {
        setFormError("Enter a valid http(s) URL.");
        return null;
      }
      const auth = buildRemoteAuth(authType, {
        headerRows,
        envAuthVarName,
        oauthClientId,
        oauthResource,
      });
      if (auth === "invalid-header-empty") {
        setFormError("Enter at least one header name and value.");
        return null;
      }
      if (auth === "invalid-header-name") {
        setFormError("Header name is required.");
        return null;
      }
      if (auth === "invalid-env-name") {
        setFormError("Environment variable name is required.");
        return null;
      }
      const remoteType: ProviderMcpTransport = effectiveRemoteTransportType;
      if (remoteType === "http") {
        return { type: "http", url: trimmedUrl, auth };
      }
      return { type: "sse", url: trimmedUrl, auth };
    }

    const trimmedCommand = command.trim();
    if (trimmedCommand.length === 0) {
      setFormError("Command is required.");
      return null;
    }
    const args = splitArgs(argsText);
    const touchedEnv = envRows.filter(
      (r) => r.name.trim().length > 0 || r.value.length > 0,
    );
    if (touchedEnv.some((r) => r.name.trim().length === 0)) {
      setFormError("Environment variable name is required.");
      return null;
    }
    const env =
      touchedEnv.length === 0
        ? null
        : touchedEnv.map((r) => ({ name: r.name.trim(), value: r.value }));
    return {
      type: "stdio",
      command: trimmedCommand,
      args,
      env,
    };
  };

  const handleSubmit = (): void => {
    const transport = validate();
    if (transport === null) return;
    setFormError(null);
    const trimmedName = name.trim();
    const requiresAuth =
      transport.type !== "stdio" &&
      transport.auth !== null &&
      transport.auth.type === "oauth";
    mutate.mutate(
      {
        ...scopeTuple,
        mutation:
          mode === "edit"
            ? {
                action: "update",
                name: trimmedName,
                transport,
              }
            : {
                action: "add",
                name: trimmedName,
                transport,
              },
        suppressToast: true,
      },
      {
        onSuccess: () => {
          if (mode === "add" && onAdded !== null) {
            onAdded({ name: trimmedName, requiresAuth });
          }
          handleOpenChange(false);
        },
        onError: (error) => {
          if (isProviderNativeRpcError(error)) {
            setFormError(
              nativeErrorMessage(error.nativeCode, error.nativeDetail),
            );
          } else if (error instanceof Error) {
            setFormError(error.message);
          } else {
            setFormError("Something went wrong.");
          }
        },
      },
    );
  };

  const isEdit = mode === "edit";
  const { title, submitLabel } = dialogCopy(mode, providerLabel);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[min(85vh,42rem)] w-[min(92vw,28rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="provider-mcp-add-dialog"
      >
        <DialogHeader className="shrink-0 p-4 pb-2">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Config is written to this provider&apos;s{" "}
            {scopeTuple.scope === "global" ? "global" : "project"} scope.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2">
          {multiTransport ? (
            <SegmentChipGroup label="Transport kind">
              <SegmentChip
                label="Remote"
                active={effectiveKind === "remote"}
                onClick={() => {
                  setKind("remote");
                }}
              />
              <SegmentChip
                label="Local (stdio)"
                active={effectiveKind === "local"}
                onClick={() => {
                  setKind("local");
                }}
              />
            </SegmentChipGroup>
          ) : null}

          {isEdit ? (
            <div className="flex flex-col gap-1.5">
              <Label id={`${uid}-name-label`}>Name</Label>
              <p className="text-ui-sm font-medium text-foreground">{name}</p>
            </div>
          ) : (
            <Field
              id={`${uid}-name`}
              label="Name"
              value={name}
              onChange={setName}
              placeholder="context7"
              type="text"
              hint={null}
            />
          )}

          {effectiveKind === "remote" ? (
            <>
              <Field
                id={`${uid}-url`}
                label="Server URL"
                value={url}
                onChange={setUrl}
                placeholder="https://mcp.example.com"
                type="text"
                hint={null}
              />

              <RemoteAuthFields
                uid={uid}
                isEdit={isEdit}
                remoteTransports={remoteTransports}
                remoteTransportType={effectiveRemoteTransportType}
                onRemoteTransportTypeChange={setRemoteTransportType}
                authOptions={authOptions}
                authType={authType}
                onAuthTypeChange={setAuthType}
                headerRows={headerRows}
                allowMultipleHeaders={allowMultipleHeaders}
                onAddHeaderRow={addHeaderRow}
                onRemoveHeaderRow={removeHeaderRow}
                onChangeHeaderRow={updateHeaderRow}
                envAuthVarName={envAuthVarName}
                onEnvAuthVarNameChange={setEnvAuthVarName}
                oauthClientId={oauthClientId}
                onOauthClientIdChange={setOauthClientId}
                oauthResource={oauthResource}
                onOauthResourceChange={setOauthResource}
                oauthFields={oauthFields}
              />
            </>
          ) : (
            <>
              <Field
                id={`${uid}-command`}
                label="Command"
                value={command}
                onChange={setCommand}
                placeholder="npx"
                type="text"
                hint={null}
              />
              <Field
                id={`${uid}-args`}
                label="Args"
                value={argsText}
                onChange={setArgsText}
                placeholder="-y @modelcontextprotocol/server-github"
                type="text"
                hint={null}
              />
              <SecretRowsEditor
                idPrefix={`${uid}-env`}
                groupLabel="Env vars"
                rowLabel="Env var"
                namePlaceholder="GITHUB_TOKEN"
                valuePlaceholder="value"
                addLabel="Add env var"
                rows={envRows}
                allowMultiple
                onAdd={addEnvRow}
                onRemove={removeEnvRow}
                onChange={updateEnvRow}
              />
            </>
          )}

          {formError !== null ? (
            <p className="text-ui-xs text-destructive">{formError}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              handleOpenChange(false);
            }}
            disabled={mutate.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={mutate.isPending}
          >
            {mutate.isPending ? <MutedAgentSpinner /> : null}
            {submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RemoteAuthFields(props: {
  readonly uid: string;
  readonly isEdit: boolean;
  readonly remoteTransports: readonly RemoteTransportType[];
  readonly remoteTransportType: RemoteTransportType;
  readonly onRemoteTransportTypeChange: (type: RemoteTransportType) => void;
  readonly authOptions: readonly ProviderMcpAuthType[];
  readonly authType: ProviderMcpAuthType;
  readonly onAuthTypeChange: (type: ProviderMcpAuthType) => void;
  readonly headerRows: readonly SecretRow[];
  readonly allowMultipleHeaders: boolean;
  readonly onAddHeaderRow: () => void;
  readonly onRemoveHeaderRow: (id: number) => void;
  readonly onChangeHeaderRow: (
    id: number,
    patch: { name: string } | { value: string },
  ) => void;
  readonly envAuthVarName: string;
  readonly onEnvAuthVarNameChange: (value: string) => void;
  readonly oauthClientId: string;
  readonly onOauthClientIdChange: (value: string) => void;
  readonly oauthResource: string;
  readonly onOauthResourceChange: (value: string) => void;
  readonly oauthFields: readonly ProviderMcpOauthField[];
}): ReactNode {
  const { uid } = props;
  return (
    <>
      {props.remoteTransports.length > 1 ? (
        <SegmentChipGroup label="Transport protocol">
          <SegmentChip
            label="HTTP"
            active={props.remoteTransportType === "http"}
            onClick={() => {
              props.onRemoteTransportTypeChange("http");
            }}
          />
          <SegmentChip
            label="SSE"
            active={props.remoteTransportType === "sse"}
            onClick={() => {
              props.onRemoteTransportTypeChange("sse");
            }}
          />
        </SegmentChipGroup>
      ) : null}

      {props.authOptions.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Label id={`${uid}-auth-label`}>Authentication</Label>
          <div
            role="group"
            className="flex flex-wrap gap-1"
            aria-labelledby={`${uid}-auth-label`}
          >
            {props.authOptions.map((option) => (
              <PillChip
                key={option}
                label={authTypeLabel(option)}
                active={props.authType === option}
                onClick={() => {
                  props.onAuthTypeChange(option);
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {props.authType === "header" ? (
        <>
          <SecretRowsEditor
            idPrefix={`${uid}-header`}
            groupLabel="Custom headers"
            rowLabel="Header"
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            addLabel="Add header"
            rows={props.headerRows}
            allowMultiple={props.allowMultipleHeaders}
            onAdd={props.onAddHeaderRow}
            onRemove={props.onRemoveHeaderRow}
            onChange={props.onChangeHeaderRow}
          />
          {props.isEdit ? (
            <p className="text-ui-xs text-muted-foreground">
              {SECRET_REENTRY_HINT}
            </p>
          ) : null}
        </>
      ) : null}

      {props.authType === "env" ? (
        <Field
          id={`${uid}-env-auth`}
          label="Environment variable name"
          value={props.envAuthVarName}
          onChange={props.onEnvAuthVarNameChange}
          placeholder="GITHUB_TOKEN"
          type="text"
          hint="Traycer passes this name to the provider; the value must already be set in your environment."
        />
      ) : null}

      {props.authType === "oauth" && props.oauthFields.length > 0 ? (
        <>
          {props.oauthFields.includes("clientId") ? (
            <Field
              id={`${uid}-oauth-client-id`}
              label="OAuth client ID (optional)"
              value={props.oauthClientId}
              onChange={props.onOauthClientIdChange}
              placeholder="client-id"
              type="text"
              hint={null}
            />
          ) : null}
          {props.oauthFields.includes("resource") ? (
            <Field
              id={`${uid}-oauth-resource`}
              label="OAuth resource (optional)"
              value={props.oauthResource}
              onChange={props.onOauthResourceChange}
              placeholder="https://mcp.example.com"
              type="text"
              hint={null}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function SegmentChipGroup(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5"
    >
      {props.children}
    </div>
  );
}

function SegmentChip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "rounded px-2.5 py-1 text-ui-xs transition-colors",
        props.active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

function PillChip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "rounded-md border px-2.5 py-1 text-ui-xs transition-colors",
        props.active
          ? "border-border bg-muted text-foreground"
          : "border-border/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

/**
 * Shared per-row masked KEY/value editor for both the remote header editor
 * and the stdio env-var editor. `allowMultiple` is capability-driven for
 * headers (only genuinely repeatable-header providers get "Add header") and
 * always true for stdio env (a config-file env map has no per-provider row
 * limit).
 */
function SecretRowsEditor(props: {
  readonly idPrefix: string;
  readonly groupLabel: string;
  readonly rowLabel: string;
  readonly namePlaceholder: string;
  readonly valuePlaceholder: string;
  readonly addLabel: string;
  readonly rows: readonly SecretRow[];
  readonly allowMultiple: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (id: number) => void;
  readonly onChange: (
    id: number,
    patch: { name: string } | { value: string },
  ) => void;
}): ReactNode {
  const visibleRows = props.allowMultiple ? props.rows : props.rows.slice(0, 1);
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={`${props.idPrefix}-label`}>{props.groupLabel}</Label>
      <div
        role="group"
        className="flex flex-col gap-2"
        aria-labelledby={`${props.idPrefix}-label`}
      >
        {visibleRows.map((row, idx) => (
          <div key={row.id} className="flex items-center gap-1.5">
            <Input
              aria-label={`${props.rowLabel} ${idx + 1} name`}
              value={row.name}
              onChange={(e) => {
                props.onChange(row.id, { name: e.target.value });
              }}
              placeholder={props.namePlaceholder}
              className="min-w-0 flex-1"
            />
            <Input
              type="password"
              aria-label={`${props.rowLabel} ${idx + 1} value`}
              value={row.value}
              onChange={(e) => {
                props.onChange(row.id, { value: e.target.value });
              }}
              placeholder={props.valuePlaceholder}
              className="min-w-0 flex-1"
            />
            {props.allowMultiple ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${props.rowLabel.toLowerCase()} ${idx + 1}`}
                onClick={() => {
                  props.onRemove(row.id);
                }}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ))}
        {props.allowMultiple ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start text-ui-xs"
            onClick={props.onAdd}
          >
            <Plus className="size-3.5" />
            {props.addLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly type: "text" | "password";
  readonly hint: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        placeholder={props.placeholder}
      />
      {props.hint !== null ? (
        <p className="text-ui-xs text-muted-foreground">{props.hint}</p>
      ) : null}
    </div>
  );
}

function authTypeLabel(type: ProviderMcpAuthType): string {
  switch (type) {
    case "none":
      return "None";
    case "header":
      return "Header";
    case "env":
      return "Env var";
    case "oauth":
      return "OAuth";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function splitArgs(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

function buildRemoteAuth(
  authType: ProviderMcpAuthType,
  fields: {
    readonly headerRows: readonly SecretRow[];
    readonly envAuthVarName: string;
    readonly oauthClientId: string;
    readonly oauthResource: string;
  },
):
  | ProviderMcpAuthWrite
  | null
  | "invalid-header-empty"
  | "invalid-header-name"
  | "invalid-env-name" {
  if (authType === "none") return null;
  if (authType === "oauth") {
    const clientId = fields.oauthClientId.trim();
    const resource = fields.oauthResource.trim();
    return {
      type: "oauth",
      oauthClientId: clientId.length > 0 ? clientId : null,
      oauthResource: resource.length > 0 ? resource : null,
    };
  }
  if (authType === "env") {
    const varName = fields.envAuthVarName.trim();
    if (varName.length === 0) return "invalid-env-name";
    return { type: "env", name: varName, value: "" };
  }
  // header — every non-blank row serializes (not just the first).
  const touched = fields.headerRows.filter(
    (r) => r.name.trim().length > 0 || r.value.length > 0,
  );
  if (touched.length === 0) return "invalid-header-empty";
  if (touched.some((r) => r.name.trim().length === 0)) {
    return "invalid-header-name";
  }
  const [first, ...rest] = touched.map((r) => ({
    name: r.name.trim(),
    value: r.value,
  }));
  return {
    type: "header",
    name: first.name,
    value: first.value,
    additionalHeaders: rest,
  };
}
