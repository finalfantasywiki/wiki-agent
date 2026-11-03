import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NamingRules } from '../src/file-renames/file-name.ts';
import { buildVocabulary } from '../src/file-renames/vocabulary.ts';
import { planBatch } from '../src/plan-batch.ts';
import { loadProfile } from '../src/profile.ts';
import { fakeWorld, type World } from './helpers/fake-world.ts';

const sample: unknown = JSON.parse(readFileSync(new URL('fixtures/codename-sample/export.json', import.meta.url), 'utf8'));
const rules: NamingRules = { vocabulary: buildVocabulary(sample, { releaseTokens: {}, versionTokens: {}, versionNeutral: [] }), types: ['render', 'model'] };
const profile = await loadProfile('finalfantasy');

const OLD_CAT = 'Category:Final Fantasy VII character images';
const NEW_CAT = 'Category:Character images from Final Fantasy VII';

const world: World = {
  pages: {
    'File:Barret.jpg': `Barret.\n[[${OLD_CAT}]]`,
    'File:Lonely.png': `[[${OLD_CAT}]]`,
    'File:Unused.png': '',
    'File:Used.png': '',
    'Barret Wallace': '[[File:Barret.jpg|thumb]]',
    'Cloud Strife': '[[File:Used.png]]',
    [OLD_CAT]: '[[Category:Character images]]',
    'Category:Character images': '',
  },
  members: { [OLD_CAT]: ['File:Barret.jpg', 'File:Lonely.png'] },
  shownOn: { 'File:Barret.jpg': ['Barret Wallace'], 'File:Used.png': ['Cloud Strife'] },
};

const plan = () =>
  planBatch(fakeWorld(world), profile, rules, {
    files: [
      { from: 'Barret.jpg', to: 'Barret Wallace from FFVII battle model.jpg', reason: 'battle model', confidence: 0.9 },
      { from: 'Lonely.png', to: 'Aeris Gainsborough from FFVII model.png', confidence: 0.9 },
      { from: 'Gone.png', to: 'Cloud Strife from FFVII model.png', confidence: 0.9 },
      { from: 'Unused.png', to: 'Cloud Strife from FFVII screen.png', confidence: 0.9 },
    ],
    categories: [{ from: OLD_CAT, to: NEW_CAT, related: "[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']]" }],
    deletions: [
      { title: 'Unused.png', reason: 'not used' },
      { title: 'File:Used.png', reason: 'duplicate' },
    ],
    questions: [{ about: 'File:Mystery.png', question: 'Who is this?' }],
  });

describe('planBatch', () => {
  test('one manifest with every kind of entry', async () => {
    const manifest = await plan();
    assert.deepEqual(
      manifest.entries.map((entry) => `${entry.id}:${entry.kind === 'question' ? entry.about : 'from' in entry ? entry.from : entry.title}`),
      ['q1:File:Mystery.png', 'q2:File:Gone.png', 'f1:File:Barret.jpg', 'f2:File:Lonely.png', 'f3:File:Unused.png', 'd1:File:Unused.png', 'd2:File:Used.png', `c1:${OLD_CAT}`],
    );
  });

  test('page edits combine file renames and category re-tags', async () => {
    const manifest = await plan();
    const edits = new Map(manifest.edits.map((edit) => [edit.title, edit]));
    assert.equal(edits.get('Barret Wallace')?.text, '[[File:Barret Wallace from FFVII battle model.jpg|thumb]]');
    assert.deepEqual(edits.get('Barret Wallace')?.entries, ['f1']);
    assert.equal(edits.get('File:Barret.jpg')?.text, `Barret.\n[[${NEW_CAT}]]`);
    assert.deepEqual(edits.get('File:Barret.jpg')?.entries, ['c1']);
    assert.ok(!edits.has(OLD_CAT), 'the old category page is replaced, not edited');
  });

  test('issues: unused files, invalid names, files still in use', async () => {
    const entries = new Map((await plan()).entries.map((entry) => [entry.id, entry]));
    const codes = (id: string) => {
      const entry = entries.get(id);
      return entry === undefined || entry.kind === 'question' ? [] : [...entry.errors, ...entry.warnings].map((issue) => issue.code);
    };
    assert.deepEqual(codes('f1'), []);
    assert.deepEqual(codes('f2'), ['unused']);
    assert.deepEqual(codes('f3'), ['not-parsed'], 'an invalid name is not called unused');
    assert.deepEqual(codes('d1'), []);
    assert.deepEqual(codes('d2'), ['in-use']);
    assert.deepEqual(codes('c1'), ['old-text-kept', 'header-added']);
  });

  test('the new category page gets the profile header', async () => {
    const category = (await plan()).entries.find((entry) => entry.kind === 'category-rename');
    assert.equal(
      category?.kind === 'category-rename' ? category.create?.text : undefined,
      "{{category |name=Character images from ''Final Fantasy VII'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']] }}\n\n[[Category:Character images]]",
    );
  });

  test('an empty batch makes an empty manifest without asking the wiki', async () => {
    const client = fakeWorld(world);
    const manifest = await planBatch(client, profile, rules, {});
    assert.deepEqual([manifest.entries, manifest.edits], [[], []]);
    assert.equal(client.requests.length, 0);
  });
});

describe('planBatch replacements', () => {
  const copies: World = {
    pages: {
      'File:Reno small.jpg': '',
      'File:Reno.png': '',
      'File:Rude small.jpg': '',
      'File:Rude.png': '',
      'File:Elena small.jpg': '',
      'File:Odd small.jpg': '',
      Reno: '[[File:Reno small.jpg|thumb]]',
      Rude: '{{Rude box}}',
      'Template:Rude box': '<span>[[File:Rude small.jpg]]</span>',
      Turks: '[[File:Reno small.jpg]] [[File:Reno.png]]',
      Gallery: '{{#tag:gallery|Odd small.jpg}}',
    },
    shownOn: {
      'File:Reno small.jpg': ['Reno', 'Turks'],
      'File:Reno.png': ['Turks'],
      'File:Rude small.jpg': ['Rude', 'Template:Rude box'],
      'File:Odd small.jpg': ['Gallery'],
    },
    transcludes: { Rude: ['Template:Rude box'] },
  };
  const planCopies = () =>
    planBatch(fakeWorld(copies), profile, rules, {
      files: [{ from: 'Reno.png', to: 'Reno from FFVII model.png', confidence: 0.9 }],
      deletions: [
        { title: 'Reno small.jpg', reason: 'low-res copy', replaceWith: 'Reno.png' },
        { title: 'Rude small.jpg', reason: 'low-res copy', replaceWith: 'File:Rude.png' },
        { title: 'Elena small.jpg', reason: 'low-res copy', replaceWith: 'Elena.png' },
        { title: 'Odd small.jpg', reason: 'low-res copy', replaceWith: 'Reno small.jpg' },
      ],
    });

  test('usages point at the replacement under its final name, and the edits serve the deletion', async () => {
    const manifest = await planCopies();
    const edits = new Map(manifest.edits.map((edit) => [edit.title, edit]));
    assert.equal(edits.get('Reno')?.text, '[[File:Reno from FFVII model.png|thumb]]', 'renamed in the batch: its new name');
    assert.deepEqual(edits.get('Reno')?.entries, ['d1']);
    assert.equal(edits.get('Turks')?.text, '[[File:Reno from FFVII model.png]] [[File:Reno from FFVII model.png]]', 'both copies on one page end up the same file');
    assert.deepEqual(edits.get('Turks')?.entries, ['d1', 'f1']);
    assert.equal(edits.get('Template:Rude box')?.text, '<span>[[File:Rude.png]]</span>', 'not renamed: its current name');
    assert.ok(!edits.has('Gallery'), 'a replacement with errors gets no edits');
  });

  test('a replacement is used by nothing once rewritten; a bad one is an error and still in use', async () => {
    const deletions = (await planCopies()).entries.flatMap((entry) => (entry.kind === 'file-delete' ? [entry] : []));
    assert.deepEqual(
      deletions.map((entry) => [entry.id, entry.replacedBy, entry.usedBy, entry.errors.map((error) => error.code)]),
      [
        ['d1', 'File:Reno from FFVII model.png', [], []],
        ['d2', 'File:Rude.png', [], []],
        ['d3', 'File:Elena.png', [], ['replacement-missing']],
        ['d4', 'File:Reno small.jpg', ['Gallery'], ['replacement-missing', 'in-use']],
      ],
    );
    assert.match(deletions[2]!.errors[0]!.message, /does not exist/);
    assert.match(deletions[3]!.errors[0]!.message, /being deleted too/);
    assert.ok(deletions.every((entry) => !entry.approved), 'deletions never start approved');
  });
});
