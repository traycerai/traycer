import { useEffect, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorkspacePathRejectionReason,
  WorkspacePrepareFoldersResponseV11,
  WorkspaceRecentEntry,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useRemoteWorkspacePathPickerStore } from "@/lib/host/remote-workspace-path-picker";

/**
 * Renders the remote "open workspace" path-entry dialog (Journey 3, T14): a
 * remote host's folders can't be reached by a native OS picker, so the client
 * enters/pastes a path, backed by the `getHomeDir` / `listRecentWorkspaces` /
 * `recordRecentWorkspace` operations of `workspace.prepareFolders` v1.1
 * (re-homed from standalone method names by T18 - see the RPC backward-compat
 * decision log).
 *
 * Against a v1.0 host these operations fail closed at the transport layer
 * with `HostRpcError(code: "DOWNGRADE_UNSUPPORTED")` (the request can't
 * project onto the older schema — `ws-rpc-client.ts`'s `prepareRequestPayload`)
 * rather than breaking the handshake. `isDowngradeUnsupportedError()` below
 * turns that into an explicit, proactive gate: `homeDirQuery` /
 * `recentQuery` fire on mount and double as the version probe (all 4
 * operations share one wire method+version, so either erroring this way is
 * conclusive), so the body shows "this host needs updating" and disables the
 * path input *before* the user can attempt a doomed submit — never the
 * generic (and misleading) "couldn't reach the host" reachability copy.
 *
 * Mount once near the app root (alongside `<OpenFolderDialog />`) — it stays
 * invisible until `openRemoteWorkspacePathPicker(client)` sets a pending
 * request on `useRemoteWorkspacePathPickerStore`.
 */
export function RemoteWorkspacePathPickerHost() {
  const request = useRemoteWorkspacePathPickerStore((s) => s.request);
  const settle = useRemoteWorkspacePathPickerStore((s) => s.settle);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle([]);
      }}
    >
      <DialogContent
        className="w-[min(92vw,30rem)]"
        data-testid="remote-workspace-path-dialog"
      >
        <DialogHeader>
          <DialogTitle>Open a workspace</DialogTitle>
          <DialogDescription>
            Enter the path to a folder on this host.
          </DialogDescription>
        </DialogHeader>
        {request === null ? null : (
          <RemoteWorkspacePathPickerBody
            client={request.client}
            onOpen={(path) => settle([path])}
            onCancel={() => settle([])}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface RemoteWorkspacePathPickerBodyProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly onOpen: (resolvedPath: string) => void;
  readonly onCancel: () => void;
}

function RemoteWorkspacePathPickerBody(
  props: RemoteWorkspacePathPickerBodyProps,
) {
  const { client, onOpen, onCancel } = props;
  const [path, setPath] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const homeDirQuery = useHostQuery<
    HostRpcRegistry,
    "workspace.prepareFolders"
  >({
    client,
    method: "workspace.prepareFolders",
    params: { operation: "getHomeDir", folderPaths: null, path: null },
    cacheKeyIdentity: undefined,
    options: {},
  });
  const recentQuery = useHostQuery<HostRpcRegistry, "workspace.prepareFolders">(
    {
      client,
      method: "workspace.prepareFolders",
      params: {
        operation: "listRecentWorkspaces",
        folderPaths: null,
        path: null,
      },
      cacheKeyIdentity: undefined,
      options: {},
    },
  );
  const openMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    unknown,
    string
  >({
    client,
    method: "workspace.prepareFolders",
    mapVariables: (candidatePath) => ({
      operation: "recordRecentWorkspace",
      folderPaths: null,
      path: candidatePath,
    }),
    options: {},
  });

  const hostTooOld =
    isDowngradeUnsupportedError(homeDirQuery.error) ||
    isDowngradeUnsupportedError(recentQuery.error);

  const submit = (): void => {
    if (path.trim().length === 0 || openMutation.isPending || hostTooOld) {
      return;
    }
    setRejection(null);
    openMutation.mutate(path, {
      onSuccess: (result: WorkspacePrepareFoldersResponseV11) => {
        if (result.validation === null) {
          setRejection("Couldn't reach the host to open this path.");
          return;
        }
        if (result.validation.ok) {
          onOpen(result.validation.resolvedPath);
          return;
        }
        setRejection(rejectionMessage(result.validation.reason));
      },
      onError: (error) => {
        setRejection(
          isDowngradeUnsupportedError(error)
            ? OUTDATED_HOST_MESSAGE
            : "Couldn't reach the host to open this path.",
        );
      },
    });
  };

  const recentEntries: readonly WorkspaceRecentEntry[] =
    recentQuery.data?.recentWorkspaces ?? [];
  const homeDir: string | null = homeDirQuery.data?.homeDir ?? null;
  const errorMessage = hostTooOld ? OUTDATED_HOST_MESSAGE : rejection;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label
          className="text-ui-xs text-muted-foreground"
          htmlFor="remote-workspace-path-input"
        >
          Path on the host
        </label>
        <Input
          ref={inputRef}
          id="remote-workspace-path-input"
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            setRejection(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="/home/you/projects/api"
          disabled={hostTooOld}
          data-testid="remote-workspace-path-input"
        />
        {errorMessage === null ? null : (
          <p
            className="text-ui-xs text-destructive"
            data-testid="remote-workspace-path-error"
          >
            {errorMessage}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {homeDir === null ? null : (
          <PathChip label="~ home" onClick={() => setPath(homeDir)} />
        )}
        {recentEntries.map((entry) => (
          <PathChip
            key={entry.path}
            label={entry.path}
            onClick={() => setPath(entry.path)}
          />
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={
            path.trim().length === 0 || openMutation.isPending || hostTooOld
          }
        >
          Open
          {openMutation.isPending ? (
            <AgentSpinningDots
              testId={undefined}
              variant="orbit"
              className="text-primary-foreground"
            />
          ) : null}
        </Button>
      </DialogFooter>
    </div>
  );
}

const OUTDATED_HOST_MESSAGE =
  "This host needs updating to open workspaces remotely.";

/**
 * `workspace.prepareFolders`'s 4 remote-picker operations fail closed with
 * this code (not the generic `RPC_ERROR` a real transport/network failure
 * uses) when the connected host is on v1.0 and the request can't project
 * onto its older schema (`ws-rpc-client.ts`'s `prepareRequestPayload`) — the
 * signal this component treats as "the host is too old," distinct from
 * "the host is unreachable."
 */
function isDowngradeUnsupportedError(error: HostRpcError | null): boolean {
  return error !== null && error.code === "DOWNGRADE_UNSUPPORTED";
}

function PathChip(props: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto max-w-full truncate border-border/70 bg-background/60 px-2 py-0.5 text-muted-foreground hover:text-foreground"
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  );
}

function rejectionMessage(reason: WorkspacePathRejectionReason): string {
  switch (reason) {
    case "NOT_ABSOLUTE":
      return "Enter an absolute path (starting with /).";
    case "NOT_FOUND":
      return "That path doesn't exist on the host.";
    case "NOT_A_DIRECTORY":
      return "That path is a file, not a folder.";
    case "NO_PERMISSION":
      return "The host can't read that path.";
    default:
      return "That path isn't valid.";
  }
}
