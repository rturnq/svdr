/**
 * Which paths in the served directory are left alone. Paths are relative to
 * the served directory.
 */

const segments = (relativePath: string) => relativePath.split(/[\\/]/);

/**
 * Dotfiles and `node_modules`, at any level, are never scanned, watched or
 * served.
 */
export function isIgnored(relativePath: string): boolean {
  return segments(relativePath).some(
    (part) => part === "node_modules" || part[0] === ".",
  );
}

/**
 * A `tags` directory, at any level, holds the custom tags pages are built
 * from. Its templates are not pages and nothing in it is served.
 */
export function isTagsPath(relativePath: string): boolean {
  return segments(relativePath).includes("tags");
}

/** Whether a request may be answered with the file at this path. */
export function isServable(relativePath: string): boolean {
  return !isIgnored(relativePath) && !isTagsPath(relativePath);
}
