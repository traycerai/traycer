import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import type {
  SandboxControlFailure,
  SandboxCreateFetchResult,
  SandboxGetFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT,
  type SandboxCreateAccepted,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import {
  sandboxCreateFailureMessage,
  sandboxFailureMessageFor,
  sandboxFailureCodeMessage,
  sandboxFailureMessage,
} from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import {
  readSandboxRetryCreate,
  sandboxRowNotFound,
} from "@/lib/sandboxes/sandbox-row-read";
import { couldntStartLine } from "@/lib/sandboxes/sandbox-strings";
import {
  sandboxRetryAfterRefusal,
  sandboxRetryCreate,
} from "@/lib/sandboxes/sandbox-create-key";

/**
 * What a create sends: the request, and the team's name when it belongs to
 * a team, so a refusal can name it (the server names no team).
 */
export interface SandboxCreateSubmit {
  readonly request: SandboxCreateRequest;
  readonly ownerUserId: string | null;
  readonly teamName: string | null;
  /** Keeps the originating failed-row button pending while the press walks. */
  readonly sourceSandboxId?: string;
  readonly reconcileSandboxId?: string;
  readonly retryRow?: {
    readonly sandboxId: string;
    readonly error: SandboxCreateError;
  };
}

/**
 * A refused create, carrying the server's refusal code for cache invalidation.
 */
export class SandboxCreateError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly nextRequest: SandboxCreateRequest | null,
  ) {
    super(message);
    this.name = "SandboxCreateError";
  }
}

export interface SandboxCreateScope {
  readonly userId: string | null;
  readonly source: "failed-row" | "team-environment";
  readonly id: string;
}

type SandboxCreateContinuation =
  | {
      readonly kind: "read";
      readonly request: SandboxCreateRequest;
      readonly sandboxId: string;
    }
  | {
      readonly kind: "retry";
      readonly request: SandboxCreateRequest;
      readonly error: SandboxCreateError;
      readonly retainUntilSettled?: true;
    }
  | {
      readonly kind: "retry-row";
      readonly request: SandboxCreateRequest;
      readonly sandboxId: string;
      readonly error: SandboxCreateError;
    };

const useSandboxCreateContinuations = create<{
  readonly byScope: Readonly<
    Partial<Record<string, SandboxCreateContinuation>>
  >;
}>(() => ({ byScope: {} }));
const latestCreateByScope = new Map<string, symbol>();

interface ScopedCreateAttempt {
  readonly key: string;
  readonly userId: string | null;
  readonly source: SandboxCreateScope["source"];
  readonly current: () => boolean;
  readonly finish: () => void;
}

function scopeKey(scope: SandboxCreateScope): string {
  return JSON.stringify([scope.userId, scope.source, scope.id]);
}

function beginScopedCreate(scope: SandboxCreateScope): ScopedCreateAttempt {
  const key = scopeKey(scope);
  const { userId } = scope;
  const id = Symbol();
  latestCreateByScope.set(key, id);
  return {
    key,
    userId,
    source: scope.source,
    current: () =>
      signedInUserId() === userId && latestCreateByScope.get(key) === id,
    finish: () => {
      if (latestCreateByScope.get(key) === id) latestCreateByScope.delete(key);
    },
  };
}

export function useSandboxCreateContinuation(
  scope: SandboxCreateScope,
): SandboxCreateContinuation | undefined {
  return useSandboxCreateContinuations(
    (state) => state.byScope[scopeKey(scope)],
  );
}

function replaceContinuation(
  key: string,
  next: SandboxCreateContinuation | undefined,
): void {
  useSandboxCreateContinuations.setState(({ byScope }) => {
    const updated = { ...byScope };
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    return { byScope: updated };
  });
}

class SandboxUnresolvedCreateError extends SandboxCreateError {
  constructor(
    message: string,
    code: string | null,
    request: SandboxCreateRequest,
  ) {
    super(message, code, request);
  }
}

export function sandboxCreatePress(
  initial: SandboxCreateRequest | null,
  previous: {
    readonly error: Error | null;
    readonly variables: SandboxCreateSubmit | undefined;
  },
  scope: SandboxCreateScope,
): Pick<
  SandboxCreateSubmit,
  "request" | "reconcileSandboxId" | "ownerUserId" | "retryRow"
> | null {
  const ownerUserId = scope.userId;
  if (signedInUserId() !== ownerUserId) return null;
  const saved =
    useSandboxCreateContinuations.getState().byScope[scopeKey(scope)];
  if (saved?.kind === "read")
    return {
      request: saved.request,
      reconcileSandboxId: saved.sandboxId,
      ownerUserId,
    };
  if (saved?.kind === "retry") return { request: saved.request, ownerUserId };
  if (saved?.kind === "retry-row")
    return {
      request: saved.request,
      ownerUserId,
      retryRow: { sandboxId: saved.sandboxId, error: saved.error },
    };

  const variables = previous.variables;
  let request = initial;
  if (variables?.ownerUserId === ownerUserId) {
    if (previous.error instanceof SandboxCreateError)
      request = previous.error.nextRequest ?? initial;
    else if (previous.error !== null) request = variables.request;
  }
  return request === null ? null : { request, ownerUserId };
}

const CREATE_READ_BUDGET_MS = 10_000;
const CREATE_READ_INTERVAL_MS = 2_000;
const CREATING_CODE = SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT;
const UNREADABLE_ROW: SandboxControlFailure = {
  kind: "network-error",
  detail: "Sandbox state could not be read.",
};

function pollCreatingSandbox(result: SandboxGetFetchResult): boolean {
  if (result.kind === "ok") return result.sandbox.state === "creating";
  if (result.kind === "network-error") return true;
  return (
    result.kind === "refused" && (result.status === 409 || result.status >= 500)
  );
}

/** Reconciliation never advances the create walk, even if the row is destroyed. */
async function reconcileSandboxCreate(
  auth: AuthService,
  sandboxId: string,
  attempted: SandboxCreateRequest,
  userId: string | null,
): Promise<SandboxCreateAccepted> {
  const until = Date.now() + CREATE_READ_BUDGET_MS;
  let expired = false;
  let timer: number | undefined;
  let pollTimer: number | undefined;
  const readState: { last: SandboxGetFetchResult | null } = { last: null };
  const current = (): boolean =>
    !expired && Date.now() < until && signedInUserId() === userId;
  const read = async (): Promise<void> => {
    while (current()) {
      const answer = await auth
        .getSandbox(sandboxId)
        .catch(() => UNREADABLE_ROW);
      if (!current()) return;
      const result =
        answer.kind === "ok" && answer.sandbox.id !== sandboxId
          ? UNREADABLE_ROW
          : answer;
      readState.last = result;
      if (!pollCreatingSandbox(result)) return;
      await new Promise<void>((resolve) => {
        pollTimer = window.setTimeout(
          resolve,
          Math.min(CREATE_READ_INTERVAL_MS, until - Date.now()),
        );
      });
    }
  };
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, CREATE_READ_BUDGET_MS);
      }),
      read(),
    ]);
  } finally {
    expired = true;
    window.clearTimeout(timer);
    window.clearTimeout(pollTimer);
  }
  const result = signedInUserId() === userId ? readState.last : null;
  if (result === null || result.kind !== "ok") {
    const notFound = result !== null && sandboxRowNotFound(result);
    const code = notFound ? SANDBOX_REFUSAL_CODE_NOT_FOUND : null;
    const failure =
      result === null || (result.kind === "refused" && !notFound)
        ? UNREADABLE_ROW
        : result;
    throw new SandboxUnresolvedCreateError(
      sandboxFailureMessage(failure),
      code,
      attempted,
    );
  }
  const { sandbox } = result;
  switch (sandbox.state) {
    case "creating":
    case "destroying":
      throw new SandboxUnresolvedCreateError(
        sandboxFailureCodeMessage(CREATING_CODE),
        CREATING_CODE,
        attempted,
      );
    case "failed":
      throw new SandboxCreateError(
        sandboxFailureCodeMessage(SANDBOX_REFUSAL_CODE_PROVIDER_FAILED),
        SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
        sandboxRetryCreate(sandbox),
      );
    case "destroyed":
      throw new SandboxCreateError(
        sandbox.failureCode === "credit-gate"
          ? couldntStartLine(sandbox.displayName)
          : sandboxFailureCodeMessage(SANDBOX_REFUSAL_CODE_NOT_FOUND),
        SANDBOX_REFUSAL_CODE_NOT_FOUND,
        sandbox.failureCode === "credit-gate"
          ? sandboxRetryCreate(sandbox)
          : attempted,
      );
    default:
      return { sandboxId: sandbox.id, hostId: sandbox.hostId, sandbox };
  }
}

/** Keep the known row through a remount, including when the foreground read expires. */
async function finishJoinedCreate(
  auth: AuthService,
  sandboxId: string,
  attempted: SandboxCreateRequest,
  attempt: ScopedCreateAttempt,
): Promise<SandboxCreateAccepted> {
  const { key, current } = attempt;
  const reading = { kind: "read", request: attempted, sandboxId } as const;
  if (current()) replaceContinuation(key, reading);
  try {
    const accepted = await reconcileSandboxCreate(
      auth,
      sandboxId,
      attempted,
      attempt.userId,
    );
    if (
      current() &&
      useSandboxCreateContinuations.getState().byScope[key] === reading
    )
      replaceContinuation(key, undefined);
    return accepted;
  } catch (error) {
    if (
      error instanceof SandboxCreateError &&
      !(error instanceof SandboxUnresolvedCreateError) &&
      current() &&
      useSandboxCreateContinuations.getState().byScope[key] === reading
    ) {
      replaceContinuation(
        key,
        error.nextRequest === null
          ? undefined
          : attempt.source === "failed-row"
            ? retainedCreateRetry(error.nextRequest, error)
            : { kind: "retry", request: error.nextRequest, error },
      );
    }
    throw error;
  }
}

function nextCreateRequest(
  refusal: SandboxControlFailure,
  request: SandboxCreateRequest,
  attempted: SandboxCreateRequest,
): SandboxCreateRequest | null {
  if (refusal.kind === "network-error") return attempted;
  if (refusal.kind !== "refused") return request;
  if (refusal.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT)
    return attempted;
  if (
    refusal.status === 503 &&
    refusal.code === SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE &&
    refusal.sandboxId === undefined
  )
    return attempted;
  if (refusal.code !== SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED) return request;
  // An unreserved team setup can use the current defaults under its base key.
  return refusal.status === 400 &&
    refusal.uncertainCreateRow !== true &&
    attempted === request &&
    request.clientRequestId?.startsWith("team-setup:") === true
    ? null
    : attempted;
}

/** One press can pass previous destroyed attempts and reserve at most one row. */
async function walkSandboxCreate(
  auth: AuthService,
  initial: SandboxCreateRequest,
  userId: string | null,
): Promise<{
  readonly result: SandboxCreateFetchResult;
  readonly attempted: SandboxCreateRequest;
}> {
  const walked = new Set<string | null>();
  let attempted = initial;
  while (signedInUserId() === userId) {
    walked.add(attempted.clientRequestId);
    const result = await auth.createSandbox(attempted);
    if (
      result.kind !== "ok" ||
      result.joined !== true ||
      result.accepted.sandbox.state !== "destroyed" ||
      result.accepted.sandbox.failureCode === "credit-gate"
    ) {
      return { result, attempted };
    }
    const next = sandboxRetryCreate(result.accepted.sandbox);
    // A repeated key cannot advance the walk, even if the response was stale.
    if (walked.has(next.clientRequestId)) return { result, attempted };
    attempted = next;
  }
  return { result: { kind: "unauthorized" }, attempted };
}

function acceptedWalkCreate(
  auth: AuthService,
  request: SandboxCreateRequest,
  walk: {
    readonly result: Extract<SandboxCreateFetchResult, { kind: "ok" }>;
    readonly attempted: SandboxCreateRequest;
  },
  attempt: ScopedCreateAttempt,
): Promise<SandboxCreateAccepted> {
  const { result, attempted } = walk;
  const { accepted } = result;
  const { sandbox } = accepted;
  if (result.joined === true && sandbox.state === "creating")
    return finishJoinedCreate(auth, sandbox.id, attempted, attempt);
  if (result.joined === true && sandbox.state === "destroying") {
    const code = SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT;
    throw new SandboxCreateError(
      sandboxFailureCodeMessage(code),
      code,
      request,
    );
  }
  const joinedFailed = result.joined === true && sandbox.state === "failed";
  if (!joinedFailed && sandbox.state !== "destroyed")
    return Promise.resolve(accepted);
  const code = joinedFailed
    ? SANDBOX_REFUSAL_CODE_PROVIDER_FAILED
    : SANDBOX_REFUSAL_CODE_NOT_FOUND;
  throw new SandboxCreateError(
    result.joined === true &&
      sandbox.state === "destroyed" &&
      sandbox.failureCode === "credit-gate"
      ? couldntStartLine(sandbox.displayName)
      : sandboxFailureCodeMessage(code),
    code,
    sandboxRetryCreate(sandbox),
  );
}

export function sandboxCreateRefusal(
  scope: SandboxCreateScope,
  previous: {
    readonly error: Error | null;
    readonly variables: SandboxCreateSubmit | undefined;
  },
  saved: SandboxCreateContinuation | undefined,
): Error | null {
  const scoped =
    previous.variables?.ownerUserId === scope.userId ? previous.error : null;
  return (
    scoped ??
    (saved?.kind === "retry" || saved?.kind === "retry-row"
      ? saved.error
      : null)
  );
}

async function resolveCreateRetry(
  auth: AuthService,
  retry: NonNullable<SandboxCreateSubmit["retryRow"]>,
  attempt: ScopedCreateAttempt,
): Promise<SandboxCreateRequest> {
  const { key, current } = attempt;
  const saved = useSandboxCreateContinuations.getState().byScope[key];
  if (saved?.kind !== "retry-row" || saved.error !== retry.error)
    throw retry.error;
  const request = await readSandboxRetryCreate(
    auth,
    retry.sandboxId,
    attempt.userId,
  );
  if (
    request === null ||
    !current() ||
    useSandboxCreateContinuations.getState().byScope[key] !== saved
  )
    throw retry.error;
  return request;
}

type RetainedCreateRetry = Extract<
  SandboxCreateContinuation,
  { kind: "retry" }
>;

function retainedCreateRetry(
  request: SandboxCreateRequest,
  error: SandboxCreateError,
): RetainedCreateRetry {
  return { kind: "retry", request, error, retainUntilSettled: true };
}

function settleRetainedCreate(
  { key, current }: ScopedCreateAttempt,
  retained: RetainedCreateRetry,
  error: SandboxCreateError | null,
): void {
  if (
    !current() ||
    useSandboxCreateContinuations.getState().byScope[key] !== retained
  )
    return;
  replaceContinuation(
    key,
    error === null || error.nextRequest === null
      ? undefined
      : retainedCreateRetry(error.nextRequest, error),
  );
}

function pressedCreateRefusal(input: {
  readonly result: SandboxControlFailure;
  readonly startingRequest: SandboxCreateRequest;
  readonly attempted: SandboxCreateRequest;
  readonly submit: SandboxCreateSubmit;
  readonly buysTeamCredits: boolean;
  readonly retained: RetainedCreateRetry | undefined;
  readonly attempt: ScopedCreateAttempt;
}): SandboxCreateError {
  const {
    result,
    startingRequest,
    attempted,
    buysTeamCredits,
    retained,
    attempt,
  } = input;
  const { teamName } = input.submit;
  const code = result.kind === "refused" ? result.code : null;
  const payload = sandboxRetryAfterRefusal(result);
  const unresolved =
    result.kind === "refused" && payload === null
      ? result.sandboxId
      : undefined;
  // A refusal for the team's credits tells only a buyer how much to add.
  const error = new SandboxCreateError(
    sandboxFailureMessageFor(
      result,
      sandboxCreateFailureMessage(result, teamName),
      { buysTeamCredits, teamName },
    ),
    code,
    unresolved === undefined
      ? (payload ?? nextCreateRequest(result, startingRequest, attempted))
      : null,
  );
  if (attempt.current()) {
    if (unresolved !== undefined)
      replaceContinuation(attempt.key, {
        kind: "retry-row",
        request: attempted,
        sandboxId: unresolved,
        error,
      });
    else if (retained !== undefined)
      settleRetainedCreate(attempt, retained, error);
    else if (
      error.nextRequest !== null &&
      attempt.source === "failed-row" &&
      (payload !== null || result.kind === "network-error")
    ) {
      replaceContinuation(
        attempt.key,
        retainedCreateRetry(error.nextRequest, error),
      );
    }
  }
  return error;
}

async function sendCreateFromPress(
  auth: AuthService,
  submit: SandboxCreateSubmit,
  buysTeamCredits: boolean,
  attempt: ScopedCreateAttempt,
): Promise<SandboxCreateAccepted> {
  const { request, retryRow } = submit;
  const { key, current } = attempt;
  const saved = useSandboxCreateContinuations.getState().byScope[key];
  let retained =
    saved?.kind === "retry" && saved.retainUntilSettled === true
      ? saved
      : undefined;
  if (saved?.kind === "retry" && retained === undefined)
    replaceContinuation(key, undefined);
  const startingRequest =
    retryRow === undefined
      ? request
      : await resolveCreateRetry(auth, retryRow, attempt);
  if (retryRow !== undefined) {
    if (!current()) throw retryRow.error;
    retained = retainedCreateRetry(startingRequest, retryRow.error);
    replaceContinuation(key, retained);
  }
  const { result, attempted } = await walkSandboxCreate(
    auth,
    startingRequest,
    attempt.userId,
  );
  if (result.kind !== "ok")
    throw pressedCreateRefusal({
      result,
      startingRequest,
      attempted,
      submit,
      buysTeamCredits,
      retained,
      attempt,
    });
  try {
    const accepted = await acceptedWalkCreate(
      auth,
      startingRequest,
      { result, attempted },
      attempt,
    );
    if (retained !== undefined) settleRetainedCreate(attempt, retained, null);
    return accepted;
  } catch (error) {
    if (error instanceof SandboxCreateError) {
      if (retained !== undefined) {
        settleRetainedCreate(attempt, retained, error);
      } else if (
        current() &&
        attempt.source === "failed-row" &&
        !(error instanceof SandboxUnresolvedCreateError) &&
        error.nextRequest !== null &&
        useSandboxCreateContinuations.getState().byScope[key] === undefined
      ) {
        replaceContinuation(key, retainedCreateRetry(error.nextRequest, error));
      }
    }
    throw error;
  }
}

interface SandboxCreateContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the create started. */
  readonly userId: string | null;
}

/**
 * Where a failed create says why: a `toast`, or `inline`, where the caller
 * draws the error's message beside the control that sent it.
 */
export type SandboxCreateRefusals = "toast" | "inline";

/**
 * `POST /api/sandboxes` for a failed row's Retry and a team's Enable cloud.
 * The server answers `202` once the sandbox is created and its host is
 * enrolling (the request can take minutes: provider capacity, boot,
 * boot-token delivery); the sandbox then appears in the host list and the
 * sandbox list, so the end of the request refreshes both (one prefix covers
 * both, see `sandboxQueryKeys.list`) and the directory.
 */
export function useSandboxCreate(
  refusals: SandboxCreateRefusals,
  buysTeamCredits: boolean,
  scope: SandboxCreateScope,
): UseMutationResult<
  SandboxCreateAccepted,
  Error,
  SandboxCreateSubmit,
  SandboxCreateContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  // The account the sandbox list and costs are keyed by.
  const { userId } = scope;
  return useMutation({
    mutationKey: sandboxMutationKeys.create(userId),
    onMutate: ({ ownerUserId }): SandboxCreateContext => ({
      directory: binding === null ? null : binding.directory,
      userId: ownerUserId,
    }),
    mutationFn: async (
      input: SandboxCreateSubmit,
    ): Promise<SandboxCreateAccepted> => {
      const { request, reconcileSandboxId, ownerUserId } = input;
      if (
        binding === null ||
        signedInUserId() !== ownerUserId ||
        userId !== ownerUserId
      ) {
        throw new SandboxCreateError(
          "Sign in to create a sandbox.",
          null,
          request,
        );
      }
      const attempt = beginScopedCreate(scope);
      try {
        if (reconcileSandboxId !== undefined)
          return await finishJoinedCreate(
            binding.auth,
            reconcileSandboxId,
            request,
            attempt,
          );
        return await sendCreateFromPress(
          binding.auth,
          input,
          buysTeamCredits,
          attempt,
        );
      } finally {
        attempt.finish();
      }
    },
    onSuccess: (accepted, { request, retryRow }, context) => {
      if (!settledForStartingAccount(context)) return;
      toast.success(
        `Created ${retryRow === undefined ? request.displayName : accepted.sandbox.displayName}`,
      );
    },
    // Settled, not only success: a `502 provider_failed` leaves a `failed`
    // row behind, which the lists must show so it can be destroyed.
    onSettled: (_data, error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      void context.directory?.refresh();
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      // The server says the person is no longer in the team: the team's
      // environment, read once per session, is read again so the next create
      // answers from membership rather than from the stale id.
      if (
        error instanceof SandboxCreateError &&
        error.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND
      ) {
        void queryClient.invalidateQueries({
          queryKey: sandboxQueryKeys.teamEnvironmentAll(),
        });
      }
    },
    onError: (error, _variables, context) => {
      if (refusals === "inline" || !settledForStartingAccount(context)) return;
      if (error instanceof SandboxCreateError) {
        toast.error(error.message);
        return;
      }
      toastFromAuthError(error, "Couldn't create the sandbox.");
    },
  });
}
