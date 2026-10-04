import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rolldown, type OutputChunk } from "rolldown";
import type { FileRef } from "./assets.ts";
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

/**
 * A file of a bundle: generated, and held in memory, or a file a page
 * refers to, which stays on disk and is served from there.
 */
export type Asset = {
  type: string;
  size: number;
  /** When a build last changed the file. */
  updated: Date;
} & ({ body: Uint8Array } | FileRef);

export interface EntryFiles {
  /** Page path relative to the served directory. */
  file: string;
  prefix: string;
  assets: ReadonlyMap<string, Asset>;
}

/** A stable directory name based on the page path, independent of its content. */
export function entryPrefix(root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const hash = createHash("sha256")
    .update(relative)
    .digest("base64url")
    .slice(0, 5);
  return `${assetsPrefix}${hash}/`;
}

type Emit = (
  fileName: string,
  content: Uint8Array | FileRef,
  type: string,
) => void;

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
  /** Entries attempted by this build batch. */
  pages: Page[];
  /**
   * Reports failed entries. Each failed entry retains its last working build;
   * successful entries publish independently.
   */
  error?: Error;
  /**
   * What happened to each entry of the batch, by its directory. Entries are
   * independent, so a page only has to act on what happened to its own.
   */
  entries: Map<string, EntryResult>;
  ms: number;
}

export interface EntryResult {
  /** What a page rendered by the entry's previous build has to do to be current. */
  changes: Changes;
  error?: Error;
  /** Whether the entry bundled again after its last build had failed. */
  recovered?: boolean;
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

/** What the bundler is doing, as it happens. Paths are absolute. */
export type BundlerEvent =
  /** The entries a batch is about to bundle, and why each one. */
  | { type: "plan"; entries: { file: string; reason: string }[] }
  /** An entry finished. With an error, `kept` tells whether its last working build is still served. */
  | { type: "entry"; file: string; ms: number; error?: Error; kept: boolean }
  /** A page that no longer exists was dropped. */
  | { type: "removed"; file: string }
  /** Two pages map to the same directory; the second one cannot be served. */
  | { type: "collision"; prefix: string; file: string; other: string }
  /** A batch finished. */
  | { type: "done"; bundled: number; failed: number; ms: number };

export interface BundlerOptions {
  root: string;
  marko: MarkoToolchain;
  prod: boolean;
  /** URL of a script to load on every page. */
  script?: string;
  onEvent?(event: BundlerEvent): void;
}

/** Owns independent builds for each page in the served directory. */
export class Bundler {
  pages = new Map<string, Page>();
  #opts: BundlerOptions;
  #entries = new Map<string, Entry>();
  #assets = new Map<string, Asset>();
  #queue: Promise<unknown> = Promise.resolve();
  /** Resolves once every queued batch has named the entries it will bundle. */
  #registered: Promise<void> = Promise.resolve();
  /** The first build of each entry that has not been bundled yet. */
  #first = new Map<string, Promise<void>>();
  /** Pages that cannot be served because another page has their directory. */
  #collided = new Set<string>();

  constructor(opts: BundlerOptions) {
    this.#opts = opts;
  }

  get settled(): Promise<void> {
    return this.#queue.then(() => {});
  }

  get assets(): ReadonlyMap<string, Asset> {
    return this.#assets;
  }

  get entries(): EntryFiles[] {
    return [...this.#entries].map(([file, entry]) => ({
      file: path.relative(this.#opts.root, file).split(path.sep).join("/"),
      prefix: entry.prefix,
      assets: entry.assets,
    }));
  }

  /**
   * Why the entry with the given directory is failing to bundle, if it is.
   * What the entry serves meanwhile is its last working build, or nothing.
   */
  failure(prefix: string): Error | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.prefix === prefix) return entry.error;
    }
  }

  get dependencies(): ReadonlySet<string> {
    return new Set(
      [...this.#entries.values()].flatMap((entry) => [...entry.deps]),
    );
  }

  /**
   * The page for a file, waiting for its first build when that is queued or
   * running. A page that has been bundled before is returned as it is, even
   * while it is being bundled again.
   */
  async page(file: string): Promise<Page | undefined> {
    const page = this.pages.get(file);
    if (page) return page;
    await this.#registered;
    await this.#first.get(file);
    return this.pages.get(file);
  }

  scan(): Promise<BuildResult> {
    return this.#enqueue(async (registered) => {
      const files = await findPages(this.#opts.root);
      return this.#build(
        files,
        new Map(files.map((file) => [file, "new"])),
        registered,
      );
    });
  }

  update(changed: Iterable<string>): Promise<UpdateResult> {
    const paths = [...changed];
    return this.#enqueue(async (registered) => {
      const stats = new Map(
        await Promise.all(
          paths.map(
            async (file) => [file, await stat(file).catch(() => null)] as const,
          ),
        ),
      );
      const discoveryChanged = paths.some(
        (file) =>
          file.endsWith(markoExt) ||
          stats.get(file)?.isDirectory() ||
          (!stats.get(file) &&
            [...this.#entries.keys()].some((entry) =>
              entry.startsWith(file + path.sep),
            )),
      );
      const files = discoveryChanged
        ? await findPages(this.#opts.root)
        : [...this.#entries.keys()];
      const previousDeps = new Set(
        [...this.#entries.values()].flatMap((entry) => [...entry.deps]),
      );
      const relative = (file: string) =>
        path.relative(this.#opts.root, file).split(path.sep).join("/");
      /** The entries to bundle, each with the reason why. */
      const affected = new Map<string, string>();
      const structural: string[] = [];
      for (const file of paths) {
        // Tag discovery and package mappings may introduce new dependencies.
        // Ordinary edits are handled by each entry's existing import graph.
        if (
          taglibFileReg.test(file) ||
          path.basename(file) === "package.json" ||
          (conventionFileReg.test(file) && !previousDeps.has(file)) ||
          (file.endsWith(markoExt) &&
            isTagsPath(path.relative(this.#opts.root, file)) &&
            !previousDeps.has(file)) ||
          (stats.get(file)?.isDirectory() &&
            isTagsPath(path.relative(this.#opts.root, file)))
        ) {
          structural.push(file);
        }
      }
      for (const file of files) {
        const entry = this.#entries.get(file);
        if (!entry) {
          // A page that lost its directory to another one is only tried
          // again when the pages themselves changed.
          if (!this.#collided.has(file) || discoveryChanged) {
            affected.set(file, "new");
          }
        } else if (entry.failed) {
          affected.set(file, "its last build failed");
        } else if (structural.length) {
          affected.set(file, `${relative(structural[0]!)} changed`);
        } else {
          const dep = paths.find((changed) =>
            [...entry.deps].some(
              (dep) => dep === changed || dep.startsWith(changed + path.sep),
            ),
          );
          if (dep === file) affected.set(file, "changed");
          else if (dep) affected.set(file, `uses ${relative(dep)}`);
        }
      }
      const removed = [...this.#entries.keys()].some(
        (file) => !files.includes(file),
      );
      const build =
        affected.size || removed
          ? await this.#build(files, affected, registered)
          : undefined;
      const deps = new Set([
        ...previousDeps,
        ...[...this.#entries.values()].flatMap((entry) => [...entry.deps]),
      ]);
      return {
        build,
        bundled: new Set(
          paths.filter(
            (file) =>
              deps.has(file) ||
              file.endsWith(markoExt) ||
              structural.includes(file),
          ),
        ),
      };
    });
  }

  async close(): Promise<void> {
    await this.#queue;
    await Promise.all(
      [...this.#entries.values()].map((entry) => entry.close()),
    );
  }

  /**
   * Runs a task after the ones before it. The task calls `registered` once
   * it has named the entries it will bundle, for `page()` to wait on them.
   */
  #enqueue<T>(task: (registered: () => void) => Promise<T>): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const before = this.#registered;
    this.#registered = before.then(() => promise);
    const result = this.#queue.then(() => task(resolve)).finally(resolve);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #build(
    found: string[],
    affected: Map<string, string>,
    registered: () => void,
  ): Promise<BuildResult> {
    const start = performance.now();
    const emit = (event: BundlerEvent) => this.#opts.onEvent?.(event);
    // A page whose directory is taken by another page cannot be served; the
    // page that had the directory first, or comes first, keeps it.
    const prefixes = new Map<string, string>();
    for (const file of [
      ...found.filter((file) => this.#entries.has(file)),
      ...found.filter((file) => !this.#entries.has(file)),
    ]) {
      const prefix = entryPrefix(this.#opts.root, file);
      const other = prefixes.get(prefix);
      if (other === undefined) {
        prefixes.set(prefix, file);
        this.#collided.delete(file);
        continue;
      }
      if (!this.#collided.has(file)) {
        emit({ type: "collision", prefix, file, other });
      }
      this.#collided.add(file);
      this.pages.set(file, {
        file,
        error: new Error(
          `${path.relative(this.#opts.root, file)} maps to the same directory (${prefix}) as ${path.relative(this.#opts.root, other)} and cannot be served alongside it`,
        ),
      });
    }
    for (const file of this.#collided) {
      if (!found.includes(file)) this.#collided.delete(file);
    }
    const files = found.filter((file) => !this.#collided.has(file));
    const results = new Map<string, EntryResult>();
    const errors: Error[] = [];
    for (const [file, entry] of this.#entries) {
      if (files.includes(file)) continue;
      this.#entries.delete(file);
      this.pages.delete(file);
      for (const url of entry.assets.keys()) this.#assets.delete(url);
      await entry.close();
      results.set(entry.prefix, { changes: { reload: true, styles: [] } });
      emit({ type: "removed", file });
    }
    for (const file of this.pages.keys()) {
      if (!found.includes(file)) this.pages.delete(file);
    }
    // Clear once before starting the independent compilers, never during one.
    this.#opts.marko.compiler.taglib.clearCaches();
    const pending = files.filter((file) => affected.has(file));
    // Entries exist before any of them is bundled, so that a request for a
    // page that has not been bundled yet can wait for it.
    const firsts = new Map<string, () => void>();
    for (const file of pending) {
      if (this.#entries.has(file)) continue;
      this.#entries.set(file, new Entry(this.#opts, file));
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#first.set(file, promise);
      firsts.set(file, resolve);
    }
    registered();
    if (pending.length) {
      emit({
        type: "plan",
        entries: pending.map((file) => ({
          file,
          reason: affected.get(file)!,
        })),
      });
    }
    let failed = 0;
    let next = 0;
    // Bound native build concurrency so a directory with many examples does
    // not start two bundlers for every page at once.
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (next < pending.length) {
          const file = pending[next++]!;
          const entry = this.#entries.get(file)!;
          const oldAssets = entry.assets;
          const oldStyleKeys = entry.styleKeys;
          const oldUrls = [...oldAssets.keys()];
          const wasFailed = entry.failed;
          const started = performance.now();
          const error = await entry.build();
          if (error) {
            errors.push(error);
            failed++;
          }
          results.set(entry.prefix, {
            changes: diff(
              oldAssets,
              oldStyleKeys,
              entry.assets,
              entry.styleKeys,
            ),
            error,
            recovered: wasFailed && !error,
          });
          // Publish each entry as soon as it is ready. Other builds neither
          // block its requests nor prevent it from keeping its last good output.
          for (const url of oldUrls) this.#assets.delete(url);
          for (const [url, asset] of entry.assets) this.#assets.set(url, asset);
          this.pages.set(file, entry.page);
          this.#first.delete(file);
          firsts.get(file)?.();
          emit({
            type: "entry",
            file,
            ms: performance.now() - started,
            error,
            kept: !!error && !!entry.page.template,
          });
        }
      }),
    );
    const result: BuildResult = {
      pages: pending.map((file) => this.pages.get(file)!),
      error: errors.length
        ? new Error(errors.map((error) => error.message).join("\n\n"))
        : undefined,
      entries: results,
      ms: performance.now() - start,
    };
    if (pending.length) {
      emit({
        type: "done",
        bundled: pending.length - failed,
        failed,
        ms: result.ms,
      });
    }
    return result;
  }
}

/** A page owns its server modules, browser assets and dependency graph. */
class Entry {
  page: Page;
  assets = new Map<string, Asset>();
  styleKeys = new Map<string, string>();
  deps: Set<string>;
  failed = false;
  /** Why the last build failed, if it did. */
  error: Error | undefined;
  #opts: BundlerOptions;
  readonly prefix: string;
  #outDir: Promise<string> | undefined;
  #serverFiles = new Set<string>();

  constructor(opts: BundlerOptions, file: string) {
    this.#opts = opts;
    this.page = { file };
    this.deps = new Set([file]);
    this.prefix = entryPrefix(opts.root, file);
  }

  async build(): Promise<Error | undefined> {
    let error: Error | undefined;
    try {
      const outDir = await (this.#outDir ??= createOutDir());
      const bundled = await this.#bundle(this.page.file, outDir);
      this.page = bundled.page;
      this.assets = bundled.assets;
      this.styleKeys = bundled.styleKeys;
      this.deps = bundled.deps;
      this.#serverFiles = bundled.serverFiles;
      this.failed = false;
      this.error = undefined;
    } catch (cause) {
      error = new Error(
        `${path.relative(this.#opts.root, this.page.file)}: ${(cause as Error).message}`,
        { cause },
      );
      if (!this.page.template) this.page = { file: this.page.file, error };
      this.failed = true;
      this.error = error;
    }
    if (this.#outDir) {
      const outDir = await this.#outDir.catch(() => undefined);
      if (outDir) await this.#prune(outDir).catch(() => {});
      else this.#outDir = undefined;
    }
    return error;
  }

  async close(): Promise<void> {
    if (this.#outDir)
      await rm(await this.#outDir, { recursive: true, force: true });
  }

  async #prune(outDir: string) {
    const entries = await readdir(outDir, {
      recursive: true,
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const file = path.join(entry.parentPath, entry.name);
        if (!this.#serverFiles.has(file)) await unlink(file).catch(() => {});
      }),
    );
  }

  async #bundle(file: string, outDir: string) {
    const { root, marko, prod } = this.#opts;
    const assetIds: AssetIds = { page: new Map(), load: new Map() };
    const css = new Map<string, Pick<Stylesheet, "css" | "fileName">>();
    const imports = new Map<string, ModuleImports>();
    const deps = new Set([file]);
    const assets = new Map<string, Asset>();
    const serverFiles = new Set<string>();
    const now = new Date();
    const emit: Emit = (fileName, content, type) => {
      const url = this.prefix + fileName;
      // The name of a file includes a hash of its content, so a file that
      // is already there has not changed.
      const updated = this.assets.get(url)?.updated ?? now;
      assets.set(
        url,
        content instanceof Uint8Array
          ? { body: content, size: content.length, type, updated }
          : { ...content, type, updated },
      );
    };
    const plugins = markoPlugins({
      root,
      marko,
      optimize: prod,
      assetIds,
      css,
      imports,
      emitFile: emit,
      assetPrefix: this.prefix,
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
      input: toInput([toServerEntryId(file)]),
      platform: "node",
      onLog(level, log, handler) {
        handler(log.code === "UNRESOLVED_IMPORT" ? "error" : level, log);
      },
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
    } finally {
      try {
        for (const dep of await serverBuild.watchFiles) deps.add(dep);
        this.deps = new Set([...this.deps, ...deps]);
      } finally {
        await serverBuild.close();
      }
    }

    const clientBuild = await rolldown({
      input: toInput([
        toClientEntryId(file),
        ...Array.from(assetIds.load.keys(), toLoadEntryId),
      ]),
      platform: "browser",
      onLog(level, log, handler) {
        handler(log.code === "UNRESOLVED_IMPORT" ? "error" : level, log);
      },
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
    } finally {
      try {
        for (const dep of await clientBuild.watchFiles) deps.add(dep);
        this.deps = new Set([...this.deps, ...deps]);
      } finally {
        await clientBuild.close();
      }
    }

    const { manifest, styleKeys } = createManifest(
      clientChunks,
      css,
      imports,
      assetIds,
      emit,
      this.#opts.script,
      prod,
      this.prefix,
    );
    const chunk = serverChunks.find(
      (chunk) =>
        chunk.isEntry &&
        parseEntryId(chunk.facadeModuleId ?? "")?.file === file,
    );
    if (!chunk) throw new Error(`Missing server entry for ${file}`);
    // Importing and registering only happens after both builds succeeded.
    // Each page's runtime lives in its own directory and cannot affect another.
    const server = await import(path.join(outDir, chunk.fileName));
    server[registerAssetsExport](manifest);
    const page: Page = { file, template: server.default };

    return {
      page,
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
  css: Map<string, Pick<Stylesheet, "css" | "fileName">>,
  imports: Map<string, ModuleImports>,
  assetIds: AssetIds,
  emit: Emit,
  script: string | undefined,
  minify: boolean,
  prefix: string,
): { manifest: AssetManifest; styleKeys: Map<string, string> } {
  const chunksByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const toUrl = (fileName: string) => assetUrl(prefix + fileName);
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
  // Keep one link per stylesheet, in each entry's dependency order. This
  // preserves import boundaries without cross-page grouping or concatenation.
  for (const id of new Set(entries.flatMap((entry) => entry.styleIds))) {
    const sheet = css.get(id)!;
    const name = path.basename(id).replace(/(?:\.marko(?:\.\d+)?)?\.css$/, "");
    const body = Buffer.from(
      minify ? minifyCss(sheet.css, `${name}.css`) : sheet.css.trim(),
    );
    if (!body.length) continue;
    const fileName =
      sheet.fileName ??
      `${name}-${Bun.hash(id + "\0" + body.toString()).toString(36)}.css`;
    emit(fileName, body, "text/css; charset=utf-8");
    styleKeys.set(prefix + fileName, prefix + "\0" + id);
    styles.set(id, ["style", toUrl(fileName)]);
  }

  for (const { assetId, chunk, styleIds, isPage } of entries) {
    const scripts = scriptTags(chunk);
    // The script is told which entry the page belongs to, to hear about
    // that entry only.
    if (isPage && script) {
      scripts.push([
        "script",
        `${script}?entry=${prefix.slice(assetsPrefix.length, -1)}`,
      ]);
    }
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
