import { expect, test } from "bun:test";
import { compress, compressStream } from "../src/compression.ts";

test("compress works off the main thread and round trips", async () => {
  const data = Buffer.from("hello ".repeat(1000));
  for (const encoding of ["br", "gzip"] as const) {
    const compressed = compress(encoding, data);
    expect(compressed).toBeInstanceOf(Promise);
    const stream = new Blob([
      (await compressed) as Uint8Array<ArrayBuffer>,
    ]).stream();
    const decoded = await new Response(
      stream.pipeThrough(
        new DecompressionStream(
          (encoding === "br" ? "brotli" : encoding) as CompressionFormat,
        ),
      ),
    ).text();
    expect(decoded).toBe(data.toString());
  }
});

test("cancelling a compressed stream cancels its source", async () => {
  let cancelled: unknown;
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(Buffer.from(`chunk ${pulls}\n`));
    },
    cancel(reason) {
      cancelled = reason ?? "cancelled";
    },
  });

  const reader = compressStream("gzip", source).getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel("client went away");
  await Bun.sleep(50);
  expect(cancelled).toBeDefined();
  const pullsAtCancel = pulls;
  await Bun.sleep(50);
  expect(pulls).toBe(pullsAtCancel);
});
