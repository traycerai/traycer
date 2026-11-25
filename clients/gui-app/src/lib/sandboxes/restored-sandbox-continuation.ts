import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { RequestOfMethod, ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  claimDraftAuthorityRestoredActionEffect,
  consumeAcceptedRestoredStart,
  readDraftAuthorityRestoredAction,
  readDraftAuthorityRestoredActionEffectGrant,
  settleDraftAuthorityRestoredActionEffect,
  type DraftAuthorityRestoredAction,
  type DraftAuthorityRestoredActionClaim,
  type DraftAuthorityRestoredActionEffect,
  type DraftAuthorityRestoredActionOutcome,
  type DraftAuthorityRestoredActionStep,
  type DraftAuthorityRestoredStartTaskMirrorBinding,
} from "@/lib/drafts/draft-authority-pending";
import type { DraftAuthorityActor, DraftAuthorityEditReceipt, DraftAuthorityVersion } from "@/lib/drafts/draft-authority-types";
import { pollEpicExistence } from "@/lib/epics/epic-existence-poll";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import type { RestoredSandboxReadyWitness } from "@/stores/composer/staged-sandbox-store";

type ContinuationMethod = DraftAuthorityRestoredActionEffect["method"];
type ContinuationRequest<M extends ContinuationMethod> = RequestOfMethod<HostRpcRegistry, M>;
type ContinuationResponse<M extends ContinuationMethod> = ResponseOfMethod<HostRpcRegistry, M>;

interface ContinuationDispatch<M extends ContinuationMethod> {
  readonly variables: ContinuationRequest<M>;
  readonly params: ContinuationRequest<M>;
  readonly client: HostRequester<HostRpcRegistry>;
  readonly dispatch: () => Promise<ContinuationResponse<M>>;
}

type AcceptedEvidence = Extract<DraftAuthorityRestoredActionOutcome, { kind: "accepted" }>["evidence"];
type ResponseEvidence = Extract<AcceptedEvidence, { proof: "response" }>;

interface RestoredActionRequest {
  readonly owner: RestoredSandboxContinuation;
  active: {
    readonly effect: DraftAuthorityRestoredActionEffect;
    readonly claim: DraftAuthorityRestoredActionClaim;
  } | null;
  repair: "none" | "offered" | "used";
}

export class RestoredSandboxContinuationHeld extends HostRequestAbortedError {
  constructor(method: ContinuationMethod, mayHaveDispatched: boolean) {
    super({
      method,
      mayHaveDispatched,
      requestId: "restored-sandbox-continuation",
      message: "The restored sandbox action could not continue.",
    });
  }
}

const requests = new WeakMap<object, RestoredActionRequest>();
const explicitRetries = new WeakSet<RestoredSandboxReadyWitness>();

export function requestRestoredSandboxActionRetry(ready: RestoredSandboxReadyWitness): void {
  explicitRetries.add(ready);
}

export interface RestoredSandboxActionCapture {
  readonly ready: RestoredSandboxReadyWitness;
  readonly readyIsCurrent: () => boolean;
  readonly draftIsCurrent: () => boolean;
  readonly targetIsCurrent?: () => boolean;
}

export class RestoredSandboxContinuation {
  readonly ready: RestoredSandboxReadyWitness;

  constructor(
    private readonly capture: RestoredSandboxActionCapture,
    readonly action: DraftAuthorityRestoredAction,
  ) {
    this.ready = capture.ready;
  }

  sourceIsCurrent(): boolean {
    return restoredSandboxSourceIsCurrent(this.capture);
  }

  isCurrent(): boolean {
    return restoredSandboxActionIsCurrent(this.capture);
  }

  bind<T extends object>(request: T): T {
    requests.set(request, { owner: this, active: null, repair: "none" });
    return request;
  }
}

export function restoredSandboxActionIsCurrent(capture: RestoredSandboxActionCapture): boolean {
  return restoredSandboxSourceIsCurrent(capture) && capture.targetIsCurrent?.() !== false;
}

function restoredSandboxSourceIsCurrent(capture: RestoredSandboxActionCapture): boolean {
  const { ready } = capture;
  return draftAuthorityActorIsCurrent(ready.actor) &&
    capture.readyIsCurrent() &&
    capture.draftIsCurrent();
}

function hostIsCurrent(
  action: RestoredActionRequest,
  client: HostRequester<HostRpcRegistry>,
): boolean {
  const { owner } = action;
  return owner.isCurrent() && client.getActiveHostId() === owner.ready.hostId &&
    client.getRequestContextUserId() === owner.ready.actor.accountId;
}

async function prepareRestoredDispatch(
  action: RestoredActionRequest,
  effect: DraftAuthorityRestoredActionEffect,
  client: HostRequester<HostRpcRegistry>,
): Promise<
  | { readonly kind: "issue"; readonly claim: DraftAuthorityRestoredActionClaim }
  | { readonly kind: "already-accepted"; readonly evidence: AcceptedEvidence }
> {
  const { owner } = action;
  const { ready } = owner;
  const { actor, draft, primary, hostId, sandboxId } = ready;
  const setupAttempt = primary.setupAttempt;
  const isCurrent = (): boolean => hostIsCurrent(action, client);
  if (!isCurrent() || setupAttempt?.attemptId !== ready.attemptId)
    throw new RestoredSandboxContinuationHeld(effect.method, false);

  let claim: DraftAuthorityRestoredActionClaim;
  if (action.active === null) {
    const existing = await readDraftAuthorityRestoredAction({ actor, draft });
    if (!isCurrent() || existing.kind === "denied" || existing.kind === "unavailable")
      throw new RestoredSandboxContinuationHeld(effect.method, false);
    if (existing.kind === "current" && existing.action.actionId !== owner.action.actionId)
      throw new RestoredSandboxContinuationHeld(effect.method, false);
    const saved = existing.kind === "current"
      ? existing.steps.find((step) => step.effect.method === effect.method)
      : undefined;
    const retry = saved?.outcome?.kind === "refused" && explicitRetries.has(ready);
    if (retry) explicitRetries.delete(ready);
    const result = await claimDraftAuthorityRestoredActionEffect({
      actor, draft, ready: { primary, setupAttempt, hostId, sandboxId },
      action: owner.action, effect,
      expectedIssueGeneration: retry ? saved.claim.issueGeneration : null,
      isCurrent,
    });
    if (result.kind === "replayed" && saved?.outcome?.kind === "accepted" && isCurrent()) {
      return { kind: "already-accepted", evidence: saved.outcome.evidence };
    }
    if (result.kind !== "committed") {
      if (result.kind === "replayed")
        void observeRestoredSandboxAction({ actor, draft, isCurrent }).catch(() => undefined);
      throw new RestoredSandboxContinuationHeld(effect.method, result.kind === "replayed" || result.kind === "unverified");
    }
    claim = result.receipt;
    action.active = { effect, claim };
  } else {
    if (effect.method !== "epic.create" || action.repair !== "offered")
      throw new RestoredSandboxContinuationHeld(effect.method, true);
    claim = action.active.claim;
    action.repair = "used";
  }
  if (!await readDraftAuthorityRestoredActionEffectGrant({ actor, claim, effect }) || !isCurrent())
    throw new RestoredSandboxContinuationHeld(effect.method, false);
  return { kind: "issue", claim };
}

async function settle(
  action: RestoredActionRequest,
  claim: DraftAuthorityRestoredActionClaim,
  outcome: DraftAuthorityRestoredActionOutcome,
): Promise<boolean> {
  const result = await settleDraftAuthorityRestoredActionEffect({
    actor: action.owner.ready.actor, claim, outcome,
  });
  return result.kind === "committed" || result.kind === "replayed";
}

async function dispatchRestored<M extends ContinuationMethod>(
  input: ContinuationDispatch<M>,
  effect: DraftAuthorityRestoredActionEffect,
  evidence: (response: ContinuationResponse<M>, hostId: string, epicId: string) =>
    ResponseEvidence | "refused" | "uncertain" | "repair",
  restoredResponse: (known: AcceptedEvidence) => ContinuationResponse<M> | null,
): Promise<ContinuationResponse<M>> {
  if (typeof input.variables !== "object" || input.variables === null)
    return input.dispatch();
  const action = requests.get(input.variables);
  if (action === undefined) return input.dispatch();
  // A continuation owns the exact mapped request object and its frozen body.
  if (input.params !== input.variables) throw new RestoredSandboxContinuationHeld(effect.method, false);
  const prepared = await prepareRestoredDispatch(action, effect, input.client);
  if (!hostIsCurrent(action, input.client))
    throw new RestoredSandboxContinuationHeld(effect.method, prepared.kind === "already-accepted");
  if (prepared.kind === "already-accepted") {
    const response = restoredResponse(prepared.evidence);
    if (response === null) throw new RestoredSandboxContinuationHeld(effect.method, true);
    return response;
  }
  const { claim } = prepared;
  let response: ContinuationResponse<M>;
  try {
    response = await input.dispatch();
  } catch (error) {
    await settle(action, claim, { kind: "uncertain" });
    const observed = await observeRestoredSandboxAction({
      actor: action.owner.ready.actor,
      draft: action.owner.ready.draft,
      isCurrent: () => hostIsCurrent(action, input.client),
    }).catch(() => null);
    const proof = observed === null ? null : restoredResponse(observed);
    if (proof !== null && hostIsCurrent(action, input.client)) return proof;
    throw error;
  }
  const verdict = evidence(response, action.owner.ready.hostId, action.owner.action.epicId);
  if (verdict === "repair" && action.repair === "none") {
    action.repair = "offered";
    return response;
  }
  const outcome: DraftAuthorityRestoredActionOutcome =
    typeof verdict === "string"
      ? { kind: verdict === "repair" ? "refused" : verdict }
      : { kind: "accepted", evidence: verdict };
  if (!await settle(action, claim, outcome) || outcome.kind === "uncertain")
    throw new RestoredSandboxContinuationHeld(effect.method, true);
  return response;
}

export async function finishRestoredEpicAttachmentRefusal(
  request: ContinuationRequest<"epic.create">,
): Promise<void> {
  const action = requests.get(request);
  if (action?.active != null && action.repair === "offered") {
    await settle(action, action.active.claim, { kind: "refused" });
  }
}

export async function restoredEpicAttachmentRepairAllowed(
  request: ContinuationRequest<"epic.create">,
  client: HostRequester<HostRpcRegistry>,
): Promise<boolean> {
  const action = requests.get(request);
  if (action === undefined) return true;
  const active = action.active;
  if (active === null || action.repair !== "offered" || !hostIsCurrent(action, client))
    return false;
  const { actor } = action.owner.ready;
  return await readDraftAuthorityRestoredActionEffectGrant({ actor, ...active }) &&
    hostIsCurrent(action, client);
}

export function dispatchRestoredEpicCreate(input: ContinuationDispatch<"epic.create">) {
  const method = "epic.create";
  return dispatchRestored<"epic.create">(
    input,
    { method, request: input.params },
    (response, hostId, epicId) => {
      if (response.refusal?.kind === "missing-attachment-bytes") return "repair";
      if (response.refusal !== undefined) return "refused";
      if (response.task != null && response.task.epic?.id !== epicId) return "uncertain";
      return { method, hostId, epicId, proof: "response", response };
    },
    (known) => {
      if (known.method !== method) return null;
      // Task existence says nothing about the folded seed's first turn.
      return known.proof === "response" ? known.response : { roomInfo: null };
    },
  );
}

export function dispatchRestoredWorktreeCreate(input: ContinuationDispatch<"worktree.create">) {
  const method = "worktree.create";
  return dispatchRestored<"worktree.create">(
    input,
    { method, request: input.params },
    (response, hostId, epicId) =>
      input.params.entries.every((entry) =>
        response.perEntry.some((result) => result.workspacePath === entry.workspacePath && result.ok),
      )
        ? { method, hostId, epicId, proof: "response", response }
        : "uncertain",
    (known) => {
      if (known.method !== method) return null;
      if (known.proof === "response") return known.response;
      return {
        binding: known.binding,
        perEntry: known.binding.entries.map((entry) => ({
          workspacePath: entry.workspacePath,
          ok: true,
          worktreePath: entry.worktreePath,
          branch: entry.branch,
          errorMessage: null,
        })),
      };
    },
  );
}

export function dispatchRestoredPrepareLaunch(input: ContinuationDispatch<"agent.tui.prepareLaunch">) {
  const method = "agent.tui.prepareLaunch";
  return dispatchRestored<"agent.tui.prepareLaunch">(
    input,
    { method, request: input.params },
    (response, hostId, epicId) =>
      response.hostId === hostId && response.harnessId === input.params.harnessId &&
        response.workingDirectory.length > 0
        ? { method, hostId, epicId, proof: "response", response }
        : "uncertain",
    (known) => known.method === method ? known.response : null,
  );
}

export function dispatchRestoredCreateTuiAgent(input: ContinuationDispatch<"epic.createTuiAgent">) {
  const method = "epic.createTuiAgent";
  return dispatchRestored<"epic.createTuiAgent">(
    input,
    { method, request: input.params },
    (response, hostId, epicId) =>
      response.tuiAgentId === input.params.tuiAgentId
        ? { method, hostId, epicId, proof: "response", response }
        : "uncertain",
    (known) => {
      if (known.method !== method) return null;
      return known.proof === "response" ? known.response : { tuiAgentId: known.tuiAgentId };
    },
  );
}

/** Only visible effects under the previously issued stable IDs can settle an unknown step. */
export async function observeRestoredSandboxAction(input: {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly isCurrent: () => boolean;
}): Promise<AcceptedEvidence | null> {
  const { actor, draft, isCurrent } = input;
  if (!draftAuthorityActorIsCurrent(actor) || !isCurrent()) return null;
  const read = await readDraftAuthorityRestoredAction({ actor, draft });
  if (read.kind !== "current" || !isCurrent()) return null;
  const step = read.steps.at(-1);
  if (
    step === undefined ||
    (step.outcome !== null && step.outcome.kind !== "uncertain") ||
    step.effect.method === "agent.tui.prepareLaunch"
  ) return null;
  const { hostId } = step.claim;
  const client = resolveNamedHostClient(getHostBindingSnapshot(), hostId);
  const isBound = (): boolean =>
    client?.getActiveHostId() === hostId &&
    client.getRequestContextUserId() === actor.accountId &&
    draftAuthorityActorIsCurrent(actor) && isCurrent();
  if (client === null || !isBound()) return null;
  const evidence = await readRestoredStepEvidence(client, actor, read.action, step)
    .catch(() => null);
  if (evidence === null || !isBound()) return null;
  const settled = await settleDraftAuthorityRestoredActionEffect({
    actor, claim: step.claim, outcome: { kind: "accepted", evidence },
  });
  return settled.kind === "committed" || settled.kind === "replayed" ? evidence : null;
}

async function readRestoredStepEvidence(
  client: HostRequester<HostRpcRegistry>,
  actor: DraftAuthorityActor,
  action: DraftAuthorityRestoredAction,
  step: DraftAuthorityRestoredActionStep,
): Promise<AcceptedEvidence | null> {
  const { effect, claim } = step;
  const { method } = effect;
  const { epicId } = action;
  const { hostId } = claim;
  if (method === "epic.create") {
    const verdict = await pollEpicExistence({ client, hostId, epicId });
    return verdict === "exists" ? { method, proof: "task-read", epicId, hostId } : null;
  }
  if (method === "worktree.create") {
    const { ownerId, ownerKind } = effect.request;
    const read = await client.request("worktree.getBinding", { epicId, ownerId, ownerKind });
    if (read.binding === null || read.missingWorktreePaths.length > 0) return null;
    return { method, proof: "binding-read", epicId, hostId, tuiAgentId: ownerId, binding: read.binding };
  }
  if (method === "epic.createTuiAgent") {
    const { tuiAgentId, harnessId } = effect.request;
    const read = await client.request("epic.listTuiAgents", {
      epicId, hasDocReplica: false, knownRevision: null,
    });
    const record = read.kind === "snapshot" ? read.tuiAgents.find((candidate) =>
      candidate.origin !== "cloud" && candidate.tuiAgentId === tuiAgentId && candidate.hostId === hostId &&
      candidate.ownerUserId === actor.accountId && candidate.harnessId === harnessId,
    ) : undefined;
    if (record === undefined || record.origin === "cloud") return null;
    return {
      method, proof: "agent-read", epicId, hostId, tuiAgentId, harnessId,
      harnessSessionId: record.harnessSessionId,
    };
  }
  return null;
}

/** The exact accepted final TUI record may retire only the source occurrence it used. */
export async function consumeRestoredTerminalAction(
  continuation: RestoredSandboxContinuation,
  taskMirrorBinding: DraftAuthorityRestoredStartTaskMirrorBinding | undefined,
): Promise<DraftAuthorityEditReceipt | null> {
  if (!continuation.isCurrent() || continuation.action.kind === "landing-send") return null;
  const { actor, draft } = continuation.ready;
  const read = await readDraftAuthorityRestoredAction({ actor, draft });
  if (read.kind !== "current" || read.action.actionId !== continuation.action.actionId ||
      !continuation.isCurrent()) return null;
  const last = read.steps.at(-1);
  if (last?.effect.method !== "epic.createTuiAgent" || last.outcome?.kind !== "accepted")
    return null;
  const result = await consumeAcceptedRestoredStart({
    actor,
    claim: last.claim,
    isCurrent: () => continuation.isCurrent(),
    ...(taskMirrorBinding === undefined ? {} : { taskMirrorBinding }),
  });
  return (result.kind === "committed" || result.kind === "replayed") &&
    draftAuthorityActorIsCurrent(actor) && result.receipt.kind === "tombstone"
    ? result.receipt
    : null;
}
