#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { parseOptions, usage, UsageError } from "./options.ts";
import { serveDir } from "./server.ts";

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${usage}`);
    return 1;
  }

  if (options === "help") {
    console.log(usage);
    return 0;
  }
  if (options === "version") {
    console.log(pkg.version);
    return 0;
  }

  // Template ids are derived from the path relative to the working directory.
  process.chdir(options.dir);

  let server;
  try {
    server = await serveDir(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    console.error(`Port ${options.port} is already in use.`);
    return 1;
  }

  console.log(`\nServing ${options.dir}\n  at ${server.url}\n`);

  const stop = () => {
    server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const code = await main();
if (code !== undefined) process.exit(code);
