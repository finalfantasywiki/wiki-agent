import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planGalleryCleanup } from '../../src/gallery-cleanup/plan-gallery-cleanup.ts';
import type { Answer } from '../../src/plans/answers.ts';
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
    linkParameters: ['gallery'],
    pointerTemplates: ['main'],
    moveSections: ['merchandise'],
    fileHomes: { 'guide scan': 'Guide book' },
  },
} as unknown as Profile;

// Hand-written, in the shape of a wiki's galleries.
const PAGES: Record<string, string> = {
  'Hero/Gallery': '==Game==\n<gallery>\nOnly here.png\nShared.png\nKept.png\nTagged.png\nMissing.png\nBad<name>.png\nHero guide scan.png\n</gallery>\n==Merchandise==\n<gallery>\nFigure.jpg\n</gallery>',
  'Talk:Hero/Gallery': 'A discussion.',
  'Villain/Gallery': '<gallery>\nShared.png\nVillain kept.png\nVillain guide scan.png\n</gallery>',
  'Nobody/Gallery': '<gallery>\nKept.png\n</gallery>',
  Hero: '{{Infobox|name=Hero|gallery=true|bio=[[:File:Hero guide scan.png|(Scan)]]}}\nIntro.\n\n==Gallery==\n{{main|/Gallery}}\n\n==Story==\nText.',
  'Fan page': '{{:Hero/Gallery}}',
  'Category:Images of Hero': '{{category}}',
  'Category:Images of Villain': '{{category}}',
  'File:Kept.png': 'A description.\n[[Category:Renders]]',
  'File:Figure.jpg': 'A figure.',
  'File:Villain kept.png': 'A description.',
  'File:Hero guide scan.png': 'A scan.',
  'File:Villain guide scan.png': 'A scan.',
};

/** Per file: pages showing it, redirects to it, and its categories. Files not here are missing. */
const FILES: Record<string, { shown: string[]; links?: string[]; redirects?: string[]; categories?: string[] }> = {
  'File:Only here.png': { shown: ['Hero/Gallery'], redirects: ['File:Old only here.png'] },
  'File:Shared.png': { shown: ['Hero/Gallery', 'Villain/Gallery', 'Third/Gallery'] },
  'File:Kept.png': { shown: ['Hero/Gallery', 'Hero'] },
  'File:Tagged.png': { shown: ['Hero/Gallery', 'Hero'], categories: ['Category:Images of Hero'] },
  'File:Figure.jpg': { shown: ['Hero/Gallery'] },
  'File:Villain kept.png': { shown: ['Villain/Gallery', 'Hero'] },
  'File:Hero guide scan.png': { shown: ['Hero/Gallery'], links: ['Hero'] },
  'File:Villain guide scan.png': { shown: ['Villain/Gallery'] },
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
        return { query: { pages: titles.map((title) => ({ title, fileusage: (FILES[title]?.shown ?? []).map(ref), linkshere: (FILES[title]?.links ?? []).map(ref), redirects: (FILES[title]?.redirects ?? []).map(ref) })) } };
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

  test('questions: not a gallery, missing, invalid lines, images to move, images still linked', () => {
    assert.deepEqual(of('question').map((question) => question.about), ['Hero/Gallery', 'File:Hero guide scan.png', 'File:Figure.jpg', 'File:Villain guide scan.png', 'Hero', 'Gone/Gallery']);
    assert.match(of('question')[0]!.question, /Bad<name>\.png/);
  });

  test('an image only galleries show, but a staying page links to, is kept and tagged, and pointed to its home', () => {
    assert.equal(of('question')[1]!.question, "Only shown on Hero/Gallery, but linked from Hero, so it's kept and tagged. Add it to Guide book.");
    assert.ok(!of('file-delete').some((file) => file.title === 'File:Hero guide scan.png'));
  });

  test('an image with a home page is kept and tagged even if nothing links to it', () => {
    assert.equal(of('question')[3]!.question, "Only shown on Villain/Gallery, but it belongs on Guide book, so it's kept and tagged. Add it to Guide book.");
    assert.ok(!of('file-delete').some((file) => file.title === 'File:Villain guide scan.png'));
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

  test("links are removed: the subject's gallery parameter, and a section left empty; links to files stay", () => {
    const hero = manifest.edits.find((edit) => edit.title === 'Hero');
    assert.equal(hero?.text, '{{Infobox|name=Hero|bio=[[:File:Hero guide scan.png|(Scan)]]}}\nIntro.\n\n==Story==\nText.');
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
        ['t2', 'File:Hero guide scan.png', 'Category:Images of Hero'],
        ['t3', 'File:Figure.jpg', 'Category:Images of Hero'],
        ['t4', 'File:Villain kept.png', 'Category:Images of Villain'],
        ['t5', 'File:Villain guide scan.png', 'Category:Images of Villain'],
        ['t6', 'File:Kept.png', 'Category:Images of Nobody'],
      ],
    );
    assert.deepEqual(
      manifest.edits.filter((edit) => edit.title.startsWith('File:')).map((edit) => [edit.title, edit.entries, edit.text]),
      [
        ['File:Kept.png', ['t1', 't6'], 'A description.\n[[Category:Renders]]\n[[Category:Images of Hero]]\n[[Category:Images of Nobody]]'],
        ['File:Hero guide scan.png', ['t2'], 'A scan.\n\n[[Category:Images of Hero]]'],
        ['File:Figure.jpg', ['t3'], 'A figure.\n\n[[Category:Images of Hero]]'],
        ['File:Villain kept.png', ['t4'], 'A description.\n\n[[Category:Images of Villain]]'],
        ['File:Villain guide scan.png', ['t5'], 'A scan.\n\n[[Category:Images of Villain]]'],
      ],
    );
  });

  test('nothing is approved but new pages and tags', () => {
    assert.deepEqual(
      manifest.entries.filter((entry) => entry.kind !== 'question' && entry.approved).map((entry) => entry.id),
      ['n1', 't1', 't2', 't3', 't4', 't5', 't6'],
    );
  });
});

describe('planGalleryCleanup with saved answers', async () => {
  const answered = 'T';
  const answers = new Map<string, Answer>([
    ['File:Figure.jpg', { about: 'File:Figure.jpg', choice: 'keep', answered }],
    ['File:Hero guide scan.png', { about: 'File:Hero guide scan.png', choice: 'delete', answered }],
    ['File:Villain guide scan.png', { about: 'File:Villain guide scan.png', choice: 'other', text: 'Ask the uploader first.', answered }],
  ]);
  const manifest = await planGalleryCleanup(wiki(), profile, ['Hero/Gallery', 'Villain/Gallery'], { answers });
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Extract<ManifestEntry, { kind: K }> => entry.kind === kind);

  test('unanswered file questions offer keep and delete', async () => {
    const unanswered = await planGalleryCleanup(wiki(), profile, ['Hero/Gallery']);
    assert.deepEqual(
      unanswered.entries.filter((entry) => entry.kind === 'question').map((question) => [question.about, question.choices]),
      [
        ['Hero/Gallery', undefined],
        ['File:Hero guide scan.png', ['keep', 'delete']],
        ['File:Figure.jpg', ['keep', 'delete']],
      ],
    );
  });

  test('"keep" is not asked again, but the image is still tagged', () => {
    assert.ok(!of('question').some((question) => question.about === 'File:Figure.jpg'));
    assert.ok(of('category-tag').some((tag) => tag.title === 'File:Figure.jpg'));
  });

  test('"delete" deletes it after all, and a page still linking blocks that', () => {
    const scan = of('file-delete').find((file) => file.title === 'File:Hero guide scan.png');
    assert.equal(scan?.reason, 'only shown on Hero/Gallery; you answered delete');
    assert.deepEqual(scan?.usedBy, ['Hero']);
    assert.deepEqual(scan?.errors.map((error) => error.code), ['in-use']);
    assert.ok(!of('category-tag').some((tag) => tag.title === 'File:Hero guide scan.png'));
  });

  test('free text is asked again, with the answer', () => {
    const question = of('question').find((candidate) => candidate.about === 'File:Villain guide scan.png');
    assert.equal(question?.answer, 'Ask the uploader first.');
    assert.deepEqual(question?.choices, ['keep', 'delete']);
  });
});
