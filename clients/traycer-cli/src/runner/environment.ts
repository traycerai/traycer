// The deployment slot the CLI + host operate on IS the build's
// `config.environment` (dev | production), baked per build - there is no
// separate "channel" concept, flag, or env. Each environment is an isolated
// install tree + service label, so a production build only ever touches the
// production tree, dev the dev tree:
//   - "production" → ~/.traycer/<component>/         + ai.traycer.host
//   - "dev"        → ~/.traycer/<component>/dev/      + ai.traycer.host.dev
//
// `resolveRuntimeContext` sets `RuntimeContext.environment` from
// `config.environment`. Re-exported here so runner-aware modules import the
// type from a single place.
export type { Environment } from "../config";
