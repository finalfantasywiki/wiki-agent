// Removes links to pages that are about to be deleted, so none are left dead:
// - [[Target]], [[Target#Section|text]] and relative [[/Subpage]] links
//   become their text;
// - images that link there ([[File:X.png|link=Target]]) link to their own
//   file page again;
// - template parameters that make a template link there (e.g. |gallery=true
//   on an infobox, given in `parameters`) are removed;
// - templates that only point readers there ({{main|/Gallery}}, named in
//   `pointers`) are removed when every page they point to is a target, and
//   a heading left with nothing under it goes with them.
// Text in comments, <nowiki>, <pre> and the like is never touched. Anything
// that still links to a target afterwards (a template parameter naming it,
// a link built by a parser function) is returned as a leftover, never guessed
// at.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import type { WikiClient } from '../wiki/client.ts';
import { mask, tryTitle, unmask, type Leftover, type Rewrite, type RewriteResult } from './references.ts';

export interface UnlinkOptions {
  /** The page being edited, for resolving relative links like [[/Gallery]]. */
  readonly page: string;
  /**
   * Template parameters to remove (any template, any value), with the target
   * they link to: e.g. `{ name: 'gallery', target: 'Tifa Lockhart/Gallery' }`
   * on Tifa Lockhart.
   */
  readonly parameters?: ReadonlyArray<{ readonly name: string; readonly target: string }>;
  /** Templates whose unnamed parameters are pages to point readers to, e.g. "main", "see also". */
  readonly pointers?: readonly string[];
}

export function removeLinks(client: WikiClient, text: string, targets: readonly string[], options: UnlinkOptions): RewriteResult {
  const normalized = new Set(targets.map((target) => new client.Title(target).toText()));
  const resolve = (target: string): string | undefined => {
    const absolute = target.trim().startsWith('/') ? `${options.page}${target.trim()}` : target;
    const title = tryTitle(client, absolute.replace(/#.*$/, ''), 0);
    return title !== undefined && normalized.has(title.toText()) ? title.toText() : undefined;
  };
  const rewrites: Rewrite[] = [];
  const { masked, regions } = mask(text);

  let current = removeParameters(client, masked, options.parameters ?? [], rewrites);
  current = removePointers(client, current, options.pointers ?? [], resolve, rewrites);
  current = unlinkImages(client, current, resolve, rewrites);
  current = unlinkLinks(client, current, resolve, rewrites);

  const leftovers = findLeftovers(client, current, resolve);
  return { text: unmask(current, regions), rewrites: rewrites.map((rewrite) => ({ ...rewrite, before: unmask(rewrite.before, regions), after: unmask(rewrite.after, regions) })), leftovers };
}

/** [[Target|text]] → text, one link at a time so links in captions are found too. */
function unlinkLinks(client: WikiClient, text: string, resolve: (target: string) => string | undefined, rewrites: Rewrite[]): string {
  for (;;) {
    const wikitext = new client.Wikitext(text);
    wikitext.parseLinks();
    const next = wikitext.links.map((link) => ({ link, from: resolve(linkTarget(link.wikitext)) })).find((candidate) => candidate.from !== undefined);
    if (next?.from === undefined) return text;
    const after = next.link.displaytext ?? linkTarget(next.link.wikitext);
    rewrites.push({ kind: 'link', from: next.from, before: next.link.wikitext, after });
    text = replaceFirst(text, next.link.wikitext, after);
  }
}

/** [[File:X.png|thumb|link=Target]] → [[File:X.png|thumb]]. */
function unlinkImages(client: WikiClient, text: string, resolve: (target: string) => string | undefined, rewrites: Rewrite[]): string {
  const wikitext = new client.Wikitext(text);
  wikitext.parseLinks();
  for (const file of wikitext.files) {
    const match = /\|\s*link\s*=\s*([^|\]]*)/.exec(file.wikitext);
    const from = match?.[1] === undefined ? undefined : resolve(match[1]);
    if (match === null || from === undefined) continue;
    const after = file.wikitext.replace(match[0], '');
    rewrites.push({ kind: 'embed', from, before: file.wikitext, after });
    text = replaceFirst(text, file.wikitext, after);
  }
  return text;
}

/** Removes each named parameter from every template it appears in. */
function removeParameters(client: WikiClient, text: string, parameters: NonNullable<UnlinkOptions['parameters']>, rewrites: Rewrite[]): string {
  for (const { name, target } of parameters) {
    const from = new client.Title(target).toText();
    for (;;) {
      const templates = client.Wikitext.parseTemplates(text, { recursive: true });
      const found = templates.flatMap((template) => template.parameters.filter((parameter) => String(parameter.name).trim() === name).map((parameter) => ({ template, parameter })))[0];
      if (found === undefined) break;
      const updated = replaceFirst(found.template.wikitext, found.parameter.wikitext, '');
      rewrites.push({ kind: 'template', from, before: found.parameter.wikitext.trim(), after: '' });
      text = replaceFirst(text, found.template.wikitext, updated);
    }
  }
  return text;
}

/**
 * Removes {{main|Target}} and the like when every page they name is a target
 * (one naming other pages too is left as a leftover). A template alone on its
 * line takes the line with it, and then its heading if nothing else is under
 * it before the next heading at the same level or above.
 */
function removePointers(client: WikiClient, text: string, pointers: readonly string[], resolve: (target: string) => string | undefined, rewrites: Rewrite[]): string {
  const names = new Set(pointers.map(templateName));
  for (;;) {
    const found = client.Wikitext.parseTemplates(text, { recursive: true }).find((template) => {
      if (!names.has(templateName(String(template.name)))) return false;
      const pages = template.parameters.filter((parameter) => typeof parameter.name === 'number' || /^\d+$/.test(String(parameter.name)));
      return pages.length > 0 && pages.every((parameter) => resolve(parameter.value.replace(/\uE000\d+\uE001/g, '')) !== undefined);
    });
    if (found === undefined) return text;
    const from = resolve(found.parameters.find((parameter) => typeof parameter.name === 'number' || /^\d+$/.test(String(parameter.name)))!.value)!;

    const at = text.indexOf(found.wikitext);
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const lineEnd = text.indexOf('\n', at + found.wikitext.length);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const aloneOnLine = (text.slice(lineStart, at) + text.slice(at + found.wikitext.length, end)).trim() === '';
    rewrites.push({ kind: 'template', from, before: found.wikitext, after: '' });
    if (!aloneOnLine) {
      text = text.slice(0, at) + text.slice(at + found.wikitext.length);
      continue;
    }
    const lines = text.split('\n');
    const index = text.slice(0, lineStart).split('\n').length - 1;
    lines.splice(index, 1);
    text = removeEmptiedHeading(lines, index, from, rewrites).join('\n');
  }
}

/** The heading above line `index`, if only blank lines separate it from the next heading at its level or above. */
function removeEmptiedHeading(lines: string[], index: number, from: string, rewrites: Rewrite[]): string[] {
  let above = index - 1;
  while (above >= 0 && lines[above]!.trim() === '') above--;
  const heading = above < 0 ? undefined : headingLevel(lines[above]!);
  if (heading === undefined) return lines;
  let below = index;
  while (below < lines.length && lines[below]!.trim() === '') below++;
  const next = below < lines.length ? headingLevel(lines[below]!) : 0;
  if (next === undefined || (below < lines.length && next > heading)) return lines;
  rewrites.push({ kind: 'template', from, before: lines[above]!.trim(), after: '' });
  if (below === lines.length) {
    // The last section: the blank lines before it go too, as MediaWiki keeps no trailing whitespace.
    let start = above;
    while (start > 0 && lines[start - 1]!.trim() === '') start--;
    lines.splice(start);
    return lines;
  }
  // The heading and the blank lines after it; the blank line before it stays as the gap.
  lines.splice(above, below - above);
  return lines;
}

function headingLevel(line: string): number | undefined {
  return /^(={1,6})\s*.+?\s*\1\s*$/.exec(line.replace(/\uE000\d+\uE001/g, ''))?.[1]?.length;
}

/** "see_also" and "See also" are the same template. */
function templateName(name: string): string {
  const spaced = name.trim().replaceAll('_', ' ').replace(/^Template:/i, '');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Links to a target that are still there: in template parameters, or anywhere this didn't parse. */
function findLeftovers(client: WikiClient, text: string, resolve: (target: string) => string | undefined): Leftover[] {
  const leftovers: Leftover[] = [];
  for (const template of client.Wikitext.parseTemplates(text, { recursive: true })) {
    for (const parameter of template.parameters) {
      const from = resolve(parameter.value.replace(/\d+/g, ''));
      if (from !== undefined && !parameter.value.includes('[[')) leftovers.push({ from, line: parameter.wikitext.trim() });
    }
  }
  for (const line of text.split('\n')) {
    for (const [, target = ''] of line.matchAll(/\[\[\s*:?([^|\]]*)/g)) {
      const from = resolve(target);
      if (from !== undefined) leftovers.push({ from, line: line.trim() });
    }
  }
  return leftovers;
}

/** The target as written: `[[Tifa Lockhart/Gallery#Remake|x]]` → `Tifa Lockhart/Gallery#Remake`. */
function linkTarget(raw: string): string {
  return /^\[\[\s*:?\s*([^|\]]*)/.exec(raw)?.[1]?.trim() ?? '';
}

function replaceFirst(text: string, search: string, replacement: string): string {
  const at = text.indexOf(search);
  return at === -1 ? text : text.slice(0, at) + replacement + text.slice(at + search.length);
}
