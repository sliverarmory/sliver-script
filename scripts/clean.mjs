import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedPaths = new Map([
  ["lib", resolve(repositoryRoot, "lib")],
  ["e2e/dist", resolve(repositoryRoot, "e2e/dist")],
]);

if (process.argv.length !== 3 || !allowedPaths.has(process.argv[2])) {
  throw new Error(`Usage: node scripts/clean.mjs ${[...allowedPaths.keys()].join("|")}`);
}

await rm(allowedPaths.get(process.argv[2]), { recursive: true, force: true });
