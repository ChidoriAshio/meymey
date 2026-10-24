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

export const formatRate = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`);
export const formatChange = (n: number | null) =>
  n == null || n === 0 ? '' : `${n > 0 ? '▲' : '▼'}${Math.abs(n).toFixed(2)}`;
