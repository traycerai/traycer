/**
 * Exit codes for the signals a killed child realistically reports.
 * 128+n is the shell convention, so 137 reads as SIGKILL (the OOM killer's
 * signal) and 139 as SIGSEGV without needing a lookup. Shared by the Vitest
 * runner (`run-tests.ts`) and the browser regression runner
 * (`run-browser-regressions.ts`).
 */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGABRT: 134,
  SIGBUS: 138,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGSEGV: 139,
  SIGTERM: 143,
};
