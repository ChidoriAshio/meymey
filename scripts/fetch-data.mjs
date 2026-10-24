// Fetches game data and pick-rate stats, and writes the small JSON files the site is built from.
//
// Sources:
// - Data Dragon (Riot): champions, ja_JP
// - CommunityDragon: Mayhem ("kiwi") augments, names/rarity/icons, ja_JP string table
// - arammayhem.com open data (CC BY 4.0): champion and augment pick rates
//
// Usage: npm run fetch-data
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { xxhash3 } from 'hash-wasm';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'src/data');
const ICON_DIR = path.join(ROOT, 'public/img/augments');
const STAT_ICON_DIR = path.join(ROOT, 'public/img/stats');

// Inline tooltip icons (%i:scaleAD% in Riot text), as the game draws them next to stats.
const STAT_ICONS = Object.fromEntries([
  ...'onhit scalead scaleadaptiveforce scaleah scaleap scaleapen scalearmor scaleas scalecooldown scalecrit scalecritmult scaleda scaledr scalehealshield scalehealth scalehpregen scalelevel scalels scalemana scalemanaregen scalempen scalemr scalems scalerange scalesize scalesv scaletenacity'
    .split(' ')
    .map((n) => [n, `statsicon/${n}.png`]),
  ...'activeeffect cooldown goldcoins'.split(' ').map((n) => [n, `gameplay/${n}.png`]),
]);
// Item stat names -> the icon the game shows beside them. Longest names first so 魔法防御貫通 beats 魔法防御.
const ITEM_STAT_ICONS = [
  ['クリティカルダメージ', 'scalecritmult'], ['クリティカル率', 'scalecrit'], ['物理防御貫通', 'scaleapen'],
  ['魔法防御貫通', 'scalempen'], ['基本体力自動回復', 'scalehpregen'], ['基本マナ自動回復', 'scalemanaregen'],
  ['回復効果およびシールド量', 'scalehealshield'], ['行動妨害耐性', 'scaletenacity'], ['ライフスティール', 'scalels'],
  ['オムニヴァンプ', 'scalesv'], ['スキルヘイスト', 'scaleah'], ['攻撃速度', 'scaleas'], ['移動速度', 'scalems'],
  ['物理防御', 'scalearmor'], ['魔法防御', 'scalemr'], ['攻撃力', 'scalead'], ['脅威', 'scaleapen'], ['魔力', 'scaleap'],
  ['体力', 'scalehealth'], ['マナ', 'scalemana'],
];
// Simplified skill descriptions come without Riot's colour tags, so tag the usual keywords ourselves.
const SPELL_KEYWORDS = [
  [/物理ダメージ/g, 'physicalDamage'], [/魔法ダメージ/g, 'magicDamage'], [/確定ダメージ/g, 'trueDamage'],
  [/通常攻撃時効果/g, 'OnHit'], [/(?:体力を)?回復/g, 'healing'], [/シールド/g, 'shield'], [/移動速度/g, 'speed'],
  [/攻撃速度/g, 'attackSpeed'],
  [/スタン(?!ガン)|スロウ|ノックアップ|ノックバック|サイレンス|スネア|移動不能|釘付け|挑発|恐怖|魅了|サプレッション|ブラインド|打ち上げ|引き寄せ/g, 'status'],
];
const tagSpellKeywords = (text) =>
  /<(?!br)[a-zA-Z]/.test(text) ? text : SPELL_KEYWORDS.reduce((t, [re, tag]) => t.replace(re, (m) => `<${tag}>${m}</${tag}>`), text);
function addItemStatIcons(text) {
  return text.replace(/<stats>([\s\S]*?)<\/stats>/, (_, body) =>
    `<stats>${body
      .split('<br>')
      .map((line) => {
        const hit = ITEM_STAT_ICONS.find(([label]) => line.replace(/<[^>]+>/g, '').trimStart().startsWith(label));
        return hit ? iconMark(hit[1]) + line : line;
      })
      .join('<br>')}</stats>`,
  );
}
const iconMark = (name) => (STAT_ICONS[name] ? `\u0001${name}\u0002` : '');

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const CDRAGON = 'https://raw.communitydragon.org/latest';
const CDRAGON_GAME_DATA = `${CDRAGON}/plugins/rcp-be-lol-game-data/global`;
const ARAMMAYHEM = 'https://arammayhem.com/data/v1/latest';
// China-server Mayhem stats per champion x augment (CC BY-NC 4.0). Only game counts are used, not win rates.
const ARAMHEX = 'https://raw.githubusercontent.com/czgreat/aramhex-data/main';
const TEXT_ICONS = `${CDRAGON}/plugins/rcp-be-lol-game-data/global/default/assets/ux/fonts/texticons/lol`;

const RARITY = { kSilver: 'silver', kGold: 'gold', kPrismatic: 'prismatic' };

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Same normalisation on both sides of a name join: "Transmute: Prismatic" -> "transmuteprismatic".
const normName = (s) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/^(quest|クエスト)\s*[:：]\s*/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

// ---------- String table ----------

// Newer string tables store most keys as "{xxxxxxxxxx}": the low 38 bits of xxh3_64 of the lowercased key.
async function makeStringLookup(entries) {
  return async (key) => {
    if (!key) return undefined;
    const lower = key.toLowerCase();
    if (entries[lower] !== undefined) return entries[lower];
    const hex = await xxhash3(lower);
    const hashed = (BigInt('0x' + hex) & ((1n << 38n) - 1n)).toString(16).padStart(10, '0');
    return entries[`{${hashed}}`];
  };
}

// ---------- Augment description formatting ----------

function formatNumber(n) {
  if (!Number.isFinite(n)) return '?';
  const r = Math.round(n * 100) / 100;
  return String(r);
}

// Values are per rank; index 0 is usually an unused rank 0, so prefer index 1.
function dataValueOf(dv) {
  const v = dv.values ?? [];
  return v.length > 1 ? v[1] : v[0] ?? 0;
}

// Bin field names that the exporter couldn't name are written as "{fnv1a32 of the lowercased name}".
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const ch of s.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `{${h.toString(16).padStart(8, '0')}}`;
}

// mStat ids used by scaling parts. A part on any other stat makes the value unresolved rather than mislabelled.
const STAT_LABEL = { 0: '魔力', 1: '物理防御', 2: '攻撃力', 5: '魔法防御', 6: '移動速度', 11: '最大体力' };

function statLabel(p) {
  const label = STAT_LABEL[p.mStat ?? 0];
  if (!label) return undefined;
  return p.mStatFormula === 2 ? `増加${label}` : label;
}

// Turns a GameCalculation into display text such as "10〜30 + 40%攻撃力". Returns undefined when a part is unknown.
function resolveCalc(calc, values) {
  const parts = calc?.mFormulaParts ?? [];
  if (!parts.length) return undefined;
  const asPercent = !!calc.mDisplayAsPercent;
  const pct = asPercent ? (n) => `${formatNumber(n * 100)}%` : formatNumber;
  // A ratio on a stat: "40%攻撃力", or in a percent value "魔力100につき3.5%".
  const scaling = (ratio, label) =>
    asPercent ? `${label}100につき${formatNumber(ratio * 10000)}%` : `${formatNumber(ratio * 100)}%${label}`;
  const out = [];
  let flat = 0;
  for (const p of parts) {
    const name = p.mDataValue?.toLowerCase();
    switch (p.__type) {
      case 'NumberCalculationPart':
        flat += p.mNumber ?? 0;
        break;
      case 'NamedDataValueCalculationPart':
        if (!(name in values)) return undefined;
        flat += values[name];
        break;
      case 'ByCharLevelInterpolationCalculationPart':
        out.push(`${pct(p.mStartValue ?? 0)}〜${pct(p.mEndValue ?? 0)}（レベルに応じて）`);
        break;
      case 'StatByNamedDataValueCalculationPart':
      case 'StatByCoefficientCalculationPart': {
        const label = statLabel(p);
        const ratio = p.__type === 'StatByCoefficientCalculationPart' ? p.mCoefficient : values[name];
        if (!label || ratio === undefined) return undefined;
        out.push(scaling(ratio, label));
        break;
      }
      default:
        return undefined;
    }
  }
  if (flat || !out.length) out.unshift(pct(flat));
  return out.join(' + ');
}

function fillPlaceholders(text, spell, stats) {
  const values = {};
  for (const dv of spell?.mSpell?.DataValues ?? []) values[dv.name.toLowerCase()] = dataValueOf(dv);
  const calcs = {};
  for (const [k, v] of Object.entries(spell?.mSpell?.mSpellCalculations ?? {})) calcs[k.toLowerCase()] = v;

  return text.replace(/@([A-Za-z0-9_.]+)(?:\*(-?[0-9.]+))?@/g, (_, rawName, mult) => {
    const name = rawName.toLowerCase();
    if (name === 'spellmodifierdescriptionappend') return '';
    let value;
    if (name in values) value = formatNumber(values[name] * (mult ? Number(mult) : 1));
    else if (name in calcs) value = resolveCalc(calcs[name], values);
    else if (fnv1a(name) in calcs) value = resolveCalc(calcs[fnv1a(name)], values);
    if (value === undefined) {
      stats.unresolved++;
      return '?';
    }
    return value;
  });
}

const escapeHtml = (s) => s.replace(/&(?!nbsp;)/g, '&amp;').replace(/"/g, '&quot;');

// Riot tooltip markup -> safe HTML: <br> stays, every other tag becomes a span with a class.
function toSafeHtml(text) {
  text = text.replace(/%i:([A-Za-z0-9_]+)%/g, (_, n) => iconMark(n.toLowerCase()));
  const out = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, closing, tag, plain, stray] = m;
    if (plain !== undefined) out.push(escapeHtml(plain).replace(/>/g, '&gt;'));
    else if (stray) out.push('&lt;');
    else if (tag.toLowerCase() === 'br') out.push(closing ? '' : '<br>');
    else out.push(closing ? '</span>' : `<span class="tt-${tag.toLowerCase()}">`);
  }
  // Close anything left open so one bad tooltip can't break the page.
  const html = out
    .join('')
    .replace(/\u0001(\w+)\u0002/g, (_, n) => `<img class="tt-icon" src="/img/stats/${n}.png" alt="" width="14" height="14">`);
  const open = (html.match(/<span/g) ?? []).length - (html.match(/<\/span>/g) ?? []).length;
  return html + '</span>'.repeat(Math.max(0, open));
}

// Tooltips can embed other strings as {{Key}}; {{SpellName}} is filled in game with the upgraded ability.
async function expandRefs(text, lookup, depth = 0) {
  if (!text || depth > 3) return text;
  const keys = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
  for (const key of keys) {
    const sub = key === 'SpellName' ? 'スキル' : await expandRefs(await lookup(key), lookup, depth + 1);
    text = text.replaceAll(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), sub ?? '');
  }
  return text;
}

const slugify = (id) =>
  id
    .replace(/^ARAM_/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();

// ---------- Main ----------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(ICON_DIR, { recursive: true });

  console.log('Fetching versions…');
  const [ddVersion] = await getJson(`${DDRAGON}/api/versions.json`);
  const cdMeta = await getJson(`${CDRAGON}/content-metadata.json`);

  console.log('Fetching champions…');
  const champJson = await getJson(`${DDRAGON}/cdn/${ddVersion}/data/ja_JP/champion.json`);
  const amChampions = await getJson(`${ARAMMAYHEM}/champions.json`);
  const champStats = new Map(amChampions.rows.map((r) => [r.championId.toLowerCase(), r]));
  // Editorial combo ratings per champion (arammayhem.com), used for the "注目度" tier.
  const amCombos = await getJson(`${ARAMMAYHEM}/combos.json`).catch(() => ({ rows: [] }));
  const comboCounts = new Map();
  for (const r of amCombos.rows) {
    const id = r.championId.toLowerCase();
    const c = comboCounts.get(id) ?? { god: 0, strong: 0 };
    if (r.types.includes('god')) c.god++;
    else if (r.types.includes('strong')) c.strong++;
    comboCounts.set(id, c);
  }

  const champions = Object.values(champJson.data)
    .map((c) => {
      const s = champStats.get(c.id.toLowerCase());
      return {
        id: c.id,
        key: c.key,
        slug: c.id.toLowerCase(),
        name: c.name,
        title: c.title,
        tags: c.tags,
        // Riot's 0-10 ratings; attack vs magic tells physical from magic damage dealers.
        info: c.info,
        icon: `${DDRAGON}/cdn/${ddVersion}/img/champion/${c.image.full}`,
        pickRate: s?.pickRate ?? null,
        pickRateRank: s?.pickRateRank ?? null,
        pickRateChange: s?.pickRateChange ?? null,
        combos: comboCounts.get(c.id.toLowerCase()) ?? { god: 0, strong: 0 },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  console.log('Fetching champion skills…');
  const champQueue = [...champions];
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (let c; (c = champQueue.shift()); ) {
        const d = (await getJson(`${DDRAGON}/cdn/${ddVersion}/data/ja_JP/champion/${c.id}.json`)).data[c.id];
        const img = (group, file) => `${DDRAGON}/cdn/${ddVersion}/img/${group}/${file}`;
        c.spells = [
          { key: 'P', name: d.passive.name, description: toSafeHtml(tagSpellKeywords(d.passive.description)), icon: img('passive', d.passive.image.full) },
          ...d.spells.map((sp, i) => ({
            key: 'QWER'[i],
            name: sp.name,
            description: toSafeHtml(tagSpellKeywords(sp.description)),
            icon: img('spell', sp.image.full),
            cooldown: sp.cooldownBurn,
          })),
        ];
      }
    }),
  );

  console.log('Fetching items…');
  const itemJson = await getJson(`${DDRAGON}/cdn/${ddVersion}/data/ja_JP/item.json`);
  // The ARAM map (12) also lists Arena copies of items under other ids, so keep only the ids
  // arammayhem.com lists as Mayhem items when that list is available.
  const amItems = await getJson(`${ARAMMAYHEM}/items.json`).catch(() => null);
  const mayhemItemIds = new Set((amItems?.rows ?? []).map((r) => r.gameItemId).filter(Boolean));
  const items = Object.entries(itemJson.data)
    .filter(([, it]) => it.maps?.['12'] && it.gold?.purchasable && !it.hideFromAll && !it.requiredAlly)
    // Boots are kept even when missing there: グラトナス ブーツ (3008) is sold in ARAM but not on that
    // list. Only base ids, since other modes add their own copies (77xxxx).
    .filter(([id, it]) => !mayhemItemIds.size || mayhemItemIds.has(id) || (id.length === 4 && (it.tags ?? []).includes('Boots')))
    .map(([id, it]) => ({
      id,
      name: it.name,
      plaintext: it.plaintext ?? '',
      // Tooltips end in <br><br>, which would leave a blank gap under each item.
      description: toSafeHtml(addItemStatIcons(it.description ?? '')).replace(/(<br>)+(?=(<\/span>)*$)/, ''),
      gold: it.gold.total,
      tags: it.tags ?? [],
      // Tier-2 boots upgrade further in some modes but are what players actually finish on.
      finished: !it.into?.length || ((it.tags ?? []).includes('Boots') && it.gold.total > 300),
      icon: `${DDRAGON}/cdn/${ddVersion}/img/item/${it.image.full}`,
    }))
    .sort((a, b) => b.gold - a.gold);

  console.log('Fetching augments (large files, this takes a moment)…');
  const [kiwi, cherryJa, cherryEn, stringTable, amAugments] = await Promise.all([
    getJson(`${CDRAGON}/game/maps/modespecificdata/kiwi.bin.json`),
    getJson(`${CDRAGON_GAME_DATA}/ja_jp/v1/cherry-augments.json`),
    getJson(`${CDRAGON_GAME_DATA}/default/v1/cherry-augments.json`),
    getJson(`${CDRAGON}/game/ja_jp/data/menu/en_us/lol.stringtable.json`),
    getJson(`${ARAMMAYHEM}/augments.json`),
  ]);
  const lookup = await makeStringLookup(stringTable.entries);
  const jaById = new Map(cherryJa.map((a) => [a.id, a]));
  const enById = new Map(cherryEn.map((a) => [a.id, a]));
  const augStatsByName = new Map();
  for (const r of amAugments.rows) {
    augStatsByName.set(normName(r.name.en), r);
    augStatsByName.set(normName(r.name['ja-JP']), r);
  }

  const stats = { unresolved: 0, noDescription: 0, noStats: 0, iconFailed: 0 };
  const augments = [];
  const seenSlugs = new Set();
  for (const a of Object.values(kiwi)) {
    if (a?.__type !== 'AugmentData') continue;
    const ja = jaById.get(a.AugmentPlatformId);
    const en = enById.get(a.AugmentPlatformId);
    const rarity = RARITY[ja?.rarity];
    if (!rarity) continue;

    const name = ((await lookup(a.NameTra)) || ja?.nameTRA || '').trim();
    // Placeholder entries (e.g. the blank Pentakill set variants) have no name and are never offered.
    if (!name || /BlankName$/.test(name)) continue;
    const rawDesc = await expandRefs(
      (await lookup(a.DescriptionTra)) || (await lookup(a.AugmentTooltipTra)),
      lookup,
    );
    if (!rawDesc) stats.noDescription++;
    const description = rawDesc ? toSafeHtml(fillPlaceholders(rawDesc, kiwi[a.RootSpell], stats)) : '';

    let slug = slugify(a.AugmentNameId);
    while (seenSlugs.has(slug)) slug += '-2';
    seenSlugs.add(slug);

    const s = augStatsByName.get(normName(en?.nameTRA)) ?? augStatsByName.get(normName(name));
    if (!s) stats.noStats++;

    augments.push({
      id: a.AugmentNameId,
      platformId: a.AugmentPlatformId,
      slug,
      name,
      nameEn: en?.nameTRA ?? null,
      rarity,
      description,
      // Large icon paths are sometimes only a hash; fall back to the small icon.
      iconSource: [a.AugmentLargeIconPath, a.AugmentSmallIconPath]
        .filter((p) => p && !p.startsWith('{'))
        .map((p) => p.toLowerCase().replace(/\.tex$/, '.png')),
      icon: `/img/augments/${slug}.png`,
      pickRate: s?.pickRate ?? null,
      pickRateRank: s?.pickRateRank ?? null,
      pickRateChange: s?.pickRateChange ?? null,
      introducedPatch: s?.introducedPatch ?? null,
    });
  }
  augments.sort((x, y) => (y.pickRate ?? -1) - (x.pickRate ?? -1) || x.name.localeCompare(y.name, 'ja'));

  console.log('Downloading stat icons…');
  await mkdir(STAT_ICON_DIR, { recursive: true });
  for (const [name, src] of Object.entries(STAT_ICONS)) {
    const file = path.join(STAT_ICON_DIR, `${name}.png`);
    if (!existsSync(file)) await writeFile(file, await getBuffer(`${TEXT_ICONS}/${src}`));
  }

  console.log(`Downloading ${augments.length} augment icons…`);
  const wanted = new Set(augments.map((a) => `${a.slug}.png`));
  for (const f of await readdir(ICON_DIR)) if (!wanted.has(f)) await unlink(path.join(ICON_DIR, f));
  const queue = [...augments];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let a; (a = queue.shift()); ) {
        const file = path.join(ICON_DIR, `${a.slug}.png`);
        if (existsSync(file)) continue;
        let ok = false;
        for (const src of a.iconSource) {
          try {
            await writeFile(file, await getBuffer(`${CDRAGON}/game/${src}`));
            ok = true;
            break;
          } catch {}
        }
        if (!ok) {
          stats.iconFailed++;
          a.icon = null;
        }
      }
    }),
  );
  for (const a of augments) delete a.iconSource;

  // Data Dragon still counts seasons from 2011 ("16.21"); the patch is named by year ("26.21").
  const [major, minor] = ddVersion.split('.').map(Number);
  const meta = {
    generatedAt: new Date().toISOString(),
    gameVersion: ddVersion,
    patch: `${major >= 16 ? major + 10 : major}.${minor}`,
    cdragonVersion: cdMeta.version,
    stats: {
      patch: amAugments.meta.patch,
      statsDate: amAugments.meta.statsDate,
      attribution: amAugments.attribution,
      source: amAugments.source,
      license: 'CC BY 4.0',
      licenseUrl: amAugments.licenseUrl,
      note: amAugments.dataSource,
    },
  };

  await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  await writeFile(path.join(DATA_DIR, 'champions.json'), JSON.stringify(champions, null, 2) + '\n');
  await writeFile(path.join(DATA_DIR, 'augments.json'), JSON.stringify(augments, null, 2) + '\n');
  await writeFile(path.join(DATA_DIR, 'items.json'), JSON.stringify(items, null, 2) + '\n');

  console.log('Fetching China-server champion x augment counts…');
  try {
    const latest = await getJson(`${ARAMHEX}/latest.json`);
    const [heroes, heroAugments] = await Promise.all([
      getJson(`${ARAMHEX}/${latest.path}/heroes.json`),
      getJson(`${ARAMHEX}/${latest.path}/hero_augments.json`),
    ]);
    const champByKey = new Map(champions.map((c) => [c.key, c.slug]));
    const augByPlatformId = new Map(augments.map((a) => [String(a.platformId), a.slug]));
    const out = {};
    for (const [heroId, h] of Object.entries(heroes)) {
      const slug = champByKey.get(heroId);
      if (!slug) continue;
      const picks = {};
      for (const [augId, v] of Object.entries(heroAugments[heroId] ?? {})) {
        const aug = augByPlatformId.get(augId);
        if (aug) picks[aug] = v.games;
      }
      out[slug] = { games: h.games, picks };
    }
    const cn = { patch: latest.patch, matches: latest.matches, snapshotAt: latest.snapshot_at, champions: out };
    await writeFile(path.join(DATA_DIR, 'champion-augments-cn.json'), JSON.stringify(cn) + '\n');
  } catch (e) {
    // Keep the previous file: the site still builds and uses the last good counts.
    console.warn(`China-server counts skipped: ${e.message}`);
  }

  console.log(
    `Done: ${items.length} items, ${champions.length} champions (${champions.filter((c) => c.pickRate != null).length} with stats), ` +
      `${augments.length} augments (${augments.length - stats.noStats} with stats, ` +
      `${stats.noDescription} without description, ${stats.unresolved} unresolved values, ${stats.iconFailed} icons failed).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
