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
  'codex-home': { type: 'string', default: process.env.CODEX_HOME || join(homedir(), '.codex') },
  'work-dir': { type: 'string', default: join(homedir(), 'Library/Application Support/Eynnzerr/activity-sync') },
} });
assert.ok(!(options.publish && options['dry-run']), 'Choose --publish or --dry-run.');
assert.ok(!options['data-only'] || options.publish, '--data-only requires --publish.');

const repository = 'Eynnzerr/Eynnzerr.github.io';
const remote = `git@github.com:${repository}.git`;
const branch = 'site-activity';
const snapshotFiles = ['codex.json', 'github.json'];
const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const syncScript = fileURLToPath(new URL('./sync-activity.mjs', import.meta.url));

/** Run a subprocess without a shell, preserving useful errors without logging credentials. */
async function run(command, args, cwd) {
  return execute(command, args, { cwd, env: environment, maxBuffer: 8 * 1024 * 1024 });
}

await mkdir(options['work-dir'], { recursive: true });
const checkout = await mkdtemp(join(options['work-dir'], 'run-'));
console.log(`Activity checkout: ${checkout}`);

/** Run Git solely inside the dedicated checkout, never in the source repository. */
async function git(...args) {
  return run('git', args, checkout);
}

try {
  await git('init', '--initial-branch', branch);
  await git('remote', 'add', 'origin', remote);
  // A missing data branch is the first-run case; authentication failures still stop the run.
  const { stdout: remoteRef } = await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  if (remoteRef.trim()) {
    await git('fetch', '--depth=1', 'origin', branch);
    await git('checkout', '-B', branch, 'FETCH_HEAD');
    const { stdout: tracked } = await git('ls-files');
    assert.deepEqual(tracked.trim().split('\n').sort(), snapshotFiles, 'The data branch must contain only the two activity JSON files.');
  }

  const { stdout } = await run(process.execPath, [syncScript, '--out-dir', checkout, '--codex-home', options['codex-home']]);
  process.stdout.write(stdout);
  for (const name of snapshotFiles) {
    const snapshot = JSON.parse(await readFile(join(checkout, name), 'utf8'));
    assert.equal(snapshot.kind, name.replace('.json', ''), `${name}: expected source`);
    assert.equal(snapshot.status, 'available', `${name}: successful collection required`);
    assert.ok(snapshot.days.length > 0, `${name}: daily aggregates required`);
  }
  await git('add', '--', ...snapshotFiles);
  const { stdout: diff } = await git('diff', '--cached', '--stat');
  console.log(diff.trim() || 'No activity changes.');

  if (!options.publish) {
    console.log(`Dry run ready. Review with: git -C "${checkout}" diff --cached`);
    console.log('No push or workflow dispatch was requested.');
  } else {
    // Keep the branch history limited to aggregates, including its first commit.
    if (diff.trim()) await git('commit', '-m', `Update daily activity ${new Date().toISOString().slice(0, 10)}`);
    await git('push', 'origin', `HEAD:refs/heads/${branch}`);
    console.log(`Published the two snapshots to ${repository}:${branch}.`);
    if (!options['data-only']) {
      // An orphan data branch has no workflow file. Dispatch the source workflow explicitly.
      await run('gh', ['workflow', 'run', 'site-pages.yml', '--repo', repository, '--ref', 'master', '-f', 'publish=true']);
      console.log('Requested site-pages.yml; SITE_PUBLISH_ENABLED controls deployment.');
    }
    await rm(checkout, { recursive: true });
  }
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  console.error(`Inspect the retained checkout: ${checkout}`);
  process.exitCode = 1;
}
