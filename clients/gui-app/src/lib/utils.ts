import type { ClassValue } from "cn";
import { createCn } from "cn/engine";

import tables from "./cn-tables";

/**
 * The class merger. Its conflict groups - including the app's own `--text-*`
 * typography and safe-area tokens, which the stock groups do not classify -
 * are declared in `cn.config.mjs` at the package root and compiled into
 * `cn-tables.ts` by `bun run cn:build`. A new token means editing that config
 * and rebuilding; `src/__tests__/cn-tables-up-to-date.test.ts` fails when the
 * committed tables fall behind it.
 */
export const cn = createCn(tables);

export type { ClassValue };

/**
 * Re-exported, not defined here. The implementation moved to
 * `lib/text/format-single-line.ts` so that a caller needing only the string
 * helper does not pull in the merger through this module - see that file for
 * why the chat find projection made that matter. Callers may import from
 * either place; there is one implementation.
 */
export {
  formatSingleLine,
  type FormatSingleLineOptions,
} from "@/lib/text/format-single-line";
