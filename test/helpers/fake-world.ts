// A fake wiki built from a description of its pages, for tests that plan a
// whole batch: it answers file info, existence checks, page text, category
// members, usages (one file at a time or batched) and transclusions the way
// the API does.

import { fakeWiki, type FakeWiki } from './fake-wiki.ts';
import { loadSiteInfo, SITEINFO } from './siteinfo.ts';

export interface World {
  /** Page texts by title. Files are pages in the File namespace. */
  readonly pages: Record<string, string>;
  /** Members of each category. */
  readonly members?: Record<string, readonly string[]>;
  /** Pages showing each file (imageusage). */
  readonly shownOn?: Record<string, readonly string[]>;
  /** Pages linking to each title (backlinks). */
  readonly linkedFrom?: Record<string, readonly string[]>;
  /** Pages each page transcludes. */
  readonly transcludes?: Record<string, readonly string[]>;
}

const NAMESPACES: Record<string, number> = { File: 6, Template: 10, Category: 14 };
const ref = (title: string) => ({ title, ns: NAMESPACES[title.split(':')[0]!] ?? 0 });

export function fakeWorld(world: World): FakeWiki {
  const revids = new Map(Object.keys(world.pages).map((title, i) => [title, 100 + i]));
  const exists = (title: string) => world.pages[title] !== undefined;
  const client = fakeWiki((params) => {
    const titles = params.get('titles')?.split('|') ?? [];
    if (params.get('meta') === 'siteinfo') return SITEINFO;
    const list = params.get('list');
    const prop = params.get('prop');
    if (list === 'categorymembers') {
      const members = world.members?.[params.get('cmtitle')!] ?? [];
      return { query: { categorymembers: members.map((title) => ({ ...ref(title), type: title.startsWith('File:') ? 'file' : title.startsWith('Category:') ? 'subcat' : 'page' })) } };
    }
    if (list === 'imageusage') return { query: { imageusage: (world.shownOn?.[params.get('iutitle')!] ?? []).map(ref) } };
    if (list === 'backlinks') {
      const pages = params.get('blfilterredir') === 'redirects' ? [] : (world.linkedFrom?.[params.get('bltitle')!] ?? []);
      return { query: { backlinks: pages.map(ref) } };
    }
    if (list === 'embeddedin') return { query: { embeddedin: [] } };
    if (prop === 'revisions') {
      return {
        query: {
          pages: titles.map((title) =>
            exists(title) ? { title, revisions: [{ revid: revids.get(title), timestamp: '2026-11-01T00:00:00Z', slots: { main: { content: world.pages[title] } } }] } : { title, missing: true },
          ),
        },
      };
    }
    if (prop === 'templates') {
      const only = params.get('tltemplates')?.split('|');
      return { query: { pages: titles.map((title) => ({ title, templates: (world.transcludes?.[title] ?? []).filter((t) => only?.includes(t) ?? true).map(ref) })) } };
    }
    if (prop === 'fileusage|linkshere|redirects') {
      return { query: { pages: titles.map((title) => ({ title, fileusage: (world.shownOn?.[title] ?? []).map(ref), linkshere: (world.linkedFrom?.[title] ?? []).map(ref), redirects: [] })) } };
    }
    if (prop?.includes('imageinfo')) {
      return {
        query: {
          pages: titles.map((title) =>
            exists(title)
              ? { title, imageinfo: [{ url: `https://img.test/${title}`, thumburl: `https://img.test/thumb/${title}`, width: 1, height: 1, size: 1, mime: 'image/png', sha1: 'x', user: 'U', timestamp: 'T' }] }
              : { title, missing: true },
          ),
        },
      };
    }
    // pagesExist
    return { query: { pages: titles.map((title) => (exists(title) ? { title } : { title, missing: true })) } };
  });
  loadSiteInfo(client);
  return client;
}
