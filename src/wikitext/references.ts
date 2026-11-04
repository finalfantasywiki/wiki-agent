// Rewrites references to renamed files and categories in a page's wikitext,
// changing only the target name and leaving everything else as it was.
// mwn's Wikitext finds links, files, categories and templates; galleries are
// handled here because mwn doesn't parse them. Text inside comments, <nowiki>,
// <pre>, <syntaxhighlight> and <source> is never touched (masked here: mwn's
// Unbinder loses nested regions like <pre><nowiki>…</nowiki></pre>). New names
// keep each reference's style: underscores stay underscores. Anything that
// still mentions an old name afterwards is returned as a leftover, never
// guessed at.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import type { MwnTitle } from 'mwn';
import type { WikiClient } from '../wiki/client.ts';

export interface Rename {
  /** Full titles with namespace, e.g. "File:Old.png" → "File:New.png". */
  readonly from: string;
  readonly to: string;
}

/** `nominate` isn't a reference: it's a deletion template added to a file's own page (gallery cleanup). */
export type ReferenceKind = 'embed' | 'link' | 'category' | 'gallery' | 'template' | 'nominate';

export interface Rewrite {
  readonly kind: ReferenceKind;
  /** The renamed title this reference pointed to. */
  readonly from: string;
  readonly before: string;
  readonly after: string;
}

export interface Leftover {
  /** The renamed title still mentioned. */
  readonly from: string;
  /** The line it's on, trimmed. */
  readonly line: string;
}

export interface RewriteResult {
  readonly text: string;
  readonly rewrites: readonly Rewrite[];
  readonly leftovers: readonly Leftover[];
}

const FILE_NS = 6;
const MEDIA_NS = -2;

/** Regions whose contents aren't wikitext, so references there are left alone. */
const MASKED: ReadonlyArray<{ readonly open: RegExp; readonly close: RegExp }> = [
  { open: /<!--/, close: /-->/ },
  { open: /<nowiki\s*>/i, close: /<\/nowiki\s*>/i },
  { open: /<pre(?:\s[^>]*)?>/i, close: /<\/pre\s*>/i },
  { open: /<syntaxhighlight(?:\s[^>]*)?>/i, close: /<\/syntaxhighlight\s*>/i },
  { open: /<source(?:\s[^>]*)?>/i, close: /<\/source\s*>/i },
];

/** Stands in for a masked region; "\uE000" is a private-use character. */
const MASK_TOKEN = /\uE000\d+\uE001/g;

export function rewriteReferences(client: WikiClient, text: string, renames: readonly Rename[]): RewriteResult {
  const targets = new Map<string, { from: string; to: MwnTitle }>();
  for (const rename of renames) {
    const from = new client.Title(rename.from);
    targets.set(from.toText(), { from: from.toText(), to: new client.Title(rename.to) });
  }
  const state: State = { client, targets, rewrites: [], placeholders: [] };

  const { masked, regions } = mask(text);
  let current = rewriteGalleries(masked, state);
  current = rewriteLinks(current, state);
  current = rewriteTemplateParameters(current, state);

  // Only now put the new names in: until here each rewritten name was a
  // placeholder, so a reference can't be rewritten twice (A → B, then B → C)
  // and swaps (A ↔ B) work.
  const leftovers = findLeftovers(current, [...targets.values()].map((target) => target.from));
  current = state.placeholders.reduce((result, name, index) => result.replaceAll(placeholder(index), name), current);
  return { text: unmask(current, regions), rewrites: state.rewrites, leftovers };
}

/**
 * Replaces each region that isn't wikitext with a token, outermost first, so
 * nested regions come back intact. An unclosed region runs to the end, as in
 * MediaWiki. `<nowiki/>` (self-closing) doesn't open a region.
 */
export function mask(text: string): { masked: string; regions: string[] } {
  const regions: string[] = [];
  let masked = '';
  let rest = text;
  for (;;) {
    let first: { index: number; length: number; close: RegExp } | undefined;
    for (const { open, close } of MASKED) {
      const match = open.exec(rest);
      if (match !== null && (first === undefined || match.index < first.index)) {
        first = { index: match.index, length: match[0].length, close };
      }
    }
    if (first === undefined) return { masked: masked + rest, regions };
    const afterOpen = rest.slice(first.index + first.length);
    const closing = first.close.exec(afterOpen);
    const end = closing === null ? rest.length : first.index + first.length + closing.index + closing[0].length;
    masked += `${rest.slice(0, first.index)}\uE000${regions.length}\uE001`;
    regions.push(rest.slice(first.index, end));
    rest = rest.slice(end);
  }
}

export function unmask(text: string, regions: readonly string[]): string {
  return text.replace(MASK_TOKEN, (token) => regions[Number(token.slice(1, -1))] ?? token);
}

/** `name` in the style of `original`: underscores if it used underscores instead of spaces. */
function styleLike(original: string, name: string): string {
  const main = original.slice((prefixOf(original) ?? '').length);
  return main.includes('_') && !main.includes(' ') ? name.replaceAll(' ', '_') : name;
}

interface State {
  readonly client: WikiClient;
  readonly targets: ReadonlyMap<string, { from: string; to: MwnTitle }>;
  readonly rewrites: Rewrite[];
  /** New names, indexed by their placeholder number. */
  readonly placeholders: string[];
}

/** Text that is a valid title, matches no rename, and won't appear in real wikitext. */
function placeholder(index: number): string {
  return `WikiAgentRenamePlaceholder${index}x`;
}

/** Records `name` and returns its placeholder. */
function hold(state: State, name: string): string {
  state.placeholders.push(name);
  return placeholder(state.placeholders.length - 1);
}

// --- Links, embedded files and category tags -------------------------------------

/**
 * One reference at a time, re-parsing after each, so nested links (a file in
 * another file's caption) are rewritten too and nothing is replaced twice.
 */
function rewriteLinks(text: string, state: State): string {
  const { client, targets } = state;
  for (;;) {
    const wikitext = new client.Wikitext(text);
    wikitext.parseLinks();
    const entities: Array<{ kind: ReferenceKind; raw: string; target: MwnTitle }> = [
      ...wikitext.files.map((file) => ({ kind: 'embed' as const, raw: file.wikitext, target: file.target })),
      ...wikitext.categories.map((category) => ({ kind: 'category' as const, raw: category.wikitext, target: category.target })),
      ...wikitext.links.map((link) => ({ kind: 'link' as const, raw: link.wikitext, target: link.target })),
    ];
    const next = entities
      .map((entity) => ({ ...entity, match: targets.get(linkKey(client, entity.target)) }))
      .find((entity) => entity.match !== undefined);
    if (next?.match === undefined) return text;

    const name = styleLike(linkTargetText(next.raw), next.match.to.getMainText());
    state.rewrites.push({ kind: next.kind, from: next.match.from, before: next.raw, after: replaceLinkTarget(next.raw, next.match.to, name) });
    text = replaceFirst(text, next.raw, replaceLinkTarget(next.raw, next.match.to, hold(state, name)));
  }
}

/** Media:X links point at File:X. */
function linkKey(client: WikiClient, target: MwnTitle): string {
  return target.getNamespaceId() === MEDIA_NS ? new client.Title(target.getMainText(), FILE_NS).toText() : target.toText();
}

/** The target as written: `[[File:Old_name.png|thumb]]` → `File:Old_name.png`. */
function linkTargetText(raw: string): string {
  return /^\[\[\s*:?\s*([^|\]]*)/.exec(raw)?.[1]?.trim() ?? '';
}

/** `[[File:Old.png|thumb]]` → `[[File:<name>|thumb]]`, keeping the prefix as written. */
function replaceLinkTarget(raw: string, to: MwnTitle, name: string): string {
  const match = /^(\[\[\s*:?\s*)([^|\]]*?)(\s*)(\||\]\])/.exec(raw);
  if (match === null) throw new Error(`can't find the target in ${raw}`);
  const [whole, open, target, space, close] = match as unknown as [string, string, string, string, string];
  const rewritten = `${prefixOf(target) ?? namespacePrefix(to)}${name}`;
  return `${open}${rewritten}${space}${close}${raw.slice(whole.length)}`;
}

// --- Galleries ---------------------------------------------------------------------

/** Lines in <gallery> are `[File:]Name.ext|caption`; mwn doesn't parse them. */
function rewriteGalleries(text: string, state: State): string {
  const { client, targets } = state;
  return text.replace(/(<gallery\b[^>]*>)([\s\S]*?)(<\/gallery>)/gi, (_block, open: string, body: string, close: string) => {
    const lines = body.split('\n').map((line) => {
      const match = /^(\s*)([^|\n]*?)(\s*)(\|.*)?$/.exec(line);
      const name = match?.[2];
      if (match === null || name === undefined || name === '') return line;
      const title = tryTitle(client, name, FILE_NS);
      const target = title === undefined ? undefined : targets.get(title.toText());
      if (target === undefined) return line;
      const rebuild = (newName: string) => `${match[1]}${prefixOf(name) ?? ''}${newName}${match[3]}${match[4] ?? ''}`;
      const newName = styleLike(name, target.to.getMainText());
      state.rewrites.push({ kind: 'gallery', from: target.from, before: line, after: rebuild(newName) });
      return rebuild(hold(state, newName));
    });
    return `${open}${lines.join('\n')}${close}`;
  });
}

// --- Template parameters -------------------------------------------------------------

/**
 * A parameter whose whole value is a file name, e.g. {{Infobox|image=X.png}}
 * or {{Gallery|X.png|caption}}. Bare names are read as files; a value with a
 * namespace prefix (Category:X) is read as written.
 */
function rewriteTemplateParameters(text: string, state: State): string {
  const { client, targets } = state;
  for (;;) {
    const templates = client.Wikitext.parseTemplates(text, { recursive: true });
    let found: { template: string; updated: string; rewrite: Rewrite } | undefined;
    for (const template of templates) {
      for (const parameter of template.parameters) {
        // A comment next to the value (masked) doesn't stop it being a name.
        const value = parameter.value.replace(MASK_TOKEN, '').trim();
        if (value === '' || value.includes('[[') || value.includes('{{')) continue;
        const title = tryTitle(client, value, FILE_NS);
        const target = title === undefined ? undefined : targets.get(title.toText());
        if (target === undefined) continue;

        const withName = (name: string) => replaceLast(parameter.wikitext, value, `${prefixOf(value) ?? ''}${name}`);
        const newName = styleLike(value, target.to.getMainText());
        found = {
          template: template.wikitext,
          updated: replaceFirst(template.wikitext, parameter.wikitext, withName(hold(state, newName))),
          rewrite: { kind: 'template', from: target.from, before: unmask(parameter.wikitext, []).trim(), after: withName(newName).trim() },
        };
        break;
      }
      if (found !== undefined) break;
    }
    if (found === undefined) return text;
    state.rewrites.push(found.rewrite);
    text = replaceFirst(text, found.template, found.updated);
  }
}

// --- Leftovers ---------------------------------------------------------------------

/**
 * Old names still in the text after rewriting: built by parser functions, in
 * <imagemap>, in places this doesn't parse... A file name matches with spaces
 * or underscores and either case of its first letter.
 */
function findLeftovers(text: string, titles: readonly string[]): Leftover[] {
  const leftovers: Leftover[] = [];
  const lines = text.split('\n');
  for (const title of titles) {
    const name = title.slice(title.indexOf(':') + 1);
    const pattern = new RegExp(namePattern(name));
    for (const line of lines) {
      if (pattern.test(line)) leftovers.push({ from: title, line: line.trim() });
    }
  }
  return leftovers;
}

function namePattern(name: string): string {
  const [first = '', ...rest] = [...name];
  const firstChar = first.toLowerCase() === first.toUpperCase() ? escape(first) : `[${escape(first.toUpperCase())}${escape(first.toLowerCase())}]`;
  return firstChar + rest.map((char) => (char === ' ' ? '[ _]' : escape(char))).join('');
}

// --- Helpers -----------------------------------------------------------------------

/** The namespace prefix as written, e.g. "Image:" or "file:", if there is one. */
function prefixOf(target: string): string | undefined {
  return /^\s*((?:File|Image|Media|Category)\s*:\s*)/i.exec(target)?.[1];
}

function namespacePrefix(title: MwnTitle): string {
  const text = title.toText();
  return text.slice(0, text.length - title.getMainText().length);
}

export function tryTitle(client: WikiClient, text: string, defaultNamespace: number): MwnTitle | undefined {
  try {
    return new client.Title(text, defaultNamespace);
  } catch {
    return undefined; // not a valid title, so not a reference
  }
}

function replaceFirst(text: string, search: string, replacement: string): string {
  const at = text.indexOf(search);
  return at === -1 ? text : text.slice(0, at) + replacement + text.slice(at + search.length);
}

function replaceLast(text: string, search: string, replacement: string): string {
  const at = text.lastIndexOf(search);
  return at === -1 ? text : text.slice(0, at) + replacement + text.slice(at + search.length);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
