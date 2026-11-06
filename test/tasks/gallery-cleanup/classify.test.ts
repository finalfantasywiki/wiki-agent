import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGalleryImages } from '../../../src/tasks/gallery-cleanup/classify.ts';
import { parseGalleryPage } from '../../../src/tasks/gallery-cleanup/gallery-page.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../../helpers/siteinfo.ts';

const GALLERY = 'Hero/Gallery';
const CATEGORY = 'Category:Images of Hero';

// Hand-written, in the shape of a character gallery.
const TEXT = `==Example Game==
<gallery>
Only here.png
Shared gallery.png
On article.png
Linked.png
Gallery link.png
Missing.png
Only here.png|The same file again.
</gallery>
==Other media==
===Merchandise===
<gallery>
Figure.jpg
Figure on article.jpg
</gallery>`;

const ref = (title: string) => ({ ns: title.startsWith('User:') ? 2 : 0, title });

/** Per file: pages showing it, linking to it, redirects to it, its categories; absent files are missing. */
const FILES: Record<string, { shown: string[]; links?: string[]; redirects?: string[]; categories?: string[] }> = {
  'File:Only here.png': { shown: [GALLERY], redirects: ['File:Old only here.png'] },
  'File:Shared gallery.png': { shown: [GALLERY, 'Villain/Gallery'], categories: [CATEGORY] },
  'File:On article.png': { shown: [GALLERY, 'Hero'] },
  'File:Linked.png': { shown: [GALLERY], links: ['User:Fan', 'Villain/Gallery'] },
  'File:Gallery link.png': { shown: [GALLERY], links: ['Villain/Gallery', 'Talk:Hero/Gallery'] },
  'File:Figure.jpg': { shown: [GALLERY] },
  'File:Figure on article.jpg': { shown: [GALLERY, 'Hero'], categories: [CATEGORY] },
};

function wiki() {
  const client = fakeWiki((params) => {
    const titles = params.get('titles')!.split('|');
    const pages = titles.map((title) => {
      const file = FILES[title];
      if (file === undefined) return { title, missing: true };
      return params.get('prop') === 'imageinfo|categories'
        ? { title, imageinfo: [{ url: 'u', width: 1, height: 1, size: 1, mime: 'image/png', sha1: 's', user: 'U', timestamp: 't' }], categories: (file.categories ?? []).map((c) => ({ title: c })) }
        : { title, fileusage: file.shown.map(ref), linkshere: (file.links ?? []).map(ref), redirects: (file.redirects ?? []).map(ref) };
    });
    return { query: { pages } };
  });
  loadSiteInfo(client);
  return client;
}

describe('classifyGalleryImages', async () => {
  const client = wiki();
  const images = await classifyGalleryImages(client, parseGalleryPage(client, TEXT), { category: CATEGORY });
  const get = (title: string) => images.find((image) => image.title === `File:${title}`)!;

  test('one entry per file, in page order, from its first appearance', () => {
    assert.deepEqual(images.map((image) => image.title), [
      'File:Only here.png',
      'File:Shared gallery.png',
      'File:On article.png',
      'File:Linked.png',
      'File:Gallery link.png',
      'File:Missing.png',
      'File:Figure.jpg',
      'File:Figure on article.jpg',
    ]);
    assert.equal(get('Only here.png').caption, '');
  });

  test('verdicts', () => {
    assert.deepEqual(Object.fromEntries(images.map((image) => [image.title.slice(5), image.verdict])), {
      'Only here.png': 'nominate',
      'Shared gallery.png': 'nominate',
      'On article.png': 'keep',
      'Linked.png': 'linked',
      'Gallery link.png': 'nominate',
      'Missing.png': 'missing',
      'Figure.jpg': 'move',
      'Figure on article.jpg': 'keep',
    });
  });

  test('only links from pages that stay keep a file: not galleries or their talk pages', () => {
    assert.deepEqual(get('Gallery link.png').linkedFrom, []);
  });

  test('galleries, other pages, links and redirects', () => {
    assert.deepEqual(get('Shared gallery.png').galleries, [GALLERY, 'Villain/Gallery']);
    assert.deepEqual(get('On article.png').shownOn, [ref('Hero')]);
    assert.deepEqual(get('Linked.png').linkedFrom, [ref('User:Fan')]);
    assert.deepEqual(get('Only here.png').redirects, [{ ns: 0, title: 'File:Old only here.png' }]);
  });

  test('whether it is in the category already', () => {
    assert.equal(get('Figure on article.jpg').inCategory, true);
    assert.equal(get('On article.png').inCategory, false);
  });

  test('other sections can be moved instead of deleted', async () => {
    const other = wiki();
    const moved = await classifyGalleryImages(other, parseGalleryPage(other, TEXT), { category: CATEGORY, moveSections: /^Example Game$/ });
    assert.equal(moved.find((image) => image.title === 'File:Only here.png')?.verdict, 'move');
    assert.equal(moved.find((image) => image.title === 'File:Figure.jpg')?.verdict, 'nominate');
  });

  test('two requests per 50 files', () => {
    assert.equal(client.requests.length, 2);
  });
});
