// OS-default shell logic now lives in `@traycer/protocol/config`, shared by
// the CLI and the host so a CLI-managed shell row always matches what the
// host's terminals spawn with. Re-exported here so existing CLI imports of
// `../shell/defaults` keep working.
export {
  defaultShellArgs,
  defaultShellPath,
} from "@traycer/protocol/config/store";
