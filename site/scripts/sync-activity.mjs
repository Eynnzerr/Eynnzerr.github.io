#!/usr/bin/env node
/** Refresh the site's public activity snapshots from GitHub and local Codex records. */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values: options } = parseArgs({ options: {
  'github-only': { type: 'boolean', default: false },
  'codex-only': { type: 'boolean', default: false },
  username: { type: 'string', default: 'Eynnzerr' },
  'codex-home': { type: 'string', default: process.env.CODEX_HOME || join(homedir(), '.codex') },
  'out-dir': { type: 'string', default: fileURLToPath(new URL('../src/data/activity/', import.meta.url)) },
} });
const outputDirectory = resolve(options['out-dir']);
const updatedAt = new Date().toISOString();
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const tokenFields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'];

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

/** Enumerate existing JSONL records without following symlinks or reading other Codex files. */
async function sessionFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await sessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(path);
  }
  return paths.sort();
}

/** Read usage numbers only; keep conversation content and record identifiers out of the snapshot. */
async function codexActivity() {
  const files = [...await sessionFiles(join(options['codex-home'], 'sessions')), ...await sessionFiles(join(options['codex-home'], 'archived_sessions'))];
  const streams = new Map();
  const seen = new Set();
  let duplicateEvents = 0;
  let invalidRecords = 0;

  for (const file of files) {
    // Agent rollouts can inherit their parent's session_meta.id. The filename identifies
    // their actual stream; resumed main rollouts keep that ID before the optional suffix.
    const streamId = basename(file).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
    if (!streamId) continue;
    const stream = streams.get(streamId) || [];
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { invalidRecords += 1; continue; }
      const payload = record.payload;
      if (record.type !== 'event_msg' || payload?.type !== 'token_count') continue;
      const total = payload.info?.total_token_usage;
      const last = payload.info?.last_token_usage;
      if (!total || !last || !Number.isFinite(Date.parse(record.timestamp))) continue;
      const event = { timestamp: record.timestamp, total, last };
      const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      if (seen.has(fingerprint)) { duplicateEvents += 1; continue; }
      seen.add(fingerprint);
      stream.push(event);
    }
    if (stream.length) streams.set(streamId, stream);
  }

  const byDate = new Map();
  let resetCount = 0;
  let missingBaselines = 0;
  let countedEvents = 0;
  let repeatedTotals = 0;
  for (const events of streams.values()) {
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let previous;
    for (const event of events) {
      const { total, last } = event;
      if (previous && total.total_tokens === previous.total_tokens) { repeatedTotals += 1; continue; }
      const reset = previous && total.total_tokens < previous.total_tokens;
      if (reset) resetCount += 1;
      // A missing first baseline carries history that cannot be assigned to this date.
      // Count the observed completion only; normal continuations use cumulative deltas.
      if (!previous && total.total_tokens !== last.total_tokens) missingBaselines += 1;
      const delta = Object.fromEntries(tokenFields.map((field) => [field,
        previous && !reset ? Math.max(0, (total[field] || 0) - (previous[field] || 0)) : (last[field] || 0),
      ]));
      previous = total;
      const date = localDate.format(new Date(event.timestamp));
      const day = byDate.get(date) || { date, count: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0 };
      day.input += delta.input_tokens;
      day.output += delta.output_tokens;
      day.cachedInput += delta.cached_input_tokens;
      day.reasoningOutput += delta.reasoning_output_tokens;
      // Cached input and reasoning output are subsets, not additional tokens.
      day.count = day.input + day.output;
      byDate.set(date, day);
      countedEvents += 1;
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) throw new Error('No local Codex usage records found.');
  const totals = days.reduce((sum, day) => {
    for (const key of ['count', 'input', 'output', 'cachedInput', 'reasoningOutput']) sum[key] += day[key];
    return sum;
  }, { count: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0 });
  return {
    version: 1, kind: 'codex', status: 'available', updatedAt,
    source: '本机 Codex 会话记录', sourceUrl: null, timezone: 'Asia/Shanghai',
    coverage: { start: days[0].date, end: localDate.format(new Date(updatedAt)) },
    totals, days,
    statistics: { files: files.length, streams: streams.size, countedEvents, duplicateEvents, repeatedTotals, resetCount, missingBaselines, invalidRecords },
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
    snapshot.message = kind === 'github' ? 'GitHub 贡献数据暂时无法同步。' : '本机 Codex 使用记录暂时无法读取。';
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.error(`${kind}: unavailable; ${previous?.days?.length ? 'kept the previous snapshot' : 'no activity invented'}.`);
    process.exitCode = 1;
  }
}

if (options['github-only'] && options['codex-only']) throw new Error('Choose at most one source flag.');
await mkdir(outputDirectory, { recursive: true });
if (!options['codex-only']) await sync('github', githubActivity);
if (!options['github-only']) await sync('codex', codexActivity);
