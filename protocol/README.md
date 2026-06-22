# @traycer/protocol

The single shared contract between Traycer clients (desktop · cli · gui-app) and
the host. Every consumer lives in this monorepo today and resolves the contract
straight from TypeScript source.

## Build & consumption

- **In-repo resolution is source-first.** `exports` point at the TypeScript
  source (`./src/*.ts`, `./utils/*.ts`), so the whole monorepo — host,
  clients, the CLI esbuild bundle, and every vitest suite — resolves protocol
  with **no build step**. This is the intentional pre-split state: a fresh
  checkout type-checks, tests, and bundles without first compiling protocol.
- `bun run build` compiles `src/` + `utils/` to `dist/` (JS + `.d.ts`) via
  `tsconfig.build.json`, then runs `scripts/patch-dist-esm-imports.cjs` to add
  `.js` extensions to the emitted relative `import` specifiers so the compiled
  `dist/` is loadable by raw Node ESM (not just bundlers). This is **publish-only
  output**: nothing in-repo consumes `dist/`, and `dist/` is gitignored.

### Publishing ships `dist/` via `publishConfig` — never flip the top-level `exports`

The top-level `exports`/`types` MUST stay pointed at `./src/*.ts`. `dist/` is not
built in CI (`bun install --frozen-lockfile` + pre-commit run no build), so a
`dist`-pointing top-level `exports` map makes every in-repo Node/vitest/tsc
consumer fail (`ERR_MODULE_NOT_FOUND` / `TS2307`, e.g. `packages/common`
importing `@traycer/protocol/...`). This has regressed CI twice — do not do it.

The publish-time flip is already wired and automatic: **`publishConfig.exports`
(and `publishConfig.types`) point at the compiled `./dist/...` outputs.** npm
applies `publishConfig` to the manifest at publish time, so `npm publish`
(see `release-npm-protocol.yml`, which runs `bun run build` first) ships a
`dist`-pointing package while the in-repo `exports` stay on source. No manual
edit is needed at the repo split — the only remaining split-time chore is
resolving the `catalog:` dev specifiers to concrete versions.

The compiled `dist/` is raw-Node-ESM-loadable because `patch-dist-esm-imports.cjs`
rewrites `tsconfig.build.json`'s extensionless relative specifiers (e.g.
`import "./framework/index"`) to extensioned ones (`"./framework/index.js"`). So
the published package works for both bundler consumers (host via esbuild, OSS
clients via Vite/esbuild) and any future unbundled raw-Node-ESM consumer.

## Two version systems — keep them separate

This package participates in **two independent versioning schemes**. They are not
the same number and must not be conflated:

| System                                           | Where                                                         | Granularity    | Purpose                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| **npm semver**                                   | `package.json` `version`                                      | whole package  | Distribution. Which build of the contract a client/host depends on.               |
| **per-method `{ major, minor }` schema version** | `src/framework/versioned-rpc.ts` (the versioned-RPC registry) | per RPC method | Handshake contract. What the client↔host handshake negotiates against at runtime. |

The runtime handshake negotiates compatibility using the **per-method
`{ major, minor }`** schema versions in the versioned-RPC registry — never the
npm semver of the package. A patch bump to the npm version does not imply a
schema change, and a schema change is gated by the registry's additivity rules
independently of how the package is versioned for distribution.
