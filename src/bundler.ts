import { mkdtemp, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rolldown, type OutputChunk } from "rolldown";
import { minifyCss, type Stylesheet } from "./css.ts";
import type { MarkoToolchain } from "./marko.ts";
import { isIgnored, isTagsPath } from "./paths.ts";
import {
  markoPlugins,
  parseEntryId,
  registerAssetsExport,
  toClientEntryId,
  toLoadEntryId,
  toServerEntryId,
  type AssetIds,
  type ModuleImports,
} from "./plugin.ts";

/** URL prefix under which the bundles are served. */
export const assetsPrefix = "/_svdr/";
/** Where, below the prefix, the files of the server bundle are served. */
const serverDir = "server/";
const scriptType = "text/javascript; charset=utf-8";

const markoExt = ".marko";
const taglibFileReg = /(?:^|[\\/])marko(?:-tag)?\.json$/;
/**
 * Files the compiler picks up by convention when they exist next to a
 * template: `style.css` in a tag directory and `<name>.style.css` beside
 * `<name>.marko`. Adding or removing one changes what a template imports.
 */
const conventionFileReg = /(?:^|[\\/])(?:[^\\/]+\.)?style\.\w+$/;

export interface Asset {
  body: Uint8Array;
  type: string;
  /** When a build last changed the file. */
  updated: Date;
}

type Emit = (fileName: string, body: Uint8Array, type: string) => void;

export interface Template {
  render(input?: Record<string, unknown>): PromiseLike<string> & {
    toReadable(): ReadableStream<Uint8Array>;
  };
}

export interface Page {
  /** Absolute path of the `.marko` file. */
  file: string;
  /** The server rendered template, unless the page never bundled or failed to load. */
  template?: Template;
  error?: Error;
}

export interface BuildResult {
  pages: Page[];
  /**
   * Set when bundling failed, in which case the pages are those of the last
   * build that worked.
   */
  error?: Error;
  /** What a page that was rendered by the previous build has to do to be current. */
  changes: Changes;
  ms: number;
}

export interface Changes {
  /** Whether anything but stylesheets changed. */
  reload: boolean;
  /** The stylesheets that were replaced, as pairs of the old and new URL path. */
  styles: [from: string, to: string][];
}

export interface UpdateResult {
  /** The build, if the changes called for one. */
  build?: BuildResult;
  /** The changed paths that are part of the bundles. */
  bundled: Set<string>;
}

type AssetTag = ["style" | "preload" | "script", string];
type AssetManifest = Record<string, { block: AssetTag[]; defer: AssetTag[] }>;

export interface BundlerOptions {
  root: string;
  marko: MarkoToolchain;
  prod: boolean;
  /** URL of a script to load on every page. */
  script?: string;
  onBuild?(result: BuildResult): void;
}

/**
 * Bundles the `.marko` pages of a directory together into a server bundle,
 * which is loaded to render the pages, and a client bundle, which is kept in
 * memory to be served alongside them.
 */
export class Bundler {
  /** The pages by file name, as of the last build that worked. */
  pages = new Map<string, Page>();
  #opts: BundlerOptions;
  #assets = new Map<string, Asset>();
  /** What each stylesheet is made of, to tell which one replaces which. */
  #styleKeys = new Map<string, string>();
  /** Files that went into the bundles and trigger a rebuild when changed. */
  #deps = new Set<string>();
  #failed = false;
  /**
   * Where the server bundle is written. One directory for every build: the
   * names of its files include a hash of their content, so a file that did
   * not change keeps its name and is not loaded again.
   */
  #outDir: Promise<string> | undefined;
  /** The files of the last successful server bundle. */
  #serverFiles = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: BundlerOptions) {
    this.#opts = opts;
  }

  /** Resolves once all changes reported so far have been bundled. */
  get settled(): Promise<void> {
    return this.#queue.then(() => {});
  }

  /** The files of the last build that worked, by URL path. */
  get assets(): ReadonlyMap<string, Asset> {
    return this.#assets;
  }

  /** Finds and bundles all pages in the served directory. */
  scan(): Promise<BuildResult> {
    return this.#enqueue(async () =>
      this.#build(await findPages(this.#opts.root)),
    );
  }

  /** Bundles the pages again if the given added, changed or removed paths affect them. */
  update(changed: Iterable<string>): Promise<UpdateResult> {
    const paths = [...changed].filter(
      (changedPath) => !isIgnored(path.relative(this.#opts.root, changedPath)),
    );
    return this.#enqueue(async () => {
      const files = await findPages(this.#opts.root);
      const previousDeps = this.#deps;
      const isBundled = (changedPath: string) =>
        // Any template may be a tag that is (or now could be) used by a page.
        changedPath.endsWith(markoExt) ||
        path.basename(changedPath) === "package.json" ||
        taglibFileReg.test(changedPath) ||
        conventionFileReg.test(changedPath) ||
        previousDeps.has(changedPath) ||
        this.#deps.has(changedPath);
      let stale =
        this.#failed ||
        files.length !== this.pages.size ||
        files.some((file) => !this.pages.has(file));

      for (const changedPath of paths) {
        if (stale) break;
        if (isBundled(changedPath)) {
          stale = true;
          break;
        }
        // A directory that was added may hold tags, one that was removed may
        // have held files that were bundled.
        const stats = await stat(changedPath).catch(() => null);
        stale = stats
          ? stats.isDirectory()
          : [...this.#deps].some((dep) =>
              dep.startsWith(changedPath + path.sep),
            );
      }

      return {
        build: stale ? await this.#build(files) : undefined,
        bundled: new Set(paths.filter(isBundled)),
      };
    });
  }

  async close(): Promise<void> {
    await this.#queue;
    if (this.#outDir) {
      await rm(await this.#outDir, { recursive: true, force: true });
    }
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #build(files: string[]): Promise<BuildResult> {
    const start = performance.now();
    let error: Error | undefined;
    let changes: Changes = { reload: false, styles: [] };

    // Adding or removing a template can change which file a tag resolves to.
    this.#opts.marko.compiler.taglib.clearCaches();

    const outDir = await (this.#outDir ??= createOutDir());

    try {
      const bundled = files.length
        ? await this.#bundle(files, outDir)
        : {
            pages: [],
            assets: new Map<string, Asset>(),
            styleKeys: new Map<string, string>(),
            deps: new Set<string>(),
            serverFiles: new Set<string>(),
          };
      changes = diff(
        this.#assets,
        this.#styleKeys,
        bundled.assets,
        bundled.styleKeys,
      );
      this.pages = new Map(bundled.pages.map((page) => [page.file, page]));
      this.#assets = bundled.assets;
      this.#styleKeys = bundled.styleKeys;
      this.#deps = bundled.deps;
      this.#serverFiles = bundled.serverFiles;
      this.#failed = false;
    } catch (err) {
      error = err as Error;
      // The last working build keeps being served. Only pages it does not
      // have, because they are new, have nothing to show but the error.
      this.pages = new Map(
        files.map((file) => [file, this.pages.get(file) ?? { file, error }]),
      );
      // Anything could fix the build, so the next change always bundles again.
      this.#failed = true;
    }

    await this.#prune(outDir);
    const result: BuildResult = {
      pages: [...this.pages.values()],
      error,
      changes,
      ms: performance.now() - start,
    };
    this.#opts.onBuild?.(result);
    return result;
  }

  /** Removes files that are not part of the current server bundle. */
  async #prune(outDir: string) {
    const entries = await readdir(outDir, {
      recursive: true,
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const file = path.join(entry.parentPath, entry.name);
        if (!this.#serverFiles.has(file)) {
          await unlink(file).catch(() => {});
        }
      }),
    );
  }

  async #bundle(files: string[], outDir: string) {
    const { root, marko, prod } = this.#opts;
    const assetIds: AssetIds = { page: new Map(), load: new Map() };
    const css = new Map<
      string,
      Pick<Stylesheet, "css" | "hasImports" | "fileName">
    >();
    const imports = new Map<string, ModuleImports>();
    const deps = new Set(files);
    const assets = new Map<string, Asset>();
    const serverFiles = new Set<string>();
    const now = new Date();
    const emit: Emit = (fileName, body, type) => {
      const url = assetsPrefix + fileName;
      // The name of a file includes a hash of its content, so a file that
      // is already there has not changed.
      const updated = this.#assets.get(url)?.updated ?? now;
      assets.set(url, { body, type, updated });
    };
    const plugins = markoPlugins({
      root,
      marko,
      optimize: prod,
      assetIds,
      css,
      imports,
      emitFile: emit,
    });
    // Entries are named after their path so their names are unique.
    const toInput = (entryIds: string[]) =>
      Object.fromEntries(
        entryIds.map((id) => [
          path
            .relative(root, id.slice(0, -markoExt.length))
            .split(path.sep)
            .join("/"),
          id,
        ]),
      );

    // Everything is bundled into the server build, so that it can be loaded
    // from outside of the served directory.
    const serverBuild = await rolldown({
      input: toInput(files.map(toServerEntryId)),
      platform: "node",
      plugins: [plugins.server],
    });
    let serverChunks: OutputChunk[];
    try {
      const { output } = await serverBuild.write({
        dir: outDir,
        format: "esm",
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "[name]-[hash].js",
      });
      serverChunks = output.filter((item) => item.type === "chunk");
      for (const chunk of serverChunks) {
        emit(serverDir + chunk.fileName, Buffer.from(chunk.code), scriptType);
      }
      for (const item of output) {
        serverFiles.add(path.join(outDir, item.fileName));
      }
      for (const dep of await serverBuild.watchFiles) deps.add(dep);
    } finally {
      await serverBuild.close();
    }

    const clientBuild = await rolldown({
      input: toInput([
        ...files.map(toClientEntryId),
        ...Array.from(assetIds.load.keys(), toLoadEntryId),
      ]),
      platform: "browser",
      plugins: [plugins.client],
      transform: {
        define: {
          "process.env.NODE_ENV": JSON.stringify(
            prod ? "production" : "development",
          ),
        },
      },
    });
    let clientChunks: OutputChunk[];
    try {
      const { output } = await clientBuild.generate({
        format: "esm",
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "[name]-[hash].js",
        minify: prod,
        sourcemap: !prod,
      });
      clientChunks = output.filter((item) => item.type === "chunk");
      // A chunk without code, such as the entry of a page without any client
      // side behavior, is left out unless another chunk imports it.
      const imported = new Set(
        clientChunks.flatMap((chunk) => [
          ...chunk.imports,
          ...chunk.dynamicImports,
        ]),
      );
      const omitted = new Set<string>();
      for (const chunk of clientChunks) {
        if (isEmptyChunk(chunk) && !imported.has(chunk.fileName)) {
          omitted.add(chunk.fileName);
          if (chunk.sourcemapFileName) omitted.add(chunk.sourcemapFileName);
        }
      }
      for (const item of output) {
        if (omitted.has(item.fileName)) continue;
        if (item.type === "chunk") {
          emit(item.fileName, Buffer.from(item.code), scriptType);
        } else {
          emit(
            item.fileName,
            Buffer.from(item.source),
            Bun.file(item.fileName).type,
          );
        }
      }
      for (const dep of await clientBuild.watchFiles) deps.add(dep);
    } finally {
      await clientBuild.close();
    }

    const { manifest, styleKeys } = createManifest(
      clientChunks,
      css,
      imports,
      assetIds,
      emit,
      this.#opts.script,
      prod,
    );
    // Loading is part of the build: a page that fails to load fails the
    // build, so that the last working build keeps being served.
    const loaded = await Promise.all(
      serverChunks.map(async (chunk) => {
        const entry = chunk.isEntry && parseEntryId(chunk.facadeModuleId ?? "");
        if (!entry) return;
        try {
          const server = await import(path.join(outDir, chunk.fileName));
          return { file: entry.file, server };
        } catch (error) {
          throw new Error(
            `Failed to load ${path.relative(root, entry.file)}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }),
    );
    // The pages share the module the assets are registered with, and so may
    // the pages of the last build. Nothing is registered until every page
    // has loaded, so a failed build does not change what they link to.
    const pages: Page[] = [];
    for (const page of loaded) {
      if (!page) continue;
      page.server[registerAssetsExport](manifest);
      pages.push({ file: page.file, template: page.server.default });
    }

    return {
      pages,
      assets,
      styleKeys,
      deps,
      serverFiles,
    };
  }
}

/**
 * Creates the directory the server bundle is written to. Bun does not notice
 * files added to a directory it reached through a symlink (such as macOS's
 * `/var/folders`) once it has resolved a module there, so the path is
 * resolved first.
 */
async function createOutDir() {
  return mkdtemp(path.join(await realpath(os.tmpdir()), "svdr-"));
}

/**
 * Splits the styles up into stylesheets the way scripts are split up into
 * chunks: styles used by the same entries share a stylesheet, so that pages
 * share stylesheets just like they share chunks. A stylesheet is only
 * shared when every entry that uses it has its styles together and in the
 * same order, so that the cascade is the same as with one stylesheet per
 * style.
 */
function groupStyles(entries: { styleIds: string[] }[]): string[][] {
  const users = new Map<string, number[]>();
  entries.forEach(({ styleIds }, index) => {
    for (const id of styleIds) {
      const indexes = users.get(id);
      if (indexes) indexes.push(index);
      else users.set(id, [index]);
    }
  });

  const groups = new Map<number, string[]>();
  const groupOf = new Map<string, number>();
  let nextGroup = 0;
  const createGroup = (ids: string[]) => {
    const group = nextGroup++;
    groups.set(group, ids);
    for (const id of ids) groupOf.set(id, group);
    return group;
  };
  const byKey = new Map<string, number>();
  for (const [id, indexes] of users) {
    const key = indexes.join(",");
    let group = byKey.get(key);
    if (group === undefined) byKey.set(key, (group = createGroup([])));
    groups.get(group)!.push(id);
    groupOf.set(id, group);
  }

  // Split a group as long as some entry has its styles apart or in another
  // order. Every split makes more groups, so this ends.
  let split = true;
  while (split) {
    split = false;
    for (const { styleIds } of entries) {
      const runs = new Map<number, string[][]>();
      let last: number | undefined;
      for (const id of styleIds) {
        const group = groupOf.get(id)!;
        if (group !== last) {
          runs.set(group, [...(runs.get(group) ?? []), []]);
          last = group;
        }
        runs.get(group)!.at(-1)!.push(id);
      }
      for (const [group, groupRuns] of runs) {
        const ids = groups.get(group)!;
        if (
          groupRuns.length === 1 &&
          groupRuns[0]!.every((id, i) => id === ids[i])
        ) {
          continue;
        }
        groups.delete(group);
        for (const run of groupRuns) createGroup(run);
        split = true;
      }
      if (split) break;
    }
  }
  return [...groups.values()];
}

/** Encodes the URL path of a bundled file, segment by segment. */
export function assetUrl(pathname: string): string {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

/** Whether a chunk has no code of its own and does not load any other chunk. */
function isEmptyChunk(chunk: OutputChunk) {
  return (
    !chunk.imports.length &&
    !chunk.dynamicImports.length &&
    Object.values(chunk.modules).every((mod) => !mod.renderedLength)
  );
}

/**
 * Compares the files of two builds. Only when nothing but the content of
 * stylesheets differs can a page pick up the changes without being reloaded.
 */
function diff(
  previous: ReadonlyMap<string, Asset>,
  previousStyleKeys: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, Asset>,
  nextStyleKeys: ReadonlyMap<string, string>,
): Changes {
  // Source maps are not part of what a page shows.
  const changed = (from: ReadonlyMap<string, Asset>, to: typeof from) =>
    [...from.keys()].filter((url) => !to.has(url) && !url.endsWith(".map"));
  const removed = changed(previous, next);
  const added = changed(next, previous);
  const styles: Changes["styles"] = [];

  for (const url of removed) {
    const key = previousStyleKeys.get(url);
    const replacement =
      key !== undefined && added.find((to) => nextStyleKeys.get(to) === key);
    if (!replacement) return { reload: true, styles: [] };
    styles.push([url, replacement]);
  }
  return styles.length === added.length
    ? { reload: false, styles }
    : { reload: true, styles: [] };
}

/**
 * Works out which stylesheets and scripts the server has to write for each
 * page and each lazily loaded template, emitting the stylesheets along the
 * way.
 */
function createManifest(
  chunks: OutputChunk[],
  css: Map<string, Pick<Stylesheet, "css" | "hasImports" | "fileName">>,
  imports: Map<string, ModuleImports>,
  assetIds: AssetIds,
  emit: Emit,
  script: string | undefined,
  minify: boolean,
): { manifest: AssetManifest; styleKeys: Map<string, string> } {
  const chunksByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const toUrl = (fileName: string) => assetUrl(assetsPrefix + fileName);
  const manifest: AssetManifest = {};

  /** The styles a module needs, each after the styles of the modules it imports. */
  const collectStyles = (entryId: string, lazy: boolean) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const imported = imports.get(id);
      for (const dep of imported?.static ?? []) visit(dep);
      if (lazy) for (const dep of imported?.dynamic ?? []) visit(dep);
      if (css.has(id)) ids.push(id);
    };
    visit(entryId);
    return ids;
  };

  const scriptTags = (entry: OutputChunk): AssetTag[] => {
    // Pages without any client side behavior do not need their (empty) script.
    if (isEmptyChunk(entry)) return [];
    const seen = new Set<OutputChunk>();
    const tags: AssetTag[] = [];
    const visit = (chunk: OutputChunk | undefined) => {
      if (!chunk || seen.has(chunk)) return;
      seen.add(chunk);
      for (const name of chunk.imports) visit(chunksByName.get(name));
      tags.push([
        chunk === entry ? "script" : "preload",
        toUrl(chunk.fileName),
      ]);
    };
    visit(entry);
    return tags;
  };

  const entries: {
    assetId: string;
    chunk: OutputChunk;
    styleIds: string[];
    isPage: boolean;
  }[] = [];

  for (const chunk of chunks) {
    const entry = chunk.isEntry && parseEntryId(chunk.facadeModuleId ?? "");
    if (!entry) continue;
    const isPage = entry.kind === "client";
    const assetId = (isPage ? assetIds.page : assetIds.load).get(entry.file);
    if (!assetId) continue;
    // Styles behind a dynamic import are written with the page as well:
    // nothing else would load them when the import happens.
    const styleIds = collectStyles(chunk.facadeModuleId!, true);
    entries.push({ assetId, chunk, styleIds, isPage });
  }

  const styles = new Map<string, AssetTag>();
  const styleKeys = new Map<string, string>();
  // An import-bearing stylesheet keeps its own link and source order. Joining
  // it to another sheet would either invalidate its imports or move them ahead
  // of preceding rules and layer declarations.
  const groups: string[][] = [];
  for (const ids of groupStyles(entries)) {
    let local: string[] = [];
    for (const id of ids) {
      if (css.get(id)!.hasImports) {
        if (local.length) groups.push(local);
        groups.push([id]);
        local = [];
      } else {
        local.push(id);
      }
    }
    if (local.length) groups.push(local);
  }
  for (const ids of groups) {
    const name = path
      .basename(ids[0]!)
      .replace(/(?:\.marko(?:\.\d+)?)?\.css$/, "");
    const text = ids
      .map((id) => css.get(id)!.css.trim())
      .filter(Boolean)
      .join("\n");
    const body = Buffer.from(minify ? minifyCss(text, `${name}.css`) : text);
    if (!body.length) continue;
    const fileName =
      css.get(ids[0]!)!.fileName ??
      `${name}-${Bun.hash(body).toString(36)}.css`;
    emit(fileName, body, "text/css; charset=utf-8");
    styleKeys.set(assetsPrefix + fileName, ids.join("\0"));
    for (const id of ids) styles.set(id, ["style", toUrl(fileName)]);
  }

  for (const { assetId, chunk, styleIds, isPage } of entries) {
    const scripts = scriptTags(chunk);
    if (isPage && script) scripts.push(["script", script]);
    manifest[assetId] = {
      block: [
        ...new Set(
          styleIds
            .map((id) => styles.get(id))
            .filter((tag) => tag !== undefined),
        ),
      ],
      defer: scripts,
    };
  }

  return { manifest, styleKeys };
}

/** Finds the `.marko` files that are pages, which excludes those in `tags` directories. */
async function findPages(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [],
    );
    await Promise.all(
      entries.map(async (entry) => {
        if (isIgnored(entry.name) || isTagsPath(entry.name)) return;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(entryPath);
        else if (entry.name.endsWith(markoExt)) files.push(entryPath);
      }),
    );
  };
  await walk(dir);
  return files.sort();
}
