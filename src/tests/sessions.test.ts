import * as fs from "node:fs";
import * as path from "node:path";

import { ParseConfigFile } from "../config";
import { SliverClient } from "../client";


const SLIVER_E2E = process.env["SLIVER_E2E"] === "1";
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../../localhost.cfg");
const SLIVER_CONFIG_FILE = process.env["SLIVER_CONFIG_FILE"] || DEFAULT_CONFIG_PATH;

jest.setTimeout(120 * 1000);
const testE2E = SLIVER_E2E && fs.existsSync(SLIVER_CONFIG_FILE) ? test : test.skip;

testE2E("sessions and beacons", async () => {
  const config = await ParseConfigFile(SLIVER_CONFIG_FILE);
  const client = new SliverClient(config);

  await client.connect();

  try {
    const sessions = await client.sessions();
    expect(Array.isArray(sessions)).toBe(true);

    const beacons = await client.beacons();
    expect(Array.isArray(beacons)).toBe(true);

    if (beacons.length > 0) {
      const beacon = client.interactBeacon(beacons[0].ID);
      const task = await beacon.lsTask(".");
      expect(task.id).toBeTruthy();
    }
  } finally {
    await client.disconnect();
  }
});
