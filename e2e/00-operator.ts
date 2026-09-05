import { randomBytes } from "node:crypto";
import * as path from "node:path";

type SliverScriptModule = typeof import("..");

const repoRoot = path.resolve(__dirname, "../..");
const configPath = process.env.SLIVER_CONFIG_FILE;
if (!configPath) throw new Error("SLIVER_CONFIG_FILE is required");

const sliver = require(path.join(repoRoot, "lib")) as SliverScriptModule;
const payloadBytes = 20 * 1024 * 1024;

async function main(): Promise<void> {
  const config = await sliver.ParseConfigFile(configPath!);
  const client = new sliver.SliverClient(config);
  const websiteName = `e2e-operator-artifact-${Date.now()}`;
  const contentPath = "/large.bin";
  const payload = randomBytes(payloadBytes);
  let websiteCreated = false;
  let returned: Buffer | undefined;

  await client.connect();
  try {
    const version = await client.getVersion(30);
    const response = await client.websiteAddContent(
      websiteName,
      {
        [contentPath]: sliver.clientpb.WebContent.create({
          Path: contentPath,
          ContentType: "application/octet-stream",
          Content: payload,
        }),
      },
      120,
    );
    websiteCreated = true;
    returned = response.Contents[contentPath]?.Content;
    if (!returned || !returned.equals(payload)) {
      throw new Error(`Large artifact round trip mismatch (${returned?.length ?? 0}/${payload.length} bytes)`);
    }
    console.log("operator artifact round trip", {
      transport: "mtls",
      version: `${version.Major}.${version.Minor}.${version.Patch}`,
      bytes: payload.length,
    });
  } finally {
    payload.fill(0);
    returned?.fill(0);
    try {
      if (websiteCreated) await client.websiteRemove(websiteName, 30);
    } finally {
      await client.disconnect();
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
