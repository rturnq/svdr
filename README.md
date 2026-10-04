# svdr

Simple directory server with bundling. It serves a directory on localhost over
HTTP/2 and renders any [Marko](https://markojs.com) template in it as a page,
bundling the template and everything it imports with
[Rolldown](https://rolldown.rs).

Requires [Bun](https://bun.sh) 1.4.1 or newer.

## Usage

```sh
bun install
bun src/cli.ts --dir example
```

| Option                | Default               | Description                                                                              |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `-d`, `--dir`         | `.`                   | Directory to serve.                                                                      |
| `-p`, `--port`        | `3000`                | Port to listen on. Fails when the port is taken.                                         |
| `-c`, `--compression` | `br,gz`               | Encodings in order of preference: `br`, `gz`, or `none`.                                 |
| `-x`, `--extensions`  | `marko,html`          | Extensions to try, in order, for paths without one and for directory indexes, or `none`. |
| `-h`, `--hot`         | on, off with `--prod` | Reload pages and swap their styles when files change. `--hot off` turns it off.          |
| `--http`              |                       | Serve plain HTTP instead of HTTPS.                                                       |
| `--prod`              |                       | Minified scripts and stylesheets, stronger compression and no source maps.               |
| `--help`              |                       | Show the options.                                                                        |

By default the server uses HTTPS with a self-signed certificate that is
generated on first use and kept in `~/.cache/svdr` (or
`$XDG_CACHE_HOME/svdr`), so it only has to be trusted once. Browsers only
speak HTTP/2 over TLS, so with `--http` they use HTTP/1.1.

## Files

URL paths map directly to files in the directory:

- `/about` is a file. It serves `about` if that exists and otherwise the
  first of `about.marko` and `about.html` that does, following
  `--extensions`. If there is no such file but there is an `about` directory,
  it redirects to `/about/`.
- `/about/` is a directory. It serves the first of `about/index.marko` and
  `about/index.html` that exists, again following `--extensions`.

Dotfiles and `node_modules`, at any level, are never served, and neither
are the templates in `tags` directories; other files in them, such as the
images their styles refer to, are. These rules apply to the file's own path, so a different spelling of
it on a case-insensitive file system or a symlink to it makes no difference.
Requests that name a host other than this machine are refused.

## Pages

Every `.marko` file outside of a `tags` directory is a page: requesting
`/about` or `/about.marko` renders `about.marko` on the server and streams
the HTML. Templates in `tags` directories are the custom tags pages are built
from. Each page is compiled independently into its own server and client
bundles. Pages share no generated modules, stylesheets, or imported assets,
even when they import the same source files. A page's files are served from
`/_svdr/<hash>/`. The five-character hash comes from the relative `.marko` file path,
so it stays the same when the file is edited or the playground is moved. Scripts
and stylesheets are linked from that page automatically, in dependency order.

Local stylesheet `@import`s are inlined (package stylesheets can be imported
by name). When an import chain includes a remote stylesheet, local dependencies
are emitted into the page's asset directory and the import chain is preserved,
including its order, conditions, and layers. Relative `url()` assets and assets
imported from JavaScript are also emitted there. Root-relative and remote URLs
keep their original meaning. CSS Modules (`<style/styles>` blocks and
`.module.css` files) are supported; other style languages are not.

`/_svdr/` lists the Marko entry paths, linking to each entry's hashed directory.
Each entry directory has its own index listing all of its bundled files, their
sizes, and when they last changed, with a link back to the entry list. Server
bundles remain available for inspection under `/_svdr/<hash>/server/`. Empty
client entries are omitted for pages without client-side behavior.

Packages resolve from the importing file's `node_modules` ancestors. Only
`marko` falls back to the runtime shipped with svdr, so a bare directory of
templates works without installing anything. Other application dependencies
must be installed by the project. Marko 6 is required.

The directory is watched recursively, along with imported dependencies outside
it. An edit rebuilds each page whose import graph contains the changed file;
a shared dependency rebuilds all of its consuming pages. Changes to tag
discovery or package mappings can require rebuilding other pages too. Independent
builds run with bounded concurrency and publish as each page finishes. Existing
pages remain available while builds run.

When an entry fails, its error is logged and its own last working build remains
available. Other entries can still publish successful builds. Only pages that
have never built successfully respond with the error. `--prod` keeps the same
independent build model with minification, stronger compression, and no source
maps.

## Live reload

With `--hot`, which is on by default except with `--prod`, every page
connects to the server with a WebSocket at `/_svdr/ws` and is kept up to
date as files change:

- When only styles changed, whether in a `<style>` block or in a stylesheet
  the page links to, the stylesheets are swapped in place and the page keeps
  its state.
- When anything else a page may show changed, the page reloads.
- When bundling fails, the error is logged to the browser console and the
  page stays as it is.

Plain `.html` files take part too: the script that connects them is
appended to them as they are served.

## Development

```sh
bun install
bun run check   # formatting, types and tests
bun run format
```

`test/fixture/` is a copy of `example/` that the tests build and serve, kept
separate so that trying things out in the example cannot break them.
