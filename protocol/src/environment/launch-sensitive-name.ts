/**
 * Variable names that select what a process starts or loads: the loader,
 * interpreter and toolchain hooks, the shell's start files, and the commands
 * a tool runs on its own.
 */
const LAUNCH_SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "IFS",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "COMSPEC",
  "PATHEXT",
  "PSMODULEPATH",
]);

const LAUNCH_SENSITIVE_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "GIT_CONFIG_",
];

const LAUNCH_SENSITIVE_SUFFIXES: readonly string[] = [
  "_COMMAND",
  "_ASKPASS",
  "_EXECUTABLE",
  "_PROGRAM",
  "_OPTIONS",
  "_OPTS",
];

/** Whether a variable of this name selects what starts. Case-insensitive, as Windows reads names. */
export function isLaunchSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  if (LAUNCH_SENSITIVE_NAMES.has(upper)) return true;
  if (upper === "SSH_ASKPASS" || upper === "GIT_SSH") return true;
  return (
    LAUNCH_SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    LAUNCH_SENSITIVE_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}
