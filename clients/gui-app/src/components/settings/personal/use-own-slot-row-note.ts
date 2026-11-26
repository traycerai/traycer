import { useCallback, useContext, useMemo, useRef } from "react";
import type { ContextType } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { QueryClient } from "@tanstack/react-query";
import {
  environmentOwnSlotPublishKindSchema,
  type EnvironmentOwnSlot,
  type EnvironmentOwnSlotChangeRequest,
  type EnvironmentOwnSlotChangeResponse,
} from "@traycer/protocol/host/environment-schemas";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  publishOwnSlot,
  type OwnSlotPublishBegin,
} from "@traycer-clients/shared/host-client/own-slot-publication";
import type { SettingsSaveOrigin } from "@/lib/environment/settings-save-origin";
import { captureSettingsSaveOrigin } from "@/lib/environment/settings-save-origin";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import type { OwnSlotAddress } from "@/components/settings/personal/own-slot-row-note";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import type { AddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
} from "@traycer-clients/shared/environment/environment-cloud";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { recordMcpPromoteIntentForHost } from "@/hooks/environment/record-mcp-promote-intent-for-host";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

const OWN_SLOTS = "environment.ownSlots";
const OWN_SLOT_CHANGE = "environment.ownSlots.change";
const OWN_SLOT_PUBLISH = "environment.ownSlots.publish";
const EMPTY_REQUEST = {};
const SAVE_FAILURE_MESSAGE = "Couldn't save these settings.";

export interface OwnSlotAddressMatch {
  readonly kind: EnvironmentOwnSlot["kind"];
  readonly key: string | null;
  readonly os: EnvironmentOwnSlot["os"] | undefined;
}

export interface OwnSlotHostBinding {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly enabled: boolean;
}

interface CapturedOwnSlotPress {
  readonly request: EnvironmentOwnSlotChangeRequest;
  readonly hostId: string | null;
  readonly origin: SettingsSaveOrigin | null;
  readonly expectedEnvironmentId: string | null;
}

interface OwnSlotPressRef {
  readonly current: WeakMap<
    EnvironmentOwnSlotChangeRequest,
    CapturedOwnSlotPress
  >;
}

interface OwnSlotRowNoteResult {
  readonly entries: readonly EnvironmentOwnSlot[];
  readonly entry: EnvironmentOwnSlot | null;
  readonly change: (
    address: OwnSlotAddress,
    action: "publish" | "usePersonal",
  ) => Promise<EnvironmentOwnSlotChangeResponse | undefined>;
  readonly changeCopy: (
    address: OwnSlotAddress,
    sourceSelector: string,
  ) => Promise<EnvironmentOwnSlotChangeResponse | undefined>;
  readonly disabled: boolean;
  readonly hostName: string;
}

/** Reads one exact slot from the Personal page's bound host and owns its write. */
export function useOwnSlotRowNote(
  target: OwnSlotAddressMatch,
  hostBinding: OwnSlotHostBinding | undefined,
): OwnSlotRowNoteResult {
  const page = useContext(PersonalPageContext);
  const binding = resolveOwnSlotHostBinding(page, hostBinding);
  const canRead = useHostSupportsMethod(binding.hostId, OWN_SLOTS);
  const canChange = useHostSupportsMethod(binding.hostId, OWN_SLOT_CHANGE);
  const supported = canRead && canChange;
  const canPublish = useHostSupportsMethod(binding.hostId, OWN_SLOT_PUBLISH);
  const query = useHostQuery<HostRpcRegistry, typeof OWN_SLOTS>({
    cacheKeyIdentity: undefined,
    client: binding.client,
    method: OWN_SLOTS,
    params: EMPTY_REQUEST,
    options: { enabled: binding.enabled && supported },
  });
  const cloud = useEnvironmentCloud();
  const queryClient = useQueryClient();
  const pressed = useRef(
    new WeakMap<EnvironmentOwnSlotChangeRequest, CapturedOwnSlotPress>(),
  );
  const entries = useMemo(
    () =>
      (query.data?.entries ?? []).map<EnvironmentOwnSlot>((entry) =>
        !canPublish &&
        entry.publishable &&
        environmentOwnSlotPublishKindSchema.safeParse(entry.kind).success
          ? { ...entry, publishable: false }
          : entry,
      ),
    [canPublish, query.data?.entries],
  );
  const matches = useMemo(
    () =>
      entries.filter(
        (entry) =>
          target.key !== null &&
          entry.kind === target.kind &&
          entry.key === target.key &&
          (target.os === undefined || entry.os === target.os),
      ),
    [entries, target.kind, target.key, target.os],
  );
  const entry = matches.length === 1 ? (matches[0] ?? null) : null;
  const addressedEnvironment = usePersonalEnvironment(
    binding.enabled &&
      supported &&
      needsOwnSlotPersonalEnvironment(target, entry, canPublish),
  );
  const mutation = useOwnSlotChangeMutation(
    binding.client,
    queryClient,
    pressed,
  );
  const changeWithSelector = useOwnSlotChange({
    binding,
    canChange: supported,
    addressedEnvironment,
    cloud,
    mutate: mutation.mutateAsync,
    pressed,
  });
  const { mutateAsync: publishItem, isPending: publishPending } =
    useOwnSlotPublicationMutation(queryClient);
  const change = useCallback(
    async (
      address: OwnSlotAddress,
      action: "publish" | "usePersonal",
    ): Promise<EnvironmentOwnSlotChangeResponse | undefined> => {
      const kind = environmentOwnSlotPublishKindSchema.safeParse(address.kind);
      if (action !== "publish" || !kind.success)
        return changeWithSelector(address, action, undefined);
      const { client, enabled, hostId } = binding;
      if (
        !enabled ||
        !supported ||
        !canPublish ||
        client === null ||
        hostId === null ||
        address.os !== "any"
      )
        return undefined;
      const { environmentId, resolved } = addressedEnvironment;
      const origin = captureSettingsSaveOrigin(cloud);
      if (
        !resolved ||
        environmentId === null ||
        origin.kind !== "sign_in_at_press"
      ) {
        toast.error(SAVE_FAILURE_MESSAGE);
        return { outcome: "forbidden" };
      }
      return publishItem({
        client,
        hostId,
        cloud: origin.operation,
        request: {
          phase: "begin",
          environmentId,
          kind: kind.data,
          key: address.key,
          os: address.os,
        },
      });
    },
    [
      addressedEnvironment,
      binding,
      canPublish,
      changeWithSelector,
      cloud,
      publishItem,
      supported,
    ],
  );
  const changeCopy = useCallback(
    (address: OwnSlotAddress, sourceSelector: string) =>
      changeWithSelector(address, "publish", sourceSelector),
    [changeWithSelector],
  );

  return {
    entries: binding.enabled && supported ? entries : [],
    entry: binding.enabled && supported ? entry : null,
    change,
    changeCopy,
    disabled: mutation.isPending || publishPending,
    hostName: binding.hostName,
  };
}

function needsOwnSlotPersonalEnvironment(
  target: OwnSlotAddressMatch,
  entry: EnvironmentOwnSlot | null,
  canPublish: boolean,
): boolean {
  return (
    target.kind === "mcp_server" ||
    (entry?.publishable === true &&
      canPublish &&
      environmentOwnSlotPublishKindSchema.safeParse(target.kind).success)
  );
}

function resolveOwnSlotHostBinding(
  page: ContextType<typeof PersonalPageContext>,
  override: OwnSlotHostBinding | undefined,
): OwnSlotHostBinding {
  const personalPage = page !== null && page.pick.kind === "personal";
  let hostId: string | null;
  let boundClient: HostClient<HostRpcRegistry> | null;
  if (override !== undefined) {
    hostId = override.hostId;
    boundClient = override.client;
  } else if (personalPage) {
    hostId = page.hostId;
    boundClient = page.client;
  } else {
    hostId = null;
    boundClient = null;
  }
  const client =
    boundClient !== null && boundClient.getActiveHostId() === hostId
      ? boundClient
      : null;
  const hostName = override?.hostName ?? page?.hostName ?? "this computer";
  return {
    client,
    hostId,
    hostName,
    enabled: override?.enabled ?? personalPage,
  };
}

interface OwnSlotPublicationPress {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly request: OwnSlotPublishBegin;
  readonly cloud: EnvironmentCloud;
}

function useOwnSlotPublicationMutation(queryClient: QueryClient) {
  return useMutation({
    mutationKey: environmentMutationKeys.ownSlotsChange(),
    retry: false,
    mutationFn: (press: OwnSlotPublicationPress) =>
      publishOwnSlot(press.client, press.hostId, press.request, press.cloud),
    onSettled: (answer, _error, { hostId, request }) => {
      if (answer?.outcome !== "saved") toast.error(SAVE_FAILURE_MESSAGE);
      void invalidateHostMethodScopes(
        queryClient,
        hostId,
        new Set([
          OWN_SLOTS,
          ...affectedNativeReads({
            kind: request.kind,
            key: request.key,
            os: request.os,
            action: "publish",
          }),
        ]),
      );
      invalidateConfigurationReads(queryClient, request.environmentId, [
        "environment.configuration.items",
        "environment.configuration.revision",
      ]);
    },
  });
}

function useOwnSlotChangeMutation(
  client: HostClient<HostRpcRegistry> | null,
  queryClient: QueryClient,
  pressed: OwnSlotPressRef,
) {
  return useHostScopedMutationForClient(client, {
    method: OWN_SLOT_CHANGE,
    mutationKey: environmentMutationKeys.ownSlotsChange(),
    errorMessage: null,
    invalidateMethods: [OWN_SLOTS],
    captureContext: (request) => pressed.current.get(request) ?? null,
    prepareRequest: (request, requestClient) =>
      prepareOwnSlotChangeRequest(request, requestClient, pressed.current),
    onSettled: (sentOn, capture) => {
      if (sentOn === null || capture === null) return;
      void refreshOwnSlotReads({
        request: capture.request,
        sentOn,
        capture,
        queryClient,
      });
    },
  });
}

interface OwnSlotChangeOptions {
  readonly binding: OwnSlotHostBinding;
  readonly canChange: boolean;
  readonly addressedEnvironment: AddressedEnvironment;
  readonly cloud: EnvironmentCloudSource | null;
  readonly mutate: (
    request: EnvironmentOwnSlotChangeRequest,
  ) => Promise<EnvironmentOwnSlotChangeResponse>;
  readonly pressed: OwnSlotPressRef;
}

function useOwnSlotChange(options: OwnSlotChangeOptions) {
  const { binding, canChange, addressedEnvironment, cloud, mutate, pressed } =
    options;
  return useCallback(
    async (
      address: OwnSlotAddress,
      action: "publish" | "usePersonal",
      sourceSelector: string | undefined,
    ): Promise<EnvironmentOwnSlotChangeResponse | undefined> => {
      if (!binding.enabled || !canChange || binding.client === null)
        return undefined;
      const request = createOwnSlotChangeRequest(
        address,
        action,
        sourceSelector,
      );
      if (request === null) return undefined;
      pressed.current.set(request, {
        request,
        hostId: binding.hostId,
        origin: shouldRecordMcpIntent(request)
          ? captureSettingsSaveOrigin(cloud)
          : null,
        expectedEnvironmentId: addressedEnvironment.resolved
          ? addressedEnvironment.environmentId
          : null,
      });
      try {
        return await mutate(request);
      } catch {
        return undefined;
      }
    },
    [addressedEnvironment, binding, canChange, cloud, mutate, pressed],
  );
}

function createOwnSlotChangeRequest(
  address: OwnSlotAddress,
  action: "publish" | "usePersonal",
  sourceSelector: string | undefined,
): EnvironmentOwnSlotChangeRequest | null {
  if (action === "usePersonal") return { ...address, action };
  const { kind, key, os } = address;
  if (kind !== "mcp_server") return { kind, key, os, action };
  if (os !== "any") return null;
  const publish = {
    kind,
    key,
    os,
    action,
    intentOperationId: crypto.randomUUID(),
  } as const;
  return sourceSelector === undefined
    ? publish
    : { ...publish, sourceSelector };
}

function shouldRecordMcpIntent(
  request: EnvironmentOwnSlotChangeRequest,
): request is Extract<
  EnvironmentOwnSlotChangeRequest,
  { kind: "mcp_server" }
> & {
  action: "publish";
} {
  return request.kind === "mcp_server" && request.action === "publish";
}

async function prepareOwnSlotChangeRequest(
  request: EnvironmentOwnSlotChangeRequest,
  requestClient: HostRequester<HostRpcRegistry>,
  pressed: WeakMap<EnvironmentOwnSlotChangeRequest, CapturedOwnSlotPress>,
): Promise<EnvironmentOwnSlotChangeRequest> {
  const capture = pressed.get(request);
  if (
    capture === undefined ||
    capture.hostId === null ||
    requestClient.getActiveHostId() !== capture.hostId
  ) {
    throw new Error(SAVE_FAILURE_MESSAGE);
  }
  if (!shouldRecordMcpIntent(request)) return request;
  const origin = capture.origin;
  if (
    origin?.kind !== "sign_in_at_press" ||
    capture.expectedEnvironmentId === null
  ) {
    throw new Error(SAVE_FAILURE_MESSAGE);
  }
  const acceptedEnvironmentId = await recordMcpPromoteIntentForHost(
    requestClient,
    origin.operation,
    {
      hostId: capture.hostId,
      expectedEnvironmentId: capture.expectedEnvironmentId,
      operationId: request.intentOperationId,
      serverName: request.key,
      sourceSelector:
        "sourceSelector" in request ? request.sourceSelector : undefined,
    },
  );
  if (
    acceptedEnvironmentId !== capture.expectedEnvironmentId ||
    requestClient.getActiveHostId() !== capture.hostId ||
    !origin.operation.onOriginSignIn()
  ) {
    throw new Error(SAVE_FAILURE_MESSAGE);
  }
  return request;
}

async function refreshOwnSlotReads(args: {
  readonly request: EnvironmentOwnSlotChangeRequest;
  readonly sentOn: string | null;
  readonly capture: CapturedOwnSlotPress | null;
  readonly queryClient: QueryClient;
}): Promise<void> {
  const { request, sentOn, capture, queryClient } = args;
  if (sentOn === null || capture?.hostId !== sentOn) return;
  const methods = new Set<keyof HostRpcRegistry & string>(
    affectedNativeReads(request),
  );
  if (request.kind === "variable" || request.kind === "env_override") {
    methods.add("environment.localOverrides");
  }
  await invalidateHostMethodScopes(queryClient, sentOn, methods);
  if (
    shouldRecordMcpIntent(request) &&
    capture.expectedEnvironmentId !== null
  ) {
    invalidateConfigurationReads(queryClient, capture.expectedEnvironmentId, [
      "environment.configuration.mcpServers.list",
      "environment.configuration.items",
    ]);
  }
}

async function invalidateHostMethodScopes(
  queryClient: QueryClient,
  hostId: string,
  methods: ReadonlySet<keyof HostRpcRegistry & string>,
): Promise<void> {
  await Promise.all(
    [...methods].map((method) =>
      queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, method),
      }),
    ),
  );
}

function affectedNativeReads(
  request: EnvironmentOwnSlotChangeRequest,
): readonly (keyof HostRpcRegistry & string)[] {
  switch (request.kind) {
    case "variable":
      return ["config.env.list"];
    case "env_override":
      return ["providers.list"];
    case "shell":
      return ["config.shell.get"];
    case "browser_agent_access":
      return ["config.browser.get"];
    case "agent_selection_guide":
      return ["agent.selectionGuide.getGlobal"];
    case "agent_definition":
      return ["environment.agentDefinitions.list"];
    case "mcp_server":
      return ["providers.list", "environment.status"];
    case "fallback_policy":
      return ["providers.fallbackPolicy.get"];
    case "pack_policy":
    case "managed_profile":
      return ["providers.list"];
  }
}
