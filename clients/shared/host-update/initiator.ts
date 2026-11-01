/**
 * Set by Traycer Desktop on the CLI commands it runs, so the lock those
 * commands take can say who is behind them. The attempt lock carries a pid and
 * a reason and nothing else, and Desktop's update work is a CLI child: without
 * this a person's `traycer host update` could not tell the app's download from
 * another terminal's.
 *
 * A label on a refusal and nothing more. It authorizes nothing, and no
 * admission reads it.
 */
export const HOST_UPDATE_INITIATOR_ENV_VAR = "TRAYCER_HOST_UPDATE_INITIATOR";
export const HOST_UPDATE_INITIATOR_DESKTOP = "desktop";
