// Reads the FF Wiki's release/series data (Module:Codename/data) two ways:
// - fromExport: one call to the wiki's own Lua via Module:Codename/export,
//   which is fast and authoritative;
// - fromLua: fetches the data pages' source and parses them with luaparse,
//   following require() calls; no Lua runs.
// crossCheck compares the two so a drift between them is noticed.

import type { WikiClient } from '../wiki/client.ts';
import { isRequireRef, parseLuaLiteral, type LuaValue } from '../lua/lua-literal.ts';

/** Max titles per prop=revisions request for non-bot accounts. */
const TITLES_PER_REQUEST = 50;

/** Calls `{{#invoke:<exportModule>|json}}` and parses the JSON it returns. */
export async function fromExport(client: WikiClient, exportModule: string): Promise<unknown> {
  const body = (await client.request({
    action: 'expandtemplates',
    prop: 'wikitext',
    text: `{{#invoke:${exportModule}|json}}`,
  })) as { expandtemplates: { wikitext: string } };
  const text = body.expandtemplates.wikitext;
  try {
    return JSON.parse(text);
  } catch {
    // A Lua error renders as wikitext/HTML instead of JSON.
    throw new Error(`Module:${exportModule} did not return JSON; it returned: ${text.slice(0, 200)}`);
  }
}

/** Parses `dataModule` and every module it requires into one value. */
export async function fromLua(client: WikiClient, dataModule: string): Promise<LuaValue> {
  const parsed = new Map<string, LuaValue>();

  // Fetch one level at a time so each level is a single batched request.
  let pending = [normalizeTitle(dataModule)];
  while (pending.length > 0) {
    const sources = await getSources(client, pending);
    const next = new Set<string>();
    for (const [title, source] of sources) {
      const value = parseLuaLiteral(source, title);
      parsed.set(title, value);
      for (const required of findRequires(value)) {
        if (!parsed.has(required) && !sources.has(required)) {
          next.add(required);
        }
      }
    }
    pending = [...next];
  }

  return resolve(normalizeTitle(dataModule), parsed, []);
}

export interface Difference {
  /** e.g. rel[14].versions.advance.name */
  readonly path: string;
  readonly exported: unknown;
  readonly parsed: unknown;
}

/**
 * Deep-compares the export with the parsed Lua. Key order is ignored (Lua
 * tables have none), and objects keyed "1".."n" count as arrays, since
 * mw.text.jsonEncode turns those Lua tables into JSON arrays.
 */
export function crossCheck(exported: unknown, parsed: unknown): Difference[] {
  const differences: Difference[] = [];
  compare(normalize(exported), normalize(parsed), '', differences);
  return differences;
}

function compare(a: unknown, b: unknown, path: string, out: Difference[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      compare(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      compare(a[key], b[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  if (a !== b) {
    out.push({ path: path === '' ? '(root)' : path, exported: a, parsed: b });
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const isSequence = keys.length > 0 && keys.every((key, i) => key === String(i + 1));
    if (isSequence) {
      return keys.map((key) => normalize(value[key]));
    }
    return Object.fromEntries(keys.map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces each require() reference with the parsed value of that module. */
function resolve(title: string, parsed: Map<string, LuaValue>, stack: string[]): LuaValue {
  if (stack.includes(title)) {
    throw new Error(`require() cycle: ${[...stack, title].join(' → ')}`);
  }
  const value = parsed.get(title);
  if (value === undefined) {
    throw new Error(`${title} was required but not loaded`);
  }
  const inner = [...stack, title];
  const walk = (node: LuaValue): LuaValue => {
    if (isRequireRef(node)) {
      return resolve(normalizeTitle(node.$require), parsed, inner);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value);
}

function findRequires(value: LuaValue): string[] {
  if (isRequireRef(value)) {
    return [normalizeTitle(value.$require)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(findRequires);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(findRequires);
  }
  return [];
}

/** MediaWiki treats underscores and spaces the same; the API returns spaces. */
function normalizeTitle(title: string): string {
  return title.replaceAll('_', ' ').trim();
}

/** Fetches the current wikitext of `titles`. Throws if any page is missing. */
async function getSources(client: WikiClient, titles: string[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
    const batch = titles.slice(i, i + TITLES_PER_REQUEST);
    const body = (await client.request({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: batch.join('|'),
    })) as {
      query: {
        pages: Array<{ title: string; missing?: boolean; revisions?: Array<{ slots: { main: { content: string } } }> }>;
      };
    };
    for (const page of body.query.pages) {
      const content = page.revisions?.[0]?.slots.main.content;
      if (page.missing === true || content === undefined) {
        throw new Error(`${page.title} does not exist`);
      }
      sources.set(page.title, content);
    }
  }
  return sources;
}
