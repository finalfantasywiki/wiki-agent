// The wikitext edits the gallery cleanup makes besides deleting pages: tagging
// a kept file's description page with the character's image category. Tags in
// comments, <nowiki>, <pre> and the like don't count.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import type { WikiClient } from '../../shared/wiki/client.ts';
import { mask } from '../../shared/wikitext/references.ts';

const CATEGORY_NS = 14;

/**
 * `text` tagged with `category`, after its last category tag (or at the end).
 * Unchanged if it's tagged already, in any spelling.
 */
export function addCategory(client: WikiClient, text: string, category: string): string {
  const target = new client.Title(category, CATEGORY_NS);
  const { masked } = mask(text);
  const wikitext = new client.Wikitext(masked);
  wikitext.parseLinks();
  if (wikitext.categories.some((tag) => tag.target.toText() === target.toText())) return text;

  const tag = `[[${target.toText()}]]`;
  const lines = text.split('\n');
  const maskedLines = masked.split('\n');
  // Masking keeps line breaks outside masked regions, so lines line up until the first one spanning lines.
  const last = maskedLines.length === lines.length ? maskedLines.findLastIndex((line) => /\[\[\s*Category\s*:/i.test(line)) : -1;
  if (last !== -1) return [...lines.slice(0, last + 1), tag, ...lines.slice(last + 1)].join('\n');
  const body = text.trimEnd();
  return body === '' ? tag : `${body}\n\n${tag}`;
}
