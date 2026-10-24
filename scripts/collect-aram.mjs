// Collects normal ARAM (queue 450) games from the Riot API for item build stats.
// Mayhem games aren't served by the API, and ARAM is the same map and all-mid play, so its builds
// are the closest public stand-in.
//
//   RIOT_API_KEY=RGAPI-... node scripts/collect-aram.mjs <state-dir>
//
// <state-dir> holds the raw counts between runs (the aram-data branch in CI):
//   state.json   patch, match ids already counted and players recently visited (both hashed)
//   counts.json  per champion: final legendary items + boots -> [games, wins]
// Only champion, final items and win/loss are kept, and players are stored only as hashes, so the
// files can sit in a public repository. The list of players to visit lives in memory per run.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Pasted keys sometimes carry a trailing newline or quotes.
const KEY = process.env.RIOT_API_KEY?.trim().replace(/^['"]|['"]$/g, '');
const PLATFORM = process.env.RIOT_PLATFORM ?? 'jp1';
const REGION = process.env.RIOT_REGION ?? 'asia';
const MAX_MINUTES = Number(process.env.MAX_MINUTES ?? 50);
const QUEUE_ARAM = 450;
// A development key allows 100 requests per 2 minutes; stay just under it.
const MIN_GAP_MS = Number(process.env.RIOT_MIN_GAP_MS ?? 1250);

const stateDir = process.argv[2];
if (!stateDir) {
  console.error('usage: node scripts/collect-aram.mjs <state-dir>');
  process.exit(1);
}
if (KEY && !KEY.startsWith('RGAPI-')) console.warn(`RIOT_API_KEY doesn't look like a Riot key (starts with ${JSON.stringify(KEY.slice(0, 3))}, length ${KEY.length}).`);
if (!KEY) {
  console.warn('RIOT_API_KEY is not set; nothing collected.');
  process.exit(0);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const meta = JSON.parse(await readFile(path.join(ROOT, 'src/data/meta.json'), 'utf8'));
// Data Dragon "16.21.1" -> match gameVersion "16.21.xxx"
const gameVersion = meta.gameVersion.split('.').slice(0, 2).join('.');

await mkdir(stateDir, { recursive: true });
const statePath = path.join(stateDir, 'state.json');
const countsPath = path.join(stateDir, 'counts.json');
const load = async (p, fallback) => (existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : fallback);
let state = await load(statePath, null);
let counts = await load(countsPath, {});
if (!state || state.gameVersion !== gameVersion) {
  // New patch: builds change, so start over.
  console.log(`Starting fresh for ${gameVersion}`);
  state = { gameVersion, startedAt: new Date().toISOString(), matches: 0, visited: {}, seen: [] };
  counts = {};
}
const seen = new Set(state.seen);
// Players are looked at again after a few days, for their newer games.
const today = Math.floor(Date.now() / 86400000);
const REVISIT_DAYS = 3;
const visited = new Map(Object.entries(state.visited).filter(([, day]) => today - day < REVISIT_DAYS));
const queue = [];
const hash = (s) => createHash('sha256').update(`meymey:${s}`).digest('hex').slice(0, 12);

class StopError extends Error {}
let last = 0;
async function riot(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get('retry-after') ?? 10);
      await new Promise((r) => setTimeout(r, retry * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      throw new StopError(`API key rejected (${res.status} ${body.slice(0, 120)}); it may have expired.`);
    }
    if (res.status === 404) return null;
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up on ${url}`);
}

const items = JSON.parse(await readFile(path.join(ROOT, 'src/data/items.json'), 'utf8'));
const itemById = new Map(items.map((i) => [Number(i.id), i]));
const isBoots = (i) => i.tags.includes('Boots');
const isLegendary = (i) => i.finished && !isBoots(i) && i.gold >= 2000;

function addMatch(m) {
  for (const p of m.info.participants) {
    const champ = String(p.championId);
    const owned = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map((id) => itemById.get(id)).filter(Boolean);
    const legendary = [...new Set(owned.filter(isLegendary).map((i) => i.id))].sort();
    const boots = owned.find(isBoots)?.id ?? '';
    const key = `${legendary.join(',')}|${boots}`;
    const c = (counts[champ] ??= {});
    const row = (c[key] ??= [0, 0]);
    row[0]++;
    if (p.win) row[1]++;
  }
}

const deadline = Date.now() + MAX_MINUTES * 60_000;
const save = async () => {
  state.seen = [...seen];
  state.visited = Object.fromEntries(visited);
  await writeFile(statePath, JSON.stringify(state) + '\n');
  await writeFile(countsPath, JSON.stringify(counts) + '\n');
};

let added = 0;
try {
  // Seed with Japan's top ranked players; their ARAM games lead to everyone else.
  for (const tier of ['challengerleagues', 'grandmasterleagues', 'masterleagues']) {
    const league = await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/${tier}/by-queue/RANKED_SOLO_5x5`);
    for (const e of league?.entries ?? []) if (e.puuid) queue.push(e.puuid);
  }
  console.log(`Seeded ${queue.length} players`);
  const since = Math.floor(Date.now() / 1000) - 14 * 86400;
  while (Date.now() < deadline && queue.length) {
    // Players met in games first (breadth), seeds after.
    const puuid = queue.pop();
    const ph = hash(puuid);
    if (visited.has(ph)) continue;
    visited.set(ph, today);
    const ids = (await riot(
      `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${QUEUE_ARAM}&startTime=${since}&count=20`,
    )) ?? [];
    for (const id of ids) {
      if (Date.now() >= deadline) break;
      const h = hash(id);
      if (seen.has(h)) continue;
      const m = await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}`);
      seen.add(h);
      if (!m || m.info.queueId !== QUEUE_ARAM || !m.info.gameVersion.startsWith(`${gameVersion}.`)) continue;
      if (m.info.gameDuration < 300) continue; // remakes
      addMatch(m);
      added++;
      state.matches++;
      for (const p of m.info.participants) if (!visited.has(hash(p.puuid)) && queue.length < 20000) queue.push(p.puuid);
      if (added % 100 === 0) {
        await save();
        console.log(`${added} matches this run (${state.matches} for ${gameVersion})`);
      }
    }
  }
} catch (e) {
  if (!(e instanceof StopError)) {
    await save();
    throw e;
  }
  console.warn(e.message);
}
await save();
console.log(`Done: ${added} matches this run, ${state.matches} for ${gameVersion}`);
