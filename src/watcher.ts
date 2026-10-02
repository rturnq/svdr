import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isIgnored } from "./paths.ts";

/**
 * Watches a directory recursively and reports the absolute paths that were
 * added, changed or removed, batching changes that happen close together.
 */
export function watchDir(
  root: string,
  onChange: (paths: Set<string>) => void,
  delay = 50,
): FSWatcher {
  let pending = new Set<string>();
  let timer: Timer | undefined;

  return watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || isIgnored(filename)) return;
    pending.add(path.join(root, filename));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = pending;
      pending = new Set();
      onChange(paths);
    }, delay);
  }).on("close", () => clearTimeout(timer));
}
