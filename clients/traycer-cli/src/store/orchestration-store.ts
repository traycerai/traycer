import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { isModelBlocked } from "@traycer-clients/shared/platform/is-model-blocked";
import {
  DEFAULT_ORCHESTRATION_SEEDS,
  SEED_VERSION,
  toOrchestrationRole,
} from "./orchestration-defaults";

// ~/.traycer/orchestrations/<name>/orchestration.json + roles/*.md
// ~/.traycer/model-groups/<name>.json

const TRAYCER_HOME = join(homedir(), ".traycer");
const ORCHESTRATIONS_DIR = join(TRAYCER_HOME, "orchestrations");
const MODEL_GROUPS_DIR = join(TRAYCER_HOME, "model-groups");

/** Primary full roster — protected from delete; UI default chip. */
export const PRIMARY_MODEL_GROUP = "default";

/** Legacy on-disk group names → current names. */
const LEGACY_MODEL_GROUP_RENAMES: Readonly<Record<string, string>> = {
  "roster-full": "default",
  "roster-budget": "budget",
  "roster-top": "top",
  cheap: "budget",
  premium: "top",
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelEntry {
  readonly harnessId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly family: string;
  readonly note: string;
}

export interface ModelTier {
  readonly description: string;
  readonly models: readonly ModelEntry[];
}

export interface ModelGroup {
  readonly name: string;
  readonly description: string;
  readonly rules: readonly string[];
  readonly tiers: Readonly<Record<string, ModelTier>>;
}

export interface OrchestrationRole {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly responsibilityFile: string;
  readonly tier: string;
  readonly isRoot: boolean;
  readonly lifecycle: string;
  readonly canCreateAgents: boolean;
  readonly canWriteArtifacts: readonly string[];
  readonly neverImplements: boolean;
  readonly excludeFamilyOf?: string;
  readonly modelPreference: readonly string[];
}

export interface ArtifactStep {
  readonly path: string;
  readonly kind: string;
  readonly author: string;
  readonly conditional?: string;
  readonly note?: string;
}

export interface Orchestration {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly defaultModelGroup: string;
  readonly roles: readonly OrchestrationRole[];
  readonly artifactChain: readonly ArtifactStep[];
  readonly globalRules: readonly string[];
}

// ─── Model Groups ───────────────────────────────────────────────────────────

async function migrateLegacyModelGroupFiles(): Promise<void> {
  try {
    await mkdir(MODEL_GROUPS_DIR, { recursive: true });
    const entries = await readdir(MODEL_GROUPS_DIR);
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const oldName = file.replace(/\.json$/, "");
      const newName = LEGACY_MODEL_GROUP_RENAMES[oldName];
      if (newName === undefined) continue;
      const src = join(MODEL_GROUPS_DIR, file);
      const dst = join(MODEL_GROUPS_DIR, `${newName}.json`);
      try {
        await readFile(dst, "utf-8");
        // Target already exists — drop legacy file only.
        await rm(src, { force: true });
        continue;
      } catch {
        // rename via read/write/unlink
      }
      const raw = await readFile(src, "utf-8");
      let parsed: ModelGroup;
      try {
        parsed = JSON.parse(raw) as ModelGroup;
      } catch {
        continue;
      }
      const migrated: ModelGroup = { ...parsed, name: newName };
      await writeFile(dst, JSON.stringify(migrated, null, 2) + "\n", "utf-8");
      await rm(src, { force: true });
    }
  } catch {
    // best-effort
  }
}

export async function listModelGroups(): Promise<readonly string[]> {
  try {
    await migrateLegacyModelGroupFiles();
    const entries = await readdir(MODEL_GROUPS_DIR);
    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function readModelGroup(name: string): Promise<ModelGroup | null> {
  const resolved =
    LEGACY_MODEL_GROUP_RENAMES[name] !== undefined
      ? LEGACY_MODEL_GROUP_RENAMES[name]
      : name;
  try {
    const raw = await readFile(
      join(MODEL_GROUPS_DIR, `${resolved}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as ModelGroup;
  } catch {
    return null;
  }
}

// ─── Orchestrations ─────────────────────────────────────────────────────────

/**
 * Idempotent seed of built-in templates (auto, dev-squad, …).
 * - Missing orchestration → create full template + role markdown.
 * - Existing with version !== SEED_VERSION → RE-CREATE seed roles (overwrite
 *   seed-owned ids incl. responsibility text, in seed order so the root rule
 *   normalizes correctly) and refresh description/rules/pack/artifactChain.
 *   User-added roles (ids not in the seed) are preserved.
 */
export async function ensureDefaultOrchestrations(): Promise<void> {
  await mkdir(ORCHESTRATIONS_DIR, { recursive: true });
  for (const seed of DEFAULT_ORCHESTRATION_SEEDS) {
    const existing = await readOrchestration(seed.name);
    if (existing === null) {
      const roles = seed.roles.map(toOrchestrationRole);
      const orch: Orchestration = {
        name: seed.name,
        description: seed.description,
        version: SEED_VERSION,
        defaultModelGroup: seed.defaultModelGroup,
        roles,
        artifactChain: [...seed.artifactChain],
        globalRules: [...seed.globalRules],
      };
      await writeOrchestration(orch);
      for (const roleSeed of seed.roles) {
        await writeFile(
          join(ORCHESTRATIONS_DIR, seed.name, `roles/${roleSeed.id}.md`),
          roleSeed.responsibility.endsWith("\n")
            ? roleSeed.responsibility
            : `${roleSeed.responsibility}\n`,
          "utf-8",
        );
      }
      continue;
    }

    if (existing.version === SEED_VERSION) continue;

    // Version bump: overwrite seed-owned roles in seed order (root first, so
    // the single-lead normalization lands on the seed's root), then refresh
    // template-level fields. User-added roles survive untouched.
    for (const roleSeed of seed.roles) {
      await upsertOrchestrationRole(seed.name, {
        id: roleSeed.id,
        label: roleSeed.label,
        description: roleSeed.description,
        tier: roleSeed.tier,
        isRoot: roleSeed.isRoot,
        responsibility: roleSeed.responsibility,
      });
    }
    const fresh = await readOrchestration(seed.name);
    if (fresh !== null) {
      await writeOrchestration({
        ...fresh,
        description: seed.description,
        version: SEED_VERSION,
        defaultModelGroup: seed.defaultModelGroup,
        artifactChain: [...seed.artifactChain],
        globalRules: [...seed.globalRules],
      });
    }
  }
}

export async function listOrchestrations(): Promise<readonly string[]> {
  try {
    await ensureDefaultOrchestrations();
    const entries = await readdir(ORCHESTRATIONS_DIR, {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function readOrchestration(
  name: string,
): Promise<Orchestration | null> {
  try {
    const raw = await readFile(
      join(ORCHESTRATIONS_DIR, name, "orchestration.json"),
      "utf-8",
    );
    return JSON.parse(raw) as Orchestration;
  } catch {
    return null;
  }
}

export async function readResponsibility(
  orchestrationName: string,
  roleId: string,
): Promise<string | null> {
  const orch = await readOrchestration(orchestrationName);
  if (!orch) return null;
  const role = orch.roles.find((r) => r.id === roleId);
  if (!role) return null;
  try {
    return await readFile(
      join(ORCHESTRATIONS_DIR, orchestrationName, role.responsibilityFile),
      "utf-8",
    );
  } catch {
    return null;
  }
}

// ─── Models for a role ──────────────────────────────────────────────────────

export interface RoleModelInfo {
  readonly role: OrchestrationRole;
  readonly modelGroup: string;
  readonly tier: string;
  readonly models: readonly ModelEntry[];
  readonly rules: readonly string[];
}

export async function getModelsForRole(
  orchestrationName: string,
  roleId: string,
  modelGroupName: string | undefined,
): Promise<RoleModelInfo | null> {
  const orch = await readOrchestration(orchestrationName);
  if (!orch) return null;

  const role = orch.roles.find((r) => r.id === roleId);
  if (!role) return null;

  const groupName = modelGroupName ?? orch.defaultModelGroup;
  const group = await readModelGroup(groupName);
  if (!group) return null;

  const tier = group.tiers[role.tier];
  if (!tier) return null;

  const blocks = await readModelBlocks();
  const liveModels = tier.models.filter(
    (m) => !isModelBlocked(m, blocks.blocks),
  );

  return {
    role,
    modelGroup: groupName,
    tier: role.tier,
    models: liveModels,
    rules: group.rules,
  };
}

// ─── Prelude for chat creation injection ────────────────────────────────────

export interface OrchestrationPrelude {
  readonly orchestration: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly modelGroup: string;
  readonly tier: string;
  readonly text: string;
}

/**
 * Builds the one-shot context block injected into a chat's initialMessage at
 * creation time (not on every subsequent send). The open client cannot set
 * host-internal `contextPrelude`; this text is prepended to the create-time
 * user content instead.
 */
export async function buildOrchestrationPrelude(
  orchestrationName: string,
  roleId: string,
  modelGroupName: string | undefined,
): Promise<OrchestrationPrelude | null> {
  const orch = await readOrchestration(orchestrationName);
  if (!orch) return null;

  const role = orch.roles.find((r) => r.id === roleId);
  if (!role) return null;

  const responsibility = await readResponsibility(orchestrationName, roleId);
  if (responsibility === null) return null;

  const groupName = modelGroupName ?? orch.defaultModelGroup;

  // Cache rule (static-first): responsibility + rules lead; anything mutable
  // (model ladders, pack edits) is NEVER baked into this brief — the agent
  // asks the CLI on demand. Roster only for the root (children don't need it).
  const rosterLines = role.isRoot
    ? orch.roles.map((r) => {
        const root = r.isRoot ? " ★ root" : "";
        return `- ${r.id} (${r.label}) — tier=${r.tier}${root}: ${r.description}`;
      })
    : [];

  const rules = [...orch.globalRules];

  const text = [
    "<!-- traycer-orchestration-prelude -->",
    "# Role brief (injected once at chat creation)",
    "",
    "You are bound to a fixed role in an agent team template. Treat the block",
    "below as standing instructions for this entire chat. Do not restate it",
    "verbatim to the user unless asked.",
    "",
    "## Responsibility",
    responsibility.trim(),
    "",
    "## Team rules (standing)",
    ...rules.map((r) => `- ${r}`),
    "",
    "## Binding",
    `- Orchestration: \`${orchestrationName}\``,
    `- Role: \`${role.id}\` (${role.label})`,
    `- Tier: \`${role.tier}\``,
    `- Model pack: \`${groupName}\``,
    role.isRoot
      ? `- Root role: yes (orchestrator — assign work, do not implement)`
      : `- Root role: no`,
    ...(rosterLines.length > 0
      ? ["", "## Team roster (root only)", ...rosterLines]
      : []),
    "",
    "## Live data (ask the CLI when needed — never cached here)",
    "```",
    `traycer orchestration roles --name ${orchestrationName}`,
    `traycer orchestration models --name ${orchestrationName} --role <roleId> --group ${groupName}`,
    `traycer orchestration responsibility --name ${orchestrationName} --role <roleId>`,
    "```",
    "",
    "<!-- /traycer-orchestration-prelude -->",
    "",
  ].join("\n");

  return {
    orchestration: orchestrationName,
    roleId: role.id,
    roleLabel: role.label,
    modelGroup: groupName,
    tier: role.tier,
    text,
  };
}

// ─── Write operations ───────────────────────────────────────────────────────

export async function createOrchestration(
  name: string,
  description: string,
  fromExisting: string | undefined,
): Promise<Orchestration | null> {
  const dir = join(ORCHESTRATIONS_DIR, name);
  await mkdir(join(dir, "roles"), { recursive: true });

  let orch: Orchestration;
  if (fromExisting !== undefined) {
    const existing = await readOrchestration(fromExisting);
    if (!existing) return null;
    // Clone without the name/description
    const { name: _n, description: _d, ...rest } = existing;
    orch = { name, description, ...rest } as Orchestration;
    // Copy responsibility files
    for (const role of existing.roles) {
      const content = await readResponsibility(fromExisting, role.id);
      if (content !== null) {
        const destPath = join(dir, role.responsibilityFile);
        await mkdir(join(destPath, ".."), { recursive: true });
        await writeFile(destPath, content, "utf-8");
      }
    }
  } else {
    orch = {
      name,
      description,
      version: "1.0.0",
      defaultModelGroup: "default",
      roles: [],
      artifactChain: [],
      globalRules: [],
    };
  }

  await writeFile(
    join(dir, "orchestration.json"),
    JSON.stringify(orch, null, 2) + "\n",
    "utf-8",
  );
  return orch;
}

export async function deleteOrchestration(name: string): Promise<boolean> {
  try {
    await rm(join(ORCHESTRATIONS_DIR, name), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function writeOrchestration(
  orch: Orchestration,
): Promise<boolean> {
  try {
    await mkdir(join(ORCHESTRATIONS_DIR, orch.name, "roles"), {
      recursive: true,
    });
    await writeFile(
      join(ORCHESTRATIONS_DIR, orch.name, "orchestration.json"),
      JSON.stringify(orch, null, 2) + "\n",
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

export async function writeResponsibility(
  orchestrationName: string,
  roleId: string,
  content: string,
): Promise<boolean> {
  const orch = await readOrchestration(orchestrationName);
  if (!orch) return false;
  const role = orch.roles.find((r) => r.id === roleId);
  if (!role) return false;
  try {
    const filePath = join(
      ORCHESTRATIONS_DIR,
      orchestrationName,
      role.responsibilityFile,
    );
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

const ROLE_ID_RE = /^[a-z][a-z0-9_-]*$/;

export interface UpsertOrchestrationRoleInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tier: string;
  readonly isRoot: boolean;
  /** Markdown body written to roles/<id>.md */
  readonly responsibility: string;
}

/**
 * Create or update a role + its responsibility markdown in one shot.
 * Keeps orchestration.json and roles/<id>.md in lockstep for the GUI editor.
 */
export async function upsertOrchestrationRole(
  orchestrationName: string,
  input: UpsertOrchestrationRoleInput,
): Promise<OrchestrationRole | null> {
  const orch = await readOrchestration(orchestrationName);
  if (orch === null) return null;

  const id = input.id.trim();
  if (!ROLE_ID_RE.test(id)) return null;

  const label = input.label.trim().length > 0 ? input.label.trim() : id;
  const description = input.description.trim();
  const tier =
    input.tier.trim().length > 0 ? input.tier.trim() : "executor";
  const responsibilityFile = `roles/${id}.md`;

  const nextRole: OrchestrationRole = {
    id,
    label,
    description,
    responsibilityFile,
    tier,
    isRoot: input.isRoot,
    lifecycle: "persistent",
    canCreateAgents: false,
    canWriteArtifacts: [],
    neverImplements: false,
    modelPreference: [],
  };

  const existingIdx = orch.roles.findIndex((r) => r.id === id);
  const roles =
    existingIdx === -1
      ? [...orch.roles, nextRole]
      : orch.roles.map((r, i) => (i === existingIdx ? nextRole : r));

  // At most one root role — if this one is root, clear the flag on others.
  const normalizedRoles = input.isRoot
    ? roles.map((r) => (r.id === id ? r : { ...r, isRoot: false }))
    : roles;

  const written = await writeOrchestration({
    ...orch,
    roles: normalizedRoles,
  });
  if (!written) return null;

  const mdOk = await writeResponsibility(
    orchestrationName,
    id,
    input.responsibility,
  );
  if (!mdOk) return null;
  return nextRole;
}

export async function deleteOrchestrationRole(
  orchestrationName: string,
  roleId: string,
): Promise<boolean> {
  const orch = await readOrchestration(orchestrationName);
  if (orch === null) return false;
  const role = orch.roles.find((r) => r.id === roleId);
  if (role === undefined) return false;

  const nextRoles = orch.roles.filter((r) => r.id !== roleId);
  const written = await writeOrchestration({ ...orch, roles: nextRoles });
  if (!written) return false;

  try {
    await rm(join(ORCHESTRATIONS_DIR, orchestrationName, role.responsibilityFile), {
      force: true,
    });
  } catch {
    // JSON already updated — stale md is non-fatal.
  }
  return true;
}

export async function writeModelGroup(group: ModelGroup): Promise<boolean> {
  try {
    await mkdir(MODEL_GROUPS_DIR, { recursive: true });
    await writeFile(
      join(MODEL_GROUPS_DIR, `${group.name}.json`),
      JSON.stringify(group, null, 2) + "\n",
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

export async function deleteModelGroup(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed === PRIMARY_MODEL_GROUP || trimmed === "default") {
    return false;
  }
  try {
    await rm(join(MODEL_GROUPS_DIR, `${trimmed}.json`), { force: false });
    return true;
  } catch {
    return false;
  }
}

// ─── Blocks (temporary provider/model blacklist) ────────────────────────────
//
// Local-only file: ~/.traycer/model-blocks.json
// When a provider or model is blocked, getModelsForRole skips it so the pack
// ladder falls through to the next live entry. Unblock restores it instantly.
// Does not delete pack entries — just filters at read time.

const MODEL_BLOCKS_PATH = join(TRAYCER_HOME, "model-blocks.json");

export interface ModelBlockEntry {
  /** Exact harness id (e.g. "kimi", "omp", "cursor"). */
  readonly harnessId: string;
  /**
   * When null/empty: block the entire provider/harness.
   * When set: block only that model slug under the harness.
   */
  readonly model: string | null;
  /** Optional human note (e.g. "out of balance"). */
  readonly note: string;
  /** ISO timestamp when blocked. */
  readonly blockedAt: string;
}

export interface ModelBlocksFile {
  readonly blocks: readonly ModelBlockEntry[];
}

function emptyBlocks(): ModelBlocksFile {
  return { blocks: [] };
}

export async function readModelBlocks(): Promise<ModelBlocksFile> {
  try {
    const raw = await readFile(MODEL_BLOCKS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelBlocksFile>;
    if (!Array.isArray(parsed.blocks)) return emptyBlocks();
    const blocks: ModelBlockEntry[] = [];
    for (const entry of parsed.blocks) {
      if (entry === null || typeof entry !== "object") continue;
      const harnessId =
        typeof (entry as ModelBlockEntry).harnessId === "string"
          ? (entry as ModelBlockEntry).harnessId.trim()
          : "";
      if (harnessId.length === 0) continue;
      const modelRaw = (entry as ModelBlockEntry).model;
      const model =
        typeof modelRaw === "string" && modelRaw.trim().length > 0
          ? modelRaw.trim()
          : null;
      const note =
        typeof (entry as ModelBlockEntry).note === "string"
          ? (entry as ModelBlockEntry).note
          : "";
      const blockedAt =
        typeof (entry as ModelBlockEntry).blockedAt === "string"
          ? (entry as ModelBlockEntry).blockedAt
          : new Date().toISOString();
      blocks.push({ harnessId, model, note, blockedAt });
    }
    return { blocks };
  } catch {
    return emptyBlocks();
  }
}

async function writeModelBlocks(file: ModelBlocksFile): Promise<boolean> {
  try {
    await mkdir(TRAYCER_HOME, { recursive: true });
    await writeFile(
      MODEL_BLOCKS_PATH,
      JSON.stringify(file, null, 2) + "\n",
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

function blockKey(entry: {
  readonly harnessId: string;
  readonly model: string | null;
}): string {
  return `${entry.harnessId.toLowerCase()}::${(entry.model ?? "").toLowerCase()}`;
}

export { isModelBlocked };

export async function addModelBlock(input: {
  readonly harnessId: string;
  readonly model: string | null;
  readonly note: string;
}): Promise<ModelBlocksFile | null> {
  const harnessId = input.harnessId.trim();
  if (harnessId.length === 0) return null;
  const model =
    input.model !== null && input.model.trim().length > 0
      ? input.model.trim()
      : null;
  const file = await readModelBlocks();
  const key = blockKey({ harnessId, model });
  const without = file.blocks.filter((b) => blockKey(b) !== key);
  const next: ModelBlocksFile = {
    blocks: [
      ...without,
      {
        harnessId,
        model,
        note: input.note.trim(),
        blockedAt: new Date().toISOString(),
      },
    ],
  };
  const ok = await writeModelBlocks(next);
  return ok ? next : null;
}

export async function removeModelBlock(input: {
  readonly harnessId: string;
  readonly model: string | null;
}): Promise<ModelBlocksFile | null> {
  const harnessId = input.harnessId.trim();
  if (harnessId.length === 0) return null;
  const model =
    input.model !== null && input.model.trim().length > 0
      ? input.model.trim()
      : null;
  const file = await readModelBlocks();
  const key = blockKey({ harnessId, model });
  const next: ModelBlocksFile = {
    blocks: file.blocks.filter((b) => blockKey(b) !== key),
  };
  const ok = await writeModelBlocks(next);
  return ok ? next : null;
}

export async function clearModelBlocks(): Promise<ModelBlocksFile | null> {
  const next = emptyBlocks();
  const ok = await writeModelBlocks(next);
  return ok ? next : null;
}
