import { createStore, type StoreApi } from "zustand/vanilla";
import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { EMPTY_LANDING_DRAFT_CONTENT } from "./landing-draft-content";

const DRAFT_CONTENT_DEBOUNCE_MS = 300;

export interface DraftRuntimeSourceDraft {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
}

export interface DraftRuntimeSource {
  readonly read: (draftId: string) => DraftRuntimeSourceDraft | null;
  readonly write: (
    draftId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  /**
   * Durably persists a caret move alone. Kept separate from `write` so a
   * selection-only debounced flush never reaches a content-comparing writer
   * (`setDraftContent`'s `sameJsonContent`) - it must stay O(1), never
   * O(document-size), even for a multi-megabyte inline-image draft.
   */
  readonly writeSelection: (
    draftId: string,
    selection: DraftSelection | null,
  ) => void;
}

export interface DraftSubmissionAttempt {
  readonly id: string;
  readonly draftId: string;
  readonly content: JsonContent;
  readonly contentRevision: number;
  readonly placement: DraftSubmissionPlacement;
  readonly attachmentRoots: ReadonlySet<string>;
  readonly abortController: AbortController;
  /** Identity/window lifetime at intent. Teardown retires this generation. */
  readonly settlementGeneration: number;
  createStarted: boolean;
}

/** Intent-time routing evidence; final placement intentionally re-reads state. */
export interface DraftSubmissionPlacement {
  readonly refKey: string;
  readonly activeItemId: string | null;
  readonly focusedRefKey: string | null;
  readonly layoutRevision: string;
}

export interface DraftRuntimeState {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
  readonly contentRevision: number;
  readonly attachmentRoots: ReadonlySet<string>;
  readonly isSubmitting: boolean;
}

/**
 * A started create may settle after the draft has been closed, but never after
 * the renderer identity/window that started it has been torn down. Keep those
 * cases distinct: the former needs one discoverable background result, while
 * the latter must be invisible to the next identity.
 */
export type DraftSubmissionSettlement =
  | { readonly kind: "current" }
  | { readonly kind: "closed" }
  | { readonly kind: "content-changed" }
  | { readonly kind: "retired" };

/**
 * A pending durable write is either a document mutation (content + the
 * selection alongside it) or a pure selection move. Keeping them distinct
 * lets `flush()` route each to the correct source capability - a selection
 * move following a still-unflushed document write coalesces into that same
 * document operation's selection (one `write` call lands both, and the
 * pending content is never dropped); a selection move with nothing else
 * pending stays a standalone selection-only operation through to
 * `writeSelection`.
 */
type PendingDraftWrite =
  | {
      readonly kind: "document";
      readonly content: JsonContent;
      readonly selection: DraftSelection | null;
    }
  | {
      readonly kind: "selection";
      readonly selection: DraftSelection | null;
    };

export class DraftRuntime {
  readonly store: StoreApi<DraftRuntimeState>;
  private pending: PendingDraftWrite | null = null;
  private timer: number | null = null;
  private attempt: DraftSubmissionAttempt | null = null;
  private attachmentCount = 0;
  private closed = false;

  constructor(
    readonly draftId: string,
    initial: DraftRuntimeSourceDraft,
    private readonly source: () => DraftRuntimeSource | null,
    private readonly settlementGeneration: () => number,
  ) {
    this.store = createStore<DraftRuntimeState>(() => ({
      content: initial.content,
      selection: initial.selection,
      contentRevision: 0,
      attachmentRoots: imageHashes(initial.content),
      isSubmitting: false,
    }));
  }

  attach(): void {
    this.attachmentCount += 1;
  }

  detach(): void {
    this.flush();
    this.attachmentCount = Math.max(0, this.attachmentCount - 1);
  }

  attached(): boolean {
    return this.attachmentCount > 0;
  }

  /**
   * Records a real document mutation. Callers must only invoke this from the
   * editor boundary's document-change signal (Tiptap's own `docChanged`-gated
   * `update` event) - never a selection-only echo - so every call
   * unconditionally bumps `contentRevision` without comparing content.
   * `contentRevision` answers "did the user change what was sent?", so a
   * caret move must go through `setSelection` instead and leave it alone.
   */
  setSnapshot(content: JsonContent, selection: DraftSelection | null): void {
    const current = this.store.getState();
    this.pending = { kind: "document", content, selection };
    this.scheduleFlush();
    this.store.setState({
      content,
      selection,
      contentRevision: current.contentRevision + 1,
      attachmentRoots: imageHashes(content),
    });
  }

  /**
   * Persists a caret move alone. Never touches `contentRevision` or compares
   * /serializes `content`. A document write already pending (not yet
   * flushed) absorbs this selection instead of being replaced - the flush
   * still lands the newer content, just with the latest caret alongside it.
   * With nothing else pending, this schedules a standalone selection-only
   * flush through `writeSelection`, never a content-comparing writer, so a
   * (possibly multi-megabyte inline-image) document is never walked.
   */
  setSelection(selection: DraftSelection | null): void {
    const current = this.store.getState();
    if (sameSelection(current.selection, selection)) return;
    this.pending =
      this.pending?.kind === "document"
        ? { ...this.pending, selection }
        : { kind: "selection", selection };
    this.scheduleFlush();
    this.store.setState({ selection });
  }

  private scheduleFlush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(
      () => this.flush(),
      DRAFT_CONTENT_DEBOUNCE_MS,
    );
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const pending = this.pending;
    this.pending = null;
    if (pending.kind === "document") {
      this.source()?.write(this.draftId, pending.content, pending.selection);
    } else {
      this.source()?.writeSelection(this.draftId, pending.selection);
    }
  }

  startSubmission(
    placement: DraftSubmissionPlacement,
  ): DraftSubmissionAttempt | null {
    if (this.attempt !== null || this.closed) return null;
    this.flush();
    if (this.source()?.read(this.draftId) === null) return null;
    const snapshot = this.store.getState();
    const attempt: DraftSubmissionAttempt = {
      id: uuidv4(),
      draftId: this.draftId,
      content: snapshot.content,
      contentRevision: snapshot.contentRevision,
      placement,
      attachmentRoots: new Set(snapshot.attachmentRoots),
      abortController: new AbortController(),
      settlementGeneration: this.settlementGeneration(),
      createStarted: false,
    };
    this.attempt = attempt;
    this.store.setState({ isSubmitting: true });
    return attempt;
  }

  canStartCreate(attempt: DraftSubmissionAttempt): boolean {
    const current = this.store.getState();
    return (
      this.attempt?.id === attempt.id &&
      !attempt.abortController.signal.aborted &&
      !this.closed &&
      current.contentRevision === attempt.contentRevision &&
      this.source()?.read(this.draftId) !== null
    );
  }

  markCreateStarted(attempt: DraftSubmissionAttempt): boolean {
    if (!this.canStartCreate(attempt)) return false;
    attempt.createStarted = true;
    return true;
  }

  settlement(attempt: DraftSubmissionAttempt): DraftSubmissionSettlement {
    if (this.attempt?.id !== attempt.id) return { kind: "closed" };
    if (this.store.getState().contentRevision !== attempt.contentRevision) {
      return { kind: "content-changed" };
    }
    if (this.source()?.read(this.draftId) === null) {
      return { kind: "closed" };
    }
    return { kind: "current" };
  }

  ownsAttempt(attempt: DraftSubmissionAttempt): boolean {
    return this.draftId === attempt.draftId && this.attempt?.id === attempt.id;
  }

  finishSubmission(attempt: DraftSubmissionAttempt): boolean {
    if (!this.ownsAttempt(attempt)) return false;
    this.attempt = null;
    this.store.setState({ isSubmitting: false });
    return true;
  }

  close(): void {
    this.flush();
    this.closed = true;
    if (this.attempt !== null) {
      this.attempt.abortController.abort();
      if (!this.attempt.createStarted) this.finishSubmission(this.attempt);
    }
  }

  canDispose(): boolean {
    return !this.attached() && this.attempt === null;
  }

  roots(): ReadonlySet<string> {
    const roots = new Set(this.store.getState().attachmentRoots);
    // A pending selection-only write carries no content of its own - the
    // store's current `attachmentRoots` above already covers it.
    if (this.pending?.kind === "document") {
      for (const hash of imageHashes(this.pending.content)) roots.add(hash);
    }
    if (this.attempt !== null) {
      for (const hash of this.attempt.attachmentRoots) roots.add(hash);
    }
    return roots;
  }

  contents(): ReadonlyArray<JsonContent> {
    const contents: JsonContent[] = [this.store.getState().content];
    if (this.pending?.kind === "document") contents.push(this.pending.content);
    if (this.attempt !== null) contents.push(this.attempt.content);
    return contents;
  }
}

/**
 * Renderer-local runtime owner. It is deliberately module-local rather than
 * persisted: recovery hydrates only this window's durable drafts and can never
 * pull a mirror, pending writer, or submission from another renderer window.
 */
export class DraftRuntimeRegistry {
  private source: DraftRuntimeSource | null = null;
  private readonly runtimes = new Map<string, DraftRuntime>();
  /** Retired runtimes keep committed-attempt image roots until settlement. */
  private readonly retiredRuntimes = new Set<DraftRuntime>();
  private generation = 0;

  configure(source: DraftRuntimeSource): void {
    this.source = source;
  }

  getOrHydrate(draftId: string | null): DraftRuntime | null {
    if (draftId === null) return null;
    const existing = this.runtimes.get(draftId);
    if (existing !== undefined) return existing;
    const durable = this.source?.read(draftId);
    if (durable === null || durable === undefined) return null;
    const runtime = new DraftRuntime(
      draftId,
      durable,
      () => this.source,
      () => this.generation,
    );
    this.runtimes.set(draftId, runtime);
    return runtime;
  }

  attach(draftId: string | null): DraftRuntime | null {
    const runtime = this.getOrHydrate(draftId);
    runtime?.attach();
    return runtime;
  }

  detach(draftId: string | null): void {
    if (draftId === null) return;
    const runtime = this.runtimes.get(draftId);
    if (runtime === undefined) return;
    runtime.detach();
    if (runtime.canDispose()) this.runtimes.delete(draftId);
  }

  flush(draftId: string | null): void {
    if (draftId === null) return;
    this.runtimes.get(draftId)?.flush();
  }

  close(draftId: string): void {
    const runtime = this.runtimes.get(draftId);
    if (runtime === undefined) return;
    runtime.close();
    if (runtime.canDispose()) this.runtimes.delete(draftId);
  }

  complete(attempt: DraftSubmissionAttempt): void {
    const runtime = this.runtimeOwning(attempt);
    if (runtime === null || !runtime.finishSubmission(attempt)) return;
    if (this.retiredRuntimes.delete(runtime)) return;
    if (
      runtime.canDispose() &&
      this.runtimes.get(attempt.draftId) === runtime
    ) {
      this.runtimes.delete(attempt.draftId);
    }
  }

  settlement(attempt: DraftSubmissionAttempt): DraftSubmissionSettlement {
    if (attempt.settlementGeneration !== this.generation) {
      return { kind: "retired" };
    }
    const runtime = this.runtimeOwning(attempt);
    if (runtime === null) return { kind: "closed" };
    return runtime.settlement(attempt);
  }

  private runtimeOwning(attempt: DraftSubmissionAttempt): DraftRuntime | null {
    const current = this.runtimes.get(attempt.draftId);
    if (current !== undefined && current.ownsAttempt(attempt)) return current;
    return (
      Array.from(this.retiredRuntimes).find((candidate) =>
        candidate.ownsAttempt(attempt),
      ) ?? null
    );
  }

  teardown(): void {
    this.generation += 1;
    for (const runtime of this.runtimes.values()) {
      runtime.flush();
      runtime.close();
      if (runtime.canDispose()) continue;
      this.retiredRuntimes.add(runtime);
    }
    this.runtimes.clear();
  }

  liveImageRoots(): ReadonlySet<string> {
    const roots = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      for (const hash of runtime.roots()) roots.add(hash);
    }
    for (const runtime of this.retiredRuntimes) {
      for (const hash of runtime.roots()) roots.add(hash);
    }
    return roots;
  }

  liveContents(): ReadonlyArray<JsonContent> {
    return [...this.runtimes.values(), ...this.retiredRuntimes].flatMap(
      (runtime) => runtime.contents(),
    );
  }

  resetForTesting(): void {
    for (const runtime of this.runtimes.values()) runtime.close();
    for (const runtime of this.retiredRuntimes) runtime.close();
    this.runtimes.clear();
    this.retiredRuntimes.clear();
    this.generation = 0;
  }
}

export const draftRuntimeRegistry = new DraftRuntimeRegistry();

export function imageHashes(content: JsonContent): Set<string> {
  const hashes = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash !== null) hashes.add(atom.hash);
  }
  return hashes;
}

export const EMPTY_DRAFT_RUNTIME_CONTENT: JsonContent =
  EMPTY_LANDING_DRAFT_CONTENT;

function sameSelection(
  left: DraftSelection | null,
  right: DraftSelection | null,
): boolean {
  return left?.from === right?.from && left?.to === right?.to;
}
