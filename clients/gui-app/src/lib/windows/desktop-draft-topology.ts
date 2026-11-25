import { readCanonicalLandingDraft } from "@/stores/home/landing-draft-store";
import type { DraftAuthorityReference } from "@/lib/drafts/draft-authority-types";
import type {
  DesktopLandingDraftReference,
  DesktopPerWindowSnapshot,
  DesktopUpdateWindowDraftReferencesRequest,
  DesktopWindowDraftReferenceEdit,
  DesktopWindowDraftTopology,
  DesktopWindowDraftTopologyResult,
  DesktopWindowsBridge,
} from "./types";

interface DesktopDraftTopologyBinding {
  readonly bridge: DesktopWindowsBridge;
  readonly apply: (snapshot: DesktopPerWindowSnapshot) => Promise<boolean>;
  topology: DesktopWindowDraftTopology | undefined;
  attachReady: boolean;
}

let binding: DesktopDraftTopologyBinding | null = null;
let draftAttachNegotiation: object | null = null;

export function holdDesktopDraftAttachDuringNegotiation(): () => void {
  const negotiation = {};
  draftAttachNegotiation = negotiation;
  return () => {
    if (draftAttachNegotiation === negotiation) draftAttachNegotiation = null;
  };
}

export function markDesktopDraftAttachReady(bridge: DesktopWindowsBridge): void {
  if (binding?.bridge === bridge) binding.attachReady = true;
}

export function bindDesktopDraftTopology(
  bridge: DesktopWindowsBridge,
  apply: (snapshot: DesktopPerWindowSnapshot) => Promise<boolean>,
): () => void {
  const installed: DesktopDraftTopologyBinding = {
    bridge,
    apply,
    topology: undefined,
    attachReady: false,
  };
  binding = installed;
  return () => {
    if (binding === installed) binding = null;
  };
}

export function usesDesktopDraftTopology(bridge: DesktopWindowsBridge): boolean {
  return binding?.bridge === bridge;
}

export function observeDesktopDraftTopology(
  bridge: DesktopWindowsBridge,
  topology: DesktopWindowDraftTopology,
): void {
  if (binding?.bridge === bridge) binding.topology = topology;
}

export function currentDesktopDraftTopology(
  bridge: DesktopWindowsBridge,
): DesktopWindowDraftTopology | undefined {
  return binding?.bridge === bridge ? binding.topology : undefined;
}

export async function refreshDesktopDraftTopology(
  bridge: DesktopWindowsBridge,
): Promise<boolean> {
  const current = binding;
  if (current?.bridge !== bridge) return false;
  const snapshot = await bridge.perWindowState.get();
  return binding === current && current.apply(snapshot);
}

export interface DesktopDraftAttachInput {
  readonly references: readonly DraftAuthorityReference[];
  readonly activateDraftId: string | null;
  readonly isCurrent: () => boolean;
}

export type DesktopDraftAttachResult =
  | { readonly kind: "attached"; readonly topologyRevision: number }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" };

export type DesktopDraftAttachAdmission =
  | { readonly kind: "legacy" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      attach(input: DesktopDraftAttachInput): Promise<DesktopDraftAttachResult>;
    };

/** Capture at the explicit create or reopen gesture, before any async work. */
export function beginDesktopDraftAttach(): DesktopDraftAttachAdmission {
  const current = binding;
  if (current === null) {
    return { kind: draftAttachNegotiation === null ? "legacy" : "unavailable" };
  }
  const topology = current.topology;
  const perWindowState = current.bridge.perWindowState;
  const update = perWindowState.updateDraftReferences?.bind(perWindowState);
  if (!current.attachReady || topology === undefined || update === undefined) {
    return { kind: "unavailable" };
  }

  let used = false;
  return {
    kind: "ready",
    attach: async (input) => {
      if (used) return { kind: "conflict" };
      used = true;
      return attachDesktopDraftReferences(current, topology, update, input);
    },
  };
}

async function attachDesktopDraftReferences(
  current: DesktopDraftTopologyBinding,
  observed: DesktopWindowDraftTopology,
  update: (
    request: DesktopUpdateWindowDraftReferencesRequest,
  ) => Promise<DesktopWindowDraftTopologyResult>,
  input: DesktopDraftAttachInput,
): Promise<DesktopDraftAttachResult> {
  const { bridge } = current;
  const isCurrent = (): boolean => binding === current && input.isCurrent();
  const originalTopologyIsCurrent = (): boolean =>
    isCurrent() && current.topology?.revision === observed.revision;
  if (!originalTopologyIsCurrent() || input.references.length === 0) {
    return { kind: "conflict" };
  }

  const expected = new Map(observed.references.map((ref) => [ref.slotId, ref]));
  const edits: DesktopWindowDraftReferenceEdit[] = [];
  for (const reference of input.references) {
    if (reference.slot.kind !== "landing") return { kind: "conflict" };
    const ref = toDesktopLandingDraftReference(reference);
    const existing = expected.get(ref.slotId);
    if (existing !== undefined) {
      if (!sameDesktopDraftReference(existing, ref)) return { kind: "conflict" };
      continue;
    }
    edits.push({ kind: "attach", ref });
    expected.set(ref.slotId, { ...ref, moveToken: null });
  }
  const activeDraftId = edits.some(
    ({ ref }) => ref.slotId === input.activateDraftId,
  )
    ? input.activateDraftId
    : observed.activeDraftId;
  const topologyRevision = observed.revision + (edits.length === 0 ? 0 : 1);

  const admitted = await admitCanonicalAttachReferences(input.references);
  if (admitted !== "live") return { kind: admitted };
  if (!originalTopologyIsCurrent()) return { kind: "conflict" };

  let replyUnverified = false;
  if (edits.length > 0) {
    const request: DesktopUpdateWindowDraftReferencesRequest = {
      expectedTopologyRevision: observed.revision,
      edits,
      activeDraftId,
    };
    try {
      const result = await update(request);
      if (result.result !== "committed") return { kind: result.result };
      if (result.revision !== topologyRevision) return { kind: "conflict" };
    } catch {
      // The sender may already have committed. Prove the exact resulting
      // topology below without issuing a second mutation.
      replyUnverified = true;
    }
  }
  if (!isCurrent()) return { kind: "conflict" };

  try {
    const snapshot = await bridge.perWindowState.get();
    const topology = snapshot.draftTopology;
    if (!isCurrent()) return { kind: "conflict" };
    if (
      topology?.revision !== topologyRevision ||
      topology.activeDraftId !== activeDraftId ||
      topology.references.length !== expected.size ||
      !topology.references.every((ref) => {
        const intended = expected.get(ref.slotId);
        return (
          intended !== undefined &&
          sameDesktopDraftReference(intended, ref) &&
          intended.moveToken === ref.moveToken
        );
      })
    ) {
      return {
        kind:
          replyUnverified && topology?.revision === observed.revision
            ? "unavailable"
            : "conflict",
      };
    }
    if (!(await current.apply(snapshot))) return { kind: "unavailable" };
    // Projection deliberately skips missing or replaced records. Successful
    // application alone does not admit the occurrence for this gesture.
    const reread = await admitCanonicalAttachReferences(input.references);
    if (reread !== "live") return { kind: reread };
    if (!isCurrent() || current.topology?.revision !== topologyRevision) {
      return { kind: "conflict" };
    }
    return { kind: "attached", topologyRevision };
  } catch {
    return { kind: "unavailable" };
  }
}

async function admitCanonicalAttachReferences(
  references: readonly DraftAuthorityReference[],
): Promise<"live" | "conflict" | "unavailable"> {
  try {
    const results = await Promise.all(references.map(readCanonicalLandingDraft));
    if (results.some(({ kind }) => kind === "unavailable")) return "unavailable";
    return results.every(({ kind }) => kind === "live") ? "live" : "conflict";
  } catch {
    return "unavailable";
  }
}

export function sameDesktopDraftReference(
  left: DesktopLandingDraftReference,
  right: DesktopLandingDraftReference,
): boolean {
  return left.slotId === right.slotId && left.occurrenceId === right.occurrenceId;
}

export function toCanonicalLandingDraftReference(
  ref: DesktopLandingDraftReference,
): DraftAuthorityReference {
  return { slot: { kind: "landing", id: ref.slotId }, occurrence: ref.occurrenceId };
}

export function toDesktopLandingDraftReference(
  ref: DraftAuthorityReference,
): DesktopLandingDraftReference {
  return { slotId: ref.slot.id, occurrenceId: ref.occurrence };
}
