import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'astro/zod';
import championsJson from '../data/champions.json';
import augmentsJson from '../data/augments.json';
import itemsJson from '../data/items.json';
import metaJson from '../data/meta.json';
import trackerJson from '../data/champion-augments.json';

export type Rarity = 'silver' | 'gold' | 'prismatic';

export interface Champion {
  id: string;
  key: string;
  slug: string;
  name: string;
  title: string;
  tags: string[];
  info: { attack: number; defense: number; magic: number; difficulty: number };
  icon: string;
  pickRate: number | null;
  pickRateRank: number | null;
  pickRateChange: number | null;
  combos: { god: number; strong: number };
}

export interface Augment {
  id: string;
  platformId: number;
  slug: string;
  name: string;
  nameEn: string | null;
  rarity: Rarity;
  description: string;
  icon: string | null;
  pickRate: number | null;
  pickRateRank: number | null;
  pickRateChange: number | null;
  introducedPatch: string | null;
}

export interface Item {
  id: string;
  name: string;
  plaintext: string;
  gold: number;
  tags: string[];
  finished: boolean;
  icon: string;
}

export const champions = championsJson as Champion[];
export const augments = augmentsJson as Augment[];
export const items = itemsJson as Item[];
export const meta = metaJson;

export const augmentBySlug = new Map(augments.map((a) => [a.slug, a]));
export const itemById = new Map(items.map((i) => [i.id, i]));

export const RARITY_LABEL: Record<Rarity, string> = {
  silver: 'シルバー',
  gold: 'ゴールド',
  prismatic: 'プリズマティック',
};

export const ROLE_LABEL: Record<string, string> = {
  Assassin: 'アサシン',
  Fighter: 'ファイター',
  Mage: 'メイジ',
  Marksman: 'マークスマン',
  Support: 'サポート',
  Tank: 'タンク',
};

export const TIERS = ['S', 'A', 'B', 'C', 'D'] as const;
export type Tier = (typeof TIERS)[number];

export interface Build {
  tier?: Tier;
  augments: Augment[];
  items: Item[];
  note?: string;
}

// Hand-written picks per champion. Edit src/data/builds.yaml to change tiers and recommendations.
const buildsSchema = z.record(
  z.string(),
  z.object({
    tier: z.enum(TIERS).optional(),
    augments: z.array(z.string()).default([]),
    items: z.array(z.coerce.string()).default([]),
    note: z.string().optional(),
  }),
);

let buildsCache: Promise<Map<string, Build>> | undefined;

// Joins builds.yaml to the game data. Unknown slugs/ids are dropped with a build warning.
export function getBuilds(): Promise<Map<string, Build>> {
  return (buildsCache ??= loadBuilds());
}

async function loadBuilds(): Promise<Map<string, Build>> {
  const text = await readFile(path.join(process.cwd(), 'src/data/builds.yaml'), 'utf8');
  const parsed = buildsSchema.safeParse(parse(text) ?? {});
  if (!parsed.success) throw new Error(`src/data/builds.yaml is invalid:\n${parsed.error.message}`);
  const out = new Map<string, Build>();
  for (const [id, data] of Object.entries(parsed.data)) {
    if (!champions.some((c) => c.slug === id)) console.warn(`[builds.yaml] unknown champion "${id}"`);
    const resolve = <T,>(keys: string[], map: Map<string, T>, kind: string) =>
      keys.flatMap((k) => {
        const v = map.get(k);
        if (!v) console.warn(`[builds.yaml] ${id}: unknown ${kind} "${k}"`);
        return v ? [v] : [];
      });
    out.set(id, {
      tier: data.tier,
      augments: resolve(data.augments, augmentBySlug, 'augment'),
      items: resolve(data.items, itemById, 'item'),
      note: data.note,
    });
  }
  return out;
}

// "注目度" tier: how much players are picking a champion right now, from public data only.
// It is not a strength (win-rate) ranking. Weights and cutoffs are deliberately simple to tweak.
export const BUZZ_WEIGHTS = { pickRate: 0.6, pickRateChange: 0.2, combos: 0.2 };
const BUZZ_CUTOFFS: [Tier, number][] = [
  ['S', 0.1],
  ['A', 0.3],
  ['B', 0.65],
  ['C', 0.85],
  ['D', 1],
];

// Share of champions with a lower value (0 = lowest, 1 = highest); ties share the same rank.
function percentile(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => (sorted.length < 2 ? 0.5 : sorted.findIndex((x) => x >= v) / (sorted.length - 1));
}

const rated = champions.filter((c) => c.pickRate != null);
const comboScore = (c: Champion) => c.combos.god * 2 + c.combos.strong;
const pPick = percentile(rated.map((c) => c.pickRate!));
const pChange = percentile(rated.map((c) => c.pickRateChange ?? 0));
const pCombo = percentile(rated.map(comboScore));

export const buzzByChampion = new Map<string, { score: number; tier: Tier }>(
  rated
    .map((c) => ({
      slug: c.slug,
      score:
        BUZZ_WEIGHTS.pickRate * pPick(c.pickRate!) +
        BUZZ_WEIGHTS.pickRateChange * pChange(c.pickRateChange ?? 0) +
        BUZZ_WEIGHTS.combos * pCombo(comboScore(c)),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ slug, score }, i, all) => {
      const rank = (i + 1) / all.length;
      const tier = BUZZ_CUTOFFS.find(([, cut]) => rank <= cut)![0];
      return [slug, { score, tier }] as const;
    }),
);

// The tier shown for a champion: a hand-written tier in builds.yaml wins over the 注目度 tier.
export function tierOf(c: Champion, builds: Map<string, Build>): { tier: Tier; manual: boolean } | undefined {
  const manual = builds.get(c.slug)?.tier;
  if (manual) return { tier: manual, manual: true };
  const buzz = buzzByChampion.get(c.slug);
  return buzz && { tier: buzz.tier, manual: false };
}

// ---------- Augment fit (automatic, keyword based) ----------
//
// Each augment gets a set of traits read from its description (Japanese text and Riot's
// tooltip classes); each champion type weighs those traits. The result is a rough guide.

type Trait = 'ap' | 'ad' | 'attack' | 'crit' | 'ability' | 'tank' | 'ally' | 'sustain' | 'mobility' | 'noAttack';

const TRAIT_PATTERNS: Record<Trait, RegExp> = {
  ap: /魔力|tt-scaleap/,
  ad: /攻撃力|tt-scalead/,
  attack: /通常攻撃|攻撃速度/,
  crit: /クリティカル/,
  ability: /スキルヘイスト|スキルダメージ|スキル使用|スキルを使用|スキルのクールダウン|アルティメット/,
  // "敵の最大体力の…" and "物理防御貫通" are damage, not tankiness.
  tank: /自身の最大体力|最大体力が|最大体力を|物理防御(?!貫通)|魔法防御(?!貫通)|クリティカル防御|tt-scalehealth|tt-scalearmor|tt-scalemr/,
  ally: /味方/,
  sustain: /回復|ライフスティール|オムニヴァンプ|tt-healing|tt-lifesteal/,
  mobility: /移動速度|ダッシュ|tt-speed/,
  // Trades basic-attack power away, e.g. attack speed converted to ability haste.
  noAttack: /攻撃速度.{0,20}(スキルヘイスト|魔力)に変換/,
};

const augmentTraits = new Map<string, Set<Trait>>(
  augments.map((a) => [
    a.slug,
    new Set(
      (Object.keys(TRAIT_PATTERNS) as Trait[]).filter(
        (t) => TRAIT_PATTERNS[t].test(a.description) && !(t === 'attack' && TRAIT_PATTERNS.noAttack.test(a.description)),
      ),
    ),
  ]),
);

type Weights = Partial<Record<Trait, number>>;
const ROLE_WEIGHTS: Record<string, { ad: Weights; ap: Weights }> = {
  Mage: {
    ap: { ap: 2, ability: 1.5, ad: -2, attack: -1.5, crit: -2, tank: -0.5, noAttack: 1 },
    ad: { ap: 2, ability: 1.5, ad: -2, attack: -1.5, crit: -2, tank: -0.5, noAttack: 1 },
  },
  Marksman: {
    ad: { attack: 2, crit: 2, ad: 1.5, ap: -2, tank: -1.5, ally: -0.5, noAttack: -3 },
    ap: { attack: 1.5, ap: 1.5, ability: 0.5, crit: -1, ad: -1, tank: -1, noAttack: -3 },
  },
  Fighter: {
    ad: { ad: 1.5, tank: 1, sustain: 1, attack: 0.5, ability: 0.5, ap: -2 },
    ap: { ap: 1.5, tank: 1, sustain: 1, ability: 0.5, ad: -1.5, crit: -2 },
  },
  Assassin: {
    ad: { ad: 2, ability: 1, mobility: 1, ap: -2, tank: -0.5, ally: -0.5 },
    ap: { ap: 2, ability: 1, mobility: 1, ad: -2, crit: -2, tank: -0.5, ally: -0.5 },
  },
  Tank: {
    ad: { tank: 2, ally: 0.5, ability: 0.5, sustain: 0.5, ap: -0.5, crit: -2, attack: -0.5 },
    ap: { tank: 2, ally: 0.5, ability: 0.5, sustain: 0.5, ad: -1, crit: -2, attack: -0.5 },
  },
  Support: {
    ad: { ally: 2, ability: 1, ap: 0.5, tank: 0.3, crit: -1.5 },
    ap: { ally: 2, ap: 1, ability: 1, tank: 0.3, ad: -2, crit: -2, attack: -1 },
  },
};

function championWeights(c: Champion): Weights {
  const dmg = c.info.magic > c.info.attack ? 'ap' : 'ad';
  const out: Weights = {};
  c.tags.slice(0, 2).forEach((tag, i) => {
    for (const [t, w] of Object.entries(ROLE_WEIGHTS[tag]?.[dmg] ?? {}) as [Trait, number][]) {
      out[t] = (out[t] ?? 0) + w * (i === 0 ? 1 : 0.5);
    }
  });
  return out;
}

// Per-champion augment picks from Mayhem Tracker uploads (scripts/import-tracker.mjs).
const tracker = trackerJson as { updatedAt: string | null; games: string[]; participants: [string, string][]; picks: [string, string, string][] };
export const trackerGames = tracker.games.length;
export const trackerUpdatedAt = tracker.updatedAt;
const trackerPlays = new Map<string, number>();
for (const [, champ] of tracker.participants) trackerPlays.set(champ, (trackerPlays.get(champ) ?? 0) + 1);
const trackerPicks = new Map<string, Map<string, number>>();
for (const [, champ, aug] of tracker.picks) {
  const m = trackerPicks.get(champ) ?? new Map<string, number>();
  m.set(aug, (m.get(aug) ?? 0) + 1);
  trackerPicks.set(champ, m);
}

export function championPlays(c: Champion) {
  return trackerPlays.get(c.slug) ?? 0;
}

// Share of this champion's tracked games in which the augment was taken, or null without data.
export function championPickShare(c: Champion, a: Augment): number | null {
  const plays = championPlays(c);
  return plays ? (trackerPicks.get(c.slug)?.get(a.slug) ?? 0) / plays : null;
}

// Plays needed before tracked picks fully count; fewer are blended with the text-based guess.
const TRACKER_FULL_TRUST = 30;
const TRACKER_WEIGHT = 40;

export const FIT_PER_RARITY = 10;

// Up to FIT_PER_RARITY augments per rarity that suit the champion, best first.
// The guess from champion type and augment text is topped up by how often players of this champion
// actually took the augment (tracker data), which counts for more as games accumulate. An augment
// that clashes with the champion's type (e.g. crit for a mage) is left out unless players take it.
export function fittingAugments(c: Champion, exclude: Set<string> = new Set()): Record<Rarity, Augment[]> {
  const w = championWeights(c);
  const trust = Math.min(1, championPlays(c) / TRACKER_FULL_TRUST);
  const scored = augments
    .filter((a) => !exclude.has(a.slug))
    .map((a) => {
      const traits = [...(augmentTraits.get(a.slug) ?? [])];
      const fit = traits.reduce((sum, t) => sum + (w[t] ?? 0), 0);
      const clash = traits.some((t) => (w[t] ?? 0) <= -1.5);
      const share = championPickShare(c, a) ?? 0;
      const played = share * trust >= 0.05;
      return {
        a,
        keep: played || (!clash && fit >= 0),
        score: fit + (a.pickRate ?? 0) * 0.03 + share * TRACKER_WEIGHT * trust,
      };
    })
    .filter((x) => x.keep)
    .sort((x, y) => y.score - x.score);
  const pick = (r: Rarity) => scored.filter((x) => x.a.rarity === r).slice(0, FIT_PER_RARITY).map((x) => x.a);
  return { silver: pick('silver'), gold: pick('gold'), prismatic: pick('prismatic') };
}

export const formatRate = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`);
export const formatChange = (n: number | null) =>
  n == null || n === 0 ? '' : `${n > 0 ? '▲' : '▼'}${Math.abs(n).toFixed(2)}`;
