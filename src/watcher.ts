import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isIgnored } from "./paths.ts";

export interface DirectoryWatcher {
  close(): void;
  updateDependencies(files: Iterable<string>): void;
}

/** Watches the playground plus dependencies it actually consumes elsewhere. */
export function watchDir(
  root: string,
  /**
   * Receives the paths that changed, each with whether the file system
   * reported it as an edit (`change`) or as a file appearing or
   * disappearing (`rename`), which is also how a file saved by replacing
   * it shows up.
   */
  onChange: (paths: Map<string, "change" | "rename">) => void,
  delay = 50,
): DirectoryWatcher {
  let pending = new Map<string, "change" | "rename">();
  let dependencies = new Set<string>();
  let timer: Timer | undefined;
  let closed = false;
  const external = new Map<string, FSWatcher>();
  const used = (file: string) =>
    dependencies.has(file) ||
    [...dependencies].some((dep) => dep.startsWith(file + path.sep));
  const notify = (file: string, event: string) => {
    if (closed) return;
    if (event === "rename" || !pending.has(file)) {
      pending.set(file, event === "rename" ? "rename" : "change");
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = pending;
      pending = new Map();
      onChange(paths);
    }, delay);
  };
  const watcher = watch(root, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const file = path.join(root, filename);
    if (!isIgnored(filename) || used(file)) notify(file, event);
  });

  return {
    updateDependencies(files) {
      if (closed) return;
      dependencies = new Set(files);
      const directories = new Set<string>();
      for (const file of dependencies) {
        const relative = path.relative(root, file);
        // The recursive watcher already handles dependencies inside the root,
        // including explicitly imported files under node_modules.
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) continue;
        directories.add(path.dirname(file));
      }
      for (const [dir, watcher] of external) {
        if (directories.has(dir)) continue;
        watcher.close();
        external.delete(dir);
      }
      for (const dir of directories) {
        if (external.has(dir)) continue;
        try {
          external.set(
            dir,
            watch(dir, (event, filename) => {
              if (!filename) return;
              const file = path.join(dir, filename);
              if (used(file)) notify(file, event);
            }),
          );
        } catch {
          // A dependency may have disappeared while its build was running.
        }
      }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      for (const watcher of external.values()) watcher.close();
    },
  };
}
