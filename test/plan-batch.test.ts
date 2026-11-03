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
