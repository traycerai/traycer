import type {
  ProviderNativeScope,
  ProviderSkill,
  ProviderSkillsCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";

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

export type SkillComposerTab = "write" | "import";

/**
 * Which authoring paths this provider actually offers for the selected scope.
 *
 * `includes(effectiveScope)` rather than `length > 0`: a verb advertised only
 * for project must not light a button while the user is viewing Global (and
 * vice versa). The tab sends mutations at the same scope it lists, so testing
 * the scope that is actually invoked is the point.
 */
export interface SkillAuthoring {
  /** Author a new SKILL.md from the composer's Write tab. */
  readonly canWrite: boolean;
  /** Pull one in from a git URL or a local folder. */
  readonly canImport: boolean;
  /** Either path is open, so the composer has something to do. */
  readonly canAuthor: boolean;
}

export function skillAuthoring(
  caps: ProviderSkillsCapabilities,
  effectiveScope: ProviderNativeScope,
): SkillAuthoring {
  const canWrite = caps.actionScopes.create.includes(effectiveScope);
  const canImport = caps.actionScopes.import.includes(effectiveScope);
  return { canWrite, canImport, canAuthor: canWrite || canImport };
}

/**
 * Which tabs the composer shows, and which one opens first.
 *
 * Empty when there is nothing to choose: a provider that can only import gets
 * the import form with no tab strip above it, rather than a one-tab strip that
 * looks like a control but selects nothing.
 */
export function skillComposerTabs(
  authoring: SkillAuthoring,
): readonly SkillComposerTab[] {
  if (authoring.canWrite && authoring.canImport) return ["write", "import"];
  return [];
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
  readonly tab: SkillComposerTab;
  readonly name: string;
  readonly description: string;
  readonly source: string;
}): string | null {
  if (args.tab === "import") {
    if (args.source.trim().length === 0) {
      return "Enter a git URL or a folder path to import from.";
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
function parentDir(path: string): string | null {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const trimmed = path.endsWith(separator) ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf(separator);
  if (index <= 0) return null;
  return trimmed.slice(0, index);
}
