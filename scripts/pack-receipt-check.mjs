import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const [receiptPath, tarballPath, expectedName, expectedVersion, expectedSourceCommit] = process.argv.slice(2);
if (![receiptPath, tarballPath, expectedName, expectedVersion, expectedSourceCommit].every(Boolean)) {
  throw new Error(
    "Usage: node scripts/pack-receipt-check.mjs RECEIPT TARBALL NAME VERSION SOURCE_COMMIT",
  );
}

const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
const tarball = await readFile(tarballPath);
const tarballStat = await stat(tarballPath);
const actual = {
  name: expectedName,
  version: expectedVersion,
  sourceCommit: expectedSourceCommit,
  filename: basename(tarballPath),
  integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  shasum: createHash("sha1").update(tarball).digest("hex"),
  size: tarballStat.size,
};

const mismatches = Object.entries(actual)
  .filter(([field, value]) => receipt[field] !== value)
  .map(([field, value]) => ({ field, expected: value, receipt: receipt[field] }));
if (mismatches.length !== 0) {
  throw new Error(`Release tarball receipt mismatch:\n${JSON.stringify(mismatches, null, 2)}`);
}

console.log(
  `Verified release receipt for ${receipt.name}@${receipt.version} from ${receipt.sourceCommit}: ` +
    `${receipt.integrity} (${receipt.size} bytes)`,
);
