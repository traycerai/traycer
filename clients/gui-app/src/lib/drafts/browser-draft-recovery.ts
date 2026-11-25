import {
  jsonContentRecordV100,
  type JsonContent,
} from "@traycer/protocol/common/registry";

import type { AnalyticsDraftInput } from "@/lib/analytics";
import {
  parseBrowserAnnotationRecord,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import { LANDING_DRAFT_TITLE_FALLBACK } from "@/lib/composer/landing-draft-title";
import {
  listDraftAuthorityRecoveryPreviews,
  readDraftAuthorityRecovery,
} from "@/lib/drafts/draft-authority";
import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import type {
  DraftAuthorityActor,
  DraftAuthorityManifest,
  DraftAuthorityPayload,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";

export interface BrowserDraftRecoveryPayload {
  readonly content: JsonContent;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
}

/** Decode the whole recovery payload or hold it, including textless drafts. */
export function decodeBrowserDraftRecoveryPayload(
  content: unknown,
  annotations: unknown,
): BrowserDraftRecoveryPayload | null {
  const document = jsonContentRecordV100.schema.safeParse(content);
  if (
    !document.success ||
    document.data.type !== "doc" ||
    !Array.isArray(annotations)
  ) {
    return null;
  }

  const browserAnnotations: BrowserAnnotationRecord[] = [];
  const seen = new Set<string>();
  for (const value of annotations) {
    const record = parseBrowserAnnotationRecord(value);
    if (
      record === null ||
      seen.has(record.annotationId) ||
      (record.imageHash === null) !== (record.imageFileName === null)
    ) {
      return null;
    }
    seen.add(record.annotationId);
    browserAnnotations.push(record);
  }
  return { content: document.data, browserAnnotations };
}

export interface BrowserDraftRecoverySubmission {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly payload: DraftAuthorityPayload;
  readonly manifest: DraftAuthorityManifest;
  readonly bytes: ReadonlyMap<string, Blob>;
}

export type BrowserDraftRecoverySubmitResult = {
  readonly kind:
    | "accepted"
    | "held"
    | "stale"
    | "denied"
    | "missing-bytes"
    | "unavailable";
};

export type BrowserDraftRecoveryResubmit = (
  submission: BrowserDraftRecoverySubmission,
) => Promise<BrowserDraftRecoverySubmitResult>;

type BrowserDraftRecoveryRead =
  | {
      readonly kind: "live";
      readonly submission: BrowserDraftRecoverySubmission;
      readonly content: JsonContent;
    }
  | {
      readonly kind:
        | "missing"
        | "stale"
        | "denied"
        | "missing-bytes"
        | "unavailable"
        | "held";
    };

/** Read the version selected by the row, with its complete rooted bytes. */
export async function readExactBrowserDraftRecovery(
  actor: DraftAuthorityActor,
  expected: DraftAuthorityVersion,
): Promise<BrowserDraftRecoveryRead> {
  if (expected.slot.kind !== "landing" || !draftAuthorityActorIsCurrent(actor)) {
    return { kind: "denied" };
  }

  const result = await readDraftAuthorityRecovery({
    actor,
    reference: expected,
  });
  if (!draftAuthorityActorIsCurrent(actor)) return { kind: "denied" };
  if (result.kind !== "live") return result;

  const { draft, payload, manifest, bytes } = result;
  if (
    draft.slot.kind !== expected.slot.kind ||
    draft.slot.id !== expected.slot.id ||
    draft.occurrence !== expected.occurrence ||
    draft.version !== expected.version
  ) {
    return { kind: "stale" };
  }

  const decoded = decodeBrowserDraftRecoveryPayload(
    payload.content,
    payload.browserAnnotations,
  );
  if (decoded === null) return { kind: "held" };

  return {
    kind: "live",
    submission: { actor, draft, payload, manifest, bytes },
    content: decoded.content,
  };
}

/** Recheck the reviewed snapshot before passing it to the shared issue claim. */
export async function resubmitBrowserDraftRecovery(
  reviewed: BrowserDraftRecoverySubmission,
  onResubmit: BrowserDraftRecoveryResubmit,
): Promise<BrowserDraftRecoverySubmitResult> {
  const current = await readExactBrowserDraftRecovery(
    reviewed.actor,
    reviewed.draft,
  );
  if (current.kind !== "live") {
    return { kind: current.kind === "missing" ? "stale" : current.kind };
  }
  if (!draftAuthorityActorIsCurrent(reviewed.actor)) return { kind: "denied" };
  return onResubmit(reviewed);
}

export type BrowserDraftRecoveryRow = Extract<
  DraftInventoryRow,
  { readonly kind: "landing" }
> & {
  readonly ownerHostId: null;
  readonly foreign: false;
  readonly recovery: { readonly reference: DraftAuthorityVersion };
};

export type DraftsViewRow = DraftInventoryRow | BrowserDraftRecoveryRow;

export async function listBrowserDraftRecoveryRows(
  actor: DraftAuthorityActor,
): Promise<ReadonlyArray<BrowserDraftRecoveryRow> | null> {
  const previews = await listDraftAuthorityRecoveryPreviews(actor);
  if (previews === null || !draftAuthorityActorIsCurrent(actor)) return null;
  return previews.map(({ draft, preview, lastEditedAt }) => ({
    kind: "landing",
    id: draft.slot.id,
    preview: preview || LANDING_DRAFT_TITLE_FALLBACK,
    content: { type: "doc" },
    lastTouchedAt: lastEditedAt ?? 0,
    open: false,
    ownerHostId: null,
    foreign: false,
    recovery: { reference: draft },
  }));
}

export interface BrowserDraftRecoveryEditor {
  readonly submission: BrowserDraftRecoverySubmission;
  readonly onResubmit: () => Promise<BrowserDraftRecoverySubmitResult>;
}

export interface DraftsRecoveryRoute {
  readonly actor: DraftAuthorityActor;
  readonly rows: ReadonlyArray<BrowserDraftRecoveryRow>;
  readonly onOpen: (
    editor: BrowserDraftRecoveryEditor,
    input: AnalyticsDraftInput,
  ) => void;
  readonly onResubmit: BrowserDraftRecoveryResubmit;
  readonly onDelete: (
    reference: DraftAuthorityVersion,
    input: AnalyticsDraftInput,
  ) => void;
}

export function draftsRecoveryRouteIsCurrent(
  route: DraftsRecoveryRoute | undefined,
): route is DraftsRecoveryRoute {
  return route !== undefined && draftAuthorityActorIsCurrent(route.actor);
}

export function mergeDraftsRecoveryRows(
  rows: ReadonlyArray<DraftInventoryRow>,
  route: DraftsRecoveryRoute | undefined,
  activeDraftId: string | null,
): ReadonlyArray<DraftsViewRow> {
  if (route === undefined || route.rows.length === 0) return rows;

  const protectedIds = new Set(route.rows.map((row) => row.id));
  const ordinary = rows.filter(
    (row) => row.kind !== "landing" || !protectedIds.has(row.id),
  );
  if (!draftsRecoveryRouteIsCurrent(route)) return ordinary;

  return [
    ...ordinary,
    ...route.rows.filter((row) => row.id !== activeDraftId),
  ].sort(
    (left, right) =>
      right.lastTouchedAt - left.lastTouchedAt ||
      left.id.localeCompare(right.id),
  );
}

export async function openBrowserDraftRecovery(
  route: DraftsRecoveryRoute,
  row: BrowserDraftRecoveryRow,
  input: AnalyticsDraftInput,
  commitOpen: () => boolean,
): Promise<void> {
  const expected = row.recovery.reference;
  if (expected.slot.id !== row.id) return;
  const read = await readExactBrowserDraftRecovery(route.actor, expected);
  if (
    read.kind !== "live" ||
    !draftAuthorityActorIsCurrent(route.actor) ||
    !commitOpen()
  ) {
    return;
  }
  route.onOpen(
    {
      submission: read.submission,
      onResubmit: () =>
        resubmitBrowserDraftRecovery(read.submission, route.onResubmit),
    },
    input,
  );
}

/** Copy uses the exact document through the same account-qualified read as Open. */
export async function copyBrowserDraftRecovery(
  route: DraftsRecoveryRoute,
  row: BrowserDraftRecoveryRow,
  copy: (content: JsonContent) => void,
): Promise<void> {
  const expected = row.recovery.reference;
  if (expected.slot.id !== row.id) return;
  const read = await readExactBrowserDraftRecovery(route.actor, expected);
  if (read.kind === "live" && draftsRecoveryRouteIsCurrent(route)) {
    copy(read.content);
  }
}
