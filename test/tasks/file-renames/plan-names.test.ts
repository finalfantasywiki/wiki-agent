import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NamingRules } from '../../../src/tasks/file-renames/file-name.ts';
import { planNames, type RenameProposal } from '../../../src/tasks/file-renames/plan-names.ts';
import { buildVocabulary } from '../../../src/tasks/file-renames/vocabulary.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';

const sample: unknown = JSON.parse(readFileSync(new URL('../../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));
const rules: NamingRules = {
  vocabulary: buildVocabulary(sample, { releaseTokens: {}, versionTokens: {}, versionNeutral: [] }),
  types: ['render', 'gameplay', 'concept art'],
};

/** A wiki where exactly `existing` exist (files get image info). */
function wiki(existing: readonly string[]) {
  const set = new Set(existing);
  return fakeWiki((params) => {
    const titles = params.get('titles')!.split('|');
    const pages = titles.map((title) =>
      !set.has(title)
        ? { title, missing: true }
        : params.get('prop')?.includes('imageinfo')
          ? { title, imageinfo: [{ url: `https://img/${title}`, thumburl: `https://img/thumb/${title}`, descriptionurl: `https://wiki/${title}`, width: 1, height: 1, size: 1, mime: 'image/png', sha1: 'x', user: 'U', timestamp: 'T' }] }
          : { title },
    );
    return { query: { pages } };
  });
}

const plan = (existing: readonly string[], proposals: readonly RenameProposal[]) => planNames(wiki(existing), rules, proposals);

describe('planNames', () => {
  test('a free, valid name is kept, with reason and confidence', async () => {
    const [planned] = await plan(['File:Aeris-ffvii-battle.png'], [
      { from: 'Aeris-ffvii-battle.png', to: 'Aeris Gainsborough from FFVII battle render.png', reason: 'battle model', confidence: 0.9 },
    ]);
    assert.equal(planned?.from, 'File:Aeris-ffvii-battle.png');
    assert.equal(planned?.to, 'File:Aeris Gainsborough from FFVII battle render.png');
    assert.equal(planned?.reason, 'battle model');
    assert.equal(planned?.confidence, 0.9);
    assert.deepEqual(planned?.errors, []);
    assert.deepEqual(planned?.warnings, []);
    assert.equal(planned?.pageUrl, 'https://wiki/File:Aeris-ffvii-battle.png');
    assert.equal(planned?.thumbUrl, 'https://img/thumb/File:Aeris-ffvii-battle.png');
  });

  test('joining a numbered set on the wiki takes the next free number', async () => {
    const [planned] = await plan(
      ['File:A.png', 'File:Cloud Strife from FFVII render 1.png', 'File:Cloud Strife from FFVII render 2.png'],
      [{ from: 'A.png', to: 'Cloud Strife from FFVII render.png' }],
    );
    assert.equal(planned?.to, 'File:Cloud Strife from FFVII render 3.png');
    assert.deepEqual(planned?.warnings.map((w) => w.code), ['renumbered']);
    assert.match(planned?.warnings[0]?.message ?? '', /Cloud Strife from FFVII render\.png is taken; it becomes/);
  });

  test('an unnumbered file on the wiki starts a set from 1, and is flagged to join it', async () => {
    const [planned] = await plan(['File:A.png', 'File:Cloud from FFVII render.png'], [{ from: 'A.png', to: 'Cloud from FFVII render.png' }]);
    assert.equal(planned?.to, 'File:Cloud from FFVII render 1.png');
    assert.deepEqual(planned?.warnings.map((w) => w.code), ['renumbered', 'unnumbered-sibling']);
    assert.match(planned?.warnings[1]?.message ?? '', /File:Cloud from FFVII render\.png has no number/);
  });

  test('names in the same batch do not collide', async () => {
    const planned = await plan(['File:A.png', 'File:B.png', 'File:C.png'], [
      { from: 'A.png', to: 'Cloud Strife from FFVII render.png' },
      { from: 'B.png', to: 'Cloud Strife from FFVII render.png' },
      { from: 'C.png', to: 'cloud_Strife from FFVII render.png' },
    ]);
    assert.match(planned[0]?.warnings[0]?.message ?? '', /other files in this batch have the same name/);
    assert.deepEqual(planned.map((p) => p.to), [
      'File:Cloud Strife from FFVII render 1.png',
      'File:Cloud Strife from FFVII render 2.png',
      'File:Cloud Strife from FFVII render 3.png',
    ]);
  });

  test('a name differing only by extension is numbered apart, with a warning', async () => {
    const [planned] = await plan(['File:A.png', 'File:Cloud from FFVII render.jpg'], [{ from: 'A.png', to: 'Cloud from FFVII render.png' }]);
    assert.equal(planned?.to, 'File:Cloud from FFVII render 1.png');
    assert.deepEqual(planned?.warnings.map((w) => w.code), ['renumbered', 'extension-twin', 'unnumbered-sibling']);
    assert.match(planned?.warnings[1]?.message ?? '', /File:Cloud from FFVII render\.jpg/);
  });

  test('extension twins within the batch are numbered apart', async () => {
    const planned = await plan(['File:A.jpg', 'File:B.png'], [
      { from: 'A.jpg', to: 'Cloud from FFVII render.jpg' },
      { from: 'B.png', to: 'Cloud from FFVII render.png' },
    ]);
    assert.deepEqual(planned.map((p) => p.to), ['File:Cloud from FFVII render 1.jpg', 'File:Cloud from FFVII render 2.png']);
    assert.deepEqual(planned[1]?.warnings.map((w) => w.code), ['renumbered', 'extension-twin']);
  });

  test('a requested number is kept if free, and counted up from if not', async () => {
    const [kept, moved] = await plan(['File:A.png', 'File:B.png', 'File:Cloud from FFVII render 4.png'], [
      { from: 'A.png', to: 'Cloud from FFVII render 2.png' },
      { from: 'B.png', to: 'Cloud from FFVII render 4.png' },
    ]);
    assert.equal(kept?.to, 'File:Cloud from FFVII render 2.png');
    assert.equal(moved?.to, 'File:Cloud from FFVII render 5.png');
  });

  test('titled names are numbered without a "from" part', async () => {
    const planned = await plan(['File:A.jpg', 'File:B.jpg'], [
      { from: 'A.jpg', to: 'Final Fantasy VII Technical Demo for PS3 render.jpg' },
      { from: 'B.jpg', to: 'Final Fantasy VII Technical Demo for PS3 render.jpg' },
    ]);
    assert.deepEqual(planned.map((p) => p.to), [
      'File:Final Fantasy VII Technical Demo for PS3 render 1.jpg',
      'File:Final Fantasy VII Technical Demo for PS3 render 2.jpg',
    ]);
  });

  test('renaming a file to its own name is not a collision', async () => {
    const [planned] = await plan(['File:Cloud from FFVII render.png'], [{ from: 'Cloud from FFVII render.png', to: 'Cloud from FFVII render.png' }]);
    assert.equal(planned?.to, 'File:Cloud from FFVII render.png');
    assert.deepEqual(planned?.warnings.map((w) => w.code), ['unchanged']);
  });

  test('numbering checks candidates in batches, past the first round', async () => {
    const taken = Array.from({ length: 7 }, (_, i) => `File:Cloud from FFVII render ${i + 1}.png`);
    const client = wiki(['File:A.png', ...taken]);
    const [planned] = await planNames(client, rules, [{ from: 'A.png', to: 'Cloud from FFVII render.png' }]);
    assert.equal(planned?.to, 'File:Cloud from FFVII render 8.png');
    // 1 file-info request, then 2 rounds of 5 candidates.
    assert.equal(client.requests.length, 3);
  });

  test('a missing source and a duplicate source are errors', async () => {
    const planned = await plan(['File:A.png'], [
      { from: 'Gone.png', to: 'Cloud from FFVII render.png' },
      { from: 'A.png', to: 'Tifa from FFVII render.png' },
      { from: 'File:A.png', to: 'Barret from FFVII render.png' },
    ]);
    assert.deepEqual(planned.map((p) => p.errors.map((e) => e.code)), [['source-missing'], [], ['duplicate-source']]);
  });

  test('invalid names keep their validation errors and are not numbered', async () => {
    const [planned] = await plan(['File:A.png'], [{ from: 'A.png', to: 'Cloud from FFVII render.jpg' }]);
    assert.deepEqual(planned?.errors.map((e) => e.code), ['extension-changed']);
    assert.equal(planned?.to, 'File:Cloud from FFVII render.jpg');
  });

  test('validation warnings are passed on', async () => {
    const [planned] = await plan(['File:A.png'], [{ from: 'A.png', to: 'Terra from FFVI render.png' }]);
    assert.deepEqual(planned?.warnings.map((w) => w.code), ['version-missing']);
  });
});
