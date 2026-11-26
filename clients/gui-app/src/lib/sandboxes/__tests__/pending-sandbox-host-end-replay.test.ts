import { expect, it, onTestFinished } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  claimDraftAuthorityEffect,
  publishDraftAuthorityOutbox,
  readDraftAuthorityOutbox,
  transferDraftAuthorityOutbox,
  type DraftAuthorityHostEndEvidence,
} from "@/lib/drafts/draft-authority-pending";
import { captureDraftAuthorityActor } from "@/lib/drafts/draft-authority-session";
import {
  pendingSandboxDispatchEffect,
  settlePendingSandboxOutboxEnd,
} from "@/lib/sandboxes/pending-sandbox-authority";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  usePendingSandboxSendStore,
  type PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { pendingSend } from "./pending-send-fixtures";

it("acknowledges the same non-delivery after the bound host-end hold commits", async () => {
  const send = pendingSend({ id: "host-end-replay" });
  const indexedDB = globalThis.indexedDB;
  const keyRange = globalThis.IDBKeyRange;
  onTestFinished(() => {
    globalThis.indexedDB = indexedDB;
    globalThis.IDBKeyRange = keyRange;
    usePendingSandboxSendStore.getState().remove(send.id);
    useAuthStore.getState().setSignedOut();
  });
  installFreshIndexedDb();
  useAuthStore.getState().setSignedIn(
    { userId: "user-1", userName: "U", email: "u@example.com" },
    { userId: "user-1", username: "U" },
    [],
  );
  const actor = captureDraftAuthorityActor();
  if (actor === null) throw new Error("Expected the signed-in actor");

  const published = await publishDraftAuthorityOutbox({
    actor,
    actionId: send.id,
    expectedSource: null,
    send,
    manifest: { digests: [] },
    verified: [],
  });
  if (published.kind !== "committed")
    throw new Error(`Expected published custody, got ${published.kind}`);

  const delivery = {
    chatId: "chat-1",
    hostId: "sandbox-host",
    sandboxId: "sandbox-1",
    readySeconds: 1,
  };
  const setupAttempt = { attemptId: "setup-1", observationGeneration: 23 };
  const dispatch: PendingSandboxSendDispatch = {
    input: {
      epicId: send.epicId,
      hostId: delivery.hostId,
      chatId: delivery.chatId,
      parentId: null,
      title: "",
      settings: send.settings,
      workspaceMode: "folderless",
      worktreeIntent: null,
      initialMessage: {
        messageId: "message-1",
        clientActionId: send.id,
        content: send.content,
        sender: { type: "user", userId: actor.accountId },
        settings: send.settings,
        accountContext: { type: "PERSONAL" },
        sentFromHostId: null,
      },
    },
    delivery,
    setupAttempt,
    status: "sending",
  };
  const transferred = await transferDraftAuthorityOutbox({
    actor,
    operationId: "prepare-dispatch",
    sendId: send.id,
    expectedGeneration: published.receipt.generation,
    dispatch,
  });
  if (transferred.kind !== "committed")
    throw new Error(`Expected transferred custody, got ${transferred.kind}`);

  const grant = await claimDraftAuthorityEffect({
    actor,
    operationId: "issue-dispatch",
    source: {
      kind: "pending-outbox",
      sendId: send.id,
      generation: transferred.receipt.generation,
    },
    effect: pendingSandboxDispatchEffect(send, dispatch),
    expectedIssueGeneration: null,
    recovery: "initial",
  });
  if (grant.kind !== "committed")
    throw new Error(`Expected an issue grant, got ${grant.kind}`);

  const evidence: DraftAuthorityHostEndEvidence = {
    kind: "signed-terminal",
    ownership: "dispatch",
    hostId: delivery.hostId,
    sandboxId: delivery.sandboxId,
    attemptId: setupAttempt.attemptId,
    observationGeneration: 24,
    proofId: "terminal-observation-24",
  };
  const result = {
    actor,
    claim: grant.receipt,
    evidence,
    undeliveredProofId: "exact-refusal-of-issue-dispatch",
  };
  expect(await settlePendingSandboxOutboxEnd(result)).toBe(true);

  const read = { actor, sendId: send.id };
  const held = await readDraftAuthorityOutbox(read);
  expect(held).toMatchObject({
    kind: "current",
    outbox: {
      ownership: "dispatch",
      generation: transferred.receipt.generation + 2,
      decision: { kind: "held", reason: "host-end" },
    },
  });

  const replayEvidence: DraftAuthorityHostEndEvidence = {
    proofId: evidence.proofId,
    observationGeneration: evidence.observationGeneration,
    attemptId: evidence.attemptId,
    sandboxId: evidence.sandboxId,
    hostId: evidence.hostId,
    ownership: evidence.ownership,
    kind: evidence.kind,
  };
  expect(await settlePendingSandboxOutboxEnd({
    ...result,
    evidence: replayEvidence,
  })).toBe(true);
  expect(await settlePendingSandboxOutboxEnd({
    ...result,
    claim: { ...result.claim, executorId: "another-executor" },
  })).toBe(false);
  expect(await settlePendingSandboxOutboxEnd({
    ...result,
    evidence: { ...replayEvidence, observationGeneration: 25 },
  })).toBe(false);
  expect(await settlePendingSandboxOutboxEnd({
    ...result,
    undeliveredProofId: "another-refusal",
  })).toBe(false);
  expect(await readDraftAuthorityOutbox(read)).toEqual(held);
});
