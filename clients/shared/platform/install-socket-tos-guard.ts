import { Socket } from "node:net";
import { installSocketTosGuard } from "./socket-tos-guard";

/**
 * Side-effecting entry hook: the CLI and the desktop main process import this
 * FIRST, ahead of anything that can open a connection. Import order is the
 * only ordering guarantee available here - ES module side effects run at
 * import time, before the importing module's own body.
 */
installSocketTosGuard(Socket.prototype);
