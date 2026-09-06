import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkArtifact, compareVersions, digests, parseReleaseTag, prepare, provenanceUrl,
  registryCheck, releaseIdentity, validateManifests, verifyPublished,
} from './release.mjs';

const sha = 'a'.repeat(40);
const bytes = Buffer.from('isolated release test artifact');
const artifact = {
  schemaVersion: 1, name: 'sliver-script', version: '2.0.0', filename: 'sliver-script-2.0.0.tgz',
  ...digests(bytes), sourceSha: sha, distTag: 'latest',
};
const env = { RELEASE_TAG: 'v2.0.0', RELEASE_SHA: sha, GITHUB_REPOSITORY: 'sliverarmory/sliver-script' };
const provenance = {
  url: 'https://registry.npmjs.org/-/npm/v1/attestations/sliver-script@2.0.0',
  provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
};

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'npm-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeArtifact(t, metadata = {}) {
  const directory = await temporaryDirectory(t);
  const { distTag, ...record } = artifact;
  await writeFile(join(directory, artifact.filename), bytes);
  await writeFile(join(directory, 'release.json'), JSON.stringify({ ...record, ...metadata }));
  return { ...env, RELEASE_DIR: directory };
}

function registryDocument({ version = artifact.version, distTag = artifact.distTag, dist = {}, includeVersion = true } = {}) {
  return {
    name: 'sliver-script',
    'dist-tags': { [distTag]: version },
    versions: includeVersion ? {
      [artifact.version]: {
        name: 'sliver-script', version: artifact.version,
        dist: {
          integrity: artifact.integrity, shasum: artifact.shasum,
          tarball: `https://registry.npmjs.org/sliver-script/-/${artifact.filename}`,
          attestations: provenance, ...dist,
        },
      },
    } : {},
  };
}

function jsonFetch(document, status = 200) {
  return async () => new Response(JSON.stringify(document), { status });
}

test('strict release tags select the stable or preview channel', () => {
  assert.equal(parseReleaseTag('v2.0.0').distTag, 'latest');
  assert.equal(parseReleaseTag('v2.1.0-rc.1').distTag, 'next');
  assert.equal(parseReleaseTag('v0.0.0-alpha-beta.0').version, '0.0.0-alpha-beta.0');
  for (const tag of [undefined, '2.0.0', 'v2', 'v02.0.0', 'v2.00.0', 'v2.0.0-01', 'v2.0.0-rc.01',
    'v2.0.0+', 'v2.0.0+build', 'v2.0.0-rc..1', 'v2.0.0-rc_1', 'v2.0.0\n', 'v2.0.0;echo bad']) {
    assert.throws(() => parseReleaseTag(tag), undefined, String(tag));
  }
  assert.throws(() => releaseIdentity({ ...env, RELEASE_SHA: `${sha}\n` }), /40-character/);
});

test('semver ordering handles numeric prereleases and large numeric components', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0-rc.1'), 0);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
});

test('manifest and root lock identity must all match', () => {
  const manifest = { name: 'sliver-script', version: '2.0.0' };
  const lock = { ...manifest, packages: { '': { ...manifest } } };
  validateManifests(manifest, lock, '2.0.0');
  assert.throws(() => validateManifests({ ...manifest, version: '1.0.0' }, lock, '2.0.0'), /package.json version/);
  assert.throws(() => validateManifests(manifest, { ...lock, version: '1.0.0' }, '2.0.0'), /package-lock.json version/);
  assert.throws(() => validateManifests(manifest, { ...lock, packages: { '': { ...manifest, version: '1.0.0' } } }, '2.0.0'), /root package version/);
  assert.throws(() => validateManifests(manifest, { ...lock, name: 'other' }, '2.0.0'), /name must be/);
  assert.throws(() => validateManifests(manifest, { ...manifest }, '2.0.0'), /root package name/);
});

test('prepare checks the actual tag, commit, repository, and master ancestry', async (t) => {
  const cwd = await temporaryDirectory(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=master');
  const manifest = { name: 'sliver-script', version: '2.0.0' };
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({ ...manifest, packages: { '': manifest } }));
  git('add', '.');
  git('commit', '-m', 'Release test fixture');
  const firstSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', firstSha);
  const localEnv = { ...env, RELEASE_SHA: firstSha };
  await assert.rejects(prepare(localEnv, cwd), /tag must exist/);
  assert.equal((await prepare({ ...localEnv, RELEASE_DRY_RUN: 'true' }, cwd)).sha, firstSha);
  git('tag', '-a', 'v2.0.0', '-m', 'Release test tag');
  assert.deepEqual(await prepare(localEnv, cwd), { sha: firstSha, version: '2.0.0', dist_tag: 'latest' });
  await assert.rejects(prepare({ ...localEnv, GITHUB_REPOSITORY: 'fork/sliver-script' }, cwd), /Releases must run in/);
  await assert.rejects(prepare({ ...localEnv, RELEASE_SHA: sha }, cwd), /HEAD must match/);
  await writeFile(join(cwd, 'fixture.txt'), 'second commit');
  git('add', '.');
  git('commit', '-m', 'Second test fixture commit');
  const secondSha = git('rev-parse', 'HEAD');
  await assert.rejects(prepare({ ...localEnv, RELEASE_SHA: secondSha, RELEASE_DRY_RUN: 'true' }, cwd), /tag must point/);
  git('tag', '-f', 'v2.0.0');
  await assert.rejects(prepare({ ...localEnv, RELEASE_SHA: secondSha }, cwd), /reachable from origin\/master/);
  git('update-ref', 'refs/remotes/origin/master', secondSha);
  assert.equal((await prepare({ ...localEnv, RELEASE_SHA: secondSha }, cwd)).sha, secondSha);
});

test('artifact validation checks source identity and both digests', async (t) => {
  const localEnv = await writeArtifact(t);
  const result = await checkArtifact(localEnv);
  assert.equal(result.integrity, artifact.integrity);
  assert.equal(result.tarball, join(localEnv.RELEASE_DIR, artifact.filename));
  await writeFile(result.tarball, 'modified bytes');
  await assert.rejects(checkArtifact(localEnv), /does not match release.json integrity/);
  for (const metadata of [{ version: '1.0.0' }, { sourceSha: 'b'.repeat(40) }, { filename: '../outside.tgz' }, { schemaVersion: 2 }, { extra: true }]) {
    await assert.rejects(checkArtifact(await writeArtifact(t, metadata)), /metadata must match|Unexpected release.json schema/);
  }
});

test('artifact validation rejects extra files and symlinked tarballs', async (t) => {
  const localEnv = await writeArtifact(t);
  await writeFile(join(localEnv.RELEASE_DIR, 'unexpected.txt'), 'extra');
  await assert.rejects(checkArtifact(localEnv), /must contain only/);
  await rm(join(localEnv.RELEASE_DIR, 'unexpected.txt'));
  const tarball = join(localEnv.RELEASE_DIR, artifact.filename);
  await rm(tarball);
  await symlink('release.json', tarball);
  await assert.rejects(checkArtifact(localEnv), /must be a regular file/);
});

test('registry preflight allows only absent or matching versions', async () => {
  assert.deepEqual(await registryCheck(artifact, { fetchImpl: jsonFetch({}, 404) }), { already_published: 'false' });
  assert.deepEqual(await registryCheck(artifact, { fetchImpl: jsonFetch(registryDocument({ includeVersion: false, version: '1.2.5' })) }),
    { already_published: 'false' });
  assert.deepEqual(await registryCheck(artifact, { fetchImpl: jsonFetch(registryDocument()) }), { already_published: 'true' });
  await assert.rejects(registryCheck(artifact, { fetchImpl: jsonFetch(registryDocument({ dist: { integrity: 'sha512-conflicting' } })) }), /different tarball integrity/);
  await assert.rejects(registryCheck(artifact, { fetchImpl: jsonFetch(registryDocument({ dist: { shasum: '0'.repeat(40) } })) }), /different tarball integrity/);
  await assert.rejects(registryCheck(artifact, { fetchImpl: jsonFetch({ error: 'malformed successful response' }) }), /Unexpected npm registry/);
});

test('registry preflight blocks moving stable or preview tags backwards', async () => {
  await assert.rejects(registryCheck(artifact, { fetchImpl: jsonFetch(registryDocument({ version: '2.1.0' })) }), /move latest backwards/);
  const preview = { ...artifact, version: '2.1.0-rc.1', distTag: 'next' };
  await assert.rejects(registryCheck(preview, { fetchImpl: jsonFetch(registryDocument({ version: '2.1.0-rc.2', distTag: 'next', includeVersion: false })) }), /move next backwards/);
});

test('registry errors never look like an unpublished version', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(registryCheck(artifact, { fetchImpl: jsonFetch({}, status) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(registryCheck(artifact, { fetchImpl: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
  await assert.rejects(registryCheck(artifact, { fetchImpl: async () => new Response('{invalid json') }), SyntaxError);
});

test('registry requests provide bounded timeout signals and reject redirects', async () => {
  await registryCheck(artifact, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/sliver-script');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return new Response('{}', { status: 404 });
  } });
});

test('published verification downloads the artifact and checks provenance metadata', async () => {
  const urls = [];
  const result = await verifyPublished(artifact, { fetchImpl: async (url) => {
    urls.push(url);
    return url.endsWith('.tgz') ? new Response(bytes) : new Response(JSON.stringify(registryDocument()));
  } });
  assert.equal(result.integrity, artifact.integrity);
  assert.equal(result.provenance_url, provenance.url);
  assert.deepEqual(urls, ['https://registry.npmjs.org/sliver-script', `https://registry.npmjs.org/sliver-script/-/${artifact.filename}`]);
  await assert.rejects(verifyPublished(artifact, { fetchImpl: async (url) =>
    url.endsWith('.tgz') ? new Response('tampered download') : new Response(JSON.stringify(registryDocument())) }), /Downloaded npm tarball does not match/);
});

test('provenance URLs and predicate types must match npm SLSA metadata', () => {
  assert.equal(provenanceUrl(registryDocument().versions['2.0.0']), provenance.url);
  for (const attestations of [undefined, { ...provenance, url: 'https://example.com/attestations' },
    { ...provenance, url: 'https://registry.npmjs.org/other-path' },
    { ...provenance, url: `${provenance.url}?query=1` },
    { ...provenance, provenance: { predicateType: 'unknown' } }]) {
    assert.throws(() => provenanceUrl({ dist: { attestations } }), /provenance/);
  }
});

test('published verification retries propagation delays within a fixed attempt budget', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('.tgz')) return new Response(bytes);
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 404 });
    if (calls === 2) return new Response(JSON.stringify(registryDocument({ version: '1.2.5' })));
    if (calls === 3) return new Response(JSON.stringify(registryDocument({ dist: { attestations: undefined } })));
    return new Response(JSON.stringify(registryDocument()));
  };
  await verifyPublished(artifact, { attempts: 4, retryDelayMs: 10, sleep: async (ms) => sleeps.push(ms), fetchImpl });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [10, 10, 10]);
  calls = 0;
  await assert.rejects(verifyPublished(artifact, { attempts: 2, sleep: async () => {}, fetchImpl: async () => {
    calls += 1;
    throw new Error('offline');
  } }), /offline/);
  assert.equal(calls, 2);
  await assert.rejects(verifyPublished(artifact, { attempts: 2, sleep: async () => {}, fetchImpl: jsonFetch(registryDocument({ dist: { attestations: undefined } })) }),
    /provenance metadata is not visible/);
});

test('published verification rejects unexpected download URLs before fetching them', async () => {
  let calls = 0;
  await assert.rejects(verifyPublished(artifact, { fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify(registryDocument({ dist: { tarball: 'https://example.com/artifact.tgz' } })));
  } }), /tarball URL does not match/);
  assert.equal(calls, 1);
});

test('CLI exposes artifact outputs for the workflow without running npm', async (t) => {
  const localEnv = await writeArtifact(t);
  const outputDirectory = await temporaryDirectory(t);
  const output = join(outputDirectory, 'github-output');
  execFileSync(process.execPath, ['scripts/npm-release/release.mjs', 'check-artifact'], {
    env: { ...process.env, ...localEnv, GITHUB_OUTPUT: output }, encoding: 'utf8',
  });
  const text = await readFile(output, 'utf8');
  assert.match(text, /version=2\.0\.0\n/);
  assert.match(text, /dist_tag=latest\n/);
  assert.ok(text.includes(`integrity=${artifact.integrity}\n`));
});
