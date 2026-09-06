import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'sliver-script';
const REPOSITORY = 'sliverarmory/sliver-script';
const REGISTRY = 'https://registry.npmjs.org';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseReleaseTag(tag) {
  requireCondition(typeof tag === 'string' && tag.startsWith('v'), 'Release tag must start with v');
  const version = tag.slice(1);
  const match = VERSION_PATTERN.exec(version);
  requireCondition(match && match[0] === version, 'Release tag must be strict v<semver> without build metadata');
  const prerelease = match[4]?.split('.') ?? [];
  requireCondition(prerelease.every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')),
    'Numeric prerelease identifiers must not have leading zeros');
  return { version, distTag: prerelease.length ? 'next' : 'latest', core: match.slice(1, 4), prerelease };
}

export function compareVersions(left, right) {
  const a = parseReleaseTag(`v${left}`);
  const b = parseReleaseTag(`v${right}`);
  for (let i = 0; i < 3; i += 1) {
    if (BigInt(a.core[i]) !== BigInt(b.core[i])) return BigInt(a.core[i]) > BigInt(b.core[i]) ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function releaseIdentity(env) {
  const release = parseReleaseTag(env.RELEASE_TAG);
  requireCondition(typeof env.RELEASE_SHA === 'string' && env.RELEASE_SHA.length === 40 && SHA_PATTERN.test(env.RELEASE_SHA),
    'RELEASE_SHA must be a lowercase 40-character commit SHA');
  return { ...release, sha: env.RELEASE_SHA };
}

export function validateManifests(manifest, lock, version) {
  for (const [label, data] of [['package.json', manifest], ['package-lock.json', lock], ['package-lock.json root package', lock?.packages?.['']]]) {
    requireCondition(data?.name === PACKAGE, `${label} name must be ${PACKAGE}`);
    requireCondition(data.version === version, `${label} version must match release version ${version}`);
  }
}

export async function prepare(env, cwd = process.cwd()) {
  const release = releaseIdentity(env);
  requireCondition(env.GITHUB_REPOSITORY === REPOSITORY, `Releases must run in ${REPOSITORY}`);
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  requireCondition(git('rev-parse', '--verify', 'HEAD') === release.sha, 'Checked-out HEAD must match RELEASE_SHA');
  let tagExists = true;
  try {
    git('show-ref', '--verify', '--quiet', `refs/tags/${env.RELEASE_TAG}`);
  } catch (error) {
    if (error.status !== 1) throw error;
    tagExists = false;
  }
  requireCondition(tagExists || env.RELEASE_DRY_RUN === 'true', 'Release tag must exist unless RELEASE_DRY_RUN is true');
  if (tagExists) {
    requireCondition(git('rev-parse', '--verify', `refs/tags/${env.RELEASE_TAG}^{commit}`) === release.sha,
      'Release tag must point to RELEASE_SHA');
  }
  try {
    git('merge-base', '--is-ancestor', release.sha, 'refs/remotes/origin/master');
  } catch {
    throw new Error('Release commit must be reachable from origin/master (fetch full history first)');
  }
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async (name) =>
    JSON.parse(await readFile(resolve(cwd, name), 'utf8'))));
  validateManifests(manifest, lock, release.version);
  return { sha: release.sha, version: release.version, dist_tag: release.distTag };
}

export function digests(bytes) {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

export async function checkArtifact(env) {
  const release = releaseIdentity(env);
  requireCondition(typeof env.RELEASE_DIR === 'string' && env.RELEASE_DIR.length, 'RELEASE_DIR is required');
  const directory = resolve(env.RELEASE_DIR);
  const filename = `${PACKAGE}-${release.version}.tgz`;
  const expectedFiles = [filename, 'release.json'].sort();
  const files = (await readdir(directory)).sort();
  requireCondition(JSON.stringify(files) === JSON.stringify(expectedFiles), 'Artifact directory must contain only the release tarball and release.json');
  for (const name of expectedFiles) {
    requireCondition((await lstat(resolve(directory, name))).isFile(), `Artifact ${name} must be a regular file`);
  }
  const metadata = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
  const keys = ['schemaVersion', 'name', 'version', 'filename', 'integrity', 'shasum', 'sourceSha'].sort();
  requireCondition(metadata && JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(keys), 'Unexpected release.json schema');
  requireCondition(metadata.schemaVersion === 1 && metadata.name === PACKAGE && metadata.version === release.version
    && metadata.filename === filename && metadata.sourceSha === release.sha, 'Artifact metadata must match the release tag, package, and commit');
  const tarball = resolve(directory, filename);
  const actual = digests(await readFile(tarball));
  requireCondition(metadata.integrity === actual.integrity && metadata.shasum === actual.shasum,
    'Artifact tarball does not match release.json integrity');
  return { ...metadata, tarball, distTag: release.distTag };
}

class RetryableError extends Error {}

async function request(url, { fetchImpl = fetch, timeoutMs = 15_000, binary = false, allow404 = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store',
      headers: { Accept: binary ? 'application/octet-stream' : 'application/json' },
    });
  } catch (error) {
    throw new RetryableError(`Registry request failed: ${error.message}`);
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    const ErrorType = response.status === 429 || response.status >= 500 ? RetryableError : Error;
    throw new ErrorType(`Registry request returned HTTP ${response.status}`);
  }
  const limit = binary ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      requireCondition(size <= limit, 'Registry response exceeded the size limit');
      chunks.push(chunk);
    }
  } catch (error) {
    throw new RetryableError(`Could not read registry response: ${error.message}`);
  }
  const bytes = Buffer.concat(chunks);
  return binary ? bytes : JSON.parse(bytes.toString('utf8'));
}

export async function readRegistry(options = {}) {
  const document = await request(`${REGISTRY}/${PACKAGE}`, { ...options, allow404: true });
  if (document !== null) {
    requireCondition(document?.name === PACKAGE && document.versions && typeof document.versions === 'object'
      && !Array.isArray(document.versions) && document['dist-tags'] && typeof document['dist-tags'] === 'object'
      && !Array.isArray(document['dist-tags']), 'Unexpected npm registry package metadata');
  }
  return document;
}

function publishedVersion(document, artifact) {
  if (!document || !Object.hasOwn(document.versions, artifact.version)) return null;
  const version = document.versions[artifact.version];
  requireCondition(version?.name === PACKAGE && version.version === artifact.version, 'Registry version identity does not match release');
  requireCondition(version.dist?.integrity === artifact.integrity && version.dist?.shasum === artifact.shasum,
    `Registry version ${artifact.version} already exists with different tarball integrity`);
  return version;
}

export async function registryCheck(artifact, options = {}) {
  const document = await readRegistry(options);
  const current = document?.['dist-tags'][artifact.distTag];
  if (current !== undefined) {
    requireCondition(compareVersions(artifact.version, current) >= 0,
      `Publishing ${artifact.version} would move ${artifact.distTag} backwards from ${current}`);
  }
  return { already_published: String(publishedVersion(document, artifact) !== null) };
}

export function provenanceUrl(version) {
  const attestations = version.dist?.attestations;
  requireCondition(attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1', 'Published version is missing npm provenance metadata');
  let url;
  try { url = new URL(attestations.url); } catch { throw new Error('Published version has an invalid provenance URL'); }
  requireCondition(url.origin === REGISTRY && url.pathname.startsWith('/-/npm/v1/attestations/')
    && !url.username && !url.password && !url.hash && !url.search, 'Published version has an unexpected provenance URL');
  return url.href;
}

export async function verifyPublished(artifact, { attempts = 6, retryDelayMs = 5_000, sleep = delay, ...options } = {}) {
  requireCondition(Number.isInteger(attempts) && attempts > 0 && attempts <= 12, 'Verification attempts must be between 1 and 12');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const document = await readRegistry(options);
      const version = publishedVersion(document, artifact);
      if (!version) throw new RetryableError('Published version is not visible in the registry yet');
      if (document['dist-tags'][artifact.distTag] !== artifact.version) {
        throw new RetryableError(`npm dist-tag ${artifact.distTag} does not point to ${artifact.version}`);
      }
      if (!version.dist?.attestations?.provenance) throw new RetryableError('Published provenance metadata is not visible yet');
      const provenance = provenanceUrl(version);
      const tarballUrl = `${REGISTRY}/${PACKAGE}/-/${artifact.filename}`;
      requireCondition(version.dist.tarball === tarballUrl, 'Registry tarball URL does not match the expected npm artifact');
      const bytes = await request(tarballUrl, { ...options, binary: true });
      const actual = digests(bytes);
      requireCondition(actual.integrity === artifact.integrity && actual.shasum === artifact.shasum,
        'Downloaded npm tarball does not match the tested artifact');
      return { version: artifact.version, dist_tag: artifact.distTag, integrity: actual.integrity, provenance_url: provenance };
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt === attempts) throw error;
      await sleep(retryDelayMs);
    }
  }
}

export async function main(command, env = process.env) {
  let outputs;
  if (command === 'prepare') {
    outputs = await prepare(env);
  } else {
    requireCondition(['check-artifact', 'registry-check', 'verify-published'].includes(command), 'Usage: release.mjs prepare|check-artifact|registry-check|verify-published');
    const artifact = await checkArtifact(env);
    if (command === 'check-artifact') {
      outputs = { tarball: artifact.tarball, version: artifact.version, dist_tag: artifact.distTag, integrity: artifact.integrity };
    } else {
      outputs = command === 'registry-check' ? await registryCheck(artifact) : await verifyPublished(artifact);
    }
  }
  for (const [key, value] of Object.entries(outputs)) {
    requireCondition(!/[\r\n]/.test(String(value)), `Output ${key} contains a newline`);
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(outputs, null, 2));
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(`npm release: ${error.message}`);
    process.exitCode = 1;
  });
}
