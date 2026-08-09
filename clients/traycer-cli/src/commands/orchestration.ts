import {
  buildOrchestrationPrelude,
  createOrchestration,
  deleteOrchestration,
  getModelsForRole,
  listModelGroups,
  listOrchestrations,
  readModelGroup,
  readOrchestration,
  readResponsibility,
  writeModelGroup,
  writeResponsibility,
  type ModelGroup,
} from "../store/orchestration-store";
import type { CommandFn } from "../runner/runner";

// `traycer orchestration list` — lista orquestrações disponíveis
export function buildOrchestrationListCommand(): CommandFn {
  return async (ctx) => {
    const names = await listOrchestrations();
    if (ctx.runtime.json) {
      return { data: names, human: null, exitCode: 0 };
    }
    if (names.length === 0) {
      return { data: names, human: "(no orchestrations found)", exitCode: 0 };
    }
    const lines = names.map((n) => `  ${n}`);
    return {
      data: names,
      human: `Orchestrations:\n${lines.join("\n")}`,
      exitCode: 0,
    };
  };
}

// `traycer orchestration show --name <name>` — detalhes de uma orquestração
export function buildOrchestrationShowCommand(opts: {
  readonly name: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const orch = await readOrchestration(name);
    if (!orch) {
      return {
        data: null,
        human: `Orchestration not found: ${name}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: orch, human: null, exitCode: 0 };
    }
    const roleLines = orch.roles.map(
      (r) =>
        `  ${r.isRoot ? "★" : "·"} ${r.id} — ${r.label} (${r.tier})\n    ${r.description}`,
    );
    const human = [
      `Orchestration: ${orch.name}`,
      `  ${orch.description}`,
      `  Model group: ${orch.defaultModelGroup}`,
      `  Roles (${orch.roles.length}):`,
      ...roleLines,
      `  Artifact chain: ${orch.artifactChain.map((a) => a.path).join(" → ")}`,
    ].join("\n");
    return { data: orch, human, exitCode: 0 };
  };
}

// `traycer orchestration roles --name <name>` — lista roles de uma orquestração
export function buildOrchestrationRolesCommand(opts: {
  readonly name: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const orch = await readOrchestration(name);
    if (!orch) {
      return {
        data: null,
        human: `Orchestration not found: ${name}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: orch.roles, human: null, exitCode: 0 };
    }
    const lines = orch.roles.map((r) => {
      const parts = [
        `  ${r.isRoot ? "★" : "·"} ${r.id}`,
        `    label: ${r.label}`,
        `    tier: ${r.tier}`,
        `    lifecycle: ${r.lifecycle}`,
        `    responsibility: ${r.responsibilityFile}`,
      ];
      if (r.excludeFamilyOf) {
        parts.push(`    excludeFamilyOf: ${r.excludeFamilyOf}`);
      }
      if (r.modelPreference.length > 0) {
        parts.push(`    modelPreference: ${r.modelPreference.join(", ")}`);
      }
      return parts.join("\n");
    });
    return {
      data: orch.roles,
      human: `Roles in ${name}:\n${lines.join("\n")}`,
      exitCode: 0,
    };
  };
}

// `traycer orchestration models --name <name> --role <role-id> [--group <group>]`
// — modelos disponíveis para um papel
export function buildOrchestrationModelsCommand(opts: {
  readonly name: string | null;
  readonly role: string | null;
  readonly group: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const roleId = opts.role ?? "";
    const group = opts.group ?? undefined;

    const info = await getModelsForRole(name, roleId, group);
    if (!info) {
      return {
        data: null,
        human: `Not found: orchestration=${name}, role=${roleId}, group=${group ?? "(default)"}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: info, human: null, exitCode: 0 };
    }
    const modelLines = info.models.map((m, i) => {
      const effort = m.effort ? ` (${m.effort})` : "";
      const note = m.note ? ` — ${m.note}` : "";
      return `  ${i + 1}. ${m.harnessId}/${m.model}${effort} [${m.family}]${note}`;
    });
    const human = [
      `Models for ${info.role.label} (${info.role.id})`,
      `  Group: ${info.modelGroup} | Tier: ${info.tier}`,
      `  Rules: ${info.rules.join("; ")}`,
      `  Available models (${info.models.length}):`,
      ...modelLines,
    ].join("\n");
    return { data: info, human, exitCode: 0 };
  };
}

// `traycer orchestration responsibility --name <name> --role <role-id>`
// — conteúdo MD da responsabilidade (para injeção no contextPrelude)
export function buildOrchestrationResponsibilityCommand(opts: {
  readonly name: string | null;
  readonly role: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const roleId = opts.role ?? "";

    const content = await readResponsibility(name, roleId);
    if (!content) {
      return {
        data: null,
        human: `Responsibility not found: orchestration=${name}, role=${roleId}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return {
        data: { name, role: roleId, content },
        human: null,
        exitCode: 0,
      };
    }
    return { data: content, human: content, exitCode: 0 };
  };
}

// `traycer orchestration prelude --name <name> --role <role-id> [--group <g>]`
// — bloco completo injetado UMA VEZ no initialMessage na criação do chat
export function buildOrchestrationPreludeCommand(opts: {
  readonly name: string | null;
  readonly role: string | null;
  readonly group: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const roleId = opts.role ?? "";
    const group = opts.group ?? undefined;

    if (name.length === 0 || roleId.length === 0) {
      return {
        data: null,
        human: "Error: --name and --role are required",
        exitCode: 1,
      };
    }

    const prelude = await buildOrchestrationPrelude(name, roleId, group);
    if (!prelude) {
      return {
        data: null,
        human: `Prelude not found: orchestration=${name}, role=${roleId}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: prelude, human: null, exitCode: 0 };
    }
    return { data: prelude, human: prelude.text, exitCode: 0 };
  };
}

// `traycer orchestration groups` — lista model groups disponíveis
export function buildOrchestrationGroupsCommand(): CommandFn {
  return async (ctx) => {
    const names = await listModelGroups();
    if (ctx.runtime.json) {
      return { data: names, human: null, exitCode: 0 };
    }
    if (names.length === 0) {
      return { data: names, human: "(no model groups found)", exitCode: 0 };
    }
    // Enrich with description
    const lines = await Promise.all(
      names.map(async (n) => {
        const group = await readModelGroup(n);
        const desc = group ? ` — ${group.description}` : "";
        return `  ${n}${desc}`;
      }),
    );
    return {
      data: names,
      human: `Model groups:\n${lines.join("\n")}`,
      exitCode: 0,
    };
  };
}

// `traycer orchestration create --name <name> [--description <desc>] [--from <existing>]`
// — cria nova orquestração (opcionalmente clonando de uma existente)
export function buildOrchestrationCreateCommand(opts: {
  readonly name: string | null;
  readonly description: string | null;
  readonly from: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const description = opts.description ?? "";
    const from = opts.from ?? undefined;

    if (name.length === 0) {
      return { data: null, human: "Error: --name is required", exitCode: 1 };
    }

    const result = await createOrchestration(name, description, from);
    if (!result) {
      return {
        data: null,
        human: `Failed to create orchestration: ${name}${from ? ` (from ${from} — not found?)` : ""}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: result, human: null, exitCode: 0 };
    }
    return {
      data: result,
      human: `Created orchestration: ${name}${from ? ` (cloned from ${from})` : ""}\n  Path: ~/.traycer/orchestrations/${name}/`,
      exitCode: 0,
    };
  };
}

// `traycer orchestration delete --name <name>` — remove orquestração
export function buildOrchestrationDeleteCommand(opts: {
  readonly name: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const ok = await deleteOrchestration(name);
    if (!ok) {
      return {
        data: null,
        human: `Failed to delete orchestration: ${name}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: { deleted: name }, human: null, exitCode: 0 };
    }
    return {
      data: { deleted: name },
      human: `Deleted orchestration: ${name}`,
      exitCode: 0,
    };
  };
}

// `traycer orchestration group show --name <name>` — mostra um model group (JSON completo)
export function buildOrchestrationGroupShowCommand(opts: {
  readonly name: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    const group = await readModelGroup(name);
    if (!group) {
      return {
        data: null,
        human: `Model group not found: ${name}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: group, human: null, exitCode: 0 };
    }
    return {
      data: group,
      human: JSON.stringify(group, null, 2),
      exitCode: 0,
    };
  };
}

// `traycer orchestration group save --name <name> [--data <json-string>]`
// — salva model group (JSON via --data arg ou stdin)
export function buildOrchestrationGroupSaveCommand(opts: {
  readonly name: string | null;
  readonly json: string | null;
}): CommandFn {
  return async (ctx) => {
    const name = opts.name ?? "";
    let raw: string;
    if (opts.json !== null && opts.json.length > 0) {
      raw = opts.json;
    } else {
      // Read JSON from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      raw = Buffer.concat(chunks).toString("utf-8").trim();
    }
    if (raw.length === 0) {
      return {
        data: null,
        human: "Error: no JSON provided (use --data or pipe stdin)",
        exitCode: 1,
      };
    }
    let group: ModelGroup;
    try {
      group = JSON.parse(raw) as ModelGroup;
    } catch {
      return { data: null, human: "Error: invalid JSON on stdin", exitCode: 1 };
    }
    // Force the name from the flag
    const toSave = { ...group, name };
    const ok = await writeModelGroup(toSave);
    if (!ok) {
      return {
        data: null,
        human: `Failed to save model group: ${name}`,
        exitCode: 1,
      };
    }
    if (ctx.runtime.json) {
      return { data: toSave, human: null, exitCode: 0 };
    }
    return {
      data: toSave,
      human: `Saved model group: ${name}`,
      exitCode: 0,
    };
  };
}
