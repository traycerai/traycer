// One copy the host and the app both draw the masked line from.
import { z } from "zod";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const PIECE_SEPARATORS = /[\s=&?:,;"']+/;

const SHOWN_MAX = 8192;
const MASK = "•••";
const PIECES = new RegExp(`(${PIECE_SEPARATORS.source})`);

/** The migrator's rule decides (`classifyCredential`); a piece after a credential's name also reads `•••`. */
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

function shown(text: string): string | null {
  const bounded = masked(text).slice(0, SHOWN_MAX);
  return bounded.trim().length === 0 ? null : bounded;
}

export { shown as maskedHeldText };

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

const heldStdioDefinitionSchema = lazySchema(() =>
  z.object({
    definition: z.object({
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()),
    }),
  }),
);

/** Only the fields each line reads. */
const heldShellValueSchema = lazySchema(() =>
  z.object({ path: z.string(), args: z.array(z.string()) }),
);
const heldSetupScriptValueSchema = lazySchema(() =>
  z.object({ text: z.string() }),
);
const heldStringValueSchema = lazySchema(() => z.object({ value: z.string() }));

/**
 * A value that does not parse for its kind has no facts. A skill's description and
 * a definition's harness are never filled: nothing on this host knows them.
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
