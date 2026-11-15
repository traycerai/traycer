import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  providersSetEnabledResponseSchema,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import type { RemovedProviderProfile } from "@/components/providers/provider-profile-model";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";

/** The `providers.list` envelope a test's fake computer returns. */
export interface ProfileListAnswer {
  providers: ProviderCliState[];
  native: null;
  removedProfiles: RemovedProviderProfile[];
}

type AnswerProfileNameRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.answerProfileName"
>;
type AnswerProfileNameResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.answerProfileName"
>;
type SetEnabledRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;

export interface ProfileListHost {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly answer: ProfileListAnswer;
  readonly listCalls: unknown[];
  readonly answerNameCalls: AnswerProfileNameRequest[];
  readonly setEnabledCalls: SetEnabledRequest[];
  readonly rpcCalls: MockHostMessenger<HostRpcRegistry>["calls"];
  readonly exposeEnvironmentBinding: () => void;
  readonly setOffersSignIns: (value: boolean | undefined) => void;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

/** A fake host whose `providers.list` returns the current answer on every read. */
export function createProfileListHost(input: {
  readonly answer: ProfileListAnswer;
  readonly answerProfileName: (
    request: AnswerProfileNameRequest,
  ) => AnswerProfileNameResponse;
  readonly failSetEnabled: boolean;
  /** When set, the list row after an answer uses this label, not the answer's. */
  readonly listLabelAfterAnswer?: string;
}): ProfileListHost {
  const queryClient = createAppQueryClient();
  const listCalls: unknown[] = [];
  const answerNameCalls: AnswerProfileNameRequest[] = [];
  const setEnabledCalls: SetEnabledRequest[] = [];
  let offersSignIns: boolean | undefined;
  const handlers = {
    "providers.list": (
      params: RequestOfMethod<HostRpcRegistry, "providers.list">,
    ) => {
      listCalls.push(params);
      return {
        providers: input.answer.providers,
        native: null,
        removedProfiles: input.answer.removedProfiles,
        ...(offersSignIns === undefined ? {} : { offersSignIns }),
      };
    },
    "providers.answerProfileName": (params: AnswerProfileNameRequest) => {
      answerNameCalls.push(params);
      const response = input.answerProfileName(params);
      const listedLabel =
        input.listLabelAfterAnswer === undefined
          ? response.label
          : input.listLabelAfterAnswer;
      input.answer.providers = input.answer.providers.map((provider) =>
        provider.providerId !== params.providerId
          ? provider
          : {
              ...provider,
              profiles: provider.profiles.map((profile) =>
                profile.profileId === params.profileId
                  ? { ...profile, label: listedLabel, otherNames: [] }
                  : profile,
              ),
            },
      );
      return response;
    },
    "providers.setEnabled": (params: SetEnabledRequest) => {
      setEnabledCalls.push(params);
      if (input.failSetEnabled) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "The rename did not finish.",
          requestId: "req-1",
          method: "providers.setEnabled",
          fatalDetails: null,
        });
      }
      const action = params.profileAction;
      if (action !== null && action.type === "rename") {
        input.answer.providers = input.answer.providers.map((provider) =>
          provider.providerId !== params.providerId
            ? provider
            : {
                ...provider,
                profiles: provider.profiles.map((profile) =>
                  profile.profileId === action.profileId
                    ? { ...profile, label: action.label }
                    : profile,
                ),
              },
        );
      }
      if (action !== null && action.type === "recolor") {
        input.answer.providers = input.answer.providers.map((provider) =>
          provider.providerId !== params.providerId
            ? provider
            : {
                ...provider,
                profiles: provider.profiles.map((profile) =>
                  profile.profileId === action.profileId
                    ? { ...profile, accentColor: action.accentColor }
                    : profile,
                ),
              },
        );
      }
      return setEnabledEcho(params.providerId);
    },
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers,
  });
  function exposeEnvironmentBinding(): void {
    messenger.setHandlers({
      ...handlers,
      "environment.status": () => ({
        principal: { kind: "team", teamName: "Test team" },
        reachability: "connected",
        bindingGeneration: null,
        desiredRevision: null,
        receivedRevision: null,
        appliedRevision: null,
        receiptAgeMs: null,
        items: [],
        pendingUploads: [],
        setup: null,
        remoteAccess: "off",
      }),
      "environment.host.read": () => ({
        hostId: mockLocalHostEntry.hostId,
        environment: {
          environmentId: "environment-profile-fixture",
          ownerKind: "organization",
          ownerId: "team-profile-fixture",
          roomId: "room-profile-fixture",
          label: "Test team",
        },
        explicit: true,
        enrolledByUserId: "user-profile-fixture",
        canUnbind: false,
      }),
    });
  }
  function setOffersSignIns(value: boolean | undefined): void {
    offersSignIns = value;
  }
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);

  function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  return {
    client,
    hostId: mockLocalHostEntry.hostId,
    answer: input.answer,
    listCalls,
    answerNameCalls,
    setEnabledCalls,
    rpcCalls: messenger.calls,
    exposeEnvironmentBinding,
    setOffersSignIns,
    Wrapper,
  };
}

/** Readiness for a requester that already names its computer. */
export function readinessFor(client: object | null): {
  readonly hostId: string | null;
  readonly requestContextUserId: string | null;
  readonly isReady: boolean;
  readonly hasRpcEndpoint: boolean;
  readonly canExecute: boolean;
} {
  const hostId = hostIdOf(client);
  return {
    hostId,
    requestContextUserId: hostId === null ? null : "person-1",
    isReady: hostId !== null,
    hasRpcEndpoint: hostId !== null,
    canExecute: hostId !== null,
  };
}

function setEnabledEcho(
  providerId: SetEnabledRequest["providerId"],
): ResponseOfMethod<HostRpcRegistry, "providers.setEnabled"> {
  return providersSetEnabledResponseSchema.parse({
    state: {
      providerId,
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled" },
      candidates: [],
      auth: {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      authPending: false,
      checkedAt: null,
      apiKey: { supported: false, configured: false, source: null },
      terminalAgentArgs: "",
      envOverrides: [],
      loginCapability: null,
      availabilityPending: false,
      profiles: [],
    },
  });
}

interface ActiveHostReader {
  getActiveHostId(): string | null;
}

function hostIdOf(client: object | null): string | null {
  if (!isActiveHostReader(client)) return null;
  const id = client.getActiveHostId();
  return typeof id === "string" ? id : null;
}

function isActiveHostReader(client: object | null): client is ActiveHostReader {
  if (client === null || !("getActiveHostId" in client)) return false;
  return typeof client.getActiveHostId === "function";
}
