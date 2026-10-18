export interface ArtifactAddress {
  readonly mountId: string;
  readonly artifactId: string;
  /** Full decoded path relative to the artifacts tree root. */
  readonly path: string;
}

const ARTIFACT_ID = /^[a-z0-9_-]+$/;
const MOUNT_ID = /^[a-z0-9]+$/;
const ANDROID_HOST_SUFFIX = ".traycer-artifact.invalid";

/** Manifest paths are decoded once, at the URL boundary, never at lookup. */
export function isArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes("\\") &&
    !Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    path
      .split("/")
      .every((segment) => segment !== "" && !segment.startsWith("."))
  );
}

export function parseArtifactAddress(url: string): ArtifactAddress | null {
  // URL() removes literal and encoded dot segments before callers can reject
  // them. Inspect the original path and authority instead.
  const match =
    /^([A-Za-z][A-Za-z0-9+.-]*):\/\/artifact-([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
  if (match === null) return null;
  const scheme = match[1];
  let authority = match[2];
  if (scheme === "https") {
    if (!authority.endsWith(ANDROID_HOST_SUFFIX)) return null;
    authority = authority.slice(0, -ANDROID_HOST_SUFFIX.length);
  } else if (scheme !== "traycer-sandbox" && scheme !== "traycer-artifact") {
    return null;
  }
  const delimiter = authority.lastIndexOf("--");
  if (delimiter < 1) return null;
  const artifactId = authority.slice(0, delimiter);
  const mountId = authority.slice(delimiter + 2);
  if (!ARTIFACT_ID.test(artifactId) || !MOUNT_ID.test(mountId)) return null;
  let path: string;
  try {
    path = decodeURIComponent(
      (typeof match[3] === "string" ? match[3] : "/").slice(1),
    );
  } catch {
    return null;
  }
  if (path === "") path = "index.html";
  return isArtifactPath(path) ? { artifactId, mountId, path } : null;
}

export interface ArtifactAddressParts {
  readonly origin: string;
  readonly artifactId: string;
  readonly mountId: string;
  readonly treePath: string;
  readonly path: string;
}

/** Keeping the folder in the URL lets the browser resolve parent references. */
export function buildArtifactAddress(address: ArtifactAddressParts): string {
  const { origin, artifactId, mountId, treePath, path } = address;
  const parsed = parseArtifactAddress(origin);
  const relativePath = path === "" ? "index.html" : path;
  const fullPath = treePath === "" ? relativePath : `${treePath}/${relativePath}`;
  if (
    !/^[^:/?#]+:\/\/[^/?#]+$/.test(origin) ||
    parsed === null || parsed.artifactId !== artifactId || parsed.mountId !== mountId ||
    !ARTIFACT_ID.test(artifactId) ||
    !MOUNT_ID.test(mountId) ||
    (treePath !== "" && !isArtifactPath(treePath)) ||
    !isArtifactPath(relativePath) ||
    !isArtifactPath(fullPath)
  ) {
    throw new Error("Invalid artifact address");
  }
  return `${origin}/${fullPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function newMountId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
