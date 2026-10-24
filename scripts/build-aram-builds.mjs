// Turns the raw ARAM counts from collect-aram.mjs into item builds per champion at
// src/data/aram-builds.json.
//
//   node scripts/build-aram-builds.mjs <state-dir>
//
// A build is a core of three legendary items; a champion gets up to MAX_BUILDS cores that differ
// by at least two items, each with how often it was built and its win rate, the items most often
// added on top of it, and the usual boots.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MAX_BUILDS = 3;
const MIN_CHAMP_GAMES = 20;
const MIN_BUILD_GAMES = 8;
const MIN_BUILD_SHARE = 0.03;

const ROOT = path.resolve(import.meta.dirname, '..');
const stateDir = process.argv[2];
const OUT = path.join(ROOT, 'src/data/aram-builds.json');
const countsPath = stateDir && path.join(stateDir, 'counts.json');
if (!countsPath || !existsSync(countsPath)) {
  console.warn('No ARAM counts yet; keeping the current builds file.');
  process.exit(0);
}
const counts = JSON.parse(await readFile(countsPath, 'utf8'));
const state = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'));
const champions = JSON.parse(await readFile(path.join(ROOT, 'src/data/champions.json'), 'utf8'));
const items = JSON.parse(await readFile(path.join(ROOT, 'src/data/items.json'), 'utf8'));
const itemById = new Map(items.map((i) => [i.id, i]));
const slugByKey = new Map(champions.map((c) => [c.key, c.slug]));

// A name for the build from what its core items give, like the game's item categories.
function archetype(core) {
  const tags = core.flatMap((id) => itemById.get(id)?.tags ?? []);
  const n = (t) => tags.filter((x) => x === t).length;
  if (n('CriticalStrike') >= 2) return 'クリティカル型';
  if (n('OnHit') >= 2 || (n('AttackSpeed') >= 2 && n('CriticalStrike') === 0)) return 'オンヒット型';
  if (n('SpellDamage') >= 2) {
    if (n('Health') + n('Armor') + n('SpellBlock') >= 3) return 'AP耐久型';
    return '魔力型';
  }
  if (n('Armor') + n('SpellBlock') + n('Health') >= 4) return 'タンク型';
  if (n('ArmorPenetration') >= 2) return '物理防御貫通型';
  if (n('Damage') >= 2 && n('Health') >= 2) return 'ブルーザー型';
  if (n('Damage') >= 2) return '物理型';
  return 'ビルド';
}

const triples = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) for (let k = j + 1; k < arr.length; k++) out.push([arr[i], arr[j], arr[k]]);
  return out;
};

const result = {};
for (const [key, rows] of Object.entries(counts)) {
  const slug = slugByKey.get(key);
  if (!slug) continue;
  const parsed = Object.entries(rows).map(([k, [games, wins]]) => {
    const [leg, boots] = k.split('|');
    return { legendary: leg ? leg.split(',') : [], boots, games, wins };
  });
  const total = parsed.reduce((s, r) => s + r.games, 0);
  if (total < MIN_CHAMP_GAMES) continue;

  const support = new Map();
  for (const r of parsed) {
    for (const t of triples(r.legendary)) {
      const k = t.join(',');
      const s = support.get(k) ?? { core: t, games: 0, wins: 0 };
      s.games += r.games;
      s.wins += r.wins;
      support.set(k, s);
    }
  }
  const ranked = [...support.values()].sort((a, b) => b.games - a.games);
  // Different types first (crit vs on-hit, say), then more of the same type if there's room.
  const eligible = ranked.filter((s) => s.games >= MIN_BUILD_GAMES && s.games / total >= MIN_BUILD_SHARE);
  const chosen = [];
  for (const sameTypeOk of [false, true]) {
    for (const s of eligible) {
      if (chosen.length >= MAX_BUILDS) break;
      if (chosen.includes(s)) continue;
      if (chosen.some((c) => c.core.filter((id) => s.core.includes(id)).length > 1)) continue;
      if (!sameTypeOk && chosen.some((c) => archetype(c.core) === archetype(s.core))) continue;
      chosen.push(s);
    }
  }
  chosen.sort((a, b) => b.games - a.games);

  const builds = chosen.map((s) => {
    const extra = new Map();
    for (const r of parsed) {
      if (!s.core.every((id) => r.legendary.includes(id))) continue;
      for (const id of r.legendary) {
        if (s.core.includes(id)) continue;
        const e = extra.get(id) ?? { id, games: 0, wins: 0 };
        e.games += r.games;
        e.wins += r.wins;
        extra.set(id, e);
      }
    }
    // Most-bought first; the core order follows each item's popularity across the champion.
    return {
      name: archetype(s.core),
      core: s.core,
      games: s.games,
      wins: s.wins,
      situational: [...extra.values()].sort((a, b) => b.games - a.games).slice(0, 5),
    };
  });
  // Two builds of the same type get numbered.
  const seenNames = new Map();
  for (const b of builds) {
    const n = (seenNames.get(b.name) ?? 0) + 1;
    seenNames.set(b.name, n);
    if (n > 1) b.name = `${b.name} ${n}`;
  }

  const bootsCount = new Map();
  for (const r of parsed) if (r.boots) bootsCount.set(r.boots, (bootsCount.get(r.boots) ?? 0) + r.games);
  const boots = [...bootsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, games]) => ({ id, games }));

  result[slug] = { games: total, builds, boots };
}

await writeFile(
  OUT,
  JSON.stringify({ gameVersion: state.gameVersion, startedAt: state.startedAt, matches: state.matches, champions: result }) + '\n',
);
console.log(`Builds for ${Object.keys(result).length} champions from ${state.matches} ARAM matches (${state.gameVersion})`);
