// The ambient sign-in verdict lives in `clients/shared` so the CLI's
// `traycer profile login` reads the same rule the GUI does. Re-exported here
// so this app's imports keep their path.
export * from "@traycer-clients/shared/providers/provider-ambient-auth";
