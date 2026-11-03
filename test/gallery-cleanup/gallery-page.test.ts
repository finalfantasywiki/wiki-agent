import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gallerySubject, isGalleryPage, parseGalleryPage } from '../../src/gallery-cleanup/gallery-page.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../helpers/siteinfo.ts';

const client = fakeWiki(() => {
  throw new Error('parseGalleryPage must not call the API');
});
loadSiteInfo(client);

const parse = (text: string) => parseGalleryPage(client, text);

// Hand-written, in the shape of a character gallery.
const SAMPLE = `==''Example'' series==
===''[[Example Game]]''===
====Artwork====
{{See|Example Game concept art}}
<gallery>
Hero artwork.png|Artwork by someone.
File:Hero sketch.jpg|Early sketch.
</gallery>

====Screenshots====
<gallery>
Hero_in_town.png
</gallery>

===''[[Example Game Remake]]/[[Example Game Remake Intergrade|Intergrade]]''===
[[File:Hero remake render.png|thumb|A render.]]

==Other media==
===Merchandise===
<gallery>
Hero figure.jpg|An [[action figure]].
</gallery>

[[Category:Character galleries from Example Game]]`;

describe('parseGalleryPage', () => {
  const { images, invalid } = parse(SAMPLE);
  const headingsOf = (title: string) => images.find((image) => image.title === title)?.headings.map((heading) => heading.text);

  test('every image, normalized, with its caption', () => {
    assert.deepEqual(
      images.map(({ title, kind, caption }) => ({ title, kind, caption })),
      [
        { title: 'File:Hero artwork.png', kind: 'gallery', caption: 'Artwork by someone.' },
        { title: 'File:Hero sketch.jpg', kind: 'gallery', caption: 'Early sketch.' },
        { title: 'File:Hero in town.png', kind: 'gallery', caption: '' },
        { title: 'File:Hero remake render.png', kind: 'embed', caption: '[[File:Hero remake render.png|thumb|A render.]]' },
        { title: 'File:Hero figure.jpg', kind: 'gallery', caption: 'An [[action figure]].' },
      ],
    );
    assert.deepEqual(invalid, []);
  });

  test('the headings each image is under, outermost first', () => {
    assert.deepEqual(headingsOf('File:Hero artwork.png'), ['Example series', 'Example Game', 'Artwork']);
    assert.deepEqual(headingsOf('File:Hero in town.png'), ['Example series', 'Example Game', 'Screenshots']);
    assert.deepEqual(headingsOf('File:Hero remake render.png'), ['Example series', 'Example Game Remake/Intergrade']);
    assert.deepEqual(headingsOf('File:Hero figure.jpg'), ['Other media', 'Merchandise']);
  });

  test('headings keep their level and the pages they link to', () => {
    const remake = images.find((image) => image.title === 'File:Hero remake render.png')?.headings.at(-1);
    assert.deepEqual(remake, {
      level: 3,
      text: 'Example Game Remake/Intergrade',
      links: ['Example Game Remake', 'Example Game Remake Intergrade'],
    });
  });

  test('ignores commented-out lines and comments after headings', () => {
    const { images } = parse('==Game== <!-- note -->\n<gallery>\n<!--Old.png|gone-->\nKept.png|<!-- c -->Caption\n</gallery>');
    assert.deepEqual(
      images.map(({ title, caption, headings }) => ({ title, caption, headings: headings.map((heading) => heading.text) })),
      [{ title: 'File:Kept.png', caption: '<!-- c -->Caption', headings: ['Game'] }],
    );
  });

  test('lines that are not file titles are reported, not guessed at', () => {
    const { images, invalid } = parse('==Game==\n<gallery>\nCategory:Not a file\nBad<name>.png|x\nGood.png\n</gallery>');
    assert.deepEqual(images.map((image) => image.title), ['File:Good.png']);
    assert.deepEqual(invalid.map((line) => line.line), ['Category:Not a file', 'Bad<name>.png|x']);
  });

  test('an unclosed gallery runs to the end', () => {
    assert.deepEqual(parse('<gallery>\nA.png\nB.png').images.map((image) => image.title), ['File:A.png', 'File:B.png']);
  });
});

describe('gallery titles', () => {
  test('isGalleryPage and gallerySubject', () => {
    assert.equal(isGalleryPage('Tifa Lockhart/Gallery'), true);
    assert.equal(isGalleryPage('Tifa Lockhart'), false);
    assert.equal(gallerySubject('Tifa Lockhart/Gallery'), 'Tifa Lockhart');
    assert.throws(() => gallerySubject('Tifa Lockhart'));
  });
});
