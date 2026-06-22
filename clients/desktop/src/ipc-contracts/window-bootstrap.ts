const INITIAL_ROUTE_ARG_PREFIX = "--traycer-initial-route=";

export function createInitialRouteArg(initialRoute: string): string {
  return `${INITIAL_ROUTE_ARG_PREFIX}${encodeURIComponent(
    normalizeInitialRoute(initialRoute),
  )}`;
}

export function readInitialRouteArg(argv: readonly string[]): string | null {
  const arg = argv.find((entry) => entry.startsWith(INITIAL_ROUTE_ARG_PREFIX));
  if (arg === undefined) return null;
  return normalizeInitialRoute(
    decodeURIComponent(arg.slice(INITIAL_ROUTE_ARG_PREFIX.length)),
  );
}

export function normalizeInitialRoute(initialRoute: string): string {
  if (!initialRoute.startsWith("/")) return "/";
  return initialRoute;
}
