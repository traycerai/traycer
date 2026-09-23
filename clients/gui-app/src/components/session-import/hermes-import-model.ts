/**
 * The Hermes profile import's pure state: what a scan found, which rows are
 * ticked, where they go, and the sentence that summarises the run before it
 * starts. Kept out of the component so the defaults (bundled skills
 * unchecked, everything else checked) and the request built from them are
 * testable without a render.
 */
import type {
  AgentIdentityHermesRunRequest,
  AgentIdentityHermesScanItem,
} from "@traycer/protocol/host/agent-identity/unary-schemas";

export const HERMES_DEFAULT_DIRECTORY = "~/.hermes";
export const HERMES_SOUL_REL_PATH = "SOUL.md";

/** A scan item the user can tick, keyed by its profile-relative path. */
export type HermesSelectableItem = Exclude<
  AgentIdentityHermesScanItem,
  { kind: "unreadable" }
>;

export function hermesItemRelPath(item: HermesSelectableItem): string {
  return item.kind === "soul" ? HERMES_SOUL_REL_PATH : item.relPath;
}

/**
 * The rows ticked when a scan lands: the soul and the memory files always,
 * a skill unless Hermes shipped it unchanged (`bundled`), since the stock
 * identity already seeds those and a copy would only duplicate them.
 */
export function defaultHermesSelection(
  items: readonly AgentIdentityHermesScanItem[],
): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const item of items) {
    if (item.kind === "unreadable") continue;
    if (item.kind === "skill" && item.bundled) continue;
    selected.add(hermesItemRelPath(item));
  }
  return selected;
}

export type HermesImportTarget =
  | { readonly kind: "new"; readonly title: string }
  | { readonly kind: "existing"; readonly identityId: string };

/** The title a new identity gets unless the user types one. */
export function defaultHermesIdentityTitle(profileName: string | null): string {
  return profileName === null ? "Hermes identity" : `Hermes (${profileName})`;
}

export type HermesSelectionCounts = {
  readonly soul: boolean;
  readonly memories: number;
  readonly skills: number;
  readonly bundledSkills: number;
};

export function countHermesSelection(
  items: readonly AgentIdentityHermesScanItem[],
  selected: ReadonlySet<string>,
): HermesSelectionCounts {
  let soul = false;
  let memories = 0;
  let skills = 0;
  let bundledSkills = 0;
  for (const item of items) {
    if (item.kind === "unreadable") continue;
    if (!selected.has(hermesItemRelPath(item))) continue;
    if (item.kind === "soul") soul = true;
    else if (item.kind === "memory") memories += 1;
    else {
      skills += 1;
      if (item.bundled) bundledSkills += 1;
    }
  }
  return { soul, memories, skills, bundledSkills };
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "Import the soul, 2 memory files and 3 skills (1 bundled) into a new
 * identity “Hermes”." - the sentence above the Import button, so the user
 * reads what will happen before it does.
 */
export function hermesImportSummary(
  counts: HermesSelectionCounts,
  target: HermesImportTarget,
  existingTitle: string | null,
): string {
  const parts: string[] = [];
  if (counts.soul) parts.push("the soul");
  if (counts.memories > 0) parts.push(plural(counts.memories, "memory file"));
  if (counts.skills > 0) {
    const bundled =
      counts.bundledSkills > 0
        ? ` (${counts.bundledSkills.toLocaleString()} bundled)`
        : "";
    parts.push(`${plural(counts.skills, "skill")}${bundled}`);
  }
  if (parts.length === 0) return "Nothing selected to import.";
  const what =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const where =
    target.kind === "new"
      ? `a new identity “${target.title.trim()}”`
      : `“${existingTitle ?? "the selected identity"}”`;
  return `Import ${what} into ${where}.`;
}

export function hermesRunRequest(args: {
  readonly directory: string;
  readonly items: readonly AgentIdentityHermesScanItem[];
  readonly selected: ReadonlySet<string>;
  readonly target: HermesImportTarget;
}): AgentIdentityHermesRunRequest {
  const selectedRelPaths: string[] = [];
  for (const item of args.items) {
    if (item.kind === "unreadable") continue;
    const relPath = hermesItemRelPath(item);
    if (args.selected.has(relPath)) selectedRelPaths.push(relPath);
  }
  return {
    directory: args.directory,
    identityId: args.target.kind === "existing" ? args.target.identityId : null,
    title:
      args.target.kind === "new" && args.target.title.trim().length > 0
        ? args.target.title.trim()
        : null,
    selectedRelPaths,
  };
}

/** Whether the run can be submitted: something ticked and a target that names one. */
export function hermesRunSubmittable(
  selected: ReadonlySet<string>,
  target: HermesImportTarget,
): boolean {
  if (selected.size === 0) return false;
  if (target.kind === "new") return target.title.trim().length > 0;
  return target.identityId.length > 0;
}
