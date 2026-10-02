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
  | { type: "error"; message: string };

/**
 * Works out what pages have to do about the given changed paths, after the
 * bundler has dealt with them.
 */
export async function messagesFor(
  root: string,
  paths: Iterable<string>,
  { build, bundled }: UpdateResult,
  describeError: (error: Error) => string,
): Promise<WsMessage[]> {
  const messages: WsMessage[] = [];
  if (build?.error) {
    messages.push({ type: "error", message: describeError(build.error) });
  }

  // Changes to what is bundled show in the build, any other file that
  // changed may be one a page shows as it is.
  let reload = build?.changes.reload ?? false;
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

  const styles = build?.changes.styles ?? [];
  if (reload) messages.push({ type: "reload" });
  else if (styles.length || files.length) {
    messages.push({ type: "styles", styles, files });
  }
  return messages;
}
