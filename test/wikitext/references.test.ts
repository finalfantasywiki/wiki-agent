import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteReferences, type Rename } from '../../src/wikitext/references.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../helpers/siteinfo.ts';

const client = fakeWiki(() => {
  throw new Error('rewriteReferences must not call the API');
});
loadSiteInfo(client);

const BARRET: Rename = { from: 'File:Barret battle render.jpg', to: 'File:Barret Wallace from FFVII battle render.jpg' };
const CATEGORY: Rename = { from: 'Category:Final Fantasy VII character images', to: 'Category:Character images from Final Fantasy VII' };

const rewrite = (text: string, renames: readonly Rename[] = [BARRET]) => rewriteReferences(client, text, renames);

describe('embedded files and links', () => {
  test('keeps the parameters, and the prefix as written', () => {
    assert.equal(
      rewrite('[[File:Barret battle render.jpg|thumb|left|Barret]]').text,
      '[[File:Barret Wallace from FFVII battle render.jpg|thumb|left|Barret]]',
    );
    assert.equal(rewrite('[[Image:Barret battle render.jpg]]').text, '[[Image:Barret Wallace from FFVII battle render.jpg]]');
  });

  test('matches underscores, a lowercase first letter and a lowercase namespace, keeping underscores', () => {
    assert.equal(rewrite('[[file:barret_battle_render.jpg|20px]]').text, '[[file:Barret_Wallace_from_FFVII_battle_render.jpg|20px]]');
    assert.equal(rewrite('[[File:barret battle render.jpg]]').text, '[[File:Barret Wallace from FFVII battle render.jpg]]');
  });

  test('files nested in captions, and links in captions are left alone', () => {
    const renames = [BARRET, { from: 'File:Icon.png', to: 'File:Barret icon from FFVII.png' }];
    assert.equal(
      rewrite('[[File:Barret battle render.jpg|thumb|With [[Gun-arm|his gun-arm]] and [[File:Icon.png|20px]]]]', renames).text,
      '[[File:Barret Wallace from FFVII battle render.jpg|thumb|With [[Gun-arm|his gun-arm]] and [[File:Barret icon from FFVII.png|20px]]]]',
    );
  });

  test('[[:File:]] and [[Media:]] links', () => {
    const { text, rewrites } = rewrite('See [[:File:Barret battle render.jpg|this]] or [[Media:Barret battle render.jpg]].');
    assert.equal(text, 'See [[:File:Barret Wallace from FFVII battle render.jpg|this]] or [[Media:Barret Wallace from FFVII battle render.jpg]].');
    assert.deepEqual(rewrites.map((r) => r.kind), ['link', 'link']);
  });

  test('every occurrence, and nothing else changes', () => {
    const text = 'A [[File:Barret battle render.jpg]]\n\nB [[File:Other.png]] [[File:Barret battle render.jpg]]';
    assert.equal(
      rewrite(text).text,
      'A [[File:Barret Wallace from FFVII battle render.jpg]]\n\nB [[File:Other.png]] [[File:Barret Wallace from FFVII battle render.jpg]]',
    );
  });
});

describe('categories', () => {
  test('category tags keep their sort key; category links are rewritten', () => {
    const { text, rewrites } = rewrite(
      '[[Category:Final Fantasy VII character images|Barret]]\n[[Category:Final_Fantasy_VII_character_images]]\nSee [[:Category:Final Fantasy VII character images]].',
      [CATEGORY],
    );
    assert.equal(
      text,
      '[[Category:Character images from Final Fantasy VII|Barret]]\n[[Category:Character_images_from_Final_Fantasy_VII]]\nSee [[:Category:Character images from Final Fantasy VII]].',
    );
    assert.deepEqual(rewrites.map((r) => r.kind), ['category', 'category', 'link']);
  });
});

describe('galleries', () => {
  test('lines with and without a prefix, keeping captions', () => {
    const { text, rewrites } = rewrite(
      '<gallery widths="120">\nFile:Barret battle render.jpg|In battle\nBarret battle render.jpg|No prefix\nOther.png|Untouched\n</gallery>',
    );
    assert.equal(
      text,
      '<gallery widths="120">\nFile:Barret Wallace from FFVII battle render.jpg|In battle\nBarret Wallace from FFVII battle render.jpg|No prefix\nOther.png|Untouched\n</gallery>',
    );
    assert.deepEqual(rewrites.map((r) => r.kind), ['gallery', 'gallery']);
  });

  test('a gallery line without a caption', () => {
    assert.equal(
      rewrite('<gallery>\nbarret_battle_render.jpg\n</gallery>').text,
      '<gallery>\nBarret_Wallace_from_FFVII_battle_render.jpg\n</gallery>',
    );
  });
});

describe('template parameters', () => {
  test('named and positional parameters holding a file name', () => {
    const { text, rewrites } = rewrite('{{Infobox character\n|image = Barret battle render.jpg\n|caption=Barret}}\n{{Gallery|File:Barret battle render.jpg|caption}}');
    assert.equal(
      text,
      '{{Infobox character\n|image = Barret Wallace from FFVII battle render.jpg\n|caption=Barret}}\n{{Gallery|File:Barret Wallace from FFVII battle render.jpg|caption}}',
    );
    assert.deepEqual(rewrites.map((r) => r.kind), ['template', 'template']);
  });

  test('a parameter in a nested template', () => {
    assert.equal(
      rewrite('{{Tabs|1={{Infobox|image=Barret battle render.jpg}}}}').text,
      '{{Tabs|1={{Infobox|image=Barret Wallace from FFVII battle render.jpg}}}}',
    );
  });

  test('a comment next to the value', () => {
    assert.equal(
      rewrite('{{Infobox|image=Barret battle render.jpg<!-- old -->|x=1}}').text,
      '{{Infobox|image=Barret Wallace from FFVII battle render.jpg<!-- old -->|x=1}}',
    );
  });

  test('values that only contain the name are not rewritten', () => {
    const { text, leftovers } = rewrite('{{Infobox|caption=Barret battle render.jpg is old}}');
    assert.equal(text, '{{Infobox|caption=Barret battle render.jpg is old}}');
    assert.deepEqual(leftovers, [{ from: 'File:Barret battle render.jpg', line: '{{Infobox|caption=Barret battle render.jpg is old}}' }]);
  });
});

describe('left alone', () => {
  test('comments, nowiki, pre and syntaxhighlight', () => {
    const text = [
      '<!-- [[File:Barret battle render.jpg]] -->',
      '<nowiki>[[File:Barret battle render.jpg]]</nowiki>',
      '<pre>[[File:Barret battle render.jpg]]</pre>',
      '<syntaxhighlight lang="text">[[File:Barret battle render.jpg]]</syntaxhighlight>',
    ].join('\n');
    const result = rewrite(text);
    assert.equal(result.text, text);
    assert.deepEqual(result.rewrites, []);
    assert.deepEqual(result.leftovers, [], 'mentions in comments etc. are not leftovers');
  });

  test('nested regions come back intact', () => {
    const text = '<pre><nowiki>[[File:Barret battle render.jpg]]</nowiki> {{#ifeq:A|B|x}}</pre>\n[[File:Barret battle render.jpg]]';
    assert.equal(rewrite(text).text, '<pre><nowiki>[[File:Barret battle render.jpg]]</nowiki> {{#ifeq:A|B|x}}</pre>\n[[File:Barret Wallace from FFVII battle render.jpg]]');
  });

  test('an unclosed comment runs to the end', () => {
    const text = '[[File:Barret battle render.jpg]]\n<!-- [[File:Barret battle render.jpg]]\nstill a comment';
    assert.equal(rewrite(text).text, '[[File:Barret Wallace from FFVII battle render.jpg]]\n<!-- [[File:Barret battle render.jpg]]\nstill a comment');
  });

  test('a self-closing <nowiki/> does not hide what follows', () => {
    assert.equal(
      rewrite('A<nowiki/> [[File:Barret battle render.jpg]] <source lang="lua">-- [[File:Barret battle render.jpg]]</source>').text,
      'A<nowiki/> [[File:Barret Wallace from FFVII battle render.jpg]] <source lang="lua">-- [[File:Barret battle render.jpg]]</source>',
    );
  });

  test('a text with no references', () => {
    assert.deepEqual(rewrite('Just text.'), { text: 'Just text.', rewrites: [], leftovers: [] });
  });
});

describe('leftovers', () => {
  test('names built by parser functions are reported, not guessed', () => {
    const { text, leftovers } = rewrite('{{#if:{{{x|}}}|[[File:Barret battle render.jpg]]|[[File:{{{y}}}.png]]}}\nimage=Barret_battle render.jpg in prose');
    assert.ok(text.includes('[[File:Barret Wallace from FFVII battle render.jpg]]'), 'the plain link inside is still rewritten');
    assert.deepEqual(leftovers.map((leftover) => leftover.line), ['image=Barret_battle render.jpg in prose']);
  });
});

describe('several renames in one text', () => {
  test('a chain A → B, B → C rewrites each reference once', () => {
    const renames = [
      { from: 'File:A.png', to: 'File:B.png' },
      { from: 'File:B.png', to: 'File:C.png' },
    ];
    assert.equal(rewrite('[[File:A.png]] [[File:B.png]]', renames).text, '[[File:B.png]] [[File:C.png]]');
  });

  test('a swap A ↔ B', () => {
    const renames = [
      { from: 'File:A.png', to: 'File:B.png' },
      { from: 'File:B.png', to: 'File:A.png' },
    ];
    assert.equal(rewrite('[[File:A.png]] <gallery>\nB.png|x\n</gallery> {{T|image=A.png}}', renames).text, '[[File:B.png]] <gallery>\nA.png|x\n</gallery> {{T|image=B.png}}');
  });
});

describe('rewrites', () => {
  test('record what changed, with the real new name', () => {
    assert.deepEqual(rewrite('[[File:Barret battle render.jpg|thumb]]').rewrites, [
      {
        kind: 'embed',
        from: 'File:Barret battle render.jpg',
        before: '[[File:Barret battle render.jpg|thumb]]',
        after: '[[File:Barret Wallace from FFVII battle render.jpg|thumb]]',
      },
    ]);
  });
});
