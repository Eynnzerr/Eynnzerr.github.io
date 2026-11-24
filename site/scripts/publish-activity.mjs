#!/usr/bin/env node
/** Prepare daily activity in an isolated checkout; publish only with --publish. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values: options } = parseArgs({ options: {
  'dry-run': { type: 'boolean', default: false },
  publish: { type: 'boolean', default: false },
  'data-only': { type: 'boolean', default: false },
  'work-dir': { type: 'string', default: join(homedir(), 'Library/Application Support/Eynnzerr/activity-sync') },
} });
assert.ok(!(options.publish && options['dry-run']), 'Choose --publish or --dry-run.');
assert.ok(!options['data-only'] || options.publish, '--data-only requires --publish.');

const repository = 'Eynnzerr/Eynnzerr.github.io';
const remote = `git@github.com:${repository}.git`;
const branch = 'site-activity';
const snapshotFiles = ['github.json'];
// No longer collected. The file stays on the data branch until it is removed deliberately,
// because deployed workflows that still copy it must keep working in the meantime.
const retiredFiles = ['codex.json'];
// ConnectTimeout turns a silent network into a prompt failure that the retries below can handle.
const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=30' };
/** Pauses between attempts, in seconds (about 15 minutes in total). launchd often starts this job right after
 * the Mac wakes, before Wi-Fi or the local proxy is ready; most failed runs were that window. */
const retryDelays = [30, 60, 120, 240, 480];
const syncScript = fileURLToPath(new URL('./sync-activity.mjs', import.meta.url));

/** Run a subprocess without a shell, preserving useful errors without logging credentials. */
async function run(command, args, cwd) {
  return execute(command, args, { cwd, env: environment, maxBuffer: 8 * 1024 * 1024 });
}

await mkdir(options['work-dir'], { recursive: true });
const checkout = await mkdtemp(join(options['work-dir'], 'run-'));
console.log(`Activity checkout: ${checkout}`);

/** Repeat a network step with growing pauses, rethrowing the last failure. */
async function withRetries(label, task) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= retryDelays.length) throw error;
      const reason = (error.stderr || error.message || String(error)).trim().split('\n').at(-1);
      console.error(`${label} failed (attempt ${attempt + 1}): ${reason}. Retrying in ${retryDelays[attempt]}s.`);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt] * 1000));
    }
  }
}

/** Run Git solely inside the dedicated checkout, never in the source repository. */
async function git(...args) {
  return run('git', args, checkout);
}

try {
  await git('init', '--initial-branch', branch);
  await git('remote', 'add', 'origin', remote);
  // A missing data branch is the first-run case; authentication failures still stop the run.
  const { stdout: remoteRef } = await withRetries('Reading the data branch', () => git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`));
  if (remoteRef.trim()) {
    await withRetries('Fetching the data branch', () => git('fetch', '--depth=1', 'origin', branch));
    await git('checkout', '-B', branch, 'FETCH_HEAD');
    const { stdout: tracked } = await git('ls-files');
    const unexpected = tracked.trim().split('\n').filter((name) => ![...snapshotFiles, ...retiredFiles].includes(name));
    assert.deepEqual(unexpected, [], 'The data branch must contain only activity JSON files.');
  }

  // The sync script reports an unreachable GitHub API by exiting non-zero, so collection retries as a whole.
  await withRetries('Collecting GitHub activity', async () => {
    const { stdout } = await run(process.execPath, [syncScript, '--out-dir', checkout]);
    process.stdout.write(stdout);
    for (const name of snapshotFiles) {
      const snapshot = JSON.parse(await readFile(join(checkout, name), 'utf8'));
      assert.equal(snapshot.kind, name.replace('.json', ''), `${name}: expected source`);
      assert.equal(snapshot.status, 'available', `${name}: successful collection required`);
      assert.ok(snapshot.days.length > 0, `${name}: daily aggregates required`);
    }
  });
  await git('add', '--', ...snapshotFiles);
  const { stdout: diff } = await git('diff', '--cached', '--stat');
  console.log(diff.trim() || 'No activity changes.');

  if (!options.publish) {
    console.log(`Dry run ready. Review with: git -C "${checkout}" diff --cached`);
    console.log('No push or workflow dispatch was requested.');
  } else {
    // Keep the branch history limited to aggregates, including its first commit.
    if (diff.trim()) await git('commit', '-m', `Update daily activity ${new Date().toISOString().slice(0, 10)}`);
    await withRetries('Pushing the data branch', () => git('push', 'origin', `HEAD:refs/heads/${branch}`));
    console.log(`Published the activity snapshot to ${repository}:${branch}.`);
    if (!options['data-only']) {
      // An orphan data branch has no workflow file. Dispatch the source workflow explicitly.
      await withRetries('Requesting the site build', () => run('gh', ['workflow', 'run', 'site-pages.yml', '--repo', repository, '--ref', 'master', '-f', 'publish=true']));
      console.log('Requested site-pages.yml; SITE_PUBLISH_ENABLED controls deployment.');
    }
    await rm(checkout, { recursive: true });
  }
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  console.error(`Inspect the retained checkout: ${checkout}`);
  process.exitCode = 1;
}
