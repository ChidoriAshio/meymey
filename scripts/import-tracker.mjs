// Turns a Mayhem Tracker database (https://github.com/Yhprum/mayhem-tracker, matches.db) into
// per-champion augment pick counts at src/data/champion-augments.json.
//
//   node scripts/import-tracker.mjs path/to/matches.db [more.db ...]
//
// Only counts leave this script: no player names, puuids or win/loss. Games are deduplicated by
// game id across every database given and every earlier import, so the same games uploaded twice
// (or by two people who played together) are counted once.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAYHEM_QUEUE = 2400;
const OUT = new URL('../src/data/champion-augments.json', import.meta.url);

const dbPaths = process.argv.slice(2);
if (dbPaths.length === 0) {
  console.error('usage: node scripts/import-tracker.mjs matches.db [more.db ...]');
  process.exit(1);
}

const champions = JSON.parse(readFileSync(new URL('../src/data/champions.json', import.meta.url)));
const augments = JSON.parse(readFileSync(new URL('../src/data/augments.json', import.meta.url)));
const champByKey = new Map(champions.map((c) => [Number(c.key), c.slug]));
const augByPlatformId = new Map(augments.map((a) => [a.platformId, a.slug]));

// Earlier imports, so new uploads add to them. Game ids are stored hashed: they are only needed
// for deduplication.
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT)) : { games: [], picks: [] };
const seen = new Set(prev.games);
// [gameHash, championSlug, augmentSlug] for every pick, kept so totals can be recounted.
const picks = prev.picks;
const participants = prev.participants ?? [];

const hash = (gameId) => createHash('sha256').update(`meymey:${gameId}`).digest('hex').slice(0, 16);

let added = 0;
for (const path of dbPaths) {
  const db = new DatabaseSync(path, { readOnly: true });
  const games = db
    .prepare('SELECT game_id FROM games WHERE queue_id = ? AND is_remake = 0')
    .all(MAYHEM_QUEUE)
    .map((g) => g.game_id);
  const partStmt = db.prepare('SELECT participant_id, champion_id FROM match_participants WHERE game_id = ?');
  const augStmt = db.prepare('SELECT participant_id, augment_id FROM match_participant_augments WHERE game_id = ?');
  for (const gameId of games) {
    const h = hash(gameId);
    if (seen.has(h)) continue;
    seen.add(h);
    added++;
    const champOf = new Map();
    for (const p of partStmt.all(gameId)) {
      const slug = champByKey.get(p.champion_id);
      if (!slug) continue;
      champOf.set(p.participant_id, slug);
      participants.push([h, slug]);
    }
    for (const a of augStmt.all(gameId)) {
      const champ = champOf.get(a.participant_id);
      const aug = augByPlatformId.get(a.augment_id);
      if (champ && aug) picks.push([h, champ, aug]);
    }
  }
  db.close();
}

writeFileSync(
  OUT,
  JSON.stringify({ updatedAt: new Date().toISOString(), games: [...seen], participants, picks }) + '\n',
);
console.log(`added ${added} games (total ${seen.size}, ${participants.length} champion plays, ${picks.length} augment picks)`);
