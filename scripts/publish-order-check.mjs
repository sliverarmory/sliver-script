import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const semver = require("semver");
const semverVersion = require("semver/package.json").version;
const expectedSemverVersion = "7.8.5";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireStrictVersion(value, label) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value === value.trim()
      && !/^[v=]/i.test(value)
      && semver.valid(value) !== null,
    `${label} is not a strict SemVer version: ${JSON.stringify(value)}`,
  );
  return value;
}

function checkPublishOrder(candidateValue, targetTagValue, distTagsValue) {
  const candidate = requireStrictVersion(candidateValue, "Candidate version");
  invariant(
    typeof targetTagValue === "string" && /^[a-z][a-z0-9._-]*$/.test(targetTagValue),
    `Target dist-tag is invalid: ${JSON.stringify(targetTagValue)}`,
  );
  invariant(
    distTagsValue !== null
      && typeof distTagsValue === "object"
      && !Array.isArray(distTagsValue),
    "Registry dist-tags response must be a JSON object",
  );

  if (!Object.prototype.hasOwnProperty.call(distTagsValue, targetTagValue)) {
    return { candidate, current: null, outcome: "absent" };
  }

  const current = requireStrictVersion(
    distTagsValue[targetTagValue],
    `Current '${targetTagValue}' dist-tag version`,
  );
  if (candidate === current) {
    return { candidate, current, outcome: "retry" };
  }

  const comparison = semver.compare(candidate, current);
  invariant(
    comparison > 0,
    comparison === 0
      ? `Candidate ${candidate} has the same SemVer precedence as '${targetTagValue}' ${current}, but is not the exact same version`
      : `Candidate ${candidate} would move '${targetTagValue}' backwards from ${current}`,
  );
  return { candidate, current, outcome: "advance" };
}

function runSelfTest() {
  invariant(
    semverVersion === expectedSemverVersion,
    `Expected directly pinned semver ${expectedSemverVersion}, got ${semverVersion}`,
  );
  const accepted = [
    {
      name: "absent target tag",
      candidate: "2.0.0-beta.1",
      tag: "beta",
      tags: { latest: "1.9.0" },
      outcome: "absent",
    },
    {
      name: "exact same-version retry",
      candidate: "2.0.0",
      tag: "latest",
      tags: { latest: "2.0.0" },
      outcome: "retry",
    },
    {
      name: "higher stable candidate",
      candidate: "2.1.0",
      tag: "latest",
      tags: { latest: "2.0.9" },
      outcome: "advance",
    },
    {
      name: "higher numeric prerelease candidate",
      candidate: "2.0.0-beta.10",
      tag: "beta",
      tags: { beta: "2.0.0-beta.2" },
      outcome: "advance",
    },
    {
      name: "stable candidate after prerelease",
      candidate: "2.0.0",
      tag: "next",
      tags: { next: "2.0.0-rc.2" },
      outcome: "advance",
    },
  ];
  const rejected = [
    {
      name: "lower stable candidate",
      candidate: "1.9.9",
      tag: "latest",
      tags: { latest: "2.0.0" },
    },
    {
      name: "lower numeric prerelease candidate",
      candidate: "2.0.0-beta.2",
      tag: "beta",
      tags: { beta: "2.0.0-beta.10" },
    },
    {
      name: "prerelease candidate before stable",
      candidate: "2.0.0-rc.3",
      tag: "next",
      tags: { next: "2.0.0" },
    },
    {
      name: "non-identical build metadata at equal precedence",
      candidate: "2.0.0+candidate",
      tag: "latest",
      tags: { latest: "2.0.0+current" },
    },
    {
      name: "invalid candidate",
      candidate: "v2.0.0",
      tag: "latest",
      tags: { latest: "1.0.0" },
    },
    {
      name: "invalid registry version",
      candidate: "2.0.0",
      tag: "latest",
      tags: { latest: "not-semver" },
    },
  ];

  for (const test of accepted) {
    const result = checkPublishOrder(test.candidate, test.tag, test.tags);
    invariant(
      result.outcome === test.outcome,
      `Self-test '${test.name}' returned ${result.outcome}, expected ${test.outcome}`,
    );
  }
  for (const test of rejected) {
    let didReject = false;
    try {
      checkPublishOrder(test.candidate, test.tag, test.tags);
    } catch {
      didReject = true;
    }
    invariant(didReject, `Self-test '${test.name}' was incorrectly accepted`);
  }

  runInlineWorkflowSelfTest(accepted, rejected);
  runInlineE404SelfTest();
  runArtifactAttemptWorkflowSelfTest();

  console.log(
    `Publish ordering self-test passed (${accepted.length} acceptance and ${rejected.length} rejection cases, including exact inline comparator, E404, and artifact-attempt paths).`,
  );
}

function runInlineWorkflowSelfTest(accepted, rejected) {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const matches = [
    ...workflow.matchAll(
      /\/\* publish-order-inline:start \*\/[\s\S]*?\/\* publish-order-inline:end \*\//g,
    ),
  ];
  invariant(matches.length === 1, "Expected exactly one marked inline publish-order comparator");
  const inlineProgram = matches[0][0];

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmRoot = execFileSync(npm, ["root", "--global"], { encoding: "utf8" }).trim();
  const bundledSemverManifest = JSON.parse(
    readFileSync(join(npmRoot, "npm", "node_modules", "semver", "package.json"), "utf8"),
  );
  invariant(
    bundledSemverManifest.version === expectedSemverVersion,
    `Expected npm-bundled semver ${expectedSemverVersion}, got ${bundledSemverManifest.version}`,
  );

  const temporary = mkdtempSync(join(tmpdir(), "sliver-script-publish-order-"));
  try {
    for (const [index, test] of [...accepted, ...rejected].entries()) {
      const distTagsPath = join(temporary, `${index}.json`);
      writeFileSync(distTagsPath, `${JSON.stringify(test.tags)}\n`, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=commonjs",
          "--eval",
          inlineProgram,
          test.candidate,
          test.tag,
          distTagsPath,
          npmRoot,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      invariant(!result.error, `Inline self-test '${test.name}' failed to execute: ${result.error}`);
      if (index < accepted.length) {
        invariant(
          result.status === 0,
          `Inline self-test '${test.name}' rejected unexpectedly: ${result.stderr.trim()}`,
        );
      } else {
        invariant(
          typeof result.status === "number" && result.status !== 0,
          `Inline self-test '${test.name}' was incorrectly accepted`,
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runInlineE404SelfTest() {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const matches = [
    ...workflow.matchAll(
      /\/\* publish-e404-inline:start \*\/[\s\S]*?\/\* publish-e404-inline:end \*\//g,
    ),
  ];
  invariant(matches.length === 1, "Expected exactly one marked inline npm E404 verifier");

  const temporary = mkdtempSync(join(tmpdir(), "sliver-script-publish-e404-"));
  const packageName = "sliver-script";
  const fixtures = [
    {
      name: "exact package E404",
      report: {
        error: {
          code: "E404",
          summary: `Not Found - GET https://registry.npmjs.org/${packageName} - Not found`,
        },
      },
      accepted: true,
    },
    {
      name: "different package E404",
      report: {
        error: {
          code: "E404",
          summary: "Not Found - GET https://registry.npmjs.org/different-package - Not found",
        },
      },
      accepted: false,
    },
    {
      name: "registry server failure",
      report: { error: { code: "E500", summary: "Internal server error" } },
      accepted: false,
    },
  ];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const reportPath = join(temporary, `${index}.json`);
      writeFileSync(reportPath, `${JSON.stringify(fixture.report)}\n`, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        ["--input-type=commonjs", "--eval", matches[0][0], reportPath, packageName],
        { encoding: "utf8", timeout: 10_000 },
      );
      invariant(!result.error, `Inline E404 self-test '${fixture.name}' failed: ${result.error}`);
      invariant(
        fixture.accepted ? result.status === 0 : result.status !== 0,
        `Inline E404 self-test '${fixture.name}' had unexpected status ${result.status}`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runArtifactAttemptWorkflowSelfTest() {
  if (process.platform === "win32") return;

  const workflow = readFileSync(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const matches = [
    ...workflow.matchAll(
      /# artifact-attempt-inline:start([\s\S]*?)# artifact-attempt-inline:end/g,
    ),
  ];
  invariant(matches.length === 2, "Expected marked artifact-attempt guards in both downstream jobs");

  const temporary = mkdtempSync(join(tmpdir(), "sliver-script-artifact-attempt-"));
  const artifactPath = join(temporary, "artifact.tar");
  writeFileSync(artifactPath, "self-test\n", { mode: 0o600 });
  const sha = "a".repeat(40);
  const baseEnvironment = {
    ...process.env,
    ARTIFACT_DIGEST: "b".repeat(64),
    ARTIFACT_ID: "123",
    ARTIFACT_PATH: artifactPath,
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: sha,
  };
  try {
    for (const [guardIndex, match] of matches.entries()) {
      for (const fixture of [
        { name: "prior attempt", attempt: "1", accepted: true },
        { name: "current attempt", attempt: "2", accepted: true },
        { name: "future attempt", attempt: "3", accepted: false },
      ]) {
        const result = spawnSync(
          "bash",
          ["-euo", "pipefail", "-c", match[1]],
          {
            encoding: "utf8",
            env: {
              ...baseEnvironment,
              ARTIFACT_NAME: `sliver-script-release-${sha}-${fixture.attempt}.tar`,
            },
            timeout: 10_000,
          },
        );
        invariant(!result.error, `Artifact guard ${guardIndex + 1} '${fixture.name}' failed: ${result.error}`);
        invariant(
          fixture.accepted ? result.status === 0 : result.status !== 0,
          `Artifact guard ${guardIndex + 1} '${fixture.name}' had unexpected status ${result.status}`,
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
    return;
  }
  invariant(
    args.length === 3,
    "Usage: node scripts/publish-order-check.mjs CANDIDATE_VERSION TARGET_DIST_TAG DIST_TAGS_JSON",
  );

  const [candidate, targetTag, distTagsPath] = args;
  const distTags = JSON.parse(readFileSync(distTagsPath, "utf8"));
  const result = checkPublishOrder(candidate, targetTag, distTags);
  if (result.outcome === "absent") {
    console.log(`Target dist-tag '${targetTag}' is absent; candidate ${candidate} may publish.`);
  } else if (result.outcome === "retry") {
    console.log(`Target dist-tag '${targetTag}' already equals ${candidate}; allowing an idempotent retry.`);
  } else {
    console.log(`Candidate ${candidate} advances '${targetTag}' from ${result.current}; publication may proceed.`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
