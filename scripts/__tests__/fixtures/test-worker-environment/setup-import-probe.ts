if (process.env.TRAYCER_ENV_GUARD_PROBE !== undefined) {
  throw new Error(
    "synthetic worker probe was present before later setup import",
  );
}
