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
    nominateText: '{{delete|reason={reason}}}',
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
  'Villain/Gallery': '<gallery>\nShared.png\nVillain kept.png\nVillain guide scan.png\nNominated.png\n</gallery>',
  'Nobody/Gallery': '<gallery>\nKept.png\n</gallery>',
  Hero: '{{Infobox|name=Hero|gallery=true|bio=[[:File:Hero guide scan.png|(Scan)]]}}\nIntro.\n\n==Gallery==\n{{main|/Gallery}}\n\n==Story==\nText.',
  'Fan page': '{{:Hero/Gallery}}',
  'Category:Images of Hero': '{{category}}',
  'Category:Images of Villain': '{{category}}',
  'File:Only here.png': 'An image.',
  'File:Shared.png': 'An image.',
  'File:Nominated.png': '{{Delete|reason=Already nominated.}}\nAn image.',
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
  'File:Nominated.png': { shown: ['Villain/Gallery'] },
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

  test('images only on galleries are nominated, not deleted, noting galleries outside the batch', () => {
    assert.equal(of('file-delete').length, 0);
    assert.deepEqual(
      of('file-nominate').map(({ id, title, reason }) => ({ id, title, reason })),
      [
        { id: 'x1', title: 'File:Only here.png', reason: 'Only shown on Hero/Gallery (gallery page replaced by image categories)' },
        {
          id: 'x2',
          title: 'File:Shared.png',
          reason: "Only shown on Hero/Gallery, Villain/Gallery, Third/Gallery (gallery pages replaced by image categories); Third/Gallery isn't in this batch and would show a red link if the file is deleted first",
        },
      ],
    );
  });

  test("the template goes at the top of the file's page, with the reason and no links; the image is tagged too", () => {
    const only = manifest.edits.find((edit) => edit.title === 'File:Only here.png');
    assert.equal(only?.text, '{{delete|reason=Only shown on Hero/Gallery (gallery page replaced by image categories)}}\nAn image.\n\n[[Category:Images of Hero]]');
    assert.deepEqual(only?.entries, ['x1', 't1']);
  });

  test('a file already nominated is not nominated again, but is still tagged', () => {
    assert.ok(!of('file-nominate').some((file) => file.title === 'File:Nominated.png'));
    assert.equal(manifest.edits.find((edit) => edit.title === 'File:Nominated.png')?.text, '{{Delete|reason=Already nominated.}}\nAn image.\n\n[[Category:Images of Villain]]');
  });

  test("galleries, their talk pages and redirects are deleted, but not a nominated image's redirects; links from deleted pages do not count", () => {
    assert.deepEqual(
      of('page-delete').map(({ title, usedBy }) => ({ title, usedBy })),
      [
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
    assert.deepEqual(hero?.entries, ['p2']);
    assert.deepEqual(
      manifest.usages.map(({ from, page, kind, status }) => [from, page, kind, status]),
      [
        ['Hero/Gallery', 'Hero', 'linked', 'rewritten'],
        ['Villain/Gallery', 'Fan page', 'transcluded', 'unresolved'],
      ],
    );
  });

  test('every image missing its category is tagged, nominated or not, with one edit per file page', () => {
    assert.deepEqual(
      of('category-tag').map(({ id, title, category }) => [id, title, category]),
      [
        ['t1', 'File:Only here.png', 'Category:Images of Hero'],
        ['t2', 'File:Shared.png', 'Category:Images of Hero'],
        ['t3', 'File:Kept.png', 'Category:Images of Hero'],
        ['t4', 'File:Hero guide scan.png', 'Category:Images of Hero'],
        ['t5', 'File:Figure.jpg', 'Category:Images of Hero'],
        ['t6', 'File:Shared.png', 'Category:Images of Villain'],
        ['t7', 'File:Villain kept.png', 'Category:Images of Villain'],
        ['t8', 'File:Villain guide scan.png', 'Category:Images of Villain'],
        ['t9', 'File:Nominated.png', 'Category:Images of Villain'],
        ['t10', 'File:Kept.png', 'Category:Images of Nobody'],
      ],
    );
    assert.deepEqual(
      manifest.edits.filter((edit) => edit.title.startsWith('File:') && edit.title !== 'File:Only here.png' && edit.title !== 'File:Shared.png').map((edit) => [edit.title, edit.entries, edit.text]),
      [
        ['File:Nominated.png', ['t9'], '{{Delete|reason=Already nominated.}}\nAn image.\n\n[[Category:Images of Villain]]'],
        ['File:Kept.png', ['t3', 't10'], 'A description.\n[[Category:Renders]]\n[[Category:Images of Hero]]\n[[Category:Images of Nobody]]'],
        ['File:Hero guide scan.png', ['t4'], 'A scan.\n\n[[Category:Images of Hero]]'],
        ['File:Figure.jpg', ['t5'], 'A figure.\n\n[[Category:Images of Hero]]'],
        ['File:Villain kept.png', ['t7'], 'A description.\n\n[[Category:Images of Villain]]'],
        ['File:Villain guide scan.png', ['t8'], 'A scan.\n\n[[Category:Images of Villain]]'],
      ],
    );
    assert.deepEqual(manifest.edits.find((edit) => edit.title === 'File:Shared.png')?.entries, ['x2', 't2', 't6']);
  });

  test('nothing is approved but new pages and tags', () => {
    assert.deepEqual(
      manifest.entries.filter((entry) => entry.kind !== 'question' && entry.approved).map((entry) => entry.id),
      ['n1', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
    );
  });
});

describe('planGalleryCleanup with saved answers', async () => {
  const answered = 'T';
  const answers = new Map<string, Answer>([
    ['File:Figure.jpg', { about: 'File:Figure.jpg', choice: 'keep', answered }],
    ['File:Hero guide scan.png', { about: 'File:Hero guide scan.png', choice: 'nominate', answered }],
    ['File:Villain guide scan.png', { about: 'File:Villain guide scan.png', choice: 'other', text: 'Ask the uploader first.', answered }],
  ]);
  const manifest = await planGalleryCleanup(wiki(), profile, ['Hero/Gallery', 'Villain/Gallery'], { answers });
  const of = <K extends ManifestEntry['kind']>(kind: K) => manifest.entries.filter((entry): entry is Extract<ManifestEntry, { kind: K }> => entry.kind === kind);

  test('unanswered file questions offer keep and nominate', async () => {
    const unanswered = await planGalleryCleanup(wiki(), profile, ['Hero/Gallery']);
    assert.deepEqual(
      unanswered.entries.filter((entry) => entry.kind === 'question').map((question) => [question.about, question.choices]),
      [
        ['Hero/Gallery', undefined],
        ['File:Hero guide scan.png', ['keep', 'nominate']],
        ['File:Figure.jpg', ['keep', 'nominate']],
      ],
    );
  });

  test('"keep" is not asked again, but the image is still tagged', () => {
    assert.ok(!of('question').some((question) => question.about === 'File:Figure.jpg'));
    assert.ok(of('category-tag').some((tag) => tag.title === 'File:Figure.jpg'));
  });

  test('"nominate" nominates it after all, noting the pages still linking, and still tags it', () => {
    const scan = of('file-nominate').find((file) => file.title === 'File:Hero guide scan.png');
    assert.equal(scan?.reason, 'Only shown on Hero/Gallery (gallery page replaced by image categories); you chose to nominate it; still linked from Hero');
    assert.ok(manifest.edits.find((edit) => edit.title === 'File:Hero guide scan.png')?.text.startsWith('{{delete|reason=Only shown on Hero/Gallery (gallery page replaced by image categories)}}\n'));
    assert.ok(of('category-tag').some((tag) => tag.title === 'File:Hero guide scan.png'));
  });

  test('free text is asked again, with the answer', () => {
    const question = of('question').find((candidate) => candidate.about === 'File:Villain guide scan.png');
    assert.equal(question?.answer, 'Ask the uploader first.');
    assert.deepEqual(question?.choices, ['keep', 'nominate']);
  });
});

describe('planGalleryCleanup and the profile rules', () => {
  test('a new image category that adds a forbidden template is an error', async () => {
    const strict = { ...profile, rules: { createPagesIn: ['Category'], forbiddenTemplates: ['category'] } } as Profile;
    const manifest = await planGalleryCleanup(wiki(), strict, ['Nobody/Gallery']);
    const created = manifest.entries.find((entry) => entry.kind === 'page-create');
    assert.deepEqual(created?.kind === 'page-create' ? [created.title, created.approved, created.errors.map((error) => error.code)] : undefined, [
      'Category:Images of Nobody',
      false,
      ['forbidden-template'],
    ]);
  });
});
