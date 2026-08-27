import {
  browserAnnotationRecordSchema,
  type BrowserAnnotationCounts,
  type BrowserAnnotationRecord,
} from "@traycer/protocol/persistence/epic/schemas";

export type { BrowserAnnotationCounts, BrowserAnnotationRecord };

export function parseBrowserAnnotationRecord(
  value: unknown,
): BrowserAnnotationRecord | null {
  const parsed = browserAnnotationRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function parseBrowserAnnotationRecords(
  value: unknown,
): ReadonlyArray<BrowserAnnotationRecord> {
  if (!Array.isArray(value)) return [];
  const records: BrowserAnnotationRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = parseBrowserAnnotationRecord(entry);
    if (record === null) continue;
    if (seen.has(record.annotationId)) continue;
    seen.add(record.annotationId);
    records.push(record);
  }
  return records;
}

export function mergeBrowserAnnotationRecords(
  current: ReadonlyArray<BrowserAnnotationRecord>,
  incoming: ReadonlyArray<BrowserAnnotationRecord>,
): ReadonlyArray<BrowserAnnotationRecord> {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((record) => record.annotationId));
  const appended: BrowserAnnotationRecord[] = [];
  for (const record of incoming) {
    if (seen.has(record.annotationId)) continue;
    seen.add(record.annotationId);
    appended.push(record);
  }
  if (appended.length === 0) return current;
  return [...current, ...appended];
}

export function collectDraftAnnotationImageHashes(
  drafts: Partial<
    Record<
      string,
      { readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord> }
    >
  >,
): ReadonlyArray<string> {
  return collectAnnotationImageHashes(
    Object.values(drafts).flatMap((draft) =>
      draft === undefined ? [] : draft.browserAnnotations,
    ),
  );
}

export function collectAnnotationImageHashes(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): ReadonlyArray<string> {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.imageHash)) continue;
    seen.add(record.imageHash);
    hashes.push(record.imageHash);
  }
  return hashes;
}

export function formatAnnotationCounts(
  counts: BrowserAnnotationCounts,
): string {
  const parts: string[] = [];
  if (counts.elements > 0) {
    parts.push(pluralize(counts.elements, "element", "elements"));
  }
  if (counts.regions > 0) {
    parts.push(pluralize(counts.regions, "region", "regions"));
  }
  if (counts.strokes > 0) {
    parts.push(pluralize(counts.strokes, "drawing", "drawings"));
  }
  return parts.join(" · ");
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
