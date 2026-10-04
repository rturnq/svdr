import { stat } from "node:fs/promises";
import path from "node:path";
import { assetsPrefix, type UpdateResult } from "./bundler.ts";
import wsScript from "./client/ws.js" with { type: "text" };
import { isServable } from "./paths.ts";

/** Where pages connect to with a WebSocket to hear about changes. */
export const wsPath = `${assetsPrefix}ws`;
/** The script that makes that connection and applies the changes. */
export const wsScriptPath = `${wsPath}.js`;
/** How a page loads that script. */
export const wsScriptTag = `<script type="module" src="${wsScriptPath}"></script>`;
export { wsScript };

export type WsMessage =
  /** Something changed that the page can only pick up by loading again. */
  | { type: "reload" }
  | {
      type: "styles";
      /** Bundled stylesheets that were replaced, as pairs of the old and new URL path. */
      styles: [from: string, to: string][];
      /** URL paths of stylesheets in the served directory that changed. */
      files: string[];
    }
  /** The page's entry failed to bundle; what it shows is its last working build. */
  | { type: "error"; message: string }
  /** The page's entry bundles again. */
  | { type: "ok" };

export interface Notice {
  /** The entry directory whose pages the message is for; all pages without one. */
  entry?: string;
  message: WsMessage;
}

/**
 * Works out what pages have to do about the given changed paths, after the
 * bundler has dealt with them. What happened to an entry only concerns the
 * pages of that entry; a file that is served as it is may be shown by any
 * page.
 */
export async function messagesFor(
  root: string,
  paths: Iterable<string>,
  { build, bundled }: UpdateResult,
  describeError: (error: Error) => string,
): Promise<Notice[]> {
  let reload = false;
  const files: string[] = [];
  for (const changedPath of paths) {
    if (reload) break;
    const relativePath = path.relative(root, changedPath);
    if (
      bundled.has(changedPath) ||
      !isServable(relativePath) ||
      // Editors leave backups behind.
      changedPath.endsWith("~") ||
      !(await stat(changedPath).catch(() => null))?.isFile()
    ) {
      continue;
    }
    if (changedPath.endsWith(".css")) {
      files.push("/" + relativePath.split(path.sep).join("/"));
    } else {
      reload = true;
    }
  }

  const notices: Notice[] = [];
  for (const [entry, { changes, error, recovered }] of build?.entries ?? []) {
    if (error) {
      notices.push({
        entry,
        message: { type: "error", message: describeError(error) },
      });
    }
    // Even when the page needs nothing else, the error it shows is over.
    if (recovered) notices.push({ entry, message: { type: "ok" } });
    if (reload) continue;
    if (changes.reload) {
      notices.push({ entry, message: { type: "reload" } });
    } else if (changes.styles.length) {
      notices.push({
        entry,
        message: { type: "styles", styles: changes.styles, files: [] },
      });
    }
  }
  if (reload) notices.push({ message: { type: "reload" } });
  else if (files.length) {
    notices.push({ message: { type: "styles", styles: [], files } });
  }
  return notices;
}
