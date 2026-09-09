/**
 * The `bun:sqlite` surface the chat-store survey uses, declared locally.
 *
 * NOT a stand-in for `@types/bun`, and deliberately not a reason to add it.
 * This package type-checks with `"types": ["node"]` (see `tsconfig.json`) and
 * the OSS repo carries no Bun types at all; pulling them in for one dynamic
 * import would put Bun's globals into scope for every file in a CLI that
 * ships as a Node binary, which is a worse trade than seven lines here.
 *
 * Only what `host/chat-store-survey.ts` calls is declared, typed as
 * `unknown` where Bun's own types say `any`, so nothing here can quietly
 * widen a value on its way into the survey. If this ever needs a third
 * method, the honest move is to check whether the survey still belongs in
 * one file rather than to grow this one.
 */
declare module "bun:sqlite" {
  export interface BunStatement {
    get(...params: readonly unknown[]): unknown;
  }

  export interface BunDatabaseOptions {
    /**
     * Bun spells this `readonly`; Node's `DatabaseSync` spells the same thing
     * `readOnly`. The survey's engine seam exists to keep that difference
     * from reaching its callers.
     */
    readonly readonly: boolean;
  }

  export class Database {
    constructor(filename: string, options: BunDatabaseOptions);
    query(sql: string): BunStatement;
    close(): void;
  }
}
