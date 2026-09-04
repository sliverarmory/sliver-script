import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_PACKAGE_NAME = "sliver-script";
const EXPECTED_REGISTRY = "https://registry.npmjs.org/";
const EXPECTED_REPOSITORY = "https://github.com/sliverarmory/sliver-script";
const EXPECTED_WORKFLOW_PATH = ".github/workflows/publish.yml";
const EXPECTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const EXPECTED_NPM_VERSION = "11.19.0";
const EXPECTED_SIGSTORE_VERSION = "4.1.1";
const EXPECTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_OWNER = "https://github.com/sliverarmory";
const EXPECTED_REPOSITORY_ID = "260983967";
const EXPECTED_OWNER_ID = "96838313";
const EXPECTED_ENVIRONMENT = "publish";
const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const NPM_PUBLISH_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.2";
const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const INTOTO_STATEMENT_V01_TYPE = "https://in-toto.io/Statement/v0.1";
const INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH_PREDICATE_TYPE =
  "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const GITHUB_WORKFLOW_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

export function verifyRegistryProvenance(report, receipt, expected, options = {}) {
  const expectedVersion = requiredString(expected?.version, "expected version");
  const expectedRef = requiredString(expected?.ref, "expected ref");
  const expectedCommit = requiredString(expected?.commit, "expected commit");
  const expectedRunId = requiredNumericString(expected?.runId, "GITHUB_RUN_ID");
  const currentRunAttempt = requiredNumericString(
    expected?.runAttempt,
    "GITHUB_RUN_ATTEMPT",
  );
  invariant(
    expectedRef === `refs/tags/v${expectedVersion}`,
    `Expected ref must be refs/tags/v${expectedVersion}, got ${expectedRef}`,
  );
  invariant(
    /^[0-9a-f]{40}$/.test(expectedCommit),
    `Expected commit must be a lowercase 40-character Git SHA, got ${expectedCommit}`,
  );

  const receiptObject = requiredObject(receipt, "release receipt");
  invariant(
    receiptObject.name === EXPECTED_PACKAGE_NAME,
    `Receipt package must be ${EXPECTED_PACKAGE_NAME}, got ${String(receiptObject.name)}`,
  );
  invariant(
    receiptObject.version === expectedVersion,
    `Receipt version must be ${expectedVersion}, got ${String(receiptObject.version)}`,
  );
  invariant(
    receiptObject.sourceCommit === expectedCommit,
    `Receipt sourceCommit must be ${expectedCommit}, got ${String(receiptObject.sourceCommit)}`,
  );
  const receiptDigest = sha512HexFromIntegrity(receiptObject.integrity);

  const audit = requiredObject(report, "npm audit signatures report");
  const invalid = requiredArray(audit.invalid, "report.invalid");
  const missing = requiredArray(audit.missing, "report.missing");
  invariant(invalid.length === 0, `npm reported ${invalid.length} invalid signature(s)`);
  invariant(missing.length === 0, `npm reported ${missing.length} missing signature(s)`);

  const verified = requiredArray(audit.verified, "report.verified");
  const packageEntries = verified.filter(
    (entry) => entry?.name === EXPECTED_PACKAGE_NAME && entry?.version === expectedVersion,
  );
  invariant(
    packageEntries.length === 1,
    `Expected exactly one verified ${EXPECTED_PACKAGE_NAME}@${expectedVersion} entry, found ${packageEntries.length}`,
  );

  const packageEntry = requiredObject(packageEntries[0], "verified package entry");
  invariant(
    packageEntry.location === `node_modules/${EXPECTED_PACKAGE_NAME}`,
    `Verified package must be the direct installed dependency, got location ${String(packageEntry.location)}`,
  );
  invariant(
    packageEntry.registry === EXPECTED_REGISTRY,
    `Verified package registry must be ${EXPECTED_REGISTRY}, got ${String(packageEntry.registry)}`,
  );
  invariant(
    packageEntry.attestations?.provenance?.predicateType === SLSA_PREDICATE_TYPE,
    `Registry metadata does not advertise ${SLSA_PREDICATE_TYPE} provenance`,
  );

  const attestationBundles = requiredArray(
    packageEntry.attestationBundles,
    "verified package attestationBundles",
  );
  const publishBundles = attestationBundles.filter(
    (attestation) => attestation?.predicateType === NPM_PUBLISH_PREDICATE_TYPE,
  );
  invariant(
    publishBundles.length === 1,
    `Expected exactly one verified npm publish v0.1 bundle, found ${publishBundles.length}`,
  );
  verifyPublishAttestation(publishBundles[0], expectedVersion, receiptDigest);

  const provenanceBundles = attestationBundles.filter(
    (attestation) => attestation?.predicateType === SLSA_PREDICATE_TYPE,
  );
  invariant(
    provenanceBundles.length === 1,
    `Expected exactly one verified SLSA v1 bundle, found ${provenanceBundles.length}`,
  );

  const attestation = requiredObject(provenanceBundles[0], "SLSA attestation");
  const bundle = requiredObject(attestation.bundle, "SLSA Sigstore bundle");
  invariant(
    bundle.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE,
    `Sigstore bundle media type must be ${SIGSTORE_BUNDLE_MEDIA_TYPE}, got ${String(bundle.mediaType)}`,
  );

  const envelope = requiredObject(bundle.dsseEnvelope, "SLSA DSSE envelope");
  invariant(
    envelope.payloadType === INTOTO_PAYLOAD_TYPE,
    `DSSE payloadType must be ${INTOTO_PAYLOAD_TYPE}, got ${String(envelope.payloadType)}`,
  );
  const signatures = requiredArray(envelope.signatures, "DSSE signatures");
  invariant(signatures.length === 1, `Expected exactly one DSSE signature, found ${signatures.length}`);
  const signature = requiredObject(signatures[0], "DSSE signature");
  requiredString(signature.sig, "DSSE signature value");
  invariant(
    signature.keyid === "",
    `SLSA provenance must use a keyless signing certificate, got keyid ${String(signature.keyid)}`,
  );

  const verificationMaterial = requiredObject(
    bundle.verificationMaterial,
    "Sigstore verificationMaterial",
  );
  const certificate = requiredObject(
    verificationMaterial.certificate,
    "Fulcio signing certificate",
  );
  const certificateRawBytes = requiredString(certificate.rawBytes, "Fulcio certificate rawBytes");
  const tlogEntries = requiredArray(verificationMaterial.tlogEntries, "Sigstore tlogEntries");
  invariant(tlogEntries.length > 0, "Sigstore bundle has no transparency-log entry");

  const expectedCertificateSan =
    `URI:${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@${expectedRef}`;
  const readCertificateSan = options.readCertificateSan ?? certificateSubjectAltName;
  let actualCertificateSan;
  try {
    actualCertificateSan = readCertificateSan(certificateRawBytes);
  } catch (error) {
    throw new Error(`Unable to parse Fulcio signing certificate: ${error.message}`, { cause: error });
  }
  invariant(
    actualCertificateSan === expectedCertificateSan,
    `Fulcio certificate SAN must be ${expectedCertificateSan}, got ${String(actualCertificateSan)}`,
  );

  const statement = parseDsseStatement(envelope.payload);
  invariant(
    statement._type === INTOTO_STATEMENT_TYPE,
    `Statement type must be ${INTOTO_STATEMENT_TYPE}, got ${String(statement._type)}`,
  );
  invariant(
    statement.predicateType === SLSA_PREDICATE_TYPE,
    `Statement predicateType must be ${SLSA_PREDICATE_TYPE}, got ${String(statement.predicateType)}`,
  );

  const subjects = requiredArray(statement.subject, "statement.subject");
  invariant(subjects.length === 1, `Expected exactly one statement subject, found ${subjects.length}`);
  const subject = requiredObject(subjects[0], "statement subject");
  const expectedPurl = `pkg:npm/${EXPECTED_PACKAGE_NAME}@${expectedVersion}`;
  invariant(
    subject.name === expectedPurl,
    `Statement subject must be ${expectedPurl}, got ${String(subject.name)}`,
  );
  invariant(
    subject.digest?.sha512 === receiptDigest,
    `Statement SHA-512 does not match the tested tarball receipt`,
  );

  const predicate = requiredObject(statement.predicate, "SLSA predicate");
  const buildDefinition = requiredObject(predicate.buildDefinition, "SLSA buildDefinition");
  invariant(
    buildDefinition.buildType === GITHUB_WORKFLOW_BUILD_TYPE,
    `SLSA buildType must be ${GITHUB_WORKFLOW_BUILD_TYPE}, got ${String(buildDefinition.buildType)}`,
  );
  const workflow = requiredObject(
    buildDefinition.externalParameters?.workflow,
    "SLSA externalParameters.workflow",
  );
  invariant(
    workflow.repository === EXPECTED_REPOSITORY,
    `SLSA repository must be ${EXPECTED_REPOSITORY}, got ${String(workflow.repository)}`,
  );
  normalizeWorkflowPath(workflow.path);
  invariant(
    workflow.ref === expectedRef,
    `SLSA workflow ref must be ${expectedRef}, got ${String(workflow.ref)}`,
  );
  invariant(
    buildDefinition.internalParameters?.github?.event_name === "push",
    `SLSA GitHub event must be push, got ${String(buildDefinition.internalParameters?.github?.event_name)}`,
  );

  const resolvedDependencies = requiredArray(
    buildDefinition.resolvedDependencies,
    "SLSA resolvedDependencies",
  );
  const expectedSourceUri = `git+${EXPECTED_REPOSITORY}@${expectedRef}`;
  const matchingSources = resolvedDependencies.filter(
    (source) => source?.uri === expectedSourceUri && source?.digest?.gitCommit === expectedCommit,
  );
  invariant(
    matchingSources.length === 1,
    `Expected exactly one SLSA source matching ${expectedSourceUri} at ${expectedCommit}, found ${matchingSources.length}`,
  );
  const runDetails = requiredObject(predicate.runDetails, "SLSA runDetails");
  invariant(
    runDetails.builder?.id === EXPECTED_BUILDER,
    `SLSA builder must be ${EXPECTED_BUILDER}, got ${String(runDetails.builder?.id)}`,
  );
  const invocation = validateInvocationUri(
    runDetails.metadata?.invocationId,
    expectedRunId,
    currentRunAttempt,
  );

  return {
    certificateSan: actualCertificateSan,
    commit: expectedCommit,
    digest: receiptDigest,
    package: `${EXPECTED_PACKAGE_NAME}@${expectedVersion}`,
    ref: expectedRef,
    bundle,
    invocationUri: invocation.uri,
    attestedAttempt: invocation.attestedAttempt,
  };
}

function verifyPublishAttestation(attestationValue, expectedVersion, receiptDigest) {
  const attestation = requiredObject(attestationValue, "npm publish attestation");
  const bundle = requiredObject(attestation.bundle, "npm publish Sigstore bundle");
  invariant(
    bundle.mediaType === NPM_PUBLISH_BUNDLE_MEDIA_TYPE,
    `npm publish bundle media type must be ${NPM_PUBLISH_BUNDLE_MEDIA_TYPE}, got ${String(bundle.mediaType)}`,
  );
  const envelope = requiredObject(bundle.dsseEnvelope, "npm publish DSSE envelope");
  invariant(
    envelope.payloadType === INTOTO_PAYLOAD_TYPE,
    `npm publish DSSE payloadType must be ${INTOTO_PAYLOAD_TYPE}, got ${String(envelope.payloadType)}`,
  );
  const signatures = requiredArray(envelope.signatures, "npm publish DSSE signatures");
  invariant(
    signatures.length === 1,
    `Expected exactly one npm publish DSSE signature, found ${signatures.length}`,
  );
  const signature = requiredObject(signatures[0], "npm publish DSSE signature");
  requiredString(signature.sig, "npm publish DSSE signature value");
  const keyid = requiredString(signature.keyid, "npm publish DSSE signature keyid");

  const verificationMaterial = requiredObject(
    bundle.verificationMaterial,
    "npm publish verificationMaterial",
  );
  const publicKey = requiredObject(verificationMaterial.publicKey, "npm publish publicKey");
  invariant(
    publicKey.hint === keyid,
    `npm publish public-key hint does not match its DSSE keyid`,
  );
  const tlogEntries = requiredArray(
    verificationMaterial.tlogEntries,
    "npm publish tlogEntries",
  );
  invariant(tlogEntries.length > 0, "npm publish bundle has no transparency-log entry");

  const statement = parseDsseStatement(envelope.payload);
  exactObjectKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "npm publish statement",
  );
  invariant(
    statement._type === INTOTO_STATEMENT_V01_TYPE,
    `npm publish statement type must be ${INTOTO_STATEMENT_V01_TYPE}, got ${String(statement._type)}`,
  );
  invariant(
    statement.predicateType === NPM_PUBLISH_PREDICATE_TYPE,
    `npm publish predicateType must be ${NPM_PUBLISH_PREDICATE_TYPE}, got ${String(statement.predicateType)}`,
  );
  const subjects = requiredArray(statement.subject, "npm publish statement.subject");
  invariant(
    subjects.length === 1,
    `Expected exactly one npm publish subject, found ${subjects.length}`,
  );
  const subject = requiredObject(subjects[0], "npm publish subject");
  exactObjectKeys(subject, ["digest", "name"], "npm publish subject");
  const digest = requiredObject(subject.digest, "npm publish subject.digest");
  exactObjectKeys(digest, ["sha512"], "npm publish subject.digest");
  const expectedPurl = `pkg:npm/${EXPECTED_PACKAGE_NAME}@${expectedVersion}`;
  invariant(
    subject.name === expectedPurl,
    `npm publish subject must be ${expectedPurl}, got ${String(subject.name)}`,
  );
  invariant(
    digest.sha512 === receiptDigest,
    "npm publish statement SHA-512 does not match the tested tarball receipt",
  );
  const predicate = requiredObject(statement.predicate, "npm publish predicate");
  exactObjectKeys(predicate, ["name", "registry", "version"], "npm publish predicate");
  invariant(
    predicate.name === EXPECTED_PACKAGE_NAME,
    `npm publish predicate name must be ${EXPECTED_PACKAGE_NAME}, got ${String(predicate.name)}`,
  );
  invariant(
    predicate.version === expectedVersion,
    `npm publish predicate version must be ${expectedVersion}, got ${String(predicate.version)}`,
  );
  invariant(
    predicate.registry === EXPECTED_REGISTRY.slice(0, -1),
    `npm publish predicate registry must be ${EXPECTED_REGISTRY.slice(0, -1)}, got ${String(predicate.registry)}`,
  );
}

export function buildSigstorePolicy(expected) {
  const repositoryId = requiredNumericString(expected?.repositoryId, "GITHUB_REPOSITORY_ID");
  const ownerId = requiredNumericString(expected?.ownerId, "GITHUB_REPOSITORY_OWNER_ID");
  const runId = requiredNumericString(expected?.runId, "GITHUB_RUN_ID");
  const runAttempt = requiredNumericString(expected?.runAttempt, "GITHUB_RUN_ATTEMPT");
  const version = requiredString(expected?.version, "expected version");
  const ref = requiredString(expected?.ref, "expected ref");
  const commit = requiredString(expected?.commit, "expected commit");
  invariant(ref === `refs/tags/v${version}`, `Sigstore policy ref does not match version ${version}`);
  invariant(/^[0-9a-f]{40}$/.test(commit), "Sigstore policy commit is not a lowercase Git SHA");
  invariant(
    repositoryId === EXPECTED_REPOSITORY_ID,
    `GITHUB_REPOSITORY_ID must be ${EXPECTED_REPOSITORY_ID}, got ${repositoryId}`,
  );
  invariant(
    ownerId === EXPECTED_OWNER_ID,
    `GITHUB_REPOSITORY_OWNER_ID must be ${EXPECTED_OWNER_ID}, got ${ownerId}`,
  );

  const invocation = validateInvocationUri(expected?.invocationUri, runId, runAttempt);
  const workflowIdentity = `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@${ref}`;
  const tokenSubject =
    `repo:sliverarmory/sliver-script:environment:${EXPECTED_ENVIRONMENT}`;
  const oid = "1.3.6.1.4.1.57264.1";
  const certificateOIDs = {
    [`${oid}.9`]: derUtf8String(workflowIdentity),
    [`${oid}.10`]: derUtf8String(commit),
    [`${oid}.11`]: derUtf8String("github-hosted"),
    [`${oid}.12`]: derUtf8String(EXPECTED_REPOSITORY),
    [`${oid}.13`]: derUtf8String(commit),
    [`${oid}.14`]: derUtf8String(ref),
    [`${oid}.15`]: derUtf8String(repositoryId),
    [`${oid}.16`]: derUtf8String(EXPECTED_OWNER),
    [`${oid}.17`]: derUtf8String(ownerId),
    [`${oid}.18`]: derUtf8String(workflowIdentity),
    [`${oid}.19`]: derUtf8String(commit),
    [`${oid}.20`]: derUtf8String("push"),
    [`${oid}.21`]: derUtf8String(invocation.uri),
    [`${oid}.22`]: derUtf8String("public"),
    [`${oid}.23`]: derUtf8String(EXPECTED_ENVIRONMENT),
    [`${oid}.24`]: derUtf8String(tokenSubject),
  };

  return {
    certificateIdentityURI: `^${escapeRegExp(workflowIdentity)}$`,
    certificateIssuer: EXPECTED_OIDC_ISSUER,
    certificateOIDs,
  };
}

export async function reverifySigstoreBundle(bundle, expected) {
  const policy = buildSigstorePolicy(expected);
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  invariant(
    npmVersion === EXPECTED_NPM_VERSION,
    `Sigstore verifier requires npm ${EXPECTED_NPM_VERSION}, got ${npmVersion}`,
  );
  const globalRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
  invariant(globalRoot.length > 0, "npm returned an empty global module root");
  const npmRoot = join(globalRoot, "npm");
  const require = createRequire(import.meta.url);
  const sigstoreManifest = require(join(npmRoot, "node_modules", "sigstore", "package.json"));
  invariant(
    sigstoreManifest.version === EXPECTED_SIGSTORE_VERSION,
    `Sigstore verifier requires sigstore ${EXPECTED_SIGSTORE_VERSION}, got ${String(sigstoreManifest.version)}`,
  );
  const sigstore = require(join(npmRoot, "node_modules", "sigstore"));
  invariant(typeof sigstore.verify === "function", "Pinned sigstore module has no verify function");

  await sigstore.verify(bundle, policy);
  return { npmVersion, sigstoreVersion: sigstoreManifest.version };
}

function certificateSubjectAltName(rawBytes) {
  const certificate = new X509Certificate(decodeCanonicalBase64(rawBytes, "certificate rawBytes"));
  return certificate.subjectAltName;
}

function parseDsseStatement(payload) {
  const payloadBytes = decodeCanonicalBase64(requiredString(payload, "DSSE payload"), "DSSE payload");
  let statement;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    statement = JSON.parse(json);
  } catch (error) {
    throw new Error(`Unable to decode attestation DSSE payload: ${error.message}`, { cause: error });
  }
  return requiredObject(statement, "attestation statement");
}

function sha512HexFromIntegrity(integrity) {
  const value = requiredString(integrity, "receipt integrity");
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  invariant(match !== null, `Receipt integrity is not a single SHA-512 SRI value: ${value}`);
  const digest = decodeCanonicalBase64(match[1], "receipt SHA-512 digest");
  invariant(digest.length === 64, `Receipt SHA-512 digest has ${digest.length} bytes, expected 64`);
  return digest.toString("hex");
}

function normalizeWorkflowPath(value) {
  invariant(
    value === EXPECTED_WORKFLOW_PATH || value === `/${EXPECTED_WORKFLOW_PATH}`,
    `SLSA workflow path must be ${EXPECTED_WORKFLOW_PATH} with at most one leading slash, got ${String(value)}`,
  );
  return EXPECTED_WORKFLOW_PATH;
}

function validateInvocationUri(value, runId, currentRunAttempt) {
  const uri = requiredString(value, "SLSA invocation URI");
  const expectedPrefix = `${EXPECTED_REPOSITORY}/actions/runs/${runId}/attempts/`;
  invariant(
    uri.startsWith(expectedPrefix),
    `SLSA invocation URI must belong to GitHub run ${runId}, got ${uri}`,
  );
  const attestedAttempt = uri.slice(expectedPrefix.length);
  requiredNumericString(attestedAttempt, "attested workflow run attempt");
  invariant(
    uri === `${expectedPrefix}${attestedAttempt}`,
    `SLSA invocation URI has unexpected trailing data: ${uri}`,
  );
  invariant(
    BigInt(attestedAttempt) <= BigInt(currentRunAttempt),
    `Attested workflow attempt ${attestedAttempt} is newer than current attempt ${currentRunAttempt}`,
  );
  return { uri, attestedAttempt };
}

function derUtf8String(value) {
  const bytes = Buffer.from(requiredString(value, "certificate OID value"), "utf8");
  let length;
  if (bytes.length < 0x80) {
    length = Buffer.from([bytes.length]);
  } else if (bytes.length <= 0xff) {
    length = Buffer.from([0x81, bytes.length]);
  } else if (bytes.length <= 0xffff) {
    length = Buffer.from([0x82, bytes.length >> 8, bytes.length & 0xff]);
  } else {
    throw new Error(`Certificate OID value is too long: ${bytes.length} bytes`);
  }
  return Buffer.concat([Buffer.from([0x0c]), length, bytes]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeCanonicalBase64(value, label) {
  const decoded = Buffer.from(value, "base64");
  invariant(decoded.toString("base64") === value, `${label} is not canonical base64`);
  return decoded;
}

function requiredObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  return value;
}

function requiredArray(value, label) {
  invariant(Array.isArray(value), `${label} is not an array`);
  return value;
}

function requiredString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} is not a non-empty string`);
  return value;
}

function requiredNumericString(value, label) {
  const string = requiredString(value, label);
  invariant(/^[1-9][0-9]*$/.test(string), `${label} must be a positive decimal integer`);
  return string;
}

function exactObjectKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(requiredObject(value, label)).sort();
  const sortedExpected = [...expectedKeys].sort();
  invariant(
    actualKeys.length === sortedExpected.length
      && actualKeys.every((key, index) => key === sortedExpected[index]),
    `${label} has unexpected fields: ${actualKeys.join(", ")}`,
  );
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSelfTestFixture() {
  const version = "2.0.0";
  const ref = `refs/tags/v${version}`;
  const commit = "a".repeat(40);
  const digest = "b".repeat(128);
  const runId = "987654";
  const runAttempt = "2";
  const attestedAttempt = "1";
  const certificateSan = `URI:${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@${ref}`;
  const statement = {
    _type: INTOTO_STATEMENT_TYPE,
    subject: [{ name: `pkg:npm/${EXPECTED_PACKAGE_NAME}@${version}`, digest: { sha512: digest } }],
    predicateType: SLSA_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: GITHUB_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: {
            ref,
            repository: EXPECTED_REPOSITORY,
            path: EXPECTED_WORKFLOW_PATH,
          },
        },
        internalParameters: { github: { event_name: "push" } },
        resolvedDependencies: [{
          uri: `git+${EXPECTED_REPOSITORY}@${ref}`,
          digest: { gitCommit: commit },
        }],
      },
      runDetails: {
        builder: { id: EXPECTED_BUILDER },
        metadata: {
          invocationId:
            `${EXPECTED_REPOSITORY}/actions/runs/${runId}/attempts/${attestedAttempt}`,
        },
      },
    },
  };
  const publishStatement = {
    _type: INTOTO_STATEMENT_V01_TYPE,
    subject: [{ name: `pkg:npm/${EXPECTED_PACKAGE_NAME}@${version}`, digest: { sha512: digest } }],
    predicateType: NPM_PUBLISH_PREDICATE_TYPE,
    predicate: {
      name: EXPECTED_PACKAGE_NAME,
      version,
      registry: EXPECTED_REGISTRY.slice(0, -1),
    },
  };
  return {
    expected: {
      version,
      ref,
      commit,
      repositoryId: EXPECTED_REPOSITORY_ID,
      ownerId: EXPECTED_OWNER_ID,
      runId,
      runAttempt,
    },
    receipt: {
      name: EXPECTED_PACKAGE_NAME,
      version,
      sourceCommit: commit,
      integrity: `sha512-${Buffer.from(digest, "hex").toString("base64")}`,
    },
    report: {
      invalid: [],
      missing: [],
      verified: [{
        name: EXPECTED_PACKAGE_NAME,
        version,
        location: `node_modules/${EXPECTED_PACKAGE_NAME}`,
        registry: EXPECTED_REGISTRY,
        attestations: { provenance: { predicateType: SLSA_PREDICATE_TYPE } },
        attestationBundles: [
          {
            predicateType: SLSA_PREDICATE_TYPE,
            bundle: {
              mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
              dsseEnvelope: {
                payloadType: INTOTO_PAYLOAD_TYPE,
                payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
                signatures: [{ keyid: "", sig: "fixture-signature" }],
              },
              verificationMaterial: {
                certificate: { rawBytes: Buffer.from(certificateSan).toString("base64") },
                tlogEntries: [{}],
              },
            },
          },
          {
            predicateType: NPM_PUBLISH_PREDICATE_TYPE,
            bundle: {
              mediaType: NPM_PUBLISH_BUNDLE_MEDIA_TYPE,
              dsseEnvelope: {
                payloadType: INTOTO_PAYLOAD_TYPE,
                payload: Buffer.from(JSON.stringify(publishStatement)).toString("base64"),
                signatures: [{ keyid: "fixture-registry-key", sig: "fixture-signature" }],
              },
              verificationMaterial: {
                publicKey: { hint: "fixture-registry-key" },
                tlogEntries: [{}],
              },
            },
          },
        ],
      }],
    },
  };
}

function mutateSelfTestStatement(fixture, mutate) {
  const envelope = fixture.report.verified[0].attestationBundles[0].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  mutate(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
}

function mutateSelfTestPublishStatement(fixture, mutate) {
  const envelope = fixture.report.verified[0].attestationBundles[1].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  mutate(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
}

function runSelfTest() {
  const fixtureCertificateSan = (rawBytes) =>
    decodeCanonicalBase64(rawBytes, "fixture certificate").toString("utf8");
  const positive = makeSelfTestFixture();
  const positiveResult = verifyRegistryProvenance(
    positive.report,
    positive.receipt,
    positive.expected,
    {
    readCertificateSan: fixtureCertificateSan,
    },
  );
  const policyExpected = {
    ...positive.expected,
    invocationUri: positiveResult.invocationUri,
  };
  const policy = buildSigstorePolicy(policyExpected);
  const workflowIdentity =
    `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@${positive.expected.ref}`;
  invariant(
    positiveResult.attestedAttempt === "1",
    "Self-test did not accept an earlier attempt from the same workflow run",
  );
  invariant(
    new RegExp(policy.certificateIdentityURI).test(workflowIdentity)
      && !new RegExp(policy.certificateIdentityURI).test(`${workflowIdentity}-other`),
    "Self-test Sigstore certificate identity policy is not an exact match",
  );
  invariant(
    policy.certificateIssuer === EXPECTED_OIDC_ISSUER,
    "Self-test Sigstore issuer policy mismatch",
  );
  invariant(
    Object.keys(policy.certificateOIDs).length === 16,
    "Self-test Sigstore policy must bind all Fulcio OIDs .9 through .24",
  );
  invariant(
    policy.certificateOIDs["1.3.6.1.4.1.57264.1.9"].equals(derUtf8String(workflowIdentity))
      && policy.certificateOIDs["1.3.6.1.4.1.57264.1.23"].equals(
        derUtf8String(EXPECTED_ENVIRONMENT),
      )
      && policy.certificateOIDs["1.3.6.1.4.1.57264.1.21"].equals(
        derUtf8String(positiveResult.invocationUri),
      )
      && policy.certificateOIDs["1.3.6.1.4.1.57264.1.24"].equals(
        derUtf8String(`repo:sliverarmory/sliver-script:environment:${EXPECTED_ENVIRONMENT}`),
      ),
    "Self-test Sigstore Fulcio OID policy mismatch",
  );
  let wrongRepositoryIdRejected = false;
  try {
    buildSigstorePolicy({ ...policyExpected, repositoryId: "1" });
  } catch {
    wrongRepositoryIdRejected = true;
  }
  invariant(wrongRepositoryIdRejected, "Unexpected GitHub repository ID was accepted");

  const rejectionCases = [
    ["npm invalid result", (fixture) => fixture.report.invalid.push({ code: "fixture" })],
    ["subject package", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.subject[0].name = "pkg:npm/not-sliver-script@2.0.0";
    })],
    ["subject digest", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.subject[0].digest.sha512 = "c".repeat(128);
    })],
    ["repository", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/example/sliver-script";
    })],
    ["workflow", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path =
        ".github/workflows/other.yml";
    })],
    ["workflow double slash", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path =
        `//${EXPECTED_WORKFLOW_PATH}`;
    })],
    ["tag ref", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
    })],
    ["source commit", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
    })],
    ["source URI", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].uri =
        `git+${EXPECTED_REPOSITORY}@refs/heads/main`;
    })],
    ["wrong invocation run ID", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.runDetails.metadata.invocationId =
        `${EXPECTED_REPOSITORY}/actions/runs/111111/attempts/1`;
    })],
    ["future invocation attempt", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.runDetails.metadata.invocationId =
        `${EXPECTED_REPOSITORY}/actions/runs/${fixture.expected.runId}/attempts/3`;
    })],
    ["ambiguous source", (fixture) => mutateSelfTestStatement(fixture, (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies.push(
        structuredClone(statement.predicate.buildDefinition.resolvedDependencies[0]),
      );
    })],
    ["certificate SAN", (fixture) => {
      const certificate = fixture.report.verified[0].attestationBundles[0]
        .bundle.verificationMaterial.certificate;
      certificate.rawBytes = Buffer.from(
        `URI:${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@refs/heads/main`,
      ).toString("base64");
    }],
    ["ambiguous provenance", (fixture) => {
      fixture.report.verified[0].attestationBundles.push(
        structuredClone(fixture.report.verified[0].attestationBundles[0]),
      );
    }],
    ["missing publish attestation", (fixture) => {
      fixture.report.verified[0].attestationBundles.splice(1, 1);
    }],
    ["ambiguous publish attestation", (fixture) => {
      fixture.report.verified[0].attestationBundles.push(
        structuredClone(fixture.report.verified[0].attestationBundles[1]),
      );
    }],
    ["publish attestation mismatch", (fixture) => {
      mutateSelfTestPublishStatement(fixture, (statement) => {
        statement.predicate.version = "2.0.1";
      });
    }],
  ];

  for (const [label, mutate] of rejectionCases) {
    const fixture = makeSelfTestFixture();
    mutate(fixture);
    let rejected = false;
    try {
      verifyRegistryProvenance(fixture.report, fixture.receipt, fixture.expected, {
        readCertificateSan: fixtureCertificateSan,
      });
    } catch {
      rejected = true;
    }
    invariant(rejected, `Self-test mutation was incorrectly accepted: ${label}`);
  }

  const malformedCertificate = makeSelfTestFixture();
  let malformedCertificateRejected = false;
  try {
    verifyRegistryProvenance(
      malformedCertificate.report,
      malformedCertificate.receipt,
      malformedCertificate.expected,
    );
  } catch {
    malformedCertificateRejected = true;
  }
  invariant(malformedCertificateRejected, "Malformed X.509 certificate fixture was incorrectly accepted");

  const normalizedPath = makeSelfTestFixture();
  mutateSelfTestStatement(normalizedPath, (statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.path =
      `/${EXPECTED_WORKFLOW_PATH}`;
  });
  verifyRegistryProvenance(normalizedPath.report, normalizedPath.receipt, normalizedPath.expected, {
    readCertificateSan: fixtureCertificateSan,
  });

  const additionalDependency = makeSelfTestFixture();
  mutateSelfTestStatement(additionalDependency, (statement) => {
    statement.predicate.buildDefinition.resolvedDependencies.push({
      uri: "pkg:npm/example@1.0.0",
      digest: { sha256: "e".repeat(64) },
    });
  });
  verifyRegistryProvenance(
    additionalDependency.report,
    additionalDependency.receipt,
    additionalDependency.expected,
    { readCertificateSan: fixtureCertificateSan },
  );

  console.log(
    `Registry provenance parser self-test passed (${rejectionCases.length + 2} rejection cases).`,
  );
}

async function main(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
    return;
  }
  if (args.length !== 9 || args.some((argument) => argument.trim() === "")) {
    throw new Error(
      "Usage: node scripts/registry-provenance-check.mjs AUDIT_JSON RECEIPT VERSION TAG_REF SOURCE_COMMIT REPOSITORY_ID OWNER_ID RUN_ID RUN_ATTEMPT",
    );
  }

  const [
    auditPath,
    receiptPath,
    version,
    ref,
    commit,
    repositoryId,
    ownerId,
    runId,
    runAttempt,
  ] = args;
  const [auditText, receiptText] = await Promise.all([
    readFile(auditPath, "utf8"),
    readFile(receiptPath, "utf8"),
  ]);
  const expected = { version, ref, commit, repositoryId, ownerId, runId, runAttempt };
  const result = verifyRegistryProvenance(
    JSON.parse(auditText),
    JSON.parse(receiptText),
    expected,
  );
  const verifier = await reverifySigstoreBundle(result.bundle, {
    ...expected,
    invocationUri: result.invocationUri,
  });
  console.log(
    `Verified registry provenance for ${result.package} with npm ${verifier.npmVersion}/sigstore ${verifier.sigstoreVersion}: `
      + `${result.digest} from ${result.ref} at ${result.commit}; ${result.certificateSan}; `
      + `attested run attempt ${result.attestedAttempt}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Registry provenance verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
