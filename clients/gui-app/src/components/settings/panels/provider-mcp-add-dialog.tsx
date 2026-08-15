import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useForm } from "@tanstack/react-form";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
type McpFormValues = {
  readonly kind: TransportKind;
  readonly remoteTransportType: RemoteTransportType;
  readonly name: string;
  readonly url: string;
  readonly command: string;
  readonly argsText: string;
  readonly envRows: SecretRow[];
  readonly headerRows: SecretRow[];
  readonly envAuthVarName: string;
  readonly oauthClientId: string;
  readonly oauthResource: string;
  readonly authType: ProviderMcpAuthType;
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

function formValuesFromServer(args: {
  readonly mode: "add" | "edit";
  readonly initialServer: ProviderMcpServer | null;
  readonly supportsRemote: boolean;
  readonly defaultAuth: ProviderMcpAuthType;
  readonly remoteTransports: readonly RemoteTransportType[];
}): McpFormValues {
  const server = args.mode === "edit" ? args.initialServer : null;
  const auth = remoteAuthFromServer(server);
  return {
    kind: transportKindFromServer(server, args.supportsRemote),
    remoteTransportType: remoteTransportTypeFromServer(
      server,
      args.remoteTransports,
    ),
    name: server?.name ?? "",
    url: urlFromServer(server),
    command: commandFromServer(server),
    argsText: "",
    envRows: envRowsFromServer(server, (name, index) => ({
      id: -(index + 1),
      name,
      value: "",
    })),
    headerRows: headerRowsFromAuth(auth),
    envAuthVarName: envAuthNameFromAuth(auth),
    oauthClientId: "",
    oauthResource: "",
    authType: authTypeFromServer(server, args.defaultAuth),
  };
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
  const rowIdRef = useRef(0);
  const nextRowId = (): number => {
    rowIdRef.current += 1;
    return rowIdRef.current;
  };

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
  const defaultValues = useMemo(
    () =>
      formValuesFromServer({
        mode,
        initialServer,
        supportsRemote,
        defaultAuth,
        remoteTransports,
      }),
    [defaultAuth, initialServer, mode, remoteTransports, supportsRemote],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const mutate = useProvidersMcpMutate();
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) => {
      submitValues(value);
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(defaultValues);
  }, [defaultValues, form, open]);

  function handleOpenChange(next: boolean): void {
    if (mutate.isPending) return;
    if (!next) {
      form.reset();
      setFormError(null);
      // M8: clear the TanStack mutation cache immediately on close so a
      // submitted secret (header/env value) doesn't linger in
      // `mutate.variables` after the user is done with the dialog.
      mutate.reset();
    }
    onOpenChange(next);
  }

  const addHeaderRow = (): void => {
    form.setFieldValue("headerRows", (rows) => [
      ...rows,
      { id: nextRowId(), name: "", value: "" },
    ]);
  };
  const removeHeaderRow = (id: number): void => {
    form.setFieldValue("headerRows", (rows) =>
      rows.filter((row) => row.id !== id),
    );
  };
  const updateHeaderRow = (
    id: number,
    patch: { name: string } | { value: string },
  ): void => {
    form.setFieldValue("headerRows", (rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const addEnvRow = (): void => {
    form.setFieldValue("envRows", (rows) => [
      ...rows,
      { id: nextRowId(), name: "", value: "" },
    ]);
  };
  const removeEnvRow = (id: number): void => {
    form.setFieldValue("envRows", (rows) =>
      rows.filter((row) => row.id !== id),
    );
  };
  const updateEnvRow = (
    id: number,
    patch: { name: string } | { value: string },
  ): void => {
    form.setFieldValue("envRows", (rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  function submissionFromValues(values: McpFormValues):
    | {
        readonly error: string;
        readonly transport?: never;
        readonly name?: never;
      }
    | {
        readonly error: undefined;
        readonly transport: ProviderMcpServerTransportWrite;
        readonly name: string;
      } {
    const trimmedName = values.name.trim();
    if (trimmedName.length === 0) {
      return { error: "Name is required." };
    }
    if (mode === "add" && existingNames.includes(trimmedName)) {
      return {
        error: `A server named “${trimmedName}” already exists in this scope.`,
      };
    }

    const effectiveKind = computeEffectiveKind(
      multiTransport,
      values.kind,
      supportsRemote,
    );
    if (effectiveKind === "remote") {
      const trimmedUrl = values.url.trim();
      if (trimmedUrl.length === 0) {
        return { error: "Server URL is required." };
      }
      if (!isHttpUrl(trimmedUrl)) {
        return { error: "Enter a valid http(s) URL." };
      }
      const auth = buildRemoteAuth(values.authType, {
        headerRows: values.headerRows,
        envAuthVarName: values.envAuthVarName,
        oauthClientId: values.oauthClientId,
        oauthResource: values.oauthResource,
      });
      if (auth === "invalid-header-empty") {
        return { error: "Enter at least one header name and value." };
      }
      if (auth === "invalid-header-name") {
        return { error: "Header name is required." };
      }
      if (auth === "invalid-env-name") {
        return { error: "Environment variable name is required." };
      }
      const remoteType: ProviderMcpTransport =
        computeEffectiveRemoteTransportType(
          remoteTransports,
          values.remoteTransportType,
        );
      if (remoteType === "http") {
        return {
          error: undefined,
          name: trimmedName,
          transport: { type: "http", url: trimmedUrl, auth },
        };
      }
      return {
        error: undefined,
        name: trimmedName,
        transport: { type: "sse", url: trimmedUrl, auth },
      };
    }

    const trimmedCommand = values.command.trim();
    if (trimmedCommand.length === 0) {
      return { error: "Command is required." };
    }
    const args = splitArgs(values.argsText);
    const touchedEnv = values.envRows.filter(
      (r) => r.name.trim().length > 0 || r.value.length > 0,
    );
    if (touchedEnv.some((r) => r.name.trim().length === 0)) {
      return { error: "Environment variable name is required." };
    }
    const env =
      touchedEnv.length === 0
        ? null
        : touchedEnv.map((r) => ({ name: r.name.trim(), value: r.value }));
    return {
      error: undefined,
      name: trimmedName,
      transport: {
        type: "stdio",
        command: trimmedCommand,
        args,
        env,
      },
    };
  }

  function submitValues(values: McpFormValues): void {
    const submission = submissionFromValues(values);
    if (submission.error !== undefined) return;
    setFormError(null);
    const requiresAuth =
      submission.transport.type !== "stdio" &&
      submission.transport.auth !== null &&
      submission.transport.auth.type === "oauth";
    mutate.mutate(
      {
        ...scopeTuple,
        mutation:
          mode === "edit"
            ? {
                action: "update",
                name: submission.name,
                transport: submission.transport,
              }
            : {
                action: "add",
                name: submission.name,
                transport: submission.transport,
              },
        suppressToast: true,
      },
      {
        onSuccess: () => {
          if (mode === "add" && onAdded !== null) {
            onAdded({ name: submission.name, requiresAuth });
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
  }

  const isEdit = mode === "edit";
  const { title, submitLabel } = dialogCopy(mode, providerLabel);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="top-[15vh] flex max-h-[min(85vh,42rem)] w-[min(92vw,28rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="provider-mcp-add-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const validationError = submissionFromValues(
              form.state.values,
            ).error;
            if (validationError !== undefined) {
              setFormError(validationError);
              return;
            }
            void form.handleSubmit();
          }}
        >
          <DialogHeader className="shrink-0 p-4 pb-2">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Config is written to this provider&apos;s{" "}
              {scopeTuple.scope === "global" ? "global" : "project"} scope.
            </DialogDescription>
          </DialogHeader>

          <form.Subscribe
            selector={(state) => ({
              values: state.values,
              isDefaultValue: state.isDefaultValue,
            })}
          >
            {({ values, isDefaultValue }) => {
              const effectiveKind = computeEffectiveKind(
                multiTransport,
                values.kind,
                supportsRemote,
              );
              const effectiveRemoteTransportType =
                computeEffectiveRemoteTransportType(
                  remoteTransports,
                  values.remoteTransportType,
                );
              const authOptions =
                effectiveKind === "local" ? [] : capabilities.authTypes;
              return (
                <>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2">
                    {multiTransport ? (
                      <SegmentChipGroup label="Transport kind">
                        <SegmentChip
                          label="Remote"
                          active={effectiveKind === "remote"}
                          disabledReason={null}
                          onClick={() => {
                            form.setFieldValue("kind", "remote");
                          }}
                        />
                        <SegmentChip
                          label="Local (stdio)"
                          active={effectiveKind === "local"}
                          disabledReason={null}
                          onClick={() => {
                            form.setFieldValue("kind", "local");
                          }}
                        />
                      </SegmentChipGroup>
                    ) : null}

                    {isEdit ? (
                      <div className="flex flex-col gap-1.5">
                        <Label id={`${uid}-name-label`}>Name</Label>
                        <p className="text-ui-sm font-medium text-foreground">
                          {values.name}
                        </p>
                      </div>
                    ) : (
                      <Field
                        id={`${uid}-name`}
                        label="Name"
                        value={values.name}
                        onChange={(value) => {
                          form.setFieldValue("name", value);
                        }}
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
                          value={values.url}
                          onChange={(value) => {
                            form.setFieldValue("url", value);
                          }}
                          placeholder="https://mcp.example.com"
                          type="text"
                          hint={null}
                        />

                        <RemoteAuthFields
                          uid={uid}
                          isEdit={isEdit}
                          remoteTransports={remoteTransports}
                          remoteTransportType={effectiveRemoteTransportType}
                          onRemoteTransportTypeChange={(value) => {
                            form.setFieldValue("remoteTransportType", value);
                          }}
                          authOptions={authOptions}
                          authType={values.authType}
                          onAuthTypeChange={(value) => {
                            form.setFieldValue("authType", value);
                          }}
                          headerRows={values.headerRows}
                          allowMultipleHeaders={allowMultipleHeaders}
                          onAddHeaderRow={addHeaderRow}
                          onRemoveHeaderRow={removeHeaderRow}
                          onChangeHeaderRow={updateHeaderRow}
                          envAuthVarName={values.envAuthVarName}
                          onEnvAuthVarNameChange={(value) => {
                            form.setFieldValue("envAuthVarName", value);
                          }}
                          oauthClientId={values.oauthClientId}
                          onOauthClientIdChange={(value) => {
                            form.setFieldValue("oauthClientId", value);
                          }}
                          oauthResource={values.oauthResource}
                          onOauthResourceChange={(value) => {
                            form.setFieldValue("oauthResource", value);
                          }}
                          oauthFields={oauthFields}
                        />
                      </>
                    ) : (
                      <>
                        <Field
                          id={`${uid}-command`}
                          label="Command"
                          value={values.command}
                          onChange={(value) => {
                            form.setFieldValue("command", value);
                          }}
                          placeholder="npx"
                          type="text"
                          hint={null}
                        />
                        <Field
                          id={`${uid}-args`}
                          label="Args"
                          value={values.argsText}
                          onChange={(value) => {
                            form.setFieldValue("argsText", value);
                          }}
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
                          rows={values.envRows}
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
                      type="submit"
                      disabled={mutate.isPending || (isEdit && isDefaultValue)}
                    >
                      {mutate.isPending ? <MutedAgentSpinner /> : null}
                      {submitLabel}
                    </Button>
                  </div>
                </>
              );
            }}
          </form.Subscribe>
        </form>
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
      {props.remoteTransports.length > 0 ? (
        <SegmentChipGroup label="Transport protocol">
          <SegmentChip
            label="HTTP"
            active={props.remoteTransportType === "http"}
            disabledReason={
              props.remoteTransports.includes("http")
                ? null
                : "Streamable HTTP isn’t supported by this provider."
            }
            onClick={() => {
              props.onRemoteTransportTypeChange("http");
            }}
          />
          <SegmentChip
            label="SSE"
            active={props.remoteTransportType === "sse"}
            disabledReason={
              props.remoteTransports.includes("sse")
                ? null
                : "SSE isn’t supported by this provider."
            }
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
  readonly disabledReason: string | null;
  readonly onClick: () => void;
}): ReactNode {
  let stateClass = "text-muted-foreground hover:text-foreground";
  if (props.active) stateClass = "bg-background text-foreground shadow-sm";
  if (props.disabledReason !== null) {
    stateClass = "cursor-not-allowed text-muted-foreground/50";
  }
  const button = (
    <button
      type="button"
      onClick={props.disabledReason === null ? props.onClick : undefined}
      aria-pressed={props.active}
      aria-disabled={props.disabledReason === null ? undefined : true}
      className={cn(
        "rounded px-2.5 py-1 text-ui-xs transition-colors",
        stateClass,
      )}
    >
      {props.label}
    </button>
  );
  if (props.disabledReason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{props.disabledReason}</TooltipContent>
    </Tooltip>
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
