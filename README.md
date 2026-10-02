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
| `-c`, `--compression` | `br,gz`               | Encodings in order of preference: `br`, `gz`, `zstd`, `deflate`, or `none`.              |
| `-x`, `--extensions`  | `marko,html`          | Extensions to try, in order, for paths without one and for directory indexes, or `none`. |
| `-h`, `--hot`         | on, off with `--prod` | Reload pages and swap their styles when files change. `--hot off` turns it off.          |
| `--http`              |                       | Serve plain HTTP instead of HTTPS.                                                       |
| `--prod`              |                       | Minified bundles, stronger compression and no source maps.                               |
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

Dotfiles, `node_modules` and `tags` directories, at any level, are never
served. These rules apply to the file's own path, so a different spelling of
it on a case-insensitive file system or a symlink to it makes no difference.
Requests that name a host other than this machine are refused.

## Pages

Every `.marko` file outside of a `tags` directory is a page: requesting
`/about` or `/about.marko` renders `about.marko` on the server and streams
the HTML. Templates in `tags` directories are the custom tags pages are built
from. All pages are bundled together into

- a server bundle, which is loaded to render the pages, and
- a client bundle, which makes the pages interactive in the browser. Code
  and `<style>` blocks used by several pages end up in chunks those pages
  share. Scripts and stylesheets are served from `/_svdr/` and linked
  from each page automatically.

`/_svdr/` itself lists every bundled file with its size and when a build
last changed it. The files of the server bundle are served for inspection
under `/_svdr/server/`. Files that would be empty, such as the script of a
page without any client side behavior, are not part of the bundle.

`marko` and other packages a page imports are resolved from the directory's
`node_modules` when installed there, and otherwise from the packages that
ship with svdr, so a bare directory of templates works without
installing anything. Marko 6 is required.

The directory is watched recursively. When a template or a file that went
into the bundles changes, the pages are bundled again. When that fails, the
error is logged and the last working build keeps being served until the
problem is fixed; only pages that have never been bundled respond with the
error.

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
