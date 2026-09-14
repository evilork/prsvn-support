// tests/support/load-ts.mjs
//
// Lets a test import the bot's lib/*.ts modules.
//
// Node strips types from .ts files by itself (Node >= 23.6), but the bot's
// modules import each other without file extensions, which Node does not
// resolve. These resolve hooks map such relative imports to real .ts files.
// They also swap `@upstash/redis` for a stub that throws on any use, so no
// imported module can reach the real database from a test. The same approach
// is used by the frontend repo's tests/support/load-ts.mjs.
//
// Import it BEFORE the modules that need it, and load those with a dynamic
// `await import(...)`: static imports are all resolved before any module runs,
// so hooks registered here would come too late for them.

import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REDIS_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "const deny = () => { throw new Error('Redis used from a unit test: tests must not touch Redis'); };" +
      "export class Redis { static fromEnv() { return new Proxy({}, { get: deny }); } constructor() { deny(); } }",
  );

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** The .ts file an extensionless module URL points at, or null. */
function resolveSourceFile(url) {
  const path = fileURLToPath(url);
  if (isFile(path)) return url;
  for (const candidate of [`${path}.ts`, `${path}/index.ts`]) {
    if (isFile(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@upstash/redis") return { url: REDIS_STUB, shortCircuit: true };
    const parent = context.parentURL;
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && parent?.startsWith("file:")) {
      const resolved = resolveSourceFile(new URL(specifier, parent).href);
      if (resolved !== null) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
