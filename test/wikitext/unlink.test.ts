import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { removeLinks, type UnlinkOptions } from '../../src/wikitext/unlink.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../helpers/siteinfo.ts';

const client = fakeWiki(() => {
  throw new Error('removeLinks must not call the API');
});
loadSiteInfo(client);

const GALLERY = 'Hero/Gallery';
const unlink = (text: string, options: Partial<UnlinkOptions> = {}) => removeLinks(client, text, [GALLERY], { page: 'Some page', ...options });

describe('links', () => {
  test('become their text, with or without a section', () => {
    assert.equal(unlink('See [[Hero/Gallery|the gallery]].').text, 'See the gallery.');
    assert.equal(unlink('See [[Hero/Gallery#Remake|Remake images]].').text, 'See Remake images.');
    assert.equal(unlink('See [[Hero/Gallery]].').text, 'See Hero/Gallery.');
  });

  test('match underscores, a lowercase first letter and a leading colon', () => {
    assert.equal(unlink('[[hero/Gallery|a]] [[:Hero_Gallery|b]] [[:Hero/Gallery|c]]').text, 'a [[:Hero_Gallery|b]] c');
  });

  test('relative links resolve against the page', () => {
    assert.equal(unlink('[[/Gallery|Images]]', { page: 'Hero' }).text, 'Images');
    assert.equal(unlink('[[/Gallery|Images]]', { page: 'Villain' }).text, '[[/Gallery|Images]]');
  });

  test('in an image caption too', () => {
    assert.equal(unlink('[[File:A.png|thumb|More in [[Hero/Gallery|the gallery]].]]').text, '[[File:A.png|thumb|More in the gallery.]]');
  });

  test('other links stay, and each removal is recorded', () => {
    const { text, rewrites } = unlink('[[Hero]] and [[Hero/Gallery|gallery]]');
    assert.equal(text, '[[Hero]] and gallery');
    assert.deepEqual(rewrites, [{ kind: 'link', from: GALLERY, before: '[[Hero/Gallery|gallery]]', after: 'gallery' }]);
  });
});

describe('images that link to a target', () => {
  test('lose the link parameter', () => {
    const { text, rewrites } = unlink('[[File:Hero.png|400x250px|link=Hero/Gallery]]');
    assert.equal(text, '[[File:Hero.png|400x250px]]');
    assert.deepEqual(rewrites.map((rewrite) => rewrite.kind), ['embed']);
  });

  test('linking elsewhere, they stay', () => {
    assert.equal(unlink('[[File:Hero.png|link=Hero]]').text, '[[File:Hero.png|link=Hero]]');
  });
});

describe('template parameters', () => {
  const parameters = [{ name: 'gallery', target: GALLERY }];

  test('are removed, whatever their value or spacing', () => {
    assert.equal(
      unlink('{{Infobox character\n|name = Hero\n|gallery=true\n|image=Hero.png\n}}', { parameters }).text,
      '{{Infobox character\n|name = Hero\n|image=Hero.png\n}}',
    );
    assert.equal(unlink('{{Infobox|gallery = yes}}', { parameters }).text, '{{Infobox}}');
  });

  test('only when asked', () => {
    assert.equal(unlink('{{Infobox|gallery=true}}').text, '{{Infobox|gallery=true}}');
  });

  test('a parameter naming a target is a leftover, not removed', () => {
    const { text, leftovers } = unlink('{{See also|Hero/Gallery}}');
    assert.equal(text, '{{See also|Hero/Gallery}}');
    assert.deepEqual(leftovers, [{ from: GALLERY, line: '|Hero/Gallery' }]);
  });
});

describe('masked text', () => {
  test('links in comments and nowiki are left alone, and are not leftovers', () => {
    const { text, leftovers } = unlink('<!-- [[Hero/Gallery]] --> <nowiki>[[Hero/Gallery]]</nowiki> [[Hero/Gallery|x]]');
    assert.equal(text, '<!-- [[Hero/Gallery]] --> <nowiki>[[Hero/Gallery]]</nowiki> x');
    assert.deepEqual(leftovers, []);
  });
});

describe('pointer templates', () => {
  const pointers = ['main', 'see also'];
  const pointer = (text: string) => unlink(text, { page: 'Hero', pointers });

  test('a section with only {{main}} goes, heading and all', () => {
    const { text, rewrites } = pointer('Intro.\n\n==Gallery==\n{{main|/Gallery|t1=Hero gallery}}\n\n==Etymology==\nText.');
    assert.equal(text, 'Intro.\n\n==Etymology==\nText.');
    assert.deepEqual(rewrites.map((rewrite) => [rewrite.kind, rewrite.before]), [
      ['template', '{{main|/Gallery|t1=Hero gallery}}'],
      ['template', '==Gallery=='],
    ]);
  });

  test('a section with more in it keeps its heading and text', () => {
    assert.equal(
      pointer('===Merchandise===\n{{Main|Hero/Gallery#Merchandise|t1=Hero merchandise gallery}}\nHero has appeared in figures.\n\n==Next==').text,
      '===Merchandise===\nHero has appeared in figures.\n\n==Next==',
    );
  });

  test('the heading stays when subsections follow', () => {
    assert.equal(pointer('==Gallery==\n{{main|/Gallery}}\n===Concept art===\nText.').text, '==Gallery==\n===Concept art===\nText.');
  });

  test('the last section, at the end of the page, with the blank lines before it', () => {
    assert.equal(pointer('Text.\n\n== Gallery ==\n{{see_also|Hero/Gallery}}').text, 'Text.');
    assert.equal(pointer('Text.\n\n== Gallery ==\n{{see_also|Hero/Gallery}}\n\n').text, 'Text.');
  });

  test('inline, only the template goes', () => {
    assert.equal(pointer('Images: {{see also|Hero/Gallery}} and more.').text, 'Images:  and more.');
  });

  test('pointing at other pages too, it is a leftover', () => {
    const { text, leftovers } = pointer('==Gallery==\n{{main|/Gallery|Hero/Other appearances}}');
    assert.equal(text, '==Gallery==\n{{main|/Gallery|Hero/Other appearances}}');
    assert.deepEqual(leftovers.map((leftover) => leftover.line), ['|/Gallery']);
  });

  test('templates not named as pointers are left alone', () => {
    assert.deepEqual(unlink('{{main|/Gallery}}', { page: 'Hero' }).leftovers.map((leftover) => leftover.line), ['|/Gallery']);
  });
});
