import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "rolldown";
import { assetUrl } from "./bundler.ts";
import { bundleStylesheet, type Stylesheet } from "./css.ts";
import {
  builtinImporter,
  compilerConfig,
  type MarkoToolchain,
} from "./marko.ts";
// The module the compiled server entry imports to write the tags for a
// page's assets. The assets are only known once the client bundle has been
// built, so they are registered after the server bundle is loaded.
import linkAssetsRuntime from "./runtime/link-assets.js" with { type: "text" };

const markoExt = ".marko";
const serverEntryExt = ".server-entry.marko";
const clientEntryExt = ".client-entry.marko";
const loadEntryExt = ".load-entry.marko";
const linkAssetsId = "\0svdr:link-assets";
const tagImportReg = /^<([^>]+)>$/;
const styleReg = /\.(?:css|less|s[ac]ss|styl(?:us)?|pcss|postcss)$/i;
const staticAssetReg =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|flac|aac|pdf)$/i;

/**
 * Whether the package a bare specifier names is installed in a
 * `node_modules` directory above the given one.
 */
export function isPackageInstalled(specifier: string, dir: string): boolean {
  const name = /^(?:@[^/]+\/)?[^/]+/.exec(specifier)?.[0];
  if (!name) return false;
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, "node_modules", name, "package.json"))) {
      return true;
    }
    if (current === path.dirname(current)) return false;
  }
}

/** The export a server bundle exposes to receive the assets of its client bundle. */
export const registerAssetsExport = "$$registerAssets";

type EntryKind = "server" | "client" | "load";

export function parseEntryId(
  id: string,
): { kind: EntryKind; file: string } | null {
  for (const [ext, kind] of [
    [serverEntryExt, "server"],
    [clientEntryExt, "client"],
    [loadEntryExt, "load"],
  ] as const) {
    if (id.endsWith(ext)) {
      return { kind, file: id.slice(0, -ext.length) + markoExt };
    }
  }
  return null;
}

export const toServerEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + serverEntryExt;
export const toClientEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + clientEntryExt;
export const toLoadEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + loadEntryExt;

export interface AssetIds {
  page: Map<string, string>;
  load: Map<string, string>;
}

export interface ModuleImports {
  static: readonly string[];
  dynamic: readonly string[];
}

export interface MarkoPluginOptions {
  /** The served directory; files inside it are addressable by URL. */
  root: string;
  marko: MarkoToolchain;
  optimize: boolean;
  /** The isolated URL directory belonging to this page. */
  assetPrefix: string;
  /**
   * The ids the compiled server code uses to request assets, by file name.
   * Filled in by the server build so the client build knows which lazily
   * loaded templates (`import ... with { load }`) need an entry of their own.
   */
  assetIds: AssetIds;
  /** Receives every stylesheet the client build encounters, by module id. */
  css: Map<string, Pick<Stylesheet, "css" | "fileName">>;
  /** Adds a file to the bundle, to be served under the assets prefix. */
  emitFile: (fileName: string, body: Uint8Array, type: string) => void;
  /**
   * Receives what every module of the client build imports, by module id.
   * Style modules leave nothing behind in the bundle, so this is what tells
   * which entries need which styles.
   */
  imports: Map<string, ModuleImports>;
}

/**
 * Creates the plugins for the server and client builds of one page. The two
 * share the compiler's cache, so they are only good for a single build each.
 */
export function markoPlugins(opts: MarkoPluginOptions): {
  server: Plugin;
  client: Plugin;
} {
  const { compiler, translator } = opts.marko;
  const virtualFiles = new Map<string, string>();
  // Stylesheets are prepared once for both builds, so that the server
  // renders the same class names the client's stylesheet has.
  const stylesheets = new Map<string, Promise<Stylesheet>>();
  const assetFiles = new Set<string>();
  const baseConfig = {
    ...compilerConfig,
    translator,
    cache: new Map(),
    optimize: opts.optimize,
    resolveVirtualDependency(
      filename: string,
      dep: { virtualPath: string; code: string },
    ) {
      virtualFiles.set(path.resolve(filename, "..", dep.virtualPath), dep.code);
      return dep.virtualPath;
    },
    linkAssets: {
      runtime: linkAssetsId,
      onAsset(kind: "page" | "load", filename: string, assetId: string) {
        opts.assetIds[kind].set(filename, assetId);
      },
    },
  };

  /** Serves a file a stylesheet refers to as part of the bundle. */
  const emitAsset = (file: string) => {
    assetFiles.add(file);
    let body;
    try {
      body = readFileSync(file);
    } catch {
      return null;
    }
    const ext = path.extname(file);
    const fileName = `assets/${path.basename(file, ext)}-${Bun.hash(body).toString(36)}${ext}`;
    opts.emitFile(fileName, body, Bun.file(file).type);
    return assetUrl(opts.assetPrefix + fileName);
  };

  const createPlugin = (isServer: boolean): Plugin => {
    const config = {
      ...baseConfig,
      output: isServer ? "html" : "dom",
    } as const;

    const loadStyle = async (
      context: { addWatchFile(id: string): void },
      id: string,
      code: string | undefined,
    ) => {
      if (!/\.css$/i.test(id)) {
        throw new Error(
          `Unable to bundle ${id}: only plain CSS styles are supported.`,
        );
      }
      let stylesheet = stylesheets.get(id);
      if (!stylesheet) {
        stylesheet = bundleStylesheet({
          file: id,
          code,
          root: opts.root,
          cssModules: /\.module\.css$/i.test(id),
          assetPrefix: assetUrl(opts.assetPrefix),
          minifyAssets: opts.optimize,
          emitAsset,
        }).catch((error) => {
          throw new Error(
            `Unable to bundle ${id}: ${(error as Error).message}`,
            {
              cause: error,
            },
          );
        });
        stylesheets.set(id, stylesheet);
      }
      const { css, fileName, assets, js, files } = await stylesheet;
      for (const { fileName, css } of assets) {
        opts.emitFile(fileName, Buffer.from(css), "text/css; charset=utf-8");
      }
      // Nothing of a stylesheet ends up in the scripts, so the files it was
      // made from would otherwise not count as files the bundle depends on.
      for (const file of code === undefined ? [id, ...files] : files) {
        context.addWatchFile(file);
      }
      for (const file of assetFiles) context.addWatchFile(file);
      if (!isServer) opts.css.set(id, { css, fileName });
      if (js) return { code: js, moduleType: "js" } as const;
      // Styles are served as stylesheets, so nothing of them ends up in a script.
      return { code: "", moduleType: "js", moduleSideEffects: false } as const;
    };

    return {
      name: "svdr:marko",

      buildEnd() {
        if (isServer) return;
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (!info) continue;
          opts.imports.set(id, {
            static: info.importedIds,
            dynamic: info.dynamicallyImportedIds,
          });
        }
      },

      async resolveId(source, importer, options) {
        if (source === linkAssetsId) return source;
        if (!importer) return parseEntryId(source) ? source : null;

        const tagName = tagImportReg.exec(source)?.[1];
        if (tagName) {
          const tagDef = compiler.taglib
            .buildLookup(path.dirname(importer), translator)
            .getTag(tagName);
          return tagDef && (tagDef.template || tagDef.renderer);
        }

        if (source[0] === ".") {
          const resolved = path.resolve(importer, "..", source);
          return virtualFiles.has(resolved) ? resolved : null;
        }

        if (/^marko(?:\/|$)/.test(source)) {
          // Only Marko is supplied for bare playground directories. All
          // application packages must resolve from their actual importer.
          const resolveOptions = { ...options, skipSelf: true };
          const resolved = await this.resolve(source, importer, resolveOptions);
          if (resolved || isPackageInstalled(source, path.dirname(importer))) {
            return resolved;
          }
          return this.resolve(source, builtinImporter, resolveOptions);
        }

        return null;
      },

      async load(id) {
        if (id === linkAssetsId) return linkAssetsRuntime;

        const virtualFile = virtualFiles.get(id);
        if (virtualFile !== undefined) {
          if (styleReg.test(id)) return loadStyle(this, id, virtualFile);
          return { code: virtualFile, moduleType: "js" };
        }

        if (id.endsWith(markoExt)) {
          const entry = parseEntryId(id);
          const file = entry ? entry.file : id;
          this.addWatchFile(file);

          const compiled = await compiler.compile(
            await readFile(file, "utf8"),
            file,
            entry
              ? { ...config, entry: entry.kind === "load" ? "load" : "page" }
              : config,
          );
          for (const watchFile of compiled.meta.watchFiles) {
            this.addWatchFile(watchFile);
          }

          let { code } = compiled;
          if (entry?.kind === "server") {
            code += `\nexport { register as ${registerAssetsExport} } from ${JSON.stringify(linkAssetsId)};`;
          }
          return {
            code,
            // Entries only wire modules together, they have no meaningful map.
            map: entry ? null : (compiled.map as never),
            moduleType: "js",
          };
        }

        if (styleReg.test(id)) {
          return loadStyle(this, id, undefined);
        }

        if (staticAssetReg.test(id)) {
          this.addWatchFile(id);
          const url = emitAsset(id);
          if (!url) throw new Error(`Unable to read imported asset ${id}`);
          return {
            code: `export default ${JSON.stringify(url)};`,
            moduleType: "js",
          };
        }

        return null;
      },
    };
  };

  return { server: createPlugin(true), client: createPlugin(false) };
}
