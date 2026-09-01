export const BUNDLED_BUILD_META_NAME = "traycer-bundled-build";

export function resolveBundledDevelopment(
  environment: "dev" | "staging" | "production",
  rawMode: string | undefined,
): boolean {
  if (rawMode === undefined || rawMode === "vite") return false;
  if (rawMode !== "bundled") {
    throw new Error(
      `TRAYCER_GUI_MODE must be vite or bundled (got "${rawMode}")`,
    );
  }
  if (environment !== "dev") {
    throw new Error(
      `TRAYCER_GUI_MODE=bundled requires TRAYCER_MOBILE_ENV=dev (got "${environment}")`,
    );
  }
  return true;
}

function htmlAttribute(tag: string, name: string): string | null {
  const expression = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  );
  const match = expression.exec(tag);
  return match?.[1] ?? match?.[2] ?? null;
}

export function bundledBuildIdFromHtml(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (htmlAttribute(tag, "name") !== BUNDLED_BUILD_META_NAME) continue;
    const buildId = htmlAttribute(tag, "content");
    return buildId === null || buildId.length === 0 ? null : buildId;
  }
  return null;
}

export function bundledBuildReloadClient(
  buildId: string,
  buildPath: string,
): string {
  return `
(() => {
  const activeBuild = ${JSON.stringify(buildId)};
  const checkForBuild = async () => {
    try {
      const response = await fetch(${JSON.stringify(buildPath)}, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const nextBuild = await response.text();
      if (nextBuild !== activeBuild) location.reload();
    } catch {
      // A build can replace dist/web between polls. Retry on the next tick.
    }
  };
  const pollForBuild = async () => {
    await checkForBuild();
    setTimeout(() => void pollForBuild(), 750);
  };
  void pollForBuild();
})();`;
}
