import { bundleAsync, transform } from "lightningcss";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isServable } from "./paths.ts";

export interface Stylesheet {
  /** The complete stylesheet, including any retained imports and layer declarations. */
  css: string;
  /** Whether this stylesheet must keep its own import boundary when emitted. */
  hasImports: boolean;
  /** The entry asset's name, also used by dependencies that import it in a cycle. */
  fileName?: string;
  /** Local stylesheets retained as imports so the browser preserves their semantics. */
  assets: { fileName: string; css: string }[];
  /** For a CSS module, the script that maps the class names to the unique ones. */
  js?: string;
  /** The files that were inlined, which the stylesheet depends on. */
  files: string[];
}

export interface StylesheetOptions {
  /** The stylesheet's path; it need not exist when `code` is given. */
  file: string;
  /** The stylesheet's content when it is not read from `file`. */
  code?: string;
  /** The served directory. */
  root: string;
  /** A file to resolve packages from when the served directory has none. */
  fallbackDir: string;
  cssModules: boolean;
  /** URL prefix for emitted stylesheet dependencies. */
  assetPrefix?: string;
  /** Minify retained dependency assets before emitting them. */
  minifyAssets?: boolean;
  /**
   * Gives a referenced file that cannot be served from where it is, such as
   * a font inside `node_modules`, a URL it can be served from.
   */
  emitAsset?: (file: string) => string | null;
}

const remoteReg = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Inline local-only stylesheets with Lightning CSS. If the graph contains a
 * remote import, retain its import edges instead: hoisting remote rules across
 * local rules or layer declarations changes the cascade. Each dependency gets
 * a bundled URL, with conditions and repeated imports left for the browser.
 */
export async function bundleStylesheet(
  options: StylesheetOptions,
): Promise<Stylesheet> {
  const { cssModules, emitAsset, assetPrefix = "/_svdr/" } = options;
  const root = realpathSync(options.root);
  const file = realDir(options.file);
  const nodes = new Map<
    string,
    {
      code: string;
      rules: ImportRule[];
      compiled?: ReturnType<typeof transform>;
      compositions: Map<string, string>;
    }
  >();
  let remote = false;

  const resolve = (specifier: string, from: string): string => {
    let name = specifier.split(/[?#]/)[0]!;
    try {
      name = decodeURIComponent(name);
    } catch {
      // Leave malformed percent escapes for the missing-file diagnostic.
    }
    const relative = name.startsWith("/")
      ? path.join(root, name)
      : path.resolve(from, "..", name);
    const resolved =
      /^(?:\.\.?\/|\/)/.test(name) || existsSync(relative)
        ? existsSync(relative) && relative
        : findPackageStylesheet(name, [
            path.dirname(from),
            options.fallbackDir,
          ]);
    if (!resolved) {
      throw new Error(
        `Cannot find the stylesheet "${specifier}" imported from ${from}`,
      );
    }
    return realpathSync(resolved);
  };

  // Discover in source order and register before recursing, including cycles.
  // CSS module composition dependencies also participate in remote detection
  // and the content hash, even though Lightning CSS handles their class maps.
  const load = async (target: string, supplied?: string) => {
    if (nodes.has(target)) return;
    const code = rewriteCssUrls(
      supplied ?? (await readFile(target, "utf8")),
      target,
      root,
      { imports: false, emitAsset },
    );
    const rules = scanImports(code);
    const node = {
      code,
      rules,
      compositions: new Map<string, string>(),
      compiled: undefined as ReturnType<typeof transform> | undefined,
    };
    nodes.set(target, node);
    for (const rule of rules) {
      if (rule.remote) remote = true;
      else await load(resolve(rule.target, target));
    }
    if (cssModules) {
      const result = transform({
        filename: target,
        code: Buffer.from(code),
        cssModules: true,
      });
      node.compiled = result;
      for (const value of Object.values(result.exports ?? {})) {
        for (const reference of value.composes) {
          if (reference.type === "dependency") {
            const dependency = resolve(reference.specifier, target);
            node.compositions.set(reference.specifier, dependency);
            await load(dependency);
          }
        }
      }
    }
  };
  await load(file, options.code);
  const files = [...nodes.keys()].filter((target) => target !== file);
  const assets: Stylesheet["assets"] = [];
  const entry = nodes.get(file)!;
  if (!cssModules && !entry.rules.length) {
    return { css: entry.code, hasImports: false, assets, files };
  }

  // Hash the complete graph before assigning URLs so cyclic imports are
  // possible and changing a transitive dependency invalidates its importers.
  const graphHash = Bun.hash(
    JSON.stringify([
      cssModules,
      !!options.minifyAssets,
      assetPrefix,
      [...nodes].map(([target, node]) => [target, node.code]),
    ]),
  ).toString(36);
  const names = new Map(
    [...nodes.keys()].map((target, index) => [
      target,
      `styles/${graphHash}/${index}.css`,
    ]),
  );
  const urls = new Map(
    [...names].map(([target, name]) => [target, assetPrefix + name]),
  );
  const prepared = new Map<string, string>();
  const retained = new Set<string>();
  if (remote) retained.add(file);
  for (const [target, node] of nodes) {
    // A module's composition dependencies are stylesheets too. Keeping them
    // as imports prevents inlined composition rules from stranding a remote
    // import below ordinary rules. Class maps are resolved separately below.
    const code =
      remote && cssModules ? node.compiled!.code.toString() : node.code;
    let out = "";
    if (remote) {
      for (const dependency of new Set(node.compositions.values())) {
        retained.add(dependency);
        out += `@import url(${cssString(urls.get(dependency)!)});\n`;
      }
    }
    let last = 0;
    for (const rule of scanImports(code)) {
      out += code.slice(last, rule.start);
      if (rule.remote) {
        out += code.slice(rule.start, rule.end);
      } else {
        let specifier = rule.target;
        if (remote) {
          const dependency = resolve(specifier, target);
          retained.add(dependency);
          specifier = urls.get(dependency)!;
        }
        out += `@import url(${cssString(specifier)})${rule.conditions && ` ${rule.conditions}`};`;
      }
      last = rule.end;
    }
    prepared.set(target, out + code.slice(last));
  }

  const result = remote
    ? {
        code: Buffer.from(prepared.get(file)!),
        exports: entry.compiled?.exports,
      }
    : await bundleAsync({
        filename: file,
        cssModules,
        resolver: {
          read(target) {
            return prepared.get(target)!;
          },
          resolve,
        },
      });
  for (const target of retained) {
    const fileName = names.get(target)!;
    const css = prepared.get(target)!;
    assets.push({
      fileName,
      css: options.minifyAssets ? minifyCss(css, fileName) : css,
    });
  }
  const css = result.code.toString();
  const fileName = remote ? names.get(file) : undefined;
  if (!cssModules) return { css, hasImports: remote, fileName, assets, files };

  const classNames = (
    target: string,
    name: string,
    seen = new Set<string>(),
  ): string[] => {
    const key = `${target}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const node = nodes.get(target)!;
    const exports = node.compiled?.exports ?? {};
    const value = exports[name];
    if (!value)
      throw new Error(`Cannot compose unknown class "${name}" from ${target}`);
    return [
      value.name,
      ...value.composes.flatMap((ref): string[] => {
        if (ref.type === "global") return [ref.name];
        if (ref.type === "dependency")
          return classNames(
            node.compositions.get(ref.specifier)!,
            ref.name,
            seen,
          );
        const local = Object.keys(exports).find(
          (name) => exports[name]!.name === ref.name,
        );
        return local === undefined
          ? [ref.name]
          : classNames(target, local, seen);
      }),
    ];
  };
  const classes: Record<string, string> = Object.create(null);
  for (const [name, { name: local, composes }] of Object.entries(
    result.exports ?? {},
  )) {
    classes[name] = (
      remote ? classNames(file, name) : [local, ...composes.map((c) => c.name)]
    ).join(" ");
  }
  const namesToExport = Object.keys(classes).filter(
    (name) => name !== "default",
  );
  const js =
    `const classes = ${JSON.stringify(classes)};\n` +
    `export default classes;\n` +
    namesToExport
      .map((name, i) => `const _${i} = classes[${JSON.stringify(name)}];\n`)
      .join("") +
    (namesToExport.length
      ? `export { ${namesToExport.map((name, i) => `_${i} as ${JSON.stringify(name)}`).join(", ")} };\n`
      : "");
  return { css, hasImports: remote, fileName, assets, js, files };
}

/** A CSS string, including control characters that JSON escapes differently. */
function cssString(value: string) {
  return (
    '"' +
    value.replace(/["\\\x00-\x1f\x7f]/g, (char) =>
      char === '"' || char === "\\"
        ? `\\${char}`
        : `\\${char.charCodeAt(0).toString(16)} `,
    ) +
    '"'
  );
}

/** The file's path with its directory's symlinks resolved; the file itself need not exist. */
function realDir(file: string) {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return file;
  }
}

/** Minifies a stylesheet; `filename` only names it in error messages. */
export function minifyCss(css: string, filename: string): string {
  return transform({
    filename,
    code: Buffer.from(css),
    minify: true,
  }).code.toString();
}

// Reading CSS the way it is tokenized: comments, strings, escapes, identifiers.

const identChar = /[\w-]/;

/** Decodes the escape at `at`; returns the character and where it ends. */
function decodeEscape(css: string, at: number): [string, number] {
  const hex = /^[0-9a-f]{1,6}/i.exec(css.slice(at + 1, at + 7))?.[0];
  if (hex) {
    let next = at + 1 + hex.length;
    // One whitespace character after a hex escape belongs to it.
    if (css[next] === "\r" && css[next + 1] === "\n") next += 2;
    else if (/\s/.test(css[next] ?? "")) next++;
    const code = parseInt(hex, 16);
    return [
      code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code),
      next,
    ];
  }
  return [css[at + 1] ?? "", Math.min(at + 2, css.length)];
}

const isEscape = (css: string, at: number) =>
  css[at] === "\\" && css[at + 1] !== "\n";

const isIdentStart = (css: string, at: number) =>
  /[a-z_-]/i.test(css[at] ?? "") ||
  css.charCodeAt(at) > 0x7f ||
  isEscape(css, at);

/** Reads the identifier starting at `at`, escapes decoded and lower-cased. */
function readIdent(css: string, at: number) {
  let name = "";
  let end = at;
  while (end < css.length) {
    if (isEscape(css, end)) {
      const [char, next] = decodeEscape(css, end);
      name += char;
      end = next;
    } else if (identChar.test(css[end]!) || css.charCodeAt(end) > 0x7f) {
      name += css[end];
      end++;
    } else {
      break;
    }
  }
  return { name: name.toLowerCase(), raw: css.slice(at, end), end };
}

/** Reads the string at `at`; `value` is `null` when it is not terminated. */
function readString(css: string, at: number) {
  const quote = css[at]!;
  let i = at + 1;
  let value: string | null = "";
  while (i < css.length) {
    const char = css[i]!;
    if (char === quote) {
      i++;
      break;
    }
    if (char === "\n") {
      value = null;
      break;
    }
    if (char === "\\") {
      // A backslash before a newline continues the string on the next line.
      if (css[i + 1] === "\n") i += 2;
      else if (css[i + 1] === "\r") i += css[i + 2] === "\n" ? 3 : 2;
      else {
        const [decoded, next] = decodeEscape(css, i);
        value += decoded;
        i = next;
      }
    } else {
      value += char;
      i++;
    }
    if (i >= css.length) value = null;
  }
  return { raw: css.slice(at, i), value, quote, end: i };
}

/**
 * Reads an unquoted `url()` value at `at`, up to the closing parenthesis.
 * Whitespace before the parenthesis is not part of the value, whitespace
 * that terminates a hex escape is consumed by the escape.
 */
function readUnquotedUrl(css: string, at: number) {
  let i = at;
  let value = "";
  let trailing = "";
  while (i < css.length && css[i] !== ")") {
    if (css[i] === "\\") {
      const [decoded, next] = decodeEscape(css, i);
      value += trailing + decoded;
      trailing = "";
      i = next;
    } else if (/\s/.test(css[i]!)) {
      trailing += css[i++];
    } else {
      value += trailing + css[i++];
      trailing = "";
    }
  }
  return { raw: css.slice(at, i), value, trailing, end: i };
}

/** Where the whitespace and comments starting at `at` end. */
function skipSpaceAndComments(css: string, at: number) {
  let i = at;
  for (;;) {
    i += /^\s*/.exec(css.slice(i))![0].length;
    if (css[i] !== "/" || css[i + 1] !== "*") return i;
    const end = css.indexOf("*/", i + 2);
    i = end === -1 ? css.length : end + 2;
  }
}

/**
 * Where the statement starting at `at` ends: after its `;`, outside of
 * strings and parentheses. Returns `-1` for a rule with a block instead.
 */
function endOfStatement(css: string, at: number) {
  let depth = 0;
  for (let i = at; i < css.length;) {
    const char = css[i]!;
    if (char === '"' || char === "'") i = readString(css, i).end;
    else if (char === "/" && css[i + 1] === "*")
      i = skipSpaceAndComments(css, i);
    else if (char === "\\") i += 2;
    else if (char === "(") (depth++, i++);
    else if (char === ")") (depth--, i++);
    else if (char === "{" && depth <= 0) return -1;
    else if (char === ";" && depth <= 0) return i + 1;
    else i++;
  }
  return css.length;
}

/** Where `at` is, as a line and column. */
function position(css: string, at: number) {
  const before = css.slice(0, at);
  const line = before.split("\n").length;
  return { line, column: at - before.lastIndexOf("\n") };
}

interface ImportRule {
  start: number;
  end: number;
  /** The imported URL, escapes decoded. */
  target: string;
  /** What follows the URL: layer, supports and media conditions. */
  conditions: string;
  remote: boolean;
  line: number;
  column: number;
}

/**
 * Finds the `@import` rules at the top of a stylesheet, which is the only
 * place they count: after `@charset` and `@layer` statements and comments,
 * and before any other rule.
 */
export function scanImports(css: string): ImportRule[] {
  const rules: ImportRule[] = [];
  let i = skipSpaceAndComments(css, 0);
  while (css[i] === "@") {
    const start = i;
    const keyword = readIdent(css, i + 1);
    if (keyword.name === "charset" || keyword.name === "layer") {
      const end = endOfStatement(css, keyword.end);
      if (end === -1) break;
      i = skipSpaceAndComments(css, end);
      continue;
    }
    if (keyword.name !== "import") break;

    let at = skipSpaceAndComments(css, keyword.end);
    let target: string | null = null;
    if (css[at] === '"' || css[at] === "'") {
      ({ value: target, end: at } = readString(css, at));
    } else {
      const fn = readIdent(css, at);
      if (fn.name === "url" && css[fn.end] === "(") {
        at = skipSpaceAndComments(css, fn.end + 1);
        if (css[at] === '"' || css[at] === "'") {
          ({ value: target, end: at } = readString(css, at));
        } else {
          ({ value: target, end: at } = readUnquotedUrl(css, at));
        }
        at = skipSpaceAndComments(css, at);
        if (css[at] === ")") at++;
        else target = null;
      }
    }
    const end = endOfStatement(css, at);
    if (target === null || end === -1) break;
    rules.push({
      start,
      end,
      target,
      conditions: css.slice(at, end - (css[end - 1] === ";" ? 1 : 0)).trim(),
      remote: remoteReg.test(target),
      ...position(css, start),
    });
    i = skipSpaceAndComments(css, end);
  }
  return rules;
}

// Finding the stylesheet of a package.

/** The conditions a stylesheet export may be published under, in order of preference. */
const styleConditions = ["style", "css", "import", "default"];

/**
 * Finds the stylesheet a package specifier refers to, looking through the
 * `node_modules` directories above each of the given directories. A package
 * with an `exports` field is entered through it, with the `style`, `css`,
 * `import` or `default` condition; otherwise a subpath names a file in the
 * package, and the package itself is its `style` field, a `main` that is a
 * stylesheet, or `index.css`. Done by hand because Bun's resolver falls
 * back to its global package cache.
 */
export function findPackageStylesheet(
  specifier: string,
  dirs: string[],
): string | null {
  const match = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return null;
  const name = match[1]!;
  const subpath = match[2];
  for (const start of dirs) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const pkg = path.join(dir, "node_modules", name);
      const manifestFile = path.join(pkg, "package.json");
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        const exists = (candidates: string[]) =>
          candidates
            .map((candidate) => path.join(pkg, candidate))
            .find((file) => existsSync(file)) ?? null;
        if (manifest.exports !== undefined) {
          const entry = subpath ? `./${subpath}` : ".";
          const target = resolveExports(manifest.exports, entry);
          const resolvedTarget =
            target === undefined
              ? subpath
                ? resolveExports(manifest.exports, `${entry}.css`)
                : undefined
              : target;
          return resolvedTarget ? exists([resolvedTarget]) : null;
        }
        if (subpath) return exists([subpath, `${subpath}.css`]);
        const { style, main } = manifest;
        return exists([
          ...(typeof style === "string" ? [style] : []),
          ...(typeof main === "string" && /\.css$/i.test(main) ? [main] : []),
          "index.css",
        ]);
      }
      if (dir === path.dirname(dir)) break;
    }
  }
  return null;
}

/** Resolves a subpath through a package's `exports` field. */
function resolveExports(
  exports: unknown,
  subpath: string,
): string | null | undefined {
  if (typeof exports === "string") {
    return subpath === "." ? exports : undefined;
  }
  if (Array.isArray(exports)) {
    for (const entry of exports) {
      const target = resolveExports(entry, subpath);
      if (target !== undefined) return target;
    }
    return null;
  }
  if (!exports || typeof exports !== "object") return null;
  const map = exports as Record<string, unknown>;
  const keys = Object.keys(map);
  if (!keys.some((key) => key.startsWith("."))) {
    // Conditions rather than subpaths.
    return subpath === "." ? resolveTarget(map) : undefined;
  }
  if (subpath in map) return resolveTarget(map[subpath]);
  // Of the patterns that match, the most specific one wins: the longest
  // part before the `*`, then the longest pattern.
  const patterns = keys
    .filter((key) => {
      const star = key.indexOf("*");
      if (star === -1) return false;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      return (
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length > prefix.length + suffix.length
      );
    })
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const key = patterns[0];
  if (key === undefined) return undefined;
  const star = key.indexOf("*");
  const wildcard = subpath.slice(
    star,
    subpath.length - (key.length - star - 1),
  );
  const target = resolveTarget(map[key]);
  return typeof target === "string" ? target.replaceAll("*", wildcard) : target;
}

/** Resolves an `exports` target, which may be nested conditions. */
function resolveTarget(target: unknown): string | null | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveTarget(entry);
      if (resolved !== undefined) return resolved;
    }
    return null;
  }
  if (!target || typeof target !== "object") return null;
  const conditions = target as Record<string, unknown>;
  for (const key of Object.keys(conditions)) {
    if (!styleConditions.includes(key)) continue;
    const resolved = resolveTarget(conditions[key]);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

// Rewriting references.

/**
 * Stylesheets are served from under the assets prefix rather than from
 * where they were written, so `url()` and `@import` references relative to
 * the stylesheet are made relative to the served directory instead. A
 * referenced file that cannot be served from where it is, such as one in
 * `node_modules` or outside of the served directory, is served as part of
 * the bundle when `emitAsset` is given.
 *
 * The stylesheet is scanned the way CSS is tokenized: comments and strings
 * elsewhere are left alone, escapes in a reference are decoded before it is
 * resolved, percent-encoding is kept as it is, and the result is written
 * back as valid CSS.
 */
export function rewriteCssUrls(
  css: string,
  file: string,
  root: string,
  {
    imports = true,
    emitAsset,
  }: { imports?: boolean; emitAsset?: (file: string) => string | null } = {},
) {
  /** The reference made relative to the served directory, or `null` to leave it alone. */
  const resolve = (ref: string): string | null => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return null;
    const [, target = "", suffix = ""] = /^([^?#]*)(.*)$/.exec(ref)!;
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      return null;
    }
    if (!decoded) return null;
    const referenced = path.resolve(file, "..", decoded);
    const relative = path.relative(root, referenced);
    const inside =
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative);
    const url = () =>
      "/" + relative.split(path.sep).map(encodeURIComponent).join("/") + suffix;
    if (inside && isServable(relative)) return url();
    const emitted = emitAsset?.(referenced);
    if (emitted) return emitted + suffix;
    return inside ? url() : null;
  };

  const serialize = (value: string, quote: string | null) => {
    const escaped = value.replace(/[\\"'\n]/g, (char) =>
      char === "\n" ? "\\a " : `\\${char}`,
    );
    if (quote) return `${quote}${escaped}${quote}`;
    return /[\s"'()\\]/.test(value) ? `"${escaped}"` : value;
  };

  let out = "";
  let i = 0;

  /** Copies whitespace and comments, which may come between tokens. */
  const copySpaceAndComments = () => {
    const end = skipSpaceAndComments(css, i);
    out += css.slice(i, end);
    i = end;
  };

  /** Rewrites the string reference at `i`, if there is one. */
  const stringReference = () => {
    if (css[i] !== '"' && css[i] !== "'") return;
    const { raw, value, quote, end } = readString(css, i);
    i = end;
    const resolved = value === null ? null : resolve(value);
    out += resolved === null ? raw : serialize(resolved, quote);
  };

  const atBoundary = () => !(i > 0 && identChar.test(css[i - 1]!));

  while (i < css.length) {
    const char = css[i]!;
    if (char === "/" && css[i + 1] === "*") {
      copySpaceAndComments();
    } else if (char === '"' || char === "'") {
      const { raw, end } = readString(css, i);
      out += raw;
      i = end;
    } else if (char === "@" && atBoundary() && isIdentStart(css, i + 1)) {
      // An at-keyword, which may be spelled with escapes.
      const { name, raw, end } = readIdent(css, i + 1);
      out += "@" + raw;
      i = end;
      if (name !== "import") continue;
      if (imports) {
        copySpaceAndComments();
        stringReference();
      } else {
        // Left as it is, for the bundler to resolve.
        const statementEnd = endOfStatement(css, i);
        if (statementEnd !== -1) {
          out += css.slice(i, statementEnd);
          i = statementEnd;
        }
      }
    } else if (atBoundary() && isIdentStart(css, i)) {
      // An identifier, which is a function name when `(` follows.
      const { name, raw, end } = readIdent(css, i);
      out += raw;
      i = end;
      if (name === "url" && css[i] === "(") {
        out += "(";
        i++;
        copySpaceAndComments();
        if (css[i] === '"' || css[i] === "'") {
          stringReference();
        } else {
          const { raw, value, trailing, end } = readUnquotedUrl(css, i);
          i = end;
          const resolved = resolve(value);
          out += resolved === null ? raw : serialize(resolved, null) + trailing;
        }
      }
    } else {
      out += char;
      i++;
    }
  }
  return out;
}
