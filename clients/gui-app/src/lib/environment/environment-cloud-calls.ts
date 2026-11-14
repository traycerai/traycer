import {
  EnvironmentCloudError,
  type EnvironmentCloud,
  type EnvironmentErrorKind,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  deleteConfigurationItem,
  deleteConfigurationMcpServer,
  listConfigurationMcpServers,
  listConfigurationPlans,
  putConfigurationItem,
  putConfigurationPolicy,
  readConfigurationItems,
  readConfigurationRevision,
  setConfigurationMcpServerEnabled,
  unlinkConfigurationPlan,
} from "@traycer-clients/shared/environment/configuration-settings";
import { listConfigurationHosts } from "@traycer-clients/shared/environment/configuration-hosts";
import {
  inviteConfigurationMember,
  readConfigurationSeats,
  recordConfigurationNoticeSeen,
  removeConfigurationMember,
  setConfigurationMemberRole,
} from "@traycer-clients/shared/environment/configuration-members";
import {
  consentToSecret,
  createSecret,
  destroySecretVersion,
  listSecrets,
  readSecretRotation,
  readSecretVersions,
  replaceSecretValue,
  undoSecretVersion,
  verifySecret,
} from "@traycer-clients/shared/environment/configuration-secrets";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The host methods whose reads and writes the app now makes itself, on the
 * person's sign-in, through authn's environment routes. Each answers the
 * protocol's response for that method, so a screen keeps its data contract.
 */
export type EnvironmentCloudMethod =
  | "environment.configuration.revision"
  | "environment.configuration.items"
  | "environment.configuration.items.put"
  | "environment.configuration.items.delete"
  | "environment.configuration.mcpServers.list"
  | "environment.configuration.mcpServers.delete"
  | "environment.configuration.mcpServers.setEnabled"
  | "environment.configuration.policy.put"
  | "environment.host.list"
  | "environment.members.seats"
  | "environment.members.invite"
  | "environment.members.setRole"
  | "environment.members.remove"
  | "environment.members.noticeSeen"
  | "environment.plans.list"
  | "environment.plans.unlink"
  | "environment.secrets.list"
  | "environment.secrets.create"
  | "environment.secrets.verify"
  | "environment.secrets.replaceValue"
  | "environment.secrets.versions"
  | "environment.secrets.undo"
  | "environment.secrets.destroy"
  | "environment.secrets.rotation"
  | "environment.secrets.consent";

type EnvironmentCloudCall<Method extends EnvironmentCloudMethod> = (
  cloud: EnvironmentCloud,
  request: RequestOfMethod<HostRpcRegistry, Method>,
) => Promise<ResponseOfMethod<HostRpcRegistry, Method>>;

/**
 * A secrets request names its environment for the app to send it to authn. A
 * null one means "the environment this computer runs", which only a host
 * knows, so such a request stays a host call and never reaches here.
 */
function namedEnvironment(environmentId: string | null): string {
  if (environmentId === null) {
    throw new EnvironmentCloudError(
      "invalid",
      "The settings request was refused.",
    );
  }
  return environmentId;
}

const CALLS: {
  readonly [Method in EnvironmentCloudMethod]: EnvironmentCloudCall<Method>;
} = {
  "environment.configuration.revision": (cloud, request) =>
    readConfigurationRevision(cloud, request.environmentId),
  "environment.configuration.items": (cloud, request) =>
    readConfigurationItems(cloud, request.environmentId),
  "environment.configuration.items.put": putConfigurationItem,
  "environment.configuration.items.delete": deleteConfigurationItem,
  "environment.configuration.mcpServers.list": (cloud, request) =>
    listConfigurationMcpServers(cloud, request.environmentId),
  "environment.configuration.mcpServers.delete": deleteConfigurationMcpServer,
  "environment.configuration.mcpServers.setEnabled":
    setConfigurationMcpServerEnabled,
  "environment.configuration.policy.put": putConfigurationPolicy,
  "environment.host.list": (cloud, request) =>
    listConfigurationHosts(cloud, request.environmentId),
  "environment.members.seats": (cloud, request) =>
    readConfigurationSeats(cloud, request.environmentId),
  "environment.members.invite": inviteConfigurationMember,
  "environment.members.setRole": setConfigurationMemberRole,
  "environment.members.remove": removeConfigurationMember,
  "environment.members.noticeSeen": (cloud, request) =>
    recordConfigurationNoticeSeen(cloud, request.environmentId),
  "environment.plans.list": (cloud, request) =>
    listConfigurationPlans(cloud, request.environmentId),
  "environment.plans.unlink": (cloud, request) =>
    unlinkConfigurationPlan(
      cloud,
      request.environmentId,
      request.profileId,
      request.expectedBindingVersion,
    ),
  "environment.secrets.list": (cloud, request) =>
    listSecrets(cloud, namedEnvironment(request.environmentId)),
  "environment.secrets.create": (cloud, request) =>
    createSecret(cloud, namedEnvironment(request.environmentId), request),
  "environment.secrets.verify": (cloud, request) =>
    verifySecret(cloud, namedEnvironment(request.environmentId), request),
  "environment.secrets.replaceValue": (cloud, request) =>
    replaceSecretValue(cloud, namedEnvironment(request.environmentId), request),
  "environment.secrets.versions": (cloud, request) =>
    readSecretVersions(cloud, namedEnvironment(request.environmentId), request),
  "environment.secrets.undo": (cloud, request) =>
    undoSecretVersion(cloud, namedEnvironment(request.environmentId), request),
  // The latest version may remove a secret's current version, as the host
  // allows on @1.1.
  "environment.secrets.destroy": (cloud, request) =>
    destroySecretVersion(
      cloud,
      namedEnvironment(request.environmentId),
      request,
      true,
    ),
  "environment.secrets.rotation": (cloud, request) =>
    readSecretRotation(cloud, namedEnvironment(request.environmentId), request),
  "environment.secrets.consent": (cloud, request) =>
    consentToSecret(cloud, namedEnvironment(request.environmentId), request),
};

/**
 * The code a host gave the same failure when it forwarded the call, so a
 * screen's existing handling (its toast, its inline line) reads it unchanged.
 */
const HOST_CODE_OF: Readonly<Record<EnvironmentErrorKind, RpcErrorCode>> = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "E_ROLE_FORBIDDEN",
  invalid: "E_INVALID_ARGUMENT",
  refused: "RPC_ERROR",
  unavailable: "RPC_ERROR",
  no_response: "RPC_ERROR",
};

/** An environment call's failure as the `HostRpcError` the screen reads. */
export function environmentCloudHostError(
  method: string,
  error: unknown,
): unknown {
  if (!(error instanceof EnvironmentCloudError)) return error;
  return new HostRpcError({
    code: HOST_CODE_OF[error.kind],
    message: error.message,
    requestId: "",
    method,
    fatalDetails: null,
  });
}

/**
 * One operation's sender. Every request it sends goes on the sign-in that was
 * current when the operation began, so an operation of several requests
 * never finishes on the next person's sign-in. Failures are the
 * `HostRpcError` a host gave; with no session service each request fails as a
 * host with no client does.
 */
export type EnvironmentCloudSend = <Method extends EnvironmentCloudMethod>(
  method: Method,
  request: RequestOfMethod<HostRpcRegistry, Method>,
) => Promise<ResponseOfMethod<HostRpcRegistry, Method>>;

/** One moved method, sent on the person's sign-in. */
export async function callEnvironmentCloud<
  Method extends EnvironmentCloudMethod,
>(
  cloud: EnvironmentCloud,
  method: Method,
  request: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const call: EnvironmentCloudCall<Method> = CALLS[method];
  try {
    return await call(cloud, request);
  } catch (error) {
    throw environmentCloudHostError(method, error);
  }
}
