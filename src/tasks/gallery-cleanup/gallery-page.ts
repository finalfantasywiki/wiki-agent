// Reads a /Gallery subpage (e.g. "Tifa Lockhart/Gallery") into the images it
// shows and the headings each one is under, so the cleanup can be planned one
// game at a time. Images come from <gallery> lines and [[File:]] embeds;
// anything else that shows an image (templates, <imagemap>) isn't read here,
// so `imageusage` stays the authority on *which* files a gallery uses. Text in
// comments, <nowiki>, <pre> and the like is ignored.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import type { WikiClient } from '../../shared/wiki/client.ts';
import { mask, tryTitle, unmask } from '../../shared/wikitext/references.ts';

const FILE_NS = 6;

export interface Heading {
  /** Number of `=`: 2 for `==X==`. */
  readonly level: number;
  /** Plain text, with links and quote marks removed: `''[[Final Fantasy VII Remake|Remake]]''` → `Remake`. */
  readonly text: string;
  /** Pages the heading links to, often the game's article. */
  readonly links: readonly string[];
}

export interface GalleryImage {
  /** Normalized, e.g. "File:Tifa-ffvii-field.png". */
  readonly title: string;
  readonly kind: 'gallery' | 'embed';
  /** The gallery caption, or the whole embed, as written. */
  readonly caption: string;
  /** The headings it's under, outermost first. */
  readonly headings: readonly Heading[];
}

export interface InvalidLine {
  /** A <gallery> line whose name isn't a valid file title. */
  readonly line: string;
  readonly headings: readonly Heading[];
}

export interface GalleryPage {
  readonly images: readonly GalleryImage[];
  readonly invalid: readonly InvalidLine[];
}

/** Whether `title` is a gallery subpage: "X/Gallery". */
export function isGalleryPage(title: string): boolean {
  return /\/Gallery$/.test(title);
}

/** The page a gallery belongs to: "Tifa Lockhart/Gallery" → "Tifa Lockhart". */
export function gallerySubject(title: string): string {
  if (!isGalleryPage(title)) throw new Error(`not a gallery page: ${title}`);
  return title.slice(0, -'/Gallery'.length);
}

export function parseGalleryPage(client: WikiClient, text: string): GalleryPage {
  const { masked, regions } = mask(text);
  const images: GalleryImage[] = [];
  const invalid: InvalidLine[] = [];
  let headings: Heading[] = [];

  // Odd chunks are <gallery> blocks, even chunks the text between them.
  const chunks = masked.split(/(<gallery\b[^>]*>[\s\S]*?(?:<\/gallery\s*>|$))/i);
  chunks.forEach((chunk, index) => {
    if (index % 2 === 1) {
      readGallery(client, chunk, headings, regions, images, invalid);
      return;
    }
    for (const line of chunk.split('\n')) {
      const heading = readHeading(client, line);
      if (heading !== undefined) {
        headings = [...headings.filter((outer) => outer.level < heading.level), heading];
        continue;
      }
      readEmbeds(client, line, headings, regions, images);
    }
  });
  return { images, invalid };
}

function readGallery(
  client: WikiClient,
  block: string,
  headings: readonly Heading[],
  regions: readonly string[],
  images: GalleryImage[],
  invalid: InvalidLine[],
): void {
  const body = block.replace(/^<gallery\b[^>]*>/i, '').replace(/<\/gallery\s*>$/i, '');
  for (const line of body.split('\n')) {
    const match = /^\s*([^|]*?)\s*(?:\|(.*))?$/.exec(line);
    // A commented-out line leaves no name; a comment next to one isn't part of it.
    const name = match?.[1]?.replace(/\d+/g, '').trim();
    if (match === null || name === undefined || name === '') continue;
    const title = tryTitle(client, name, FILE_NS);
    if (title === undefined || title.getNamespaceId() !== FILE_NS) {
      invalid.push({ line: unmask(line, regions).trim(), headings });
      continue;
    }
    images.push({ title: title.toText(), kind: 'gallery', caption: unmask(match[2] ?? '', regions).trim(), headings });
  }
}

function readEmbeds(client: WikiClient, line: string, headings: readonly Heading[], regions: readonly string[], images: GalleryImage[]): void {
  if (!line.includes('[[')) return;
  const wikitext = new client.Wikitext(line);
  wikitext.parseLinks();
  for (const file of wikitext.files) {
    images.push({ title: file.target.toText(), kind: 'embed', caption: unmask(file.wikitext, regions), headings });
  }
}

function readHeading(client: WikiClient, line: string): Heading | undefined {
  // A comment after a heading (masked) doesn't stop it being one.
  const match = /^(={1,6})\s*(.+?)\s*\1\s*$/.exec(line.replace(/\d+/g, ''));
  if (match === null) return undefined;
  const [, equals = '', raw = ''] = match;
  const links: string[] = [];
  for (const [, target = ''] of raw.matchAll(/\[\[\s*([^|\]]+?)\s*(?:\|[^\]]*)?\]\]/g)) {
    const title = tryTitle(client, target, 0);
    if (title !== undefined) links.push(title.toText());
  }
  const text = raw
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .trim();
  return { level: equals.length, text, links };
}
