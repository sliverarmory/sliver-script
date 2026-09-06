import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateIntegrationLock } from "../integration-lock.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const integrationLock = JSON.parse(await readFile(resolve(repositoryRoot, "integration.lock.json"), "utf8"));
const protobufLock = JSON.parse(await readFile(resolve(repositoryRoot, "protobuf.lock.json"), "utf8"));

function changed(mutator) {
  const value = structuredClone(integrationLock);
  mutator(value);
  return value;
}

function changedProtobuf(mutator) {
  const value = structuredClone(protobufLock);
  mutator(value);
  return value;
}

test("the shipped integration lock contains only generic package provenance", () => {
  const result = validateIntegrationLock(integrationLock, protobufLock);
  assert.ok(result.referencedPaths.includes("protobuf.lock.json"));
  assert.ok(result.referencedPaths.includes("src/client.ts"));
  assert.ok(result.referencedPaths.includes("scripts"));
  assert.ok(result.referencedPaths.includes("src/pb/commonpb/common.ts"));
});

test("consumer-specific sections and repositories are rejected", () => {
  assert.throws(
    () => validateIntegrationLock(changed((lock) => {
      lock.consumerProvenance = { repository: "https://example.invalid/downstream.git" };
    }), protobufLock),
    /root has unexpected fields/,
  );
  assert.throws(
    () => validateIntegrationLock(changed((lock) => {
      lock.wrapper.repository = "https://example.invalid/downstream.git";
    }), protobufLock),
    /wrapper repository must identify sliver-script/,
  );
});

test("known downstream markers are rejected even in free-text fields", () => {
  for (const marker of [
    "sliver-gui",
    "authoritativeGui",
    "vendoredRoot",
    "guiOnlyOmissions",
    "provenanceManifest",
    "handwrittenOverlay",
    "vendor/sliver-script",
    "protocol/sliver-script-provenance.json",
    "protocol/sliver-script-handwritten-overlay.patch",
  ]) {
    assert.throws(
      () => validateIntegrationLock(changed((lock) => {
        lock.standaloneOmissions[0] = `Removed downstream metadata: ${marker}`;
      }), protobufLock),
      /consumer-specific marker/,
      marker,
    );
  }
  assert.throws(
    () => validateIntegrationLock(integrationLock, changedProtobuf((lock) => {
      lock.protobuf.pluginOptions.push("source=sliver-gui");
    })),
    /consumer-specific marker/,
  );
});

test("the protobuf lock rejects unknown provenance fields and malformed entries", () => {
  assert.throws(
    () => validateIntegrationLock(integrationLock, changedProtobuf((lock) => {
      lock.downstream = { repository: "https://example.invalid/consumer.git" };
    })),
    /protobuf lock root has unexpected fields/,
  );
  assert.throws(
    () => validateIntegrationLock(integrationLock, changedProtobuf((lock) => {
      lock.protobuf.files[0].consumerPath = "vendor/client-library";
    })),
    /protobuf lock protobuf\.files\[0\] has unexpected fields/,
  );
  assert.throws(
    () => validateIntegrationLock(integrationLock, changedProtobuf((lock) => {
      lock.protobuf.outputs[0].sha256 = "not-a-digest";
    })),
    /must be a lowercase SHA-256/,
  );
});

test("foreign, escaping, and stale package paths are rejected", () => {
  for (const sourcePath of ["vendor/client-library", "protocol/downstream-provenance.json", "../outside"]) {
    assert.throws(
      () => validateIntegrationLock(changed((lock) => {
        lock.standaloneAdaptations[0].paths.push(sourcePath);
      }), protobufLock),
      /outside the generic package source areas|normalized repository-relative path/,
    );
  }
});

test("the Sliver input must match the canonical protobuf lock", () => {
  assert.throws(
    () => validateIntegrationLock(changed((lock) => {
      lock.sliver.sourceCommit = "0".repeat(40);
    }), protobufLock),
    /Sliver commit must match protobuf\.lock\.json/,
  );
});
