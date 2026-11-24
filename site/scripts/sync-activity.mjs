#!/usr/bin/env node
/** Refresh the site's public GitHub activity snapshot. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values: options } = parseArgs({ options: {
  username: { type: 'string', default: 'Eynnzerr' },
  'out-dir': { type: 'string', default: fileURLToPath(new URL('../src/data/activity/', import.meta.url)) },
} });
const outputDirectory = resolve(options['out-dir']);
const updatedAt = new Date().toISOString();

/** Run a read-only GraphQL query with the existing gh authentication; return only its data. */
async function githubQuery(query) {
  const { stdout } = await execute('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `login=${options.username}`], { maxBuffer: 8 * 1024 * 1024 });
  const response = JSON.parse(stdout);
  if (response.errors || !response.data?.user) throw new Error('GitHub contribution query failed.');
  return response.data.user;
}

/** Fetch all contribution years using GitHub's official calendar dates and daily counts. */
async function githubActivity() {
  const profile = await githubQuery('query($login: String!) { user(login: $login) { contributionsCollection { contributionYears } } }');
  const years = profile.contributionsCollection.contributionYears;
  const queries = years.map((year) => {
    const end = year === new Date(updatedAt).getUTCFullYear() ? updatedAt : `${year}-12-31T23:59:59Z`;
    return `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${end}") { contributionCalendar { weeks { contributionDays { date contributionCount } } } }`;
  });
  const calendars = await githubQuery(`query($login: String!) { user(login: $login) { ${queries.join('\n')} } }`);
  const byDate = new Map();
  for (const calendar of Object.values(calendars)) {
    for (const week of calendar.contributionCalendar.weeks) {
      for (const day of week.contributionDays) byDate.set(day.date, { date: day.date, count: day.contributionCount });
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    version: 1, kind: 'github', status: 'available', updatedAt,
    source: 'GitHub Contributions · 官方贡献日历', sourceUrl: `https://github.com/${options.username}`,
    timezone: 'GitHub contribution calendar',
    coverage: { start: days[0].date, end: days.at(-1).date },
    totals: { count: days.reduce((sum, day) => sum + day.count, 0) }, days,
  };
}

/** Persist an aggregate snapshot; keep the previous snapshot visible if its source is unavailable. */
async function sync(kind, collect) {
  const path = join(outputDirectory, `${kind}.json`);
  try {
    const snapshot = await collect();
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`${kind}: ${snapshot.days.length} days, ${snapshot.coverage.start} → ${snapshot.coverage.end}, total ${snapshot.totals.count}`);
  } catch {
    let previous;
    try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* No successful snapshot yet. */ }
    const snapshot = previous?.days?.length
      ? { ...previous, status: 'stale', lastAttemptAt: updatedAt }
      : { version: 1, kind, status: 'unavailable', updatedAt: null, lastAttemptAt: updatedAt, coverage: null, days: [], totals: { count: 0 } };
    snapshot.message = 'GitHub 贡献数据暂时无法同步。';
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.error(`${kind}: unavailable; ${previous?.days?.length ? 'kept the previous snapshot' : 'no activity invented'}.`);
    process.exitCode = 1;
  }
}

await mkdir(outputDirectory, { recursive: true });
await sync('github', githubActivity);
