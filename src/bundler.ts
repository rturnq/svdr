import { mkdtemp, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rolldown, type OutputChunk } from "rolldown";
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
        taglibFileReg.test(changedPath) ||
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
    const css = new Map<string, string>();
    const imports = new Map<string, ModuleImports>();
    const deps = new Set(files);
    const plugins = markoPlugins({
      root,
      marko,
      optimize: prod,
      assetIds,
      css,
      imports,
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
    );
    const pages = await Promise.all(
      serverChunks.map(async (chunk): Promise<Page | undefined> => {
        const entry = chunk.isEntry && parseEntryId(chunk.facadeModuleId ?? "");
        if (!entry) return;
        try {
          const server = await import(path.join(outDir, chunk.fileName));
          // All pages share the module the assets are registered with.
          server[registerAssetsExport](manifest);
          return { file: entry.file, template: server.default };
        } catch (error) {
          return { file: entry.file, error: error as Error };
        }
      }),
    );

    return {
      pages: pages.filter((page) => page !== undefined),
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
  css: Map<string, string>,
  imports: Map<string, ModuleImports>,
  assetIds: AssetIds,
  emit: Emit,
  script: string | undefined,
): { manifest: AssetManifest; styleKeys: Map<string, string> } {
  const chunksByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const toUrl = (fileName: string) => encodeURI(assetsPrefix + fileName);
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
  const pageEntries: [file: string, chunk: OutputChunk][] = [];
  const lazyStyleIds = new Set<string>();

  for (const chunk of chunks) {
    const entry = chunk.isEntry && parseEntryId(chunk.facadeModuleId ?? "");
    if (!entry) continue;
    if (entry.kind === "client") {
      pageEntries.push([entry.file, chunk]);
      continue;
    }

    const assetId = assetIds.load.get(entry.file);
    if (!assetId) continue;
    const styleIds = collectStyles(chunk.facadeModuleId!, true);
    for (const id of styleIds) lazyStyleIds.add(id);
    entries.push({ assetId, chunk, styleIds, isPage: false });
  }

  for (const [file, chunk] of pageEntries) {
    const assetId = assetIds.page.get(file);
    if (!assetId) continue;
    const loaded = new Set(collectStyles(chunk.facadeModuleId!, false));
    // Styles that are not written with a lazily loaded template belong to
    // the page, even when their script is only loaded on demand.
    const styleIds = collectStyles(chunk.facadeModuleId!, true).filter(
      (id) => loaded.has(id) || !lazyStyleIds.has(id),
    );
    entries.push({ assetId, chunk, styleIds, isPage: true });
  }

  // Like scripts, styles are split up by which entries use them, so that
  // pages share stylesheets just like they share chunks.
  const users = new Map<string, string[]>();
  for (const { assetId, styleIds } of entries) {
    for (const id of styleIds) {
      const assetIds = users.get(id);
      if (assetIds) assetIds.push(assetId);
      else users.set(id, [assetId]);
    }
  }
  const groups = new Map<string, string[]>();
  for (const [id, assetIds] of users) {
    const key = assetIds.join("\0");
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }
  const styles = new Map<string, AssetTag>();
  const styleKeys = new Map<string, string>();
  for (const ids of groups.values()) {
    const body = Buffer.from(
      ids
        .map((id) => css.get(id)!.trim())
        .filter(Boolean)
        .join("\n"),
    );
    if (!body.length) continue;
    const name = path
      .basename(ids[0]!)
      .replace(/(?:\.marko(?:\.\d+)?)?\.css$/, "");
    const fileName = `${name}-${Bun.hash(body).toString(36)}.css`;
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
