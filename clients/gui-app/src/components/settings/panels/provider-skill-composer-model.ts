import type {
  ProviderNativeScope,
  ProviderSkill,
  ProviderSkillInspectCandidate,
  ProviderSkillsCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { isProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { parseSkillMarkdown } from "./provider-skill-markdown";

/**
 * Pure decision layer for the Skills authoring surface.
 *
 * Everything here answers a question the JSX would otherwise answer inline —
 * which entry points to render, where a write lands, what the file will look
 * like — so each one can be tested without mounting a dialog, and so the
 * capability rules below cannot be re-derived slightly differently in two
 * places.
 */

/** Agent Skills name pattern (open standard). Mirrors the host's own copy. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The standard's soft ceiling on `description`. Not enforced — the field is
 * what the agent reads to decide whether to load the skill at all, and a hard
 * stop mid-sentence is worse than a long line — but it is shown, because a
 * description that blows past this is a description the agent will struggle
 * to use.
 */
export const SKILL_DESCRIPTION_SOFT_LIMIT = 1024;

/** The shared, cross-provider skills directory, relative to its root. */
const SHARED_SKILLS_RELATIVE = ".agents/skills";

export type SkillComposerStep = "import" | "picker" | "write";

/**
 * Prefill payload for opening the composer on an existing skill.
 * Submit hashes `baseline` into the edit mutation's compare-and-swap guard.
 */
export type SkillEditTarget = {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly baseline: string;
};

export function skillEditPrefill(
  skill: ProviderSkill,
  raw: string,
): SkillEditTarget {
  const parsed = parseSkillMarkdown(raw);
  return {
    path: skill.path,
    name:
      parsed.name !== null && parsed.name.length > 0 ? parsed.name : skill.name,
    description:
      parsed.description !== null
        ? parsed.description
        : (skill.description ?? ""),
    body: parsed.body,
    baseline: raw,
  };
}

/**
 * Which authoring paths this provider actually offers for the selected scope.
 *
 * `includes(effectiveScope)` rather than `length > 0`: a verb advertised only
 * for project must not light a button while the user is viewing Global (and
 * vice versa). The tab sends mutations at the same scope it lists, so testing
 * the scope that is actually invoked is the point.
 *
 * `canInspect` is the skew gate: absent `actionScopes.inspect` (old host)
 * means the composer keeps today's single-shot import. Do not default the
 * capability to `[]` at parse time - absent is the signal - but treat a
 * missing key as no scopes here, matching host helpers.
 */
export interface SkillAuthoring {
  /** Author a new SKILL.md from the composer's write form. */
  readonly canWrite: boolean;
  /** Pull skills in from a source string. */
  readonly canImport: boolean;
  /** Host advertises inspect for this scope, so the picker path is live. */
  readonly canInspect: boolean;
  /** Either path is open, so the composer has something to do. */
  readonly canAuthor: boolean;
}

export function skillAuthoring(
  caps: ProviderSkillsCapabilities,
  effectiveScope: ProviderNativeScope,
): SkillAuthoring {
  const canWrite = caps.actionScopes.create.includes(effectiveScope);
  const canImport = caps.actionScopes.import.includes(effectiveScope);
  const inspectScopes = caps.actionScopes.inspect ?? [];
  const canInspect = inspectScopes.includes(effectiveScope);
  return {
    canWrite,
    canImport,
    canInspect,
    canAuthor: canWrite || canImport,
  };
}

/**
 * Whether the "<Provider> only" radio is an honest choice for this listing.
 *
 * Keyed on advertised create/import scopes, not on existing rows: a project
 * listing with zero provider-sourced skills must still be able to create the
 * first one. The host already advertises those verbs only where a native
 * destination exists. Destination copy falls back to a generic label when
 * no row has revealed the provider root yet.
 */
export function skillProviderScopeVisible(args: {
  readonly effectiveScope: ProviderNativeScope;
  readonly createScopes: readonly ProviderNativeScope[];
  readonly importScopes: readonly ProviderNativeScope[];
}): boolean {
  return (
    args.createScopes.includes(args.effectiveScope) ||
    args.importScopes.includes(args.effectiveScope)
  );
}

export interface SkillDestination {
  /**
   * The directory a write lands in, as shown to the user. `~` stands for the
   * home directory the host will resolve — the client has no reason to know
   * its expansion, and showing the literal tilde is how every one of these
   * paths is written down anyway.
   */
  readonly display: string;
  /**
   * False when the directory could not be determined and `display` is prose
   * rather than a path. A guess rendered as a path would be worse than an
   * honest sentence: this line's whole job is to be trustworthy.
   */
  readonly exact: boolean;
}

/**
 * Where a create/import will land, for the audience the user picked.
 *
 * The shared root is fixed by the Agent Skills standard, so it is derived
 * rather than reported. A provider's own root is provider-specific and lives
 * in host code; rather than mirror that table here (a second copy that would
 * drift silently), it is read off a skill the host has ALREADY reported from
 * that root, and falls back to prose when the list has none yet.
 */
export function skillDestination(args: {
  readonly providerScoped: boolean;
  readonly providerLabel: string;
  readonly providerRoot: string | null;
}): SkillDestination {
  if (!args.providerScoped) {
    return { display: `~/${SHARED_SKILLS_RELATIVE}`, exact: true };
  }
  if (args.providerRoot === null) {
    return {
      display: `${args.providerLabel}'s own skills folder`,
      exact: false,
    };
  }
  return { display: args.providerRoot, exact: true };
}

/**
 * The provider's own skills root, read off a skill already listed from it.
 *
 * `ProviderSkill.path` is the skill's own directory, so its parent is the
 * root. Only `source: "provider"` rows qualify — a `shared` row sits in the
 * cross-provider root and a `plugin`/`managed` row is somewhere we never
 * write.
 */
export function providerRootFromSkills(
  skills: readonly ProviderSkill[],
): string | null {
  for (const skill of skills) {
    if (skill.source !== "provider") continue;
    const parent = parentDir(skill.path);
    if (parent !== null) return parent;
  }
  return null;
}

/** The full path of the file a create will produce, for the footer. */
export function skillFilePath(args: {
  readonly destination: SkillDestination;
  readonly name: string;
}): string {
  const trimmed = args.name.trim();
  if (!args.destination.exact) return args.destination.display;
  if (trimmed.length === 0) return args.destination.display;
  return joinPath(joinPath(args.destination.display, trimmed), "SKILL.md");
}

/**
 * The starter body a new skill opens with.
 *
 * Not a placeholder — real text in the field. An empty box is the single
 * biggest reason a first skill never gets written: the headings are the part
 * that is hard to invent and cheap to delete.
 */
export function skillBodyScaffold(): string {
  return [
    "## When to use this",
    "",
    "",
    "## Steps",
    "",
    "1. ",
    "",
    "## Notes",
    "",
    "",
  ].join("\n");
}

/**
 * The exact file the host will write, for the Preview toggle.
 *
 * Mirrors the host's `formatSkillMd`, including its JSON-quoted description
 * and its empty-body fallback — a preview that pretty-printed the frontmatter
 * differently would be a preview of a file that does not exist.
 */
export function previewSkillMd(args: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}): string {
  const name = args.name.trim().length > 0 ? args.name.trim() : "my-skill";
  const description = args.description.trim();
  const body = args.body.trim();
  const rendered = body.length > 0 ? body : `# ${name}\n`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${rendered}\n`;
}

/** Validation message for the name field, or null when it is usable. */
export function skillNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (!SKILL_NAME_PATTERN.test(trimmed)) {
    return "Use lowercase letters, digits and hyphens only — for example review-pr.";
  }
  return null;
}

/**
 * Why the submit button is disabled, or null when it is ready.
 *
 * Returned as a message rather than a boolean so the dialog can SAY what is
 * missing. A disabled button with no reason beside it is the failure mode this
 * whole surface was rewritten to remove.
 */
export function skillSubmitBlocker(args: {
  readonly step: SkillComposerStep;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly selectedNames: readonly string[];
}): string | null {
  if (args.step === "import") {
    if (args.source.trim().length === 0) {
      return "Enter a source to import from.";
    }
    return null;
  }
  if (args.step === "picker") {
    if (args.selectedNames.length === 0) {
      return "Select at least one skill to install.";
    }
    return null;
  }
  if (args.name.trim().length === 0) return "Give the skill a name.";
  const nameError = skillNameError(args.name);
  if (nameError !== null) return nameError;
  if (args.description.trim().length === 0) {
    return "Add a description — the agent reads it to decide when to use this skill.";
  }
  return null;
}

/**
 * Names requested via `-s` / `--skill` on a pasted `npx skills add` command.
 *
 * Full source parsing (wrapper strip, owner/repo, tree URL) is host-side.
 * The GUI only needs these flags to preselect picker rows.
 */
export function skillNamesFromSourceFlags(source: string): readonly string[] {
  // Built per call: a module-level `/g` regex would leak `lastIndex` across
  // invocations and skip later flags.
  const pattern = /(?:^|\s)(?:-s|--skill)(?:\s+|=)(?<name>[^\s,]+)/gi;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const name = match.groups?.name;
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Intersection of inspect candidates with `-s` / `--skill` flags. */
export function preselectSkillNames(
  candidates: readonly ProviderSkillInspectCandidate[],
  flagged: readonly string[],
): readonly string[] {
  if (flagged.length === 0) return [];
  const wanted = new Set(flagged);
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (wanted.has(candidate.name)) selected.push(candidate.name);
  }
  return selected;
}

/**
 * Host maps `NativeWriteError("external_drift")` onto the wire for both
 * inspect SHA drift (expired-token re-clone moved) and update-from-source
 * when canon hash ≠ recorded `installedHash`. The GUI preserves that as
 * `ProviderNativeRpcError.nativeCode`. The verb is what distinguishes them.
 */
export function isExternalDriftError(error: unknown): boolean {
  return (
    isProviderNativeRpcError(error) && error.nativeCode === "external_drift"
  );
}

/** Fetched source matches what is already installed. */
export function isSkillUpdateNoOp(error: unknown): boolean {
  return (
    isProviderNativeRpcError(error) && error.nativeCode === "no_change_detected"
  );
}

/**
 * Absent `actionScopes.edit` / `update` is the old-host skew gate: hide
 * the feature rather than offering a verb the host will refuse.
 */
export function skillActionAdvertised(
  scopes: readonly ProviderNativeScope[] | undefined,
  effectiveScope: ProviderNativeScope,
): boolean {
  if (scopes === undefined) return false;
  return scopes.includes(effectiveScope);
}

export function skillIsEditable(skill: ProviderSkill): boolean {
  if (skill.conflict === true) return false;
  return skill.source === "shared" || skill.source === "provider";
}

export function skillOriginDisplay(skill: ProviderSkill): string | null {
  const origin = skill.origin;
  if (origin === undefined || origin === null) return null;
  const trimmed = origin.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function composerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "Couldn't add this skill.";
}

/**
 * POSIX-style join, which is what these paths are.
 *
 * The destination strings this joins are either the standard's own
 * `~/.agents/skills` or a path the host already reported, so a separator is
 * never invented — only appended.
 */
function joinPath(left: string, right: string): string {
  if (left.endsWith("/")) return `${left}${right}`;
  return `${left}/${right}`;
}

/**
 * The parent of a skill directory, honouring whichever separator the host's
 * path already uses. Returns null when there is no parent segment to take.
 */
export function parentDir(path: string): string | null {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const trimmed = path.endsWith(separator) ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf(separator);
  if (index <= 0) return null;
  return trimmed.slice(0, index);
}
