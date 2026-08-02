import { installEnvProxyDispatcher } from "./env-proxy";

/**
 * Side-effecting entry hook: the CLI imports this FIRST so the dispatcher is in
 * place before any module that might dial out (Sentry's transport, the release
 * registry, auth) gets a chance to. Import order is the only ordering guarantee
 * available here - ES module side effects run at import time, before the
 * importing module's own body.
 */
installEnvProxyDispatcher(process.env);
