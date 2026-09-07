import { app } from "electron";
import { log } from "./logger";

export function configureHostResolverDoH(): void {
  try {
    app.configureHostResolver({
      secureDnsMode: "automatic",
    });
    log.info("[host-resolver] DoH automatic mode configured");
  } catch (err) {
    log.warn("[host-resolver] configureHostResolver failed", { err });
  }
}
