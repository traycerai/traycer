import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingByHarnessId,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSendRequest,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";

/** Whether the agent the person asked for can take the message on the sandbox. */
export type RequestedAgentReadiness =
  /** Its availability is still being probed, or its install is in flight. */
  | { readonly kind: "waiting" }
  | { readonly kind: "ready" }
  /** It cannot run there: no sign-in on the configuration, or not offered. */
  | { readonly kind: "unusable" }
  /** Its install there failed; `detail` is the host's sentence for it. */
  | { readonly kind: "setup-failed"; readonly detail: string };

type HarnessRow = Pick<
  GuiHarnessOption,
  "id" | "enabled" | "available" | "availabilityPending"
>;

/**
 * The requested agent's readiness on the sandbox, from the sandbox host's own
 * harness catalog and provider list (sandboxes redesign Flow 1: the message
 * is delivered when the setup the requested agent needs is ready, not merely
 * when the control plane says awake). A install in flight or an availability
 * still being probed is a wait; a failed install and an agent that cannot run
 * there are refusals. Never another agent: the model the person picked is the
 * one the message runs on.
 */
export function requestedAgentReadiness(
  harnessId: GuiHarnessId,
  harnesses: ReadonlyArray<HarnessRow> | undefined,
  providers: ReadonlyArray<ProviderCliState> | undefined,
): RequestedAgentReadiness {
  if (harnesses === undefined || providers === undefined) {
    return { kind: "waiting" };
  }
  const preparing = providerPackPreparingByHarnessId(providers, null).get(
    harnessId,
  );
  if (preparing !== undefined && providerPackBlocksExecution(preparing)) {
    if (preparing.kind === "downloading") return { kind: "waiting" };
    const providerId = guiHarnessIdToProviderId(harnessId);
    return {
      kind: "setup-failed",
      detail: providerPackPreparingLabel(
        preparing,
        providerId === null ? harnessId : providerDisplayName(providerId),
      ),
    };
  }
  const harness = harnesses.find((row) => row.id === harnessId);
  if (harness === undefined || !harness.enabled) return { kind: "unusable" };
  if (harness.available) return { kind: "ready" };
  return harness.availabilityPending
    ? { kind: "waiting" }
    : { kind: "unusable" };
}

/** What a surface's send hands to its task. */
export interface PendingSandboxSendInput {
  /** The surface whose stage the send takes. */
  readonly fromSurfaceKey: string;
  readonly epicId: string;
  readonly request: PendingSandboxSendRequest;
  readonly content: JsonContent;
  readonly text: string;
  /** The person's pick, captured as it stands: never re-resolved on the sandbox. */
  readonly settings: ChatRunSettings;
  /** Whether the task already exists (`PendingSandboxSend.epicConfirmed`). */
  readonly epicConfirmed: boolean;
  readonly now: number;
}

/**
 * Hands a surface's staged send to its task: the stage moves, its create key
 * with it, under a pending send's key, and the message and its settings are
 * recorded beside it. The surface stages nothing after; the pending send's
 * driver runs the create, joining one already on its way under that key.
 * Returns the send's id, or `null` when the surface has no stage or its stage
 * is already in its handoff.
 */
export function handPendingSandboxSend(
  input: PendingSandboxSendInput,
): string | null {
  const stage = readStagedSandbox(input.fromSurfaceKey);
  if (stage === null || stage.phase === "handoff") return null;
  const id = uuidv4();
  const surfaceKey = pendingSendSurfaceKey(id);
  usePendingSandboxSendStore.getState().add({
    id,
    userId: useAuthStore.getState().profile?.userId ?? null,
    epicId: input.epicId,
    request: input.request,
    content: input.content,
    text: input.text,
    settings: input.settings,
    createdAt: input.now,
    epicConfirmed: input.epicConfirmed,
    delivery: null,
  });
  handedThisSession.add(id);
  const store = useStagedSandboxStore.getState();
  store.adopt(input.fromSurfaceKey, surfaceKey);
  // The message is this send's; a terminal asked for on the composer's stage
  // is dropped with the move.
  store.report(surfaceKey, {
    ownerId: null,
    sendTaken: true,
    terminalLaunch: null,
    openTerminal: false,
  });
  return id;
}

/**
 * The sends this window handed, whose task's create may still be on its way:
 * a send with no task yet waits for it here, and one rehydrated without it
 * lost that create.
 */
const handedThisSession = new Set<string>();

/** Whether this window handed the send (it was not rehydrated). */
export function pendingSandboxSendHandedHere(id: string): boolean {
  return handedThisSession.has(id);
}

/** The send's task was created: its sandbox may start. */
export function confirmPendingSandboxSendEpic(id: string): void {
  usePendingSandboxSendStore.getState().confirmEpic(id);
}

/** Ends a pending send: its stage and its record go; a sandbox it made stays. */
export function endPendingSandboxSend(id: string): void {
  useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(id));
  usePendingSandboxSendStore.getState().remove(id);
}

/**
 * The run settings of the agent the person picked, as the toolbar holds them.
 * The toolbar shows the first runnable agent in place of one this host cannot
 * run (`presentedHarnessSelection`), but a send to a sandbox runs there, not
 * here: it carries the person's own pick, and the sandbox says whether that
 * agent can run.
 */
export function pickedRunSettings(
  toolbar: Pick<
    ComposerToolbarState,
    "values" | "selection" | "permission" | "reasoning" | "serviceTier"
  >,
): ChatRunSettings {
  const picked = toolbar.values.selection;
  const shown = toolbar.selection.harnessId === picked.harnessId;
  return buildChatRunSettings({
    // A pick with no model yet takes the model shown for the same agent.
    selection:
      shown && picked.modelSlug.length === 0 ? toolbar.selection : picked,
    permission: shown ? toolbar.permission : toolbar.values.permission,
    reasoning: shown ? toolbar.reasoning : toolbar.values.reasoning,
    serviceTier: shown ? toolbar.serviceTier : toolbar.values.serviceTier,
  });
}
