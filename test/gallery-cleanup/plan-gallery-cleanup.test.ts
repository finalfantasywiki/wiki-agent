import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planGalleryCleanup } from '../../src/gallery-cleanup/plan-gallery-cleanup.ts';
import type { ManifestEntry } from '../../src/plans/manifest.ts';
import type { Profile } from '../../src/profile.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../helpers/siteinfo.ts';

const profile = {
  name: 'example',
  api: 'https://wiki.test/api.php',
  galleries: {
    imageCategory: 'Category:Images of {subject}',
    categoryText: '{{category |related=[[{subject}]] }}',
    linkParameters: ['gallery'], pointerTemplates: ['main'], moveSections: ['merchandise'],
  },
} as unknown as Profile;

// Hand-written, in the shape of a wiki's galleries.
const PAGES: Record<string, string> = {
  'Hero/Gallery': '==Game==\n<gallery>\nOnly here.png\nShared.png\nKept.png\nTagged.png\nMissing.png\nBad<name>.png\n</gallery>\n==Merchandise==\n<gallery>\nFigure.jpg\n</gallery>',
  'Talk:Hero/Gallery': 'A discussion.',
  'Villain/Gallery': '<gallery>\nShared.png\nVillain kept.png\n</gallery>',
  'Nobody/Gallery': '<gallery>\nKept.png\n</gallery>',
  Hero: '{{Infobox|name=Hero|gallery=true}}\nIntro.\n\n==Gallery==\n{{main|/Gallery}}\n\n==Story==\nText.',
  'Fan page': '{{:Hero/Gallery}}',
  'Category:Images of Hero': '{{category}}',
  'Category:Images of Villain': '{{category}}',
  'File:Kept.png': 'A description.\n[[Category:Renders]]',
  'File:Figure.jpg': 'A figure.',
  'File:Villain kept.png': 'A description.',
};

/** Per file: pages showing it, redirects to it, and its categories. Files not here are missing. */
const FILES: Record<string, { shown: string[]; redirects?: string[]; categories?: string[] }> = {
  'File:Only here.png': { shown: ['Hero/Gallery'], redirects: ['File:Old only here.png'] },
  'File:Shared.png': { shown: ['Hero/Gallery', 'Villain/Gallery', 'Third/Gallery'] },
  'File:Kept.png': { shown: ['Hero/Gallery', 'Hero'] },
  'File:Tagged.png': { shown: ['Hero/Gallery', 'Hero'], categories: ['Category:Images of Hero'] },
  'File:Figure.jpg': { shown: ['Hero/Gallery'] },
  'File:Villain kept.png': { shown: ['Villain/Gallery', 'Hero'] },
};

/** Per page: what links to it, redirects to it and transcludes it. */
const LINKS: Record<string, { links?: string[]; redirects?: string[]; transclusions?: string[] }> = {
  'Hero/Gallery': { links: ['Hero', 'Talk:Hero/Gallery'], redirects: ['Hero/Images'] },
  'Villain/Gallery': { transclusions: ['Fan page'] },
};

const ref = (title: string) => ({ ns: 0, title });

function wiki() {
  const client = fakeWiki((params) => {
    const titles = params.get('titles')?.split('|') ?? [];
    switch (params.get('prop') ?? params.get('list')) {
      case 'revisions':
        return {
          query: {
            pages: titles.map((title) =>
              PAGES[title] === undefined ? { title, missing: true } : { title, revisions: [{ revid: 1, timestamp: 'T', slots: { main: { content: PAGES[title] } } }] },
            ),
          },
        };
      case 'imageinfo|categories':
        return {
          query: {
            pages: titles.map((title) =>
              FILES[title] === undefined
                ? { title, missing: true }
                : { title, imageinfo: [{ url: 'u', width: 1, height: 1, size: 1, mime: 'image/png', sha1: 's', user: 'U', timestamp: 't' }], categories: (FILES[title]!.categories ?? []).map((c) => ({ title: c })) },
            ),
          },
        };
      case 'fileusage|linkshere|redirects':
        return { query: { pages: titles.map((title) => ({ title, fileusage: (FILES[title]?.shown ?? []).map(ref), redirects: (FILES[title]?.redirects ?? []).map(ref) })) } };
      case 'backlinks': {
        const page = LINKS[params.get('bltitle')!];
        const list = params.get('blfilterredir') === 'redirects' ? page?.redirects : page?.links;
        return { query: { backlinks: (list ?? []).map(ref) } };
      }
      case 'imageusage':
        return { query: { imageusage: [] } };
      case 'embeddedin':
        return { query: { embeddedin: (LINKS[params.get('eititle')!]?.transclusions ?? []).map(ref) } };
      case null: // pagesExist
        return { query: { pages: titles.map((title) => (PAGES[title] === undefined ? { title, missing: true } : { title })) } };
      default:
        throw new Error(`unexpected request ${params}`);
    }
  });
  loadSiteInfo(client);
  return client;
}

describe('planGalleryCleanup', async () => {
  const manifest = await planGalleryCleanup(wiki(), profile, ['Hero/Gallery', 'Villain/Gallery', 'Nobody/Gallery', 'Hero', 'Gone/Gallery']);
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Extract<ManifestEntry, { kind: K }> => entry.kind === kind);

  test('questions: not a gallery, missing, invalid lines, images to move', () => {
    assert.deepEqual(of('question').map((question) => question.about), ['Hero/Gallery', 'File:Figure.jpg', 'Hero', 'Gone/Gallery']);
    assert.match(of('question')[0]!.question, /Bad<name>\.png/);
  });

  test("a subject without an image category gets one, from the profile's text", () => {
    assert.deepEqual(
      of('page-create').map(({ id, title, text, reason, approved }) => ({ id, title, text, reason, approved })),
      [{ id: 'n1', title: 'Category:Images of Nobody', text: '{{category |related=[[Nobody]] }}', reason: 'for the images kept from Nobody/Gallery', approved: true }],
    );
  });

  test('images only on galleries are deleted, noting galleries outside the batch', () => {
    assert.deepEqual(
      of('file-delete').map(({ title, reason, usedBy }) => ({ title, reason, usedBy })),
      [
        { title: 'File:Only here.png', reason: 'only shown on Hero/Gallery', usedBy: [] },
        {
          title: 'File:Shared.png',
          reason: "only shown on Hero/Gallery, Villain/Gallery, Third/Gallery; Third/Gallery isn't in this batch and would show a red link until it's deleted too",
          usedBy: [],
        },
      ],
    );
  });

  test('galleries, their talk pages and redirects are deleted; links from deleted pages do not count', () => {
    assert.deepEqual(
      of('page-delete').map(({ title, usedBy }) => ({ title, usedBy })),
      [
        { title: 'File:Old only here.png', usedBy: [] },
        { title: 'Hero/Images', usedBy: [] },
        { title: 'Hero/Gallery', usedBy: [] },
        { title: 'Talk:Hero/Gallery', usedBy: [] },
        { title: 'Villain/Gallery', usedBy: ['Fan page'] },
        { title: 'Nobody/Gallery', usedBy: [] },
      ],
    );
    assert.deepEqual(of('page-delete').find((page) => page.title === 'Villain/Gallery')?.errors.map((error) => error.code), ['in-use']);
  });

  test("links are removed: the subject's gallery parameter, and a section left empty", () => {
    const hero = manifest.edits.find((edit) => edit.title === 'Hero');
    assert.equal(hero?.text, '{{Infobox|name=Hero}}\nIntro.\n\n==Story==\nText.');
    assert.deepEqual(hero?.entries, ['p3']);
    assert.deepEqual(
      manifest.usages.map(({ from, page, kind, status }) => [from, page, kind, status]),
      [
        ['Hero/Gallery', 'Hero', 'linked', 'rewritten'],
        ['Villain/Gallery', 'Fan page', 'transcluded', 'unresolved'],
      ],
    );
  });

  test('kept and moved images missing their category are tagged, one edit each', () => {
    assert.deepEqual(
      of('category-tag').map(({ id, title, category }) => [id, title, category]),
      [
        ['t1', 'File:Kept.png', 'Category:Images of Hero'],
        ['t2', 'File:Figure.jpg', 'Category:Images of Hero'],
        ['t3', 'File:Villain kept.png', 'Category:Images of Villain'],
        ['t4', 'File:Kept.png', 'Category:Images of Nobody'],
      ],
    );
    assert.deepEqual(
      manifest.edits.filter((edit) => edit.title.startsWith('File:')).map((edit) => [edit.title, edit.entries, edit.text]),
      [
        ['File:Kept.png', ['t1', 't4'], 'A description.\n[[Category:Renders]]\n[[Category:Images of Hero]]\n[[Category:Images of Nobody]]'],
        ['File:Figure.jpg', ['t2'], 'A figure.\n\n[[Category:Images of Hero]]'],
        ['File:Villain kept.png', ['t3'], 'A description.\n\n[[Category:Images of Villain]]'],
      ],
    );
  });

  test('nothing is approved but new pages and tags', () => {
    assert.deepEqual(
      manifest.entries.filter((entry) => entry.kind !== 'question' && entry.approved).map((entry) => entry.id),
      ['n1', 't1', 't2', 't3', 't4'],
    );
  });
});
