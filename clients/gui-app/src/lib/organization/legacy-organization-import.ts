/**
 * The machine-local tab groups and tab colours this build retired, lifted out
 * of their source before anything can prune them.
 *
 * ## Why a copy at all
 *
 * The layout prunes itself. `repairTabGroups` rebuilds `customizations` and
 * `groups` from the strip items that are open, on every commit and inside
 * `partialize` on every write, so a group whose tabs are closed is gone and
 * so is a closed tab's colour. That has always been true, and it means the
 * legacy data is a wasting asset: reading it "later", from a hydrated store,
 * reads whatever is left after the session has run. So it is copied out once,
 * from the raw persisted bytes, before the stores write over them.
 *
 * ## One record per authoritative source
 *
 * Two authorities, never both live in one renderer: the browser's own
 * `traycer-gui-app:tabs` payload, and the desktop shell's per-window snapshot
 * (which disables that writer once its handshake succeeds). Each gets its own
 * record, so a desktop window's data is never unioned with a stale browser
 * payload and one window never overwrites another. A record is written only
 * when none exists for that source, so a later snapshot - which by then
 * carries a layout the import has already cleaned - cannot replace a record
 * still in flight.
 *
 * ## What it is not
 *
 * Not an archive and not a fallback. Nothing reads it to draw a group, it
 * holds no label (there was never a machine-local label), and it is deleted
 * as soon as its import settles.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { organizationActionSchema } from "@traycer/protocol/host/organization/contracts";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  parseTabCustomizations,
  parseTabGroups,
  type TabCustomizations,
  type TabGroup,
  type TabGroups,
} from "@/stores/tabs/tab-groups";

const IMPORT_KEY = persistKey(STORE_KEYS.legacyOrganizationImport);
const CANVAS_KEY_PREFIX = `${persistKey(STORE_KEYS.epicCanvas)}:`;

/** A legacy group and the tasks it held, in the order the strip drew them. */
const capturedGroupSchema = lazySchema(() =>
  z.object({
    groupId: z.string().min(1),
    name: z.string(),
    color: z.string(),
    taskIds: z.array(z.string().min(1)),
  }),
);

/** A legacy per-tab colour or icon, resolved to the task the tab showed. */
const capturedAppearanceSchema = lazySchema(() =>
  z.object({
    taskId: z.string().min(1),
    color: z.string().nullable(),
    icon: z.string().nullable(),
  }),
);
type CapturedAppearance = z.infer<typeof capturedAppearanceSchema>;

/**
 * A cloud request this record has already prepared, kept verbatim so every
 * later attempt sends the same bytes rather than forming new ones against a
 * base that has moved.
 */
const preparedRequestSchema = lazySchema(() =>
  z.object({
    commandId: z.string().min(1),
    action: organizationActionSchema,
  }),
);

export const legacyOrganizationCaptureSchema = lazySchema(() =>
  z.object({
    sourceId: z.string().min(1),
    capturedAt: z.number(),
    /**
     * The account this record's requests were prepared for, once they have
     * been. A prepared request names versions of THAT account's data, so it
     * may never be sent under another: a sign-out or a switch leaves it here
     * until its own account is back. `null` before anything is prepared.
     */
    accountId: z.string().nullable(),
    /**
     * Tabs the source's own mapping could not place on a task, or placed on
     * two. They are not a conflict and they are not nothing: the record is
     * not settled while any remain, because settling would delete the only
     * copy of a group membership nothing has looked at.
     */
    unresolvedTabIds: z.array(z.string().min(1)),
    groups: z.array(capturedGroupSchema),
    appearances: z.array(capturedAppearanceSchema),
    prepared: z.array(preparedRequestSchema),
    /**
     * The import is over for this record: its work is in the account, or it
     * ended for good. Written and made durable BEFORE the source is cleaned,
     * so a crash during the cleanup finishes it rather than replaying it
     * against an account that has since moved on.
     */
    settled: z.boolean(),
  }),
);
export type LegacyOrganizationCapture = z.infer<
  typeof legacyOrganizationCaptureSchema
>;

const captureFileSchema = lazySchema(() =>
  z.record(z.string(), legacyOrganizationCaptureSchema),
);

export function readLegacyOrganizationCaptures(): LegacyOrganizationCapture[] {
  return Object.values(readFile()).sort((a, b) => a.capturedAt - b.capturedAt);
}

export function updateLegacyOrganizationCapture(
  sourceId: string,
  change: (capture: LegacyOrganizationCapture) => LegacyOrganizationCapture,
): void {
  const file = readFile();
  if (!Object.hasOwn(file, sourceId)) return;
  writeFile({ ...file, [sourceId]: change(file[sourceId]) });
}

export function deleteLegacyOrganizationCapture(sourceId: string): void {
  const file = readFile();
  if (!Object.hasOwn(file, sourceId)) return;
  const next = { ...file };
  delete next[sourceId];
  writeFile(next);
}

/**
 * The browser's raw sources, read once before the stores can write over them.
 *
 * `stores/tabs/store.ts` calls this at module load, which is the last moment
 * the persisted layout is still the one the previous session left: zustand's
 * rehydration writes the repaired layout straight back, so an effect or a
 * provider is already too late. Reading is all that happens here - whether
 * the browser is this renderer's authority is not known yet, and nothing is
 * recorded until {@link captureBrowserLegacyOrganization} says it is.
 */
export function rememberBrowserLegacySources(): void {
  if (browserSources !== null) return;
  browserSources = {
    layout: persistedState(readLocalStorage(persistKey(STORE_KEYS.tabs))),
    tasksByTabId: readCanvasTabs(),
  };
}

interface BrowserLegacySources {
  readonly layout: unknown;
  readonly tasksByTabId: ReadonlyMap<string, string>;
}
let browserSources: BrowserLegacySources | null = null;

/**
 * Records what {@link rememberBrowserLegacySources} read, now that the
 * browser is known to be this renderer's authority.
 */
export function captureBrowserLegacyOrganization(): void {
  rememberBrowserLegacySources();
  if (browserSources === null) return;
  captureLegacyOrganization({
    sourceId: "browser",
    layout: browserSources.layout,
    tasksByTabId: browserSources.tasksByTabId,
  });
}

/**
 * Records a desktop window's snapshot before it is hydrated.
 *
 * The snapshot carries its own tab-to-task mapping (`epicTabs`) beside the
 * layout, from the same window and the same moment, so nothing is resolved
 * against live state. It carries no account - desktop per-window state is not
 * bucketed by one - which is why `accountId` is null here and why the import
 * settles attribution separately.
 */
export function captureDesktopLegacyOrganization(input: {
  readonly windowId: string;
  readonly tabStripLayout: unknown;
  readonly epicTabs: ReadonlyArray<{
    readonly id: string;
    readonly epicId: string;
  }>;
}): void {
  captureLegacyOrganization({
    sourceId: `desktop:${input.windowId}`,
    layout: input.tabStripLayout,
    tasksByTabId: new Map(input.epicTabs.map((tab) => [tab.id, tab.epicId])),
  });
}

function captureLegacyOrganization(input: {
  readonly sourceId: string;
  readonly layout: unknown;
  readonly tasksByTabId: ReadonlyMap<string, string>;
}): void {
  const file = readFile();
  // A record already stands for this source. It may be mid-import, and the
  // layout in front of us may be one that import has already cleaned.
  if (Object.hasOwn(file, input.sourceId)) return;
  const fields = legacyLayoutFields(input.layout);
  const capture = buildLegacyCapture({
    sourceId: input.sourceId,
    groups: fields.groups,
    customizations: fields.customizations,
    tasksByTabId: input.tasksByTabId,
  });
  if (capture === null) return;
  writeFile({ ...file, [input.sourceId]: capture });
}

/**
 * The capture a source's raw fields produce, or `null` when it holds nothing
 * machine-local worth moving.
 *
 * A group or a tab customization the organization projection wrote carries
 * `organizationOwnerId`; those are copies of the account's own data and are
 * skipped, so the import can never re-upload the cloud's own state as a
 * machine-local choice.
 */
export function buildLegacyCapture(input: {
  readonly sourceId: string;
  readonly groups: TabGroups;
  readonly customizations: TabCustomizations;
  readonly tasksByTabId: ReadonlyMap<string, string>;
}): LegacyOrganizationCapture | null {
  const members = new Map<string, string[]>();
  const appearances: CapturedAppearance[] = [];
  const unresolved = new Set<string>();
  for (const [key, customization] of Object.entries(input.customizations)) {
    if (customization.organizationOwnerId || !key.startsWith("epic:")) continue;
    const tabId = key.slice("epic:".length);
    const taskId = input.tasksByTabId.get(tabId);
    if (taskId === undefined) {
      // Only a tab that HELD something machine-local is worth recording as
      // unplaced; an untouched tab the mapping cannot resolve is not a loss.
      if (
        customization.groupId !== null ||
        customization.color !== null ||
        customization.icon !== null
      )
        unresolved.add(tabId);
      continue;
    }
    const groupId = customization.groupId;
    if (groupId !== null && legacyGroup(input.groups, groupId) !== null) {
      const held = members.get(groupId);
      if (held === undefined) members.set(groupId, [taskId]);
      else held.push(taskId);
    }
    if (customization.color !== null || customization.icon !== null)
      appearances.push({
        taskId,
        color: customization.color,
        icon: customization.icon,
      });
  }
  const groups = [...members].flatMap(([groupId, taskIds]) => {
    const group = legacyGroup(input.groups, groupId);
    if (group === null) return [];
    return [{ groupId, name: group.name, color: group.color, taskIds }];
  });
  if (groups.length === 0 && appearances.length === 0 && unresolved.size === 0)
    return null;
  return {
    sourceId: input.sourceId,
    capturedAt: Date.now(),
    accountId: null,
    unresolvedTabIds: [...unresolved],
    groups,
    appearances,
    prepared: [],
    settled: false,
  };
}

/**
 * The group behind this id when it is a MACHINE-LOCAL one. A group the
 * organization projection wrote carries `organizationOwnerId` and is the
 * account's own data wearing the same shape; a id with no group behind it at
 * all is a dangling reference the layout's own repair would have dropped.
 */
function legacyGroup(groups: TabGroups, groupId: string): TabGroup | null {
  if (!Object.hasOwn(groups, groupId)) return null;
  const group = groups[groupId];
  return group.organizationOwnerId ? null : group;
}

function legacyLayoutFields(layout: unknown): {
  readonly groups: TabGroups;
  readonly customizations: TabCustomizations;
} {
  const record = asRecord(layout);
  if (record === null) return { groups: {}, customizations: {} };
  return {
    groups: parseTabGroups(record.groups),
    customizations: parseTabCustomizations(record.customizations),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The state a zustand persist envelope carries, or `null`. */
function persistedState(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    const envelope = asRecord(JSON.parse(raw));
    return envelope === null ? null : (envelope.state ?? null);
  } catch {
    return null;
  }
}

const canvasTabsSchema = lazySchema(() =>
  z.object({
    tabsById: z.record(z.string(), z.object({ epicId: z.string().min(1) })),
  }),
);

/**
 * tabId -> taskId from the browser's canvas payloads.
 *
 * The canvas store is keyed per account, and the browser's tab layout is not,
 * so the layout's `epic:<tabId>` keys are resolved against every payload
 * present. That is a LOOKUP, not an attribution: a tab id is a uuid minted
 * once, so the bucket it is found in adds nothing, and a tab id that somehow
 * names two different tasks is dropped rather than guessed. Who may act on
 * the task is the host's decision, not this map's.
 */
function readCanvasTabs(): Map<string, string> {
  const tabs = new Map<string, string>();
  const conflicting = new Set<string>();
  let keys: string[] = [];
  try {
    keys = Object.keys(window.localStorage);
  } catch {
    return tabs;
  }
  for (const key of keys) {
    if (!key.startsWith(CANVAS_KEY_PREFIX)) continue;
    const parsed = canvasTabsSchema.safeParse(
      persistedState(readLocalStorage(key)),
    );
    if (!parsed.success) continue;
    for (const [tabId, tab] of Object.entries(parsed.data.tabsById)) {
      const seen = tabs.get(tabId);
      if (seen !== undefined && seen !== tab.epicId) conflicting.add(tabId);
      tabs.set(tabId, tab.epicId);
    }
  }
  for (const tabId of conflicting) tabs.delete(tabId);
  return tabs;
}

function readFile(): Record<string, LegacyOrganizationCapture> {
  const raw = readLocalStorage(IMPORT_KEY);
  if (raw === null) return {};
  try {
    const parsed = captureFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeFile(file: Record<string, LegacyOrganizationCapture>): void {
  try {
    if (Object.keys(file).length === 0)
      window.localStorage.removeItem(IMPORT_KEY);
    else window.localStorage.setItem(IMPORT_KEY, JSON.stringify(file));
  } catch {
    // A full or blocked store leaves the capture where it was. The source has
    // not been touched, so the next launch reads it again.
  }
}

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
