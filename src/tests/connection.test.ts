import * as fs from "node:fs";
import * as path from "node:path";

import { ParseConfigFile } from "../config";
import { SliverClient } from "../client";


const SLIVER_E2E = process.env["SLIVER_E2E"] === "1";
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../../localhost.cfg");
const SLIVER_CONFIG_FILE = process.env["SLIVER_CONFIG_FILE"] || DEFAULT_CONFIG_PATH;

const testE2E = SLIVER_E2E && fs.existsSync(SLIVER_CONFIG_FILE) ? test : test.skip;

jest.setTimeout(120 * 1000);
testE2E("authenticate to server", async () => {
  const config = await ParseConfigFile(SLIVER_CONFIG_FILE);
  const client = new SliverClient(config);

  await client.connect();
  await expect(client.getVersion()).resolves.toBeDefined();
  await client.disconnect();
});
