# svdr

A simple local server that serves a directory and bundles Marko files.
Point it at a directory and open your pages in a browser.

It bundles Marko pages and their JavaScript, TypeScript, CSS, and CSS Modules.
Live reload updates the browser when you edit a file.
HTTPS and HTTP/2 are enabled by default.

## Usage

Requires [Bun](https://bun.sh) 1.4.1 or newer.

```sh
bun install -g @svdr/cli
cd ~/my-site
svdr
```

This serves the current directory at `https://localhost:3000`.
The server uses a self-signed certificate.
Use `svdr --dir ./my-site` to serve a different directory.

## Pages

Each `.marko` file is a separate page. Put reusable components in `tags`
directories to keep them from becoming pages.

- `index.marko` is served at `/`.
- `about.marko` is served at `/about`.
- `docs/index.marko` is served at `/docs/`.

Other files are served as static files. Dotfiles and `node_modules` are hidden.
Marko 6 is included. Install any other packages your pages need.

If a build fails, the last working page stays available.
Visit `/_svdr/` to browse each page's generated files.

## Options

| Option                       | Default      | Description                                                                   |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `-d`, `--dir <path>`         | `.`          | Directory to serve.                                                           |
| `-p`, `--port <number>`      | `3000`       | Port to listen on.                                                            |
| `-c`, `--compression <list>` | `br,gz`      | Brotli (`br`) and gzip (`gz`), in preference order. Use `none` to disable.    |
| `-x`, `--extensions <list>`  | `marko,html` | Extensions to try for page URLs and directory indexes. Use `none` to disable. |
| `-h`, `--hot [on\|off]`      | `on`         | Live reload. Defaults to `off` with `--prod`.                                 |
| `--http`                     | `off`        | Use plain HTTP instead of HTTPS.                                              |
| `--prod`                     | `off`        | Minify bundles, use stronger compression, and omit source maps.               |
| `--help`                     |              | Show help.                                                                    |

Separate compression types and extensions with commas.
