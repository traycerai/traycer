// The declaration the scan must never report: a definition is not a caller.
export function createLocalOpenAuth(options: {
  readonly authnBaseUrl: string;
}): string {
  return options.authnBaseUrl;
}
