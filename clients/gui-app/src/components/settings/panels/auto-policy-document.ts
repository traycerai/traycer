/**
 * The account auto-mode policy as a DOCUMENT: how it splits into the Rules
 * tab's sections and joins back, the size the server will accept, and the one
 * question the tab asks about staleness.
 *
 * Kept apart from the tab because a module that exports a component may export
 * nothing else - fast refresh replaces the whole module, so a helper living
 * beside a component is re-created on every edit and
 * `react(only-export-components)` fails the build over it. These are also the
 * pieces worth testing without rendering anything.
 */
import type {
  AutoPolicyGetResponse,
  AutoPolicyReadState,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

/**
 * A prepared rule the Permissions page received through the open intent and
 * has not yet handed to the Rules tab's editor. `id` is the intent's own, so
 * the editor applies each exactly once and in the order they arrived.
 */
export interface PendingRuleDraft {
  readonly id: number;
  readonly draft: SettingsRuleDraft;
}

/**
 * How far the host's answer can be trusted, with the one fallback an older
 * host forces spelled in exactly one place.
 *
 * `readState` rode into `autoPolicy.get@1.0` IN PLACE rather than on a minor of
 * its own, so the negotiated version does not say whether the host on the other
 * end fills it: a response without the property is a host whose resolver
 * predates it. `fresh` is the only honest answer for that host - it reproduces
 * this panel's behaviour before the field existed, and the two states it stands
 * in for ("stale", "unreadable") are ones that host cannot detect either. The
 * same shape as `providerAutoJudgeFor`'s `?? "traycer"`, for the same reason.
 */
export function autoPolicyReadStateFor(
  response: AutoPolicyGetResponse,
): AutoPolicyReadState {
  return response.readState ?? "fresh";
}

/**
 * Where the editor's OPEN-time authoritative read has got to.
 *
 * `pending` and `failed` collapse to the same answer for Save - "this window
 * cannot yet tell whether another device has moved the policy" - but they are
 * different sentences on screen, so the third state is not a boolean.
 *
 * It lives in this module rather than beside either component because BOTH the
 * row that drives the read and the dialog that gates on it need the name, and a
 * module exporting a component may export nothing else (see the header).
 */
export type AutoPolicyOpeningRead = "pending" | "settled" | "failed";

/** The four sections the judge's prompt builder reads a policy under. */
export const AUTO_POLICY_SECTION_KEYS = [
  "environment",
  "allow",
  "softDeny",
  "hardDeny",
] as const;

export type AutoPolicySectionKey = (typeof AUTO_POLICY_SECTION_KEYS)[number];

/**
 * A policy as the Rules tab edits it: one text per section, plus `notes` for
 * everything the host files under no section (text before the first heading,
 * or under a heading it does not recognise).
 */
export type AutoPolicySections = Readonly<
  Record<AutoPolicySectionKey | "notes", string>
>;

export const EMPTY_AUTO_POLICY_SECTIONS: AutoPolicySections = {
  environment: "",
  allow: "",
  softDeny: "",
  hardDeny: "",
  notes: "",
};

/**
 * The storage heading of each section. These are the words the host's parser
 * recognises, not the tab's labels ("Always allow", "Ask first", "Never
 * allow"): the stored document is prose the judge reads, and renaming a heading
 * there is a host change.
 */
const AUTO_POLICY_SECTION_HEADINGS: Readonly<
  Record<AutoPolicySectionKey, string>
> = {
  environment: "Environment",
  allow: "Allow",
  softDeny: "Soft deny",
  hardDeny: "Hard deny",
};

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

/**
 * The host's heading synonyms, normalised the way the host normalises them.
 *
 * RESTATED, not shared: the host's parser
 * (`traycer-host/src/domain/chat/auto-judge/auto-policy-document.ts`) lives in
 * the closed-source repository, and the two copies are held together by a
 * fixture pair checked into both repositories, each asserting its own parser
 * reads the same sections out of the same documents.
 */
const CANONICAL_TITLES: ReadonlyMap<string, AutoPolicySectionKey> = new Map([
  ["environment", "environment"],
  ["allow", "allow"],
  ["allowed", "allow"],
  ["soft deny", "softDeny"],
  ["softdeny", "softDeny"],
  ["soft block", "softDeny"],
  ["hard deny", "hardDeny"],
  ["harddeny", "hardDeny"],
  ["hard block", "hardDeny"],
]);

function normalizeHeadingTitle(title: string): string {
  return title
    .replace(/[^A-Za-z0-9\s-]/g, "")
    .replace(/-/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Splits a stored policy into the Rules tab's sections, exactly as the host's
 * `parseAutoPolicyDocument` does.
 *
 * Any mismatch with the host is a user-visible lie - a rule shown under Always
 * allow that the judge reads as a note - so this is a line-for-line mirror,
 * including what the host does NOT do: it tracks no code fences, so neither
 * does this. Membership follows heading depth: a heading deeper than the one
 * that opened the current section stays inside it, heading line and all; a
 * heading at the same or a shallower depth that names no section closes it
 * into `notes`, and that heading line is kept in `notes` too.
 */
export function splitAutoPolicySections(body: string): AutoPolicySections {
  const buffers: Record<AutoPolicySectionKey | "notes", string[]> = {
    environment: [],
    allow: [],
    softDeny: [],
    hardDeny: [],
    notes: [],
  };
  let current: AutoPolicySectionKey | "notes" = "notes";
  let currentDepth = 0;
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading === null) {
      buffers[current].push(line);
      continue;
    }
    const depth = heading[1].length;
    const canonical = CANONICAL_TITLES.get(normalizeHeadingTitle(heading[2]));
    if (canonical !== undefined) {
      current = canonical;
      currentDepth = depth;
      continue;
    }
    if (current !== "notes" && depth > currentDepth) {
      buffers[current].push(line);
      continue;
    }
    current = "notes";
    currentDepth = depth;
    buffers.notes.push(line);
  }
  return {
    environment: buffers.environment.join("\n").trim(),
    allow: buffers.allow.join("\n").trim(),
    softDeny: buffers.softDeny.join("\n").trim(),
    hardDeny: buffers.hardDeny.join("\n").trim(),
    notes: buffers.notes.join("\n").trim(),
  };
}

/**
 * A line a section's text cannot keep through a save: the stored document
 * would file it, and everything after it, somewhere else on the next read.
 */
export interface UnrepresentableSectionLine {
  /** 1-based, counted in the text as typed. */
  readonly line: number;
  /** A depth-1 heading, which no section can keep. */
  readonly topLevel: boolean;
  /** Its title is a section's name or alias, which opens that section. */
  readonly namesSection: boolean;
}

/**
 * The first line of `text` that would not come back in `section` after a
 * save, or `null` when all of it does.
 *
 * It is {@link splitAutoPolicySections}' own rule, read backwards:
 * - a heading whose title names a section opens that section whatever its
 *   depth, because the split recognises the name before it looks at depth -
 *   so neither a section nor Notes can keep one;
 * - a depth-1 heading closes any section into Notes. The join escalates the
 *   section headings to `#` for a body carrying a `##` heading, and nothing is
 *   shallower than `#`. Notes CAN keep one: they are written first, before any
 *   section is open.
 *
 * It reads the text as Save WRITES it, not as it was typed: the join trims
 * each body whole ({@link joinAutoPolicySections}), which takes the
 * indentation off the first non-blank line and can make that line a heading
 * the textarea never showed as one. Only the ends are trimmed, so an indented
 * `#` further down stays indented, and is no heading to either parser. The
 * line it names is still counted in the text as typed, blank leading lines
 * included.
 *
 * Reject, never rewrite: the Rules tab holds Save off and names the line,
 * rather than escaping it into something the user did not type.
 */
export function unrepresentableSectionLine(
  section: AutoPolicySectionKey | "notes",
  text: string,
): UnrepresentableSectionLine | null {
  const trimmedLead = text.slice(0, text.length - text.trimStart().length);
  const skippedLines = trimmedLead.split("\n").length - 1;
  for (const [index, line] of text.trim().split(/\r?\n/).entries()) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading === null) continue;
    const namesSection = CANONICAL_TITLES.has(
      normalizeHeadingTitle(heading[2]),
    );
    const topLevel = section !== "notes" && heading[1].length === 1;
    if (namesSection || topLevel) {
      return { line: skippedLines + index + 1, topLevel, namesSection };
    }
  }
  return null;
}

/**
 * The canonical stored form of a policy: Notes first, then the four sections
 * in the judge's order, one blank line between parts, each body trimmed.
 *
 * **Notes go FIRST, although the tab shows them last.** The host files text
 * under no heading - and text before the first heading - into `notes`, but it
 * files text AFTER `## Hard deny` into Hard deny, so Notes written last would
 * come back as Hard deny rules on the next read. Before the first heading is
 * the one place free text is guaranteed to stay notes. The judge sees no
 * difference: the host renders notes last, under their own heading.
 *
 * **All four headings are always written** once anything is, so the document
 * a person opens on another device shows every section, and an empty one
 * reads as empty rather than missing.
 *
 * **Headings escalate from `##` to `#`** when any section's body carries a
 * heading of depth two or less. The host keeps a heading inside a section only
 * while it is DEEPER than the section's own, so a `## Deploy` subheading under
 * a `## Allow` would close Allow and move every rule below it into notes. `#`
 * is the shallowest heading there is, so under it every body heading of depth
 * two or more stays put. A body line that is itself a `#` heading cannot be
 * kept inside any section by the host's rule, and neither can a heading of any
 * depth that names a section. A split never produces either inside a section,
 * but a person can type one: the Rules tab refuses to save such text
 * ({@link unrepresentableSectionLine}), so this never has to guess.
 *
 * An all-empty document joins to `""`, which `autoPolicy.set` reads as "clear
 * the policy".
 */
export function joinAutoPolicySections(sections: AutoPolicySections): string {
  const bodies = AUTO_POLICY_SECTION_KEYS.map((key) => sections[key].trim());
  const notes = sections.notes.trim();
  if (notes.length === 0 && bodies.every((body) => body.length === 0)) {
    return "";
  }
  const marker = bodies.some(carriesShallowHeading) ? "#" : "##";
  const parts: string[] = [];
  if (notes.length > 0) parts.push(notes);
  AUTO_POLICY_SECTION_KEYS.forEach((key, index) => {
    const heading = `${marker} ${AUTO_POLICY_SECTION_HEADINGS[key]}`;
    const body = bodies[index];
    parts.push(body.length === 0 ? heading : `${heading}\n\n${body}`);
  });
  return `${parts.join("\n\n")}\n`;
}

function carriesShallowHeading(body: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    const heading = HEADING_PATTERN.exec(line);
    return heading !== null && heading[1].length <= 2;
  });
}

/**
 * Whether a stored policy will be rewritten on its next save only because the
 * tab writes the canonical form - the one case the tab says so, once, before
 * any edit ("Saved in Traycer's section order.").
 *
 * Not for an empty record, and not for one whose canonical form is empty: a
 * document of blank lines is cleared by a save, which is not a reordering.
 */
export function autoPolicyNeedsReorder(stored: string): boolean {
  if (stored.length === 0) return false;
  const canonical = joinAutoPolicySections(splitAutoPolicySections(stored));
  return canonical.length > 0 && canonical !== stored;
}

/**
 * `text` added as a new line at the end of a section's body, as a drafted rule
 * is: below whatever is there, including an earlier draft still unsaved.
 */
export function appendAutoPolicyLine(body: string, text: string): string {
  const trimmedBody = body.replace(/\s+$/u, "");
  return trimmedBody.length === 0 ? text : `${trimmedBody}\n${text}`;
}

/**
 * The server's cap on a policy body, in UTF-8 BYTES.
 *
 * Restated here because the authoritative constant lives in the closed-source
 * service and reaches no client contract - `autoPolicy.set` carries a plain
 * string. This is therefore a courtesy pre-flight, not the enforcement: the
 * server refuses an oversized body regardless, and this only spares the user a
 * round-trip and a toast for something the editor could see coming. Bytes, not
 * characters: `String.length` counts UTF-16 code units and would let a policy
 * written in a non-Latin script past a check the server then fails.
 */
export const AUTO_POLICY_MAX_BYTES = 64 * 1024;

export function autoPolicyByteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * Whether the record moved under the editor while it was open.
 *
 * The two `null` sides are NOT symmetric, and treating them as if they were is
 * what let a real overwrite through. `updatedAt: null` means two different
 * things depending on which side it is on:
 *
 * - **`currentUpdatedAt === null`** is "cannot tell". The protocol sends it both
 *   for a policy that was never saved and for one the host is serving from a
 *   cache it could not refresh, so a `timestamp -> null` transition is not
 *   evidence of a change. Warning there would train the user to dismiss the one
 *   warning that means something.
 * - **`loadedAt === null` with a concrete `currentUpdatedAt`** is the opposite:
 *   the editor opened on no policy, and there is one now. That is a CREATION by
 *   another device, and saving over it destroys a record this window never saw.
 *   It is exactly the case the refetch on open was added to catch, and the
 *   symmetric `null` check was swallowing it.
 *
 * `null -> null` stays `false`: nothing appeared.
 *
 * The residual imprecision is deliberate. A host serving a STALE read can
 * report `updatedAt: null` while the account does have a policy, so a
 * subsequent good read can trip this warning for a record that was there all
 * along. The sentence the user sees - saving now replaces that version - is
 * true either way, and the alternative is the silent overwrite. (An
 * `unreadable` read cannot reach here at all: the row refuses to open the
 * editor on one.)
 */
export function autoPolicyChangedSinceLoad(
  loadedAt: string | null,
  currentUpdatedAt: string | null,
): boolean {
  if (currentUpdatedAt === null) return false;
  if (loadedAt === null) return true;
  return loadedAt !== currentUpdatedAt;
}
