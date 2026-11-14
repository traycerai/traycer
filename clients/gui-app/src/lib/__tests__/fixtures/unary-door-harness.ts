import { useAuthStore } from "@/stores/auth/auth-store";
import { hostRpcRegistry } from "@/lib/host";
import { noteHostTokenRefusal } from "@/lib/host/host-door-observer";
import { recordingRefusedHost } from "@/lib/host/refused-host";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import {
  hostTokenBearerFor,
  hostTokenUnaryRevalidator,
} from "@traycer-clients/shared/auth/host-token-lease";
import type {
  RefusalAwareAuthRevalidator,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  HostRpcError,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthAwareMessenger } from "@traycer-clients/shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

export const UNARY_DOOR_HOST_ID = "unary-door-host";
export const POOL_DOOR_HOST_ID = "pool";
export const UNARY_DOOR_USER_ID = "user-1";
export const UNARY_DOOR_SIGN_IN = "test-sign-in";

type UnaryDoorRegistry = typeof hostRpcRegistry;

export interface UnaryDoorHarnessOptions {
  readonly hostId: string;
  readonly refusals: readonly HostRpcError[];
}

export interface UnaryDoorHarness {
  readonly call: () => Promise<HostRpcError>;
  readonly sentBearers: string[];
  readonly mintCalls: string[];
  readonly signInRevalidationCalls: string[];
  readonly tokens: HostTokenSource;
  readonly setNow: (now: number) => void;
}

export function fatalDoorRefusal(
  code: HostRpcError["code"],
  doorReason: string | undefined,
): HostRpcError {
  const details: FatalErrorDetails = {
    code,
    reason: "refused before the request was sent",
    incompatibleMethods: null,
    upgradeGuidance: null,
    ...(doorReason === undefined ? {} : { doorReason }),
  };
  return new HostRpcError({
    code,
    message: details.reason,
    requestId: `req-${doorReason ?? code}`,
    method: "host.status",
    fatalDetails: details,
    doorRefusal: details,
  });
}

function scriptedDoorMessenger(
  refusals: readonly HostRpcError[],
  sentBearers: string[],
): IHostMessenger<UnaryDoorRegistry> {
  const queue = [...refusals];
  const request = <Method extends keyof UnaryDoorRegistry & string>(
    _method: Method,
    _params: RequestOfMethod<UnaryDoorRegistry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<UnaryDoorRegistry, Method>> => {
    sentBearers.push(options.authority.bearer.getBearerToken());
    const refusal = queue.shift();
    return Promise.reject(refusal ?? new Error("unexpected unary send"));
  };
  const requestWithResponseTimeout = async <
    Method extends keyof UnaryDoorRegistry & string,
  >(
    method: Method,
    params: RequestOfMethod<UnaryDoorRegistry, Method>,
    timeoutMs: number,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<UnaryDoorRegistry, Method>> => {
    void timeoutMs;
    return request(method, params, options);
  };
  return {
    request,
    requestWithResponseTimeout,
  };
}

export async function unaryDoorHarness(
  options: UnaryDoorHarnessOptions,
): Promise<UnaryDoorHarness> {
  let now = 1_000_000;
  let signInToken = UNARY_DOOR_SIGN_IN;
  const sentBearers: string[] = [];
  const mintCalls: string[] = [];
  const signInRevalidationCalls: string[] = [];
  const signInLease: OpenFrameBearerSource = {
    identity: { userId: UNARY_DOOR_USER_ID },
    getBearerToken: () => signInToken,
  };
  const tokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: (hostId, _signInToken): Promise<HostTokenMintOutcome> => {
      mintCalls.push(hostId);
      return Promise.resolve({
        kind: "ok",
        token: {
          token: `fresh-host-token-${mintCalls.length}`,
          expiresAtMs: now + 60_000,
        },
      });
    },
    signIn: (userId) =>
      userId === UNARY_DOOR_USER_ID ? UNARY_DOOR_SIGN_IN : null,
    now: () => now,
  });
  await tokens.adopt(
    UNARY_DOOR_USER_ID,
    options.hostId,
    {
      token: "held-host-token",
      expiresAtMs: now + 60_000,
    },
    tokens.era(UNARY_DOOR_USER_ID),
  );
  const signInRecovery: StreamAuthRevalidator = {
    revalidateForReconnect: () => {
      signInRevalidationCalls.push("stream");
      signInToken = `${UNARY_DOOR_SIGN_IN}-stream`;
      return Promise.resolve("rotated");
    },
  };
  const hostRecovery = hostTokenUnaryRevalidator({
    tokens,
    currentUserId: () =>
      useAuthStore.getState().contextMetadata?.userId ?? null,
    signInRecovery,
    onState: noteHostTokenRefusal,
    now: () => now,
  });
  const revalidateExpectedBearer: RefusalAwareAuthRevalidator["revalidateExpectedBearer"] =
    (expected) => {
      signInRevalidationCalls.push("unary");
      if (expected !== signInLease) return Promise.resolve("superseded");
      signInToken = `${UNARY_DOOR_SIGN_IN}-${signInRevalidationCalls.length}`;
      return Promise.resolve("rotated");
    };
  const auth: RefusalAwareAuthRevalidator = {
    revalidateExpectedBearer,
    revalidateRefusedBearer: (expected, hostId, refusal) => {
      if (hostId === POOL_DOOR_HOST_ID) {
        if (refusal !== null && refusal.code !== "UNAUTHORIZED")
          return Promise.resolve("rejected");
        return revalidateExpectedBearer(expected);
      }
      return hostRecovery.revalidateRefusedBearer(expected, hostId, refusal);
    },
  };
  const bearer =
    options.hostId === POOL_DOOR_HOST_ID
      ? signInLease
      : await hostTokenBearerFor(tokens, noteHostTokenRefusal)(
          options.hostId,
          signInLease,
        );
  if (bearer === null) throw new Error("expected a host-only token bearer");
  const raw = scriptedDoorMessenger(options.refusals, sentBearers);
  const messenger = recordingRefusedHost(
    createRetryingMessenger(
      createAuthAwareMessenger(raw, auth, "always"),
      DEFAULT_TRANSPORT_RETRY_POLICY,
    ),
  );
  return {
    sentBearers,
    mintCalls,
    signInRevalidationCalls,
    tokens,
    setNow: (nextNow) => {
      now = nextNow;
    },
    call: async () => {
      try {
        await messenger.request(
          "host.status",
          {},
          {
            idempotencyKey: null,
            replayMustBeKeyed: false,
            requiredHostMethodVersion: null,
            authority: {
              endpoint: {
                hostId: options.hostId,
                websocketUrl: "ws://host.invalid/rpc",
              },
              bearer,
              abortSignal: new AbortController().signal,
            },
          },
        );
      } catch (cause) {
        if (cause instanceof HostRpcError) return cause;
        throw cause;
      }
      throw new Error("expected the host to refuse the request");
    },
  };
}

export function signInForUnaryTest(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: UNARY_DOOR_USER_ID, userName: "U", email: "u@example.com" },
      { userId: UNARY_DOOR_USER_ID, username: "U" },
      [],
    );
}
