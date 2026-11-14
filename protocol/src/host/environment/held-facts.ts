/**
 * The line a review sheet draws for a held executable entry: what it runs or
 * holds, masked so that no credential is shown. One copy the host and the app
 * both draw it from.
 */
import { z } from "zod";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** The pieces of a string a token can hide among: words, `k=v` halves, URL parts. */
export const PIECE_SEPARATORS = /[\s=&?:,;"']+/;

const SHOWN_MAX = 8192;
const MASK = "•••";
const PIECES = new RegExp(`(${PIECE_SEPARATORS.source})`);

/**
 * `text` as the sheet shows it to its owner: its shape, never a credential.
 * The migrator's own rule decides (`classifyCredential` over the pieces it
 * splits a value into): a word or piece that looks like a key, and a piece
 * that follows a credential's name (`--api-key <key>`, `TOKEN=<key>`), reads
 * `•••`.
 */
function masked(text: string): string {
  return (
    text
      .split(PIECES)
      .map((piece, index, parts) => {
        // Odd indexes are the separators the split kept.
        if (index % 2 === 1) return piece;
        const name = index >= 2 ? (parts[index - 2] ?? "") : "";
        return classifyCredential({ name, value: piece }).credentialLike
          ? MASK
          : piece;
      })
      .join("")
      // A whole word the pieces hide, a URL with a password among them.
      .split(/(\s+)/)
      .map((word) =>
        classifyCredential({ name: "", value: word }).credentialLike
          ? MASK
          : word,
      )
      .join("")
  );
}

/** A fact as the sheet shows it: masked and bounded; null when there is none. */
function shown(text: string): string | null {
  const bounded = masked(text).slice(0, SHOWN_MAX);
  return bounded.trim().length === 0 ? null : bounded;
}

export interface HeldFacts {
  readonly command: string | null;
  readonly description: string | null;
  readonly harness: string | null;
  readonly value: string | null;
}

const NO_FACTS: HeldFacts = {
  command: null,
  description: null,
  harness: null,
  value: null,
};

/** A held stdio MCP server's definition, as the migration holds it. */
const heldStdioDefinitionSchema = lazySchema(() =>
  z.object({
    definition: z.object({
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()),
    }),
  }),
);

/**
 * The fields of a held value each line reads, and only those: a shell's path
 * and arguments, a setup script's text, a variable's or an override's value.
 */
const heldShellValueSchema = lazySchema(() =>
  z.object({ path: z.string(), args: z.array(z.string()) }),
);
const heldSetupScriptValueSchema = lazySchema(() =>
  z.object({ text: z.string() }),
);
const heldStringValueSchema = lazySchema(() => z.object({ value: z.string() }));

/**
 * What a held executable entry does, for its line on the sheet. A value that
 * does not parse for its kind has no facts. Never filled, because nothing on
 * this host knows them: a skill's description (the migration holds no
 * skill, and a held skill's content is not on this host) and an agent
 * definition's harness. No held change names when it runs, so the facts
 * carry no trigger.
 */
export function heldFactsOf(entry: {
  readonly kind: string;
  readonly key: string;
  readonly value: unknown;
}): HeldFacts {
  switch (entry.kind) {
    case "mcp_server": {
      const parsed = heldStdioDefinitionSchema.safeParse(entry.value);
      if (!parsed.success) return NO_FACTS;
      const { command, args } = parsed.data.definition;
      // The definition carries no env, so no env value can reach the line.
      return { ...NO_FACTS, command: shown([command, ...args].join(" ")) };
    }
    case "shell": {
      const parsed = heldShellValueSchema.safeParse(entry.value);
      if (!parsed.success) return NO_FACTS;
      const { path, args } = parsed.data;
      return { ...NO_FACTS, command: shown([path, ...args].join(" ")) };
    }
    case "setup_script": {
      const parsed = heldSetupScriptValueSchema.safeParse(entry.value);
      if (!parsed.success) return NO_FACTS;
      const lines = parsed.data.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { ...NO_FACTS, command: shown(lines.join("; ")) };
    }
    case "variable":
    case "env_override": {
      const parsed = heldStringValueSchema.safeParse(entry.value);
      if (!parsed.success) return NO_FACTS;
      const separator = entry.key.indexOf(":");
      return {
        ...NO_FACTS,
        // An env setting's key is `<harness>:<NAME>`.
        harness:
          entry.kind === "env_override" && separator > 0
            ? entry.key.slice(0, separator)
            : null,
        value: shown(parsed.data.value),
      };
    }
    default:
      return NO_FACTS;
  }
}
