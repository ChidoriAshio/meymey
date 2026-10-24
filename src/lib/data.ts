import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'astro/zod';
import championsJson from '../data/champions.json';
import augmentsJson from '../data/augments.json';
import itemsJson from '../data/items.json';
import metaJson from '../data/meta.json';

export type Rarity = 'silver' | 'gold' | 'prismatic';

export interface Champion {
  id: string;
  key: string;
  slug: string;
  name: string;
  title: string;
  tags: string[];
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

export const formatRate = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`);
export const formatChange = (n: number | null) =>
  n == null || n === 0 ? '' : `${n > 0 ? '▲' : '▼'}${Math.abs(n).toFixed(2)}`;
