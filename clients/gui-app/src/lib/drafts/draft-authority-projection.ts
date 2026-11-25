import {
  acknowledgeDraftAuthorityEditorWrite,
  readDraftAuthoritySlot,
  writeDraftAuthority,
  type WriteDraftAuthorityInput,
} from "./draft-authority";
import { mintDraftId } from "./draft-ids";
import type {
  DraftAuthorityLandingFlush,
  DraftAuthorityManifest,
  DraftAuthorityPayload,
  DraftAuthoritySlot,
  DraftAuthorityVersion,
} from "./draft-authority-types";

interface ProjectionWrite {
  readonly slot: DraftAuthoritySlot;
  readonly before: DraftAuthorityPayload | null;
  readonly after: DraftAuthorityPayload;
  readonly newOccurrence: string;
}

type ProjectionResult =
  | { readonly kind: "saved"; readonly draft: DraftAuthorityVersion }
  | { readonly kind: "conflict" | "unavailable" };

interface ProjectionAttempt {
  write: WriteDraftAuthorityInput | undefined;
  rebase: boolean;
}

interface ActiveProjection {
  result: Promise<ProjectionResult>;
  readonly previous: ActiveProjection | undefined;
  readonly attempt: ProjectionAttempt;
  readonly input: ProjectionWrite;
}

type MetadataReader = (payload: DraftAuthorityPayload) => {
  readonly manifest: DraftAuthorityManifest;
  readonly returnAccountId: string | null;
};

function sameField(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(
  before: DraftAuthorityPayload,
  after: DraftAuthorityPayload,
): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (field) =>
      Object.hasOwn(before, field) !== Object.hasOwn(after, field) ||
      !sameField(before[field], after[field]),
  );
}

function applyFields(
  current: DraftAuthorityPayload,
  before: DraftAuthorityPayload,
  after: DraftAuthorityPayload,
): DraftAuthorityPayload | null {
  const next = { ...current };
  for (const field of changedFields(before, after)) {
    if (
      Object.hasOwn(current, field) !== Object.hasOwn(before, field) ||
      !sameField(current[field], before[field])
    ) {
      return null;
    }
    if (Object.hasOwn(after, field)) next[field] = after[field];
    else delete next[field];
  }
  return next;
}

export class DraftAuthorityProjection {
  private readonly operations = new Map<string, ActiveProjection>();
  private readonly acknowledged = new Map<string, DraftAuthorityVersion>();
  private hydration: Promise<void> | null = null;

  constructor(private readonly metadata: MetadataReader) {}

  waitForHydration(hydration: Promise<void>): void {
    this.hydration = hydration;
    void hydration.finally(() => {
      if (this.hydration === hydration) this.hydration = null;
    });
  }

  observe(draft: DraftAuthorityVersion): void {
    this.acknowledged.set(draft.slot.id, draft);
  }

  knows(id: string): boolean {
    return this.acknowledged.has(id);
  }

  current(id: string): DraftAuthorityVersion | null {
    return this.busy(id) ? null : this.acknowledged.get(id) ?? null;
  }

  busy(id: string): boolean {
    return this.operations.has(id);
  }

  queue(input: ProjectionWrite): void {
    const id = input.slot.id;
    const previous = this.operations.get(id);
    const attempt: ProjectionAttempt = { write: undefined, rebase: true };
    const active: ActiveProjection = {
      previous,
      attempt,
      input,
      result: this.persistAfter(input, previous, attempt),
    };
    this.operations.set(id, active);
    this.removeSaved(active);
  }

  private removeSaved(active: ActiveProjection): void {
    const id = active.input.slot.id;
    void active.result.then((result) => {
      if (result.kind === "saved" && this.operations.get(id) === active) {
        this.operations.delete(id);
      }
    });
  }

  private continueProjection(active: ActiveProjection): Promise<ProjectionResult> {
    const retry = active.result.then(async (result) => {
      if (result.kind !== "unavailable") return result;
      if (active.previous !== undefined) {
        await this.continueProjection(active.previous);
      }
      return this.persistAfter(active.input, active.previous, active.attempt);
    });
    active.result = retry;
    return retry;
  }

  private async persistAfter(
    input: ProjectionWrite,
    previous: ActiveProjection | undefined,
    attempt: ProjectionAttempt,
  ): Promise<ProjectionResult> {
    await this.hydration;
    const prior = await previous?.result;
    if (prior !== undefined && prior.kind !== "saved") return prior;
    if (attempt.write !== undefined) {
      const replay = await this.commit(attempt.write);
      if (replay.kind !== "conflict" || !attempt.rebase) return replay;
      attempt.write = undefined;
      attempt.rebase = false;
    }

    const observed = prior?.draft ?? this.acknowledged.get(input.slot.id);
    const read = await readDraftAuthoritySlot(input.slot);
    if (read.kind === "unavailable") return { kind: "unavailable" };
    const current = read.kind === "current" ? read.record : null;
    const { before, after } = input;
    let payload = after;
    if (before !== null) {
      if (
        current?.kind !== "live" ||
        (observed === undefined
          ? changedFields(before, current.payload).length !== 0
          : observed.occurrence !== current.draft.occurrence)
      ) {
        return { kind: "conflict" };
      }
      const rebased = applyFields(current.payload, before, after);
      if (rebased === null) return { kind: "conflict" };
      payload = rebased;
    } else if (
      current?.kind === "live" ||
      (current?.kind === "tombstone" &&
        observed?.version !== current.draft.version)
    ) {
      return { kind: "conflict" };
    }

    const live = { payload, ...this.metadata(payload) };
    const write: WriteDraftAuthorityInput = {
      operation: { id: mintDraftId(), actor: null },
      expected:
        current === null
          ? { kind: "absent", slot: input.slot }
          : { kind: "current", draft: current.draft },
      mutation:
        before === null
          ? { kind: "replace", occurrence: input.newOccurrence, ...live }
          : { kind: "edit", ...live },
    };
    attempt.write = write;
    const result = await this.commit(write);
    if (result.kind === "conflict" && before !== null && attempt.rebase) {
      attempt.write = undefined;
      attempt.rebase = false;
      return this.persistAfter(input, previous, attempt);
    }
    return result;
  }

  private async commit(write: WriteDraftAuthorityInput): Promise<ProjectionResult> {
    const result = await writeDraftAuthority(write);
    if (result.kind === "committed" || result.kind === "replayed") {
      this.observe(result.receipt.draft);
      void acknowledgeDraftAuthorityEditorWrite(result.receipt);
      return { kind: "saved", draft: result.receipt.draft };
    }
    return {
      kind: result.kind === "conflict" || result.kind === "invalid"
        ? "conflict"
        : "unavailable",
    };
  }

  async flush(slot: DraftAuthoritySlot): Promise<DraftAuthorityLandingFlush> {
    const active = this.operations.get(slot.id);
    if (active !== undefined) {
      this.continueProjection(active);
      this.removeSaved(active);
    }
    const result = await active?.result;
    if (result !== undefined && result.kind !== "saved") return result;
    if (active !== undefined && this.operations.has(slot.id)) {
      return { kind: "conflict" };
    }
    const observed = result?.draft ?? this.acknowledged.get(slot.id);
    if (observed === undefined) return { kind: "unavailable" };

    const read = await readDraftAuthoritySlot(slot);
    if (read.kind === "unavailable") return { kind: "unavailable" };
    if (
      read.kind !== "current" ||
      read.record.kind !== "live" ||
      read.record.draft.occurrence !== observed.occurrence ||
      read.record.draft.version !== observed.version ||
      this.operations.has(slot.id)
    ) {
      return { kind: "conflict" };
    }
    return {
      kind: "committed",
      draft: read.record.draft,
      manifest: read.record.manifest,
    };
  }
}
