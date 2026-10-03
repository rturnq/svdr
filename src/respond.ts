import { stripVTControlCharacters } from "node:util";
import {
  compress,
  isCompressible,
  negotiate,
  type Encoding,
} from "./compression.ts";

/** Bodies smaller than this are not worth compressing. */
const minCompressSize = 1024;
const maxCompressCacheSize = 128 * 1024 * 1024;

export type Send = (
  req: Request,
  body: Uint8Array,
  headers: Headers,
  cacheKey: string,
) => Promise<Response>;

/**
 * Creates the function that sends complete bodies, compressed when the
 * client and the content allow it. Compressed bodies are cached by the
 * given key, which must change whenever the body does.
 */
export function createSend(options: {
  compression: readonly Encoding[];
  prod: boolean;
}): Send {
  const cache = new CompressionCache(maxCompressCacheSize);

  return async (req, body, headers, cacheKey) => {
    let encoding: Encoding | null = null;
    if (
      body.byteLength >= minCompressSize &&
      isCompressible(headers.get("content-type") ?? "")
    ) {
      headers.append("vary", "accept-encoding");
      encoding = negotiate(
        req.headers.get("accept-encoding"),
        options.compression,
      );
    }
    if (encoding) {
      const key = `${encoding}\0${cacheKey}`;
      body = await cache.get(key, () => compress(encoding, body, options.prod));
      headers.set("content-encoding", encoding);
    }
    headers.set("content-length", String(body.byteLength));
    return new Response(req.method === "HEAD" ? null : (body as BodyInit), {
      headers,
    });
  };
}

/**
 * Keeps compressed bodies around, evicting the oldest once over the size
 * limit. A body that is being compressed is only compressed once, however
 * many requests ask for it meanwhile.
 */
class CompressionCache {
  #entries = new Map<string, Uint8Array>();
  #pending = new Map<string, Promise<Uint8Array>>();
  #size = 0;
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  get(key: string, create: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const body = this.#entries.get(key);
    if (body) return Promise.resolve(body);
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = create().then((body) => {
        this.#add(key, body);
        return body;
      });
      this.#pending.set(key, pending);
      pending.finally(() => this.#pending.delete(key)).catch(() => {});
    }
    return pending;
  }

  #add(key: string, body: Uint8Array) {
    this.#entries.set(key, body);
    this.#size += body.byteLength;
    for (const [oldKey, oldBody] of this.#entries) {
      if (this.#size <= this.#maxSize) break;
      this.#entries.delete(oldKey);
      this.#size -= oldBody.byteLength;
    }
  }
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Redirects to a path on this server; a path that is not root-relative is made so. */
export function redirectToDirectory(
  pathname: string,
  search: string,
): Response {
  return new Response(null, {
    status: 308,
    headers: { location: `/${pathname.replace(/^\/+/, "")}${search}` },
  });
}

const stackFrameReg = /^\s+at (?:.+ \(.+\)|(?:\/|file:|node:|native).*)$/;

/** Describes an error, by default without the stack frames that are part of its message. */
export function errorMessage(error: unknown, stack = false): string {
  const { message, stack: trace } = error as Error;
  const text = stripVTControlCharacters(
    String((stack && trace) || message || error),
  );
  if (stack) return text;
  return text
    .split("\n")
    .filter((line) => !stackFrameReg.test(line))
    .join("\n")
    .trim();
}
