import type { RuntimeContext } from "./runtime";

/**
 * ANSI colour for human-facing output. Resolution is per call, never at
 * module load: the runner's `--json` mode force-disables colour even on a
 * TTY, because a caller that mixes machine-readable and human output must
 * never find escape codes in a payload. `NO_COLOR` and a stream that is not a
 * terminal suppress colour as well. The stream is a parameter because a
 * command's prose can go to stdout while its prompts and transient lines go
 * to stderr, and only the stream being written to knows whether it is a TTY.
 */
export function shouldUseColor(
  runtime: Pick<RuntimeContext, "json">,
  stream: { readonly isTTY: boolean | undefined },
): boolean {
  if (runtime.json) return false;
  return stream.isTTY === true && !process.env.NO_COLOR;
}

export interface Colorizer {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

/** With colour off, every method is the identity, so callers never branch. */
export function makeColorizer(useColor: boolean): Colorizer {
  const wrap = (s: string, code: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    bold: (s) => wrap(s, "1"),
    dim: (s) => wrap(s, "2"),
    green: (s) => wrap(s, "32"),
    red: (s) => wrap(s, "31"),
    yellow: (s) => wrap(s, "33"),
    cyan: (s) => wrap(s, "36"),
    gray: (s) => wrap(s, "90"),
  };
}
