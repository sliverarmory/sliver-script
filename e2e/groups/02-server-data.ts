import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { clientpb as ClientPB } from "../../lib";

import type { E2ESuiteContext } from "../context";

// This module is emitted below e2e/dist/groups, so its runtime package path
// differs from the source-level path used for declaration checking.
const sliverScript = require("../../../lib") as typeof import("../../lib");
const { clientpb, commonpb } = sliverScript;

export const name = "02-server-data";

const RPC_TIMEOUT_SECONDS = 30;

export async function run(context: E2ESuiteContext): Promise<void> {
  await verifyCompiler(context);
  await verifyServerInventories(context);

  const suffix = `${process.pid}${Date.now().toString(36)}`;
  await verifyProfileLifecycle(context, `sliverscripte2eprofile${suffix}`);
  await verifyLootLifecycle(context, `sliver-script-e2e-loot-${suffix}`);
  await verifyCredentialLifecycle(context, suffix);
  await verifyWebsiteLifecycle(context, `sliver-script-e2e-site-${suffix}`);
}

async function verifyServerInventories(context: E2ESuiteContext): Promise<void> {
  const canaries = await context.client.canaries(RPC_TIMEOUT_SECONDS);
  assert.ok(Array.isArray(canaries.Canaries), "DNS canary inventory must contain an array");
  assert.deepEqual(canaries.Canaries, [], "fresh server DNS canary inventory");

  const encoders = await context.client.getShellcodeEncoderMap(RPC_TIMEOUT_SECONDS);
  const architectures = Object.entries(encoders.Encoders);
  assert.ok(architectures.length > 0, "shellcode encoder map must advertise at least one architecture");
  for (const [architecture, encoderMap] of architectures) {
    assert.ok(architecture.trim(), "shellcode encoder architecture");
    assert.ok(Object.keys(encoderMap.Encoders).length > 0, `${architecture} shellcode encoders`);
    for (const name of Object.keys(encoderMap.Encoders)) {
      assert.ok(encoderMap.Descriptions[name]?.trim(), `${architecture}/${name} encoder description`);
    }
  }

  const uniqueIP = await context.client.generateUniqueIP(RPC_TIMEOUT_SECONDS);
  assert.equal(isIP(uniqueIP.IP), 4, "generated WireGuard peer address must be IPv4");
}

async function verifyCompiler(context: E2ESuiteContext): Promise<void> {
  const compiler: ClientPB.Compiler = await context.client.getCompiler(RPC_TIMEOUT_SECONDS);

  assert.equal(compiler.GOOS, context.environment.expectedOS, "compiler operating system");
  assert.equal(compiler.GOARCH, context.environment.expectedArch, "compiler architecture");
  assert.ok(Array.isArray(compiler.Targets), "compiler targets must be an array");
  assert.ok(Array.isArray(compiler.CrossCompilers), "cross compilers must be an array");
  assert.ok(Array.isArray(compiler.UnsupportedTargets), "unsupported targets must be an array");
  assert.ok(
    compiler.Targets.some((target) =>
      target.GOOS === context.environment.expectedOS
      && target.GOARCH === context.environment.expectedArch
      && target.Format === clientpb.OutputFormat.EXECUTABLE
    ),
    "compiler must advertise the native executable target",
  );
}

async function verifyProfileLifecycle(
  context: E2ESuiteContext,
  profileName: string,
): Promise<void> {
  const c2Url = "mtls://127.0.0.1:65534";
  const config = clientpb.ImplantConfig.create({
    GOOS: context.environment.expectedOS,
    GOARCH: context.environment.expectedArch,
    TemplateName: "sliver",
    IncludeMTLS: true,
    ReconnectInterval: "1000000000",
    MaxConnectionErrors: 20,
    PollTimeout: "1000000000",
    C2: [clientpb.ImplantC2.create({ Priority: 0, URL: c2Url })],
    ConnectionStrategy: "s",
    Format: clientpb.OutputFormat.EXECUTABLE,
    HTTPC2ConfigName: "default",
    NetGoEnabled: true,
  });

  let created = false;
  try {
    const saved: ClientPB.ImplantProfile = await context.client.saveImplantProfile(
      clientpb.ImplantProfile.create({ Name: profileName, Config: config }),
      RPC_TIMEOUT_SECONDS,
    );
    created = true;
    context.profileNames.add(profileName);

    assert.match(saved.ID, UUID_PATTERN, "saved profile id");
    assert.equal(saved.Name, profileName, "saved profile name");
    assert.ok(saved.Config, "saved profile config");
    assert.equal(saved.Config.GOOS, context.environment.expectedOS, "saved profile operating system");
    assert.equal(saved.Config.GOARCH, context.environment.expectedArch, "saved profile architecture");
    assert.equal(saved.Config.Format, clientpb.OutputFormat.EXECUTABLE, "saved profile format");
    assert.equal(saved.Config.C2.length, 1, "saved profile C2 count");
    assert.equal(saved.Config.C2[0]?.URL, c2Url, "saved profile C2 URL");

    const updated: ClientPB.ImplantProfile = await context.client.saveImplantProfile(
      clientpb.ImplantProfile.create({
        ID: saved.ID,
        Name: saved.Name,
        Config: clientpb.ImplantConfig.create({
          ...saved.Config,
          Debug: true,
        }),
      }),
      RPC_TIMEOUT_SECONDS,
    );

    assert.equal(updated.ID, saved.ID, "updated profile id");
    assert.equal(updated.Name, profileName, "updated profile name");
    assert.equal(updated.Config?.Debug, true, "updated profile debug flag");

    const profiles: ClientPB.ImplantProfiles = await context.client.implantProfiles(RPC_TIMEOUT_SECONDS);
    assert.ok(Array.isArray(profiles.Profiles), "implant profiles response must contain an array");
    const listed = profiles.Profiles.find((profile) => profile.Name === profileName);
    assert.ok(listed, "saved profile must be listed");
    assert.equal(listed.ID, saved.ID, "listed profile id");
    assert.equal(listed.Config?.Debug, true, "listed profile update");
    assert.equal(listed.Config?.C2[0]?.URL, c2Url, "listed profile C2 URL");
  } finally {
    if (created) {
      await context.client.deleteImplantProfile(profileName, RPC_TIMEOUT_SECONDS);
      context.profileNames.delete(profileName);
    }
  }

  const afterDelete = await context.client.implantProfiles(RPC_TIMEOUT_SECONDS);
  assert.equal(
    afterDelete.Profiles.some((profile) => profile.Name === profileName),
    false,
    "deleted profile must not be listed",
  );
}

async function verifyLootLifecycle(
  context: E2ESuiteContext,
  lootName: string,
): Promise<void> {
  const payload = Buffer.from("sliver-script real-server loot fixture\n", "utf8");
  const updatedName = `${lootName}-updated`;
  let lootId: string | undefined;

  try {
    const added: ClientPB.Loot = await context.client.lootAdd(
      clientpb.Loot.create({
        Name: lootName,
        FileType: clientpb.FileType.TEXT,
        File: commonpb.File.create({ Name: "e2e-loot.txt", Data: payload }),
      }),
      RPC_TIMEOUT_SECONDS,
    );
    lootId = added.ID;

    assert.match(added.ID, UUID_PATTERN, "added loot id");
    assert.equal(added.Name, lootName, "added loot name");
    assert.equal(added.FileType, clientpb.FileType.TEXT, "added loot file type");
    assert.equal(added.Size, String(payload.length), "added loot size");

    const listed = await context.client.lootAll(RPC_TIMEOUT_SECONDS);
    assert.ok(Array.isArray(listed), "loot helper must return an array");
    const listedLoot = listed.find((loot) => loot.ID === added.ID);
    assert.ok(listedLoot, "added loot must be listed");
    assert.equal(listedLoot.Name, lootName, "listed loot name");
    assert.equal(listedLoot.File?.Name, "e2e-loot.txt", "listed loot file name");
    assert.equal(listedLoot.File?.Data.length, 0, "loot listing must omit content bytes");

    const content: ClientPB.Loot = await context.client.lootContent(added.ID, RPC_TIMEOUT_SECONDS);
    assert.equal(content.ID, added.ID, "loot content id");
    assert.equal(content.File?.Name, "e2e-loot.txt", "loot content file name");
    assert.deepEqual(content.File?.Data, payload, "loot content bytes");

    const updated: ClientPB.Loot = await context.client.lootUpdate(
      clientpb.Loot.create({ ID: added.ID, Name: updatedName }),
      RPC_TIMEOUT_SECONDS,
    );
    assert.equal(updated.ID, added.ID, "updated loot id");
    assert.equal(updated.Name, updatedName, "updated loot name");

    await context.client.lootRemove(added.ID, RPC_TIMEOUT_SECONDS);
    lootId = undefined;
    const afterDelete = await context.client.lootAll(RPC_TIMEOUT_SECONDS);
    assert.equal(
      afterDelete.some((loot) => loot.ID === added.ID),
      false,
      "removed loot must not be listed",
    );
  } finally {
    if (lootId !== undefined) {
      await context.client.lootRemove(lootId, RPC_TIMEOUT_SECONDS);
    }
  }
}

async function verifyCredentialLifecycle(
  context: E2ESuiteContext,
  suffix: string,
): Promise<void> {
  const username = `sliver-script-e2e-user-${suffix}`;
  const collection = `sliver-script-e2e-${suffix}`;

  try {
    await context.client.credentialAdd(
      clientpb.Credential.create({
        Username: username,
        Plaintext: "sliver-script-e2e-password",
        HashType: clientpb.HashType.MD5,
        Collection: collection,
      }),
      RPC_TIMEOUT_SECONDS,
    );

    const credentials: ClientPB.Credential[] = await context.client.credentialsAll(RPC_TIMEOUT_SECONDS);
    assert.ok(Array.isArray(credentials), "credentials helper must return an array");
    const stored = credentials.find((credential) =>
      credential.Username === username && credential.Collection === collection
    );
    assert.ok(stored, "added credential must be listed");
    assert.match(stored.ID, UUID_PATTERN, "added credential id");
    assert.equal(stored.Plaintext, "sliver-script-e2e-password", "stored credential plaintext");
    assert.equal(stored.Hash, "", "stored credential hash");
    assert.equal(stored.IsCracked, false, "plaintext-only credential cracked state");

    const fetched = await context.client.credentialById(stored.ID, RPC_TIMEOUT_SECONDS);
    assert.deepEqual(fetched, stored, "credential lookup by id");

    const sniffed = await context.client.credentialSniffHashType(
      "$2a$10$sliverscripte2efixture",
      RPC_TIMEOUT_SECONDS,
    );
    assert.equal(sniffed, clientpb.HashType.BCRYPT_UNIX, "credential hash type detection");

    await context.client.credentialRemove(stored.ID, RPC_TIMEOUT_SECONDS);
    const afterDelete = await context.client.credentialsAll(RPC_TIMEOUT_SECONDS);
    assert.equal(
      afterDelete.some((credential) => credential.ID === stored.ID),
      false,
      "removed credential must not be listed",
    );
  } finally {
    const remaining = (await context.client.credentialsAll(RPC_TIMEOUT_SECONDS)).filter((credential) =>
      credential.Username === username && credential.Collection === collection
    );
    for (const credential of remaining) {
      await context.client.credentialRemove(credential.ID, RPC_TIMEOUT_SECONDS);
    }
  }
}

async function verifyWebsiteLifecycle(
  context: E2ESuiteContext,
  websiteName: string,
): Promise<void> {
  const path = "/index.html";
  const payload = Buffer.from("<p>sliver-script real-server fixture</p>\n", "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");

  try {
    const added: ClientPB.Website = await context.client.websiteAddContent(
      websiteName,
      {
        [path]: clientpb.WebContent.create({
          Path: path,
          ContentType: "text/html; charset=utf-8",
          Content: payload,
        }),
      },
      RPC_TIMEOUT_SECONDS,
    );

    assert.match(added.ID, UUID_PATTERN, "added website id");
    assert.equal(added.Name, websiteName, "added website name");
    assert.equal(added.Contents[path]?.WebsiteID, added.ID, "added website content owner");
    assert.equal(added.Contents[path]?.Path, path, "added website content path");
    assert.equal(added.Contents[path]?.ContentType, "text/html; charset=utf-8", "added website content type");
    assert.equal(added.Contents[path]?.Size, String(payload.length), "added website content size");
    assert.equal(added.Contents[path]?.Sha256, sha256, "added website content digest");
    assert.deepEqual(added.Contents[path]?.Content, payload, "added website content bytes");

    const websites: ClientPB.Website[] = await context.client.websites(RPC_TIMEOUT_SECONDS);
    assert.ok(Array.isArray(websites), "websites helper must return an array");
    const listed = websites.find((website) => website.Name === websiteName);
    assert.ok(listed, "added website must be listed");
    assert.equal(listed.ID, added.ID, "listed website id");
    assert.deepEqual(listed.Contents[path]?.Content, payload, "listed website content bytes");

    const fetched: ClientPB.Website = await context.client.website(websiteName, RPC_TIMEOUT_SECONDS);
    assert.equal(fetched.ID, added.ID, "fetched website id");
    assert.deepEqual(fetched.Contents[path]?.Content, payload, "fetched website content bytes");

    const existingContent = added.Contents[path];
    assert.ok(existingContent, "added website content");
    const updated: ClientPB.Website = await context.client.websiteUpdateContent(
      websiteName,
      {
        [path]: clientpb.WebContent.create({
          ...existingContent,
          ContentType: "application/xhtml+xml",
          Content: Buffer.alloc(0),
        }),
      },
      RPC_TIMEOUT_SECONDS,
    );
    assert.equal(updated.Contents[path]?.ContentType, "application/xhtml+xml", "updated website content type");

    const withoutContent: ClientPB.Website = await context.client.websiteRemoveContent(
      websiteName,
      [path],
      RPC_TIMEOUT_SECONDS,
    );
    assert.deepEqual(withoutContent.Contents, {}, "website content removal");

    await context.client.websiteRemove(websiteName, RPC_TIMEOUT_SECONDS);
    const afterDelete = await context.client.websites(RPC_TIMEOUT_SECONDS);
    assert.equal(
      afterDelete.some((website) => website.Name === websiteName),
      false,
      "removed website must not be listed",
    );
  } finally {
    const remaining = await context.client.websites(RPC_TIMEOUT_SECONDS);
    if (remaining.some((website) => website.Name === websiteName)) {
      await context.client.websiteRemove(websiteName, RPC_TIMEOUT_SECONDS);
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
