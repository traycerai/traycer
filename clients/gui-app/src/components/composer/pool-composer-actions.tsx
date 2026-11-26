import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus } from "lucide-react";
import { toast } from "sonner";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  type SandboxCatalogue,
  type SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMakeActiveHost } from "@/components/settings/host-scope/use-host-scope";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxDefaultsLookup } from "@/hooks/sandboxes/use-sandbox-defaults";
import { useTeamBundleBalances } from "@/hooks/sandboxes/use-team-bundle-balances";
import { teamEnvironmentQueryOptions } from "@/hooks/sandboxes/use-team-environment-query";
import { sandboxCreateFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useEpicAttachEnvironment } from "@/hooks/epic/use-epic-attach-environment-mutation";
import { authQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";
import { sandboxStateAllowsPoolActions } from "@/lib/sandboxes/chat-sandbox-state";
import {
  stageConfigurationCopy,
  stageProviderFor,
  type StageConfiguration,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  COULDNT_VERIFY_BALANCE,
  SANDBOXES_UNAVAILABLE,
  sandboxCreditShortLine,
  sandboxShapeLabel,
  shapeNotOfferedLine,
} from "@/lib/sandboxes/sandbox-strings";
import { createFailure } from "@/lib/sandboxes/staged-sandbox-run";
import { stagedSandboxName } from "@/lib/sandboxes/staged-sandbox-name";
import { finishPoolSandboxStart } from "@/lib/sandboxes/pool-sandbox-start";
import { toastWakeFailed } from "@/lib/sandboxes/sandbox-wake";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HandoffOwnerWatch } from "@/stores/composer/staged-sandbox-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import {
  newRowFacts,
  newRowPresentation,
  type NewRowFacts,
} from "@/components/composer/new-sandbox-rows";

interface PoolComposerActionsProps {
  readonly epicId: string | null;
  readonly surfaceKey: string;
  readonly place: (hostId: string) => void;
  readonly watchPlacement: HandoffOwnerWatch | null;
  readonly originatingChatHostId?: string;
  /** Release a caller-named placement only when this gesture can act. */
  readonly releaseNamedHost?: () => boolean;
}

type PoolSandboxAuth = HostRuntimeBinding<HostRpcRegistry>["auth"];

function chatCreateAllowed(
  hostId: string | undefined,
  queryClient: QueryClient,
  auth: PoolSandboxAuth,
): boolean {
  if (hostId === undefined) return true;
  // The list can publish before React commits the new composer slot.
  const userId = useAuthStore.getState().contextMetadata?.userId ?? null;
  const sandbox = queryClient
    .getQueryData<SandboxListResponse>(sandboxQueryKeys.list(auth, userId))
    ?.sandboxes.find((row) => row.hostId === hostId);
  return sandboxStateAllowsPoolActions(sandbox?.state);
}

interface SandboxFlight {
  readonly isCurrent: () => boolean;
}

// An accepted start can outlive its composer. Only the run that took this
// slot can release it, and a sign-in change leaves the next account free.
const flights = new WeakMap<PoolSandboxAuth, Map<string, SandboxFlight>>();
const flightListeners = new Set<() => void>();

function subscribeFlights(onChange: () => void): () => void {
  flightListeners.add(onChange);
  const unsubscribeAuth = useAuthStore.subscribe(onChange);
  return () => {
    flightListeners.delete(onChange);
    unsubscribeAuth();
  };
}

function notifyFlights(): void {
  for (const listener of flightListeners) listener();
}

function claimSandboxFlight(
  auth: PoolSandboxAuth,
  surfaceKey: string,
  current: () => boolean,
  releaseNamedHost: (() => boolean) | undefined,
): (() => void) | null {
  if (!current()) return null;
  const active = flights.get(auth) ?? new Map<string, SandboxFlight>();
  if (active.get(surfaceKey)?.isCurrent()) return null;
  if (releaseNamedHost?.() === false) return null;
  const flight = { isCurrent: current };
  flights.set(auth, active);
  active.set(surfaceKey, flight);
  notifyFlights();
  return () => {
    if (active.get(surfaceKey) !== flight) return;
    active.delete(surfaceKey);
    notifyFlights();
  };
}

function watchTeamPlacement(
  personal: boolean,
  place: (hostId: string) => void,
  watch: HandoffOwnerWatch | null,
) {
  if (personal || watch === null) return { place, stop: null };
  let current = true;
  const stop = watch(() => {
    current = false;
  });
  return {
    place: (hostId: string) => {
      if (current) place(hostId);
    },
    stop,
  };
}

export function PoolComposerActions(
  props: PoolComposerActionsProps,
): ReactNode {
  const binding = useHostBinding();
  const { openSettings } = useSystemTabModalActions();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {binding !== null &&
      binding.auth.sandboxControlUnavailableReason() === null ? (
        <StartSandbox {...props} binding={binding} />
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (props.releaseNamedHost?.() === false) return;
          const knownHostIds = binding?.directory.knownHostIds() ?? [];
          useAddHostDialogStore.getState().openDialog(knownHostIds);
          openSettings({
            section: null,
            resetToGeneral: false,
            tab: null,
            draft: null,
            hostId: null,
          });
        }}
      >
        Connect a computer
      </Button>
    </div>
  );
}

function StartSandbox(
  props: PoolComposerActionsProps & {
    readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  },
): ReactNode {
  const {
    binding,
    epicId,
    originatingChatHostId,
    releaseNamedHost,
    place,
    surfaceKey,
    watchPlacement,
  } = props;
  const { auth, directory } = binding;
  const queryClient = useQueryClient();
  const user = useAuthUser().data ?? null;
  const teamBalanceMc = useTeamBundleBalances();
  const catalogue = useSandboxCatalogue(true).data ?? null;
  const defaults = useSandboxDefaultsLookup(true);
  const attach = useEpicAttachEnvironment(null, "pool-sandbox");
  const { makeActiveWithWakeNotice } = useMakeActiveHost([]);
  const openTransport = useDurableStreamTransportFactory();
  const pending = useSyncExternalStore(
    subscribeFlights,
    () => flights.get(auth)?.get(surfaceKey)?.isCurrent() === true,
  );
  const rows = newRowFacts({ user, teamBalanceMc, catalogue, defaults });
  const personal = rows[0];
  if (catalogue === null || personal.shape === null) return null;

  const teamEnvironmentForCreate = async (
    teamId: string,
    operation: EnvironmentCloud,
  ): Promise<string | undefined> => {
    if (epicId !== null) {
      const attached = await attach
        .mutateAsync({ epicId, teamId, operation })
        .catch(() => null);
      return attached !== null && "environmentId" in attached
        ? attached.environmentId
        : undefined;
    }
    const userId = useAuthStore.getState().profile?.userId ?? null;
    const environment = await queryClient
      .fetchQuery(teamEnvironmentQueryOptions(auth, userId, teamId, true))
      .catch(() => null);
    if (!operation.onOriginSignIn()) return undefined;
    if (environment?.kind === "ok") return environment.environmentId;
    toast.error("Couldn't complete the sandbox action.");
    return undefined;
  };

  const start = async (row: NewRowFacts): Promise<void> => {
    const { configuration, shape } = row;
    if (shape === null) return;
    const operation = auth.environmentCloud();
    const current = operation.onOriginSignIn;
    const release = claimSandboxFlight(
      auth,
      surfaceKey,
      current,
      releaseNamedHost,
    );
    if (release === null) return;
    const personal = configuration.kind === "personal";
    const placePersonal = releaseNamedHost !== undefined;
    const placement = watchTeamPlacement(
      personal && !placePersonal,
      place,
      watchPlacement,
    );
    try {
      const environmentId =
        configuration.kind === "team"
          ? await teamEnvironmentForCreate(configuration.teamId, operation)
          : null;
      if (environmentId === undefined) return;
      if (!current()) return;
      if (!chatCreateAllowed(originatingChatHostId, queryClient, auth)) return;
      const result = await auth
        .createSandbox({
          ...shape,
          displayName: stagedSandboxName(""),
          burst: false,
          destroyAfterRestingMinutes: shape.destroyAfterRestingMinutes ?? 0,
          createdByHostId: null,
          createdByAgentId: null,
          createdByTaskId: null,
          clientRequestId: null,
          environmentId,
        })
        .catch((): SandboxCreateFetchResult => ({
          kind: "network-error",
          detail: "",
        }));
      if (!current()) return;

      const finishing =
        result.kind === "ok"
          ? finishPoolSandboxStart({
              accepted: result.accepted,
              current,
              directory,
              personal,
              placePersonal,
              activate: makeActiveWithWakeNotice,
              openTransport,
              place: placement.place,
            })
          : null;
      refreshSandboxCreateLists(queryClient, directory, result);
      if (result.kind === "ok") {
        await finishing;
      } else {
        toast.error(
          createFailureLine(result, { configuration, shape }, catalogue),
        );
      }
    } catch {
      if (current()) toastWakeFailed();
    } finally {
      placement.stop?.();
      release();
    }
  };

  return (
    <div className="inline-flex">
      <Button
        type="button"
        className="rounded-r-none"
        disabled={pending}
        onClick={() => void start(personal)}
      >
        Start a sandbox
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            className="rounded-l-none"
            aria-label="Host: none selected"
            disabled={pending}
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-max min-w-0 max-w-[var(--radix-dropdown-menu-content-available-width)]"
        >
          {rows.map((row) => {
            const presentation = newRowPresentation(row, null);
            return (
              <DropdownMenuItem
                key={presentation.configurationKey}
                disabled={presentation.disabled}
                onSelect={() => void start(row)}
              >
                <Plus aria-hidden />
                <span className="flex min-w-0 flex-col whitespace-normal">
                  <span>{presentation.label}</span>
                  <span className="text-ui-xs text-muted-foreground">
                    {presentation.subLine}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function refreshSandboxCreateLists(
  queryClient: QueryClient,
  directory: HostDirectoryService,
  result: SandboxCreateFetchResult,
): void {
  void directory.refresh();
  void queryClient.invalidateQueries({
    queryKey: authQueryKeys.registeredHostsAll(),
  });
  if (
    result.kind === "refused" &&
    result.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND
  ) {
    void queryClient.invalidateQueries({
      queryKey: sandboxQueryKeys.teamEnvironmentAll(),
    });
  }
}

function createFailureLine(
  result: Exclude<SandboxCreateFetchResult, { readonly kind: "ok" }>,
  row: {
    readonly configuration: StageConfiguration;
    readonly shape: StageShape;
  },
  catalogue: SandboxCatalogue,
): string {
  const { configuration, shape } = row;
  const teamName =
    configuration.kind === "team" ? configuration.teamName : null;
  const failure = createFailure(result, teamName);
  switch (failure.kind) {
    case "unverified":
      return COULDNT_VERIFY_BALANCE;
    case "credits":
      return sandboxCreditShortLine(
        stageConfigurationCopy(configuration),
        failure.creditSource ?? null,
        failure.shortfallMc,
        { waking: false, context: "sentence" },
      );
    case "shape": {
      const region = stageProviderFor(catalogue, shape.os)?.regions.find(
        (candidate) => candidate.id === shape.region,
      );
      return shapeNotOfferedLine(
        region?.label ?? "",
        sandboxShapeLabel(shape.cpus, shape.memoryMb),
      );
    }
    case "unavailable":
      return SANDBOXES_UNAVAILABLE;
    case "refused":
      return failure.message;
    default:
      return sandboxCreateFailureMessage(result, teamName);
  }
}
