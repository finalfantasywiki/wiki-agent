import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedRules } from '../../src/file-renames/load-vocabulary.ts';
import { buildVocabulary } from '../../src/file-renames/vocabulary.ts';
import { createServer } from '../../src/mcp/server.ts';
import { loadManifest } from '../../src/plans/manifest.ts';
import { loadProfile } from '../../src/profile.ts';
import { fakeWorld } from '../helpers/fake-world.ts';
import { connect, type TestClient } from '../helpers/mcp-client.ts';

const sample: unknown = JSON.parse(readFileSync(new URL('../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));
const rules = async (): Promise<LoadedRules> => ({
  rules: { vocabulary: buildVocabulary(sample, { releaseTokens: {}, versionTokens: {}, versionNeutral: [] }), types: ['render', 'model'] },
  source: 'export-module',
  differences: [],
});

const client = fakeWorld({
  pages: {
    'File:Barret.jpg': 'Barret.',
    'File:Tifa.jpg': '',
    'Barret Wallace': '[[File:Barret.jpg|thumb]]',
    Broken: '{{#if:x|[[File:{{{img}}}]]}}',
  },
  shownOn: { 'File:Barret.jpg': ['Barret Wallace'], 'File:Tifa.jpg': ['Broken'] },
});

let mcp: TestClient;
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiki-agent-mcp-'));
  mcp = await connect(createServer({ profile: await loadProfile('finalfantasy'), client, rules, manifestsDir: dir }));
});
after(() => mcp.close());

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((block) => block.text ?? '').join('\n');

/** Plans the two files, returning the manifest ID. */
async function planTwo(): Promise<string> {
  const result = await mcp.callTool('plan_renames', {
    files: [
      { from: 'Barret.jpg', to: 'Barret Wallace from FFVII battle model.jpg', confidence: 0.9 },
      { from: 'Tifa.jpg', to: 'Tifa Lockhart from FFVII model.jpg', confidence: 0.9 },
    ],
  });
  assert.equal(result.isError, false, textOf(result));
  const id = /Saved manifest ([0-9a-f-]{36})/.exec(textOf(result))?.[1];
  assert.ok(id !== undefined, textOf(result));
  return id;
}

describe('planning tools', () => {
  test('plan_renames saves the manifest and its Markdown, and returns the summary', async () => {
    const id = await planTwo();
    assert.ok(existsSync(join(dir, `${id}.json`)));
    assert.match(readFileSync(join(dir, `${id}.md`), 'utf8'), /```diff/, 'the saved Markdown has diffs');
    const manifest = await loadManifest(id, dir);
    assert.deepEqual(
      manifest.entries.map((entry) => (entry.kind === 'file-rename' ? [entry.id, entry.to, entry.approved] : [])),
      [
        ['f1', 'File:Barret Wallace from FFVII battle model.jpg', true],
        ['f2', 'File:Tifa Lockhart from FFVII model.jpg', false],
      ],
    );
  });

  test('plan_renames takes a deletion replaced by a file the batch renames', async () => {
    const result = await mcp.callTool('plan_renames', {
      files: [{ from: 'Barret.jpg', to: 'Barret Wallace from FFVII battle model.jpg', confidence: 0.9 }],
      deletions: [{ title: 'Tifa.jpg', reason: 'low-res copy', replaceWith: 'Barret.jpg' }],
    });
    assert.equal(result.isError, false, textOf(result));
    const manifest = await loadManifest(/Saved manifest ([0-9a-f-]{36})/.exec(textOf(result))![1]!, dir);
    const deletion = manifest.entries.find((entry) => entry.kind === 'file-delete');
    assert.equal(deletion?.kind === 'file-delete' ? deletion.replacedBy : undefined, 'File:Barret Wallace from FFVII battle model.jpg');
  });

  test('the summary it returns has no diffs', async () => {
    const result = await mcp.callTool('plan_renames', { files: [{ from: 'Barret.jpg', to: 'Barret Wallace from FFVII battle model.jpg' }] });
    assert.ok(textOf(result).includes('| File renames | 1 |'));
    assert.ok(!textOf(result).includes('```diff'));
  });

  test('show_manifest lists page edits by default, and shows diffs on request', async () => {
    const id = await planTwo();
    const list = textOf(await mcp.callTool('show_manifest', { id }));
    assert.ok(list.includes('- Barret Wallace (f1): 1 change(s)'));
    assert.ok(list.includes("Broken (shown) uses File:Tifa.jpg, and its text can't be rewritten"));
    assert.ok(textOf(await mcp.callTool('show_manifest', { id, edits: 'diffs' })).includes('```diff'));
  });

  test('set_approval saves the change; entries with errors are refused', async () => {
    const id = await planTwo();
    const unapproved = await mcp.callTool('set_approval', { id, entries: ['f1'], approved: false });
    assert.equal(unapproved.isError, false);
    const entry = (await loadManifest(id, dir)).entries.find((candidate) => candidate.id === 'f1');
    assert.equal(entry?.kind === 'file-rename' && entry.approved, false);

    const refused = await mcp.callTool('set_approval', { id, entries: ['f2'], approved: true });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /f2 has errors: blocked/);
  });

  test('an unknown manifest is an error', async () => {
    const result = await mcp.callTool('show_manifest', { id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(result.isError, true);
  });

  test('the wiki namespaces are loaded once', () => {
    assert.equal(client.requests.filter((params) => params.get('meta') === 'siteinfo').length, 1);
  });
});

describe('gallery tools', () => {
  // Its own wiki, so the request counts above stay the renames' own.
  const galleries = fakeWorld({
    pages: {
      'Hero/Gallery': '<gallery>\nOnly here.png\nKept.png\n</gallery>\n==Merchandise==\n<gallery>\nFigure.jpg\n</gallery>',
      Hero: '{{Infobox|gallery=true}}\nIntro.\n\n==Gallery==\n{{main|/Gallery}}',
      'Category:Images of Hero': '{{category}}',
      'File:Only here.png': '',
      'File:Kept.png': 'Kept.',
      'File:Figure.jpg': 'A figure.',
    },
    shownOn: { 'File:Only here.png': ['Hero/Gallery'], 'File:Kept.png': ['Hero/Gallery', 'Hero'], 'File:Figure.jpg': ['Hero/Gallery'] },
    linkedFrom: { 'Hero/Gallery': ['Hero'] },
  });
  let gallery: TestClient;
  let answersDir: string;
  before(async () => {
    answersDir = await mkdtemp(join(tmpdir(), 'wiki-agent-answers-'));
    gallery = await connect(createServer({ profile: await loadProfile('finalfantasy'), client: galleries, rules, manifestsDir: dir, answersDir }));
  });
  after(() => gallery.close());
  // Answers are kept per wiki, so each test starts with none.
  beforeEach(() => rm(join(answersDir, 'finalfantasy.json'), { force: true }));

  const idOf = (result: { content: Array<{ type: string; text?: string }> }) => {
    const id = /Saved manifest ([0-9a-f-]{36})/.exec(textOf(result))?.[1];
    assert.ok(id !== undefined, textOf(result));
    return id;
  };
  const summary = (manifest: Awaited<ReturnType<typeof loadManifest>>) =>
    manifest.entries.map((entry) => [entry.id, entry.kind, 'title' in entry ? entry.title : entry.kind === 'question' ? entry.about : '', entry.kind !== 'question' && entry.approved]);

  test('plan_gallery_cleanup saves the manifest, and says to show the files to nominate first', async () => {
    const result = await gallery.callTool('plan_gallery_cleanup', { galleries: ['Hero/Gallery'] });
    assert.equal(result.isError, false, textOf(result));
    assert.match(textOf(result), /1 file\(s\) to nominate for deletion: show them to the user with get_file_info/);
    const manifest = await loadManifest(idOf(result), dir);
    assert.deepEqual(summary(manifest), [
      ['q1', 'question', 'File:Figure.jpg', false],
      ['x1', 'file-nominate', 'File:Only here.png', false],
      ['p1', 'page-delete', 'Hero/Gallery', false],
      ['t1', 'category-tag', 'File:Only here.png', true],
      ['t2', 'category-tag', 'File:Kept.png', true],
      ['t3', 'category-tag', 'File:Figure.jpg', true],
    ]);
    assert.deepEqual(manifest.request, { task: 'gallery-cleanup', galleries: ['Hero/Gallery'] });
    assert.deepEqual(manifest.edits.map((edit) => [edit.title, edit.text]), [
      ['Hero', '{{Infobox}}\nIntro.'],
      ['File:Only here.png', '{{delete|reason=Only shown on Hero/Gallery (gallery page replaced by image categories)}}\n\n[[Category:Images of Hero]]'],
      ['File:Kept.png', 'Kept.\n\n[[Category:Images of Hero]]'],
      ['File:Figure.jpg', 'A figure.\n\n[[Category:Images of Hero]]'],
    ]);
  });

  test('answer_question saves answers; replan applies them and keeps approvals', async () => {
    const first = idOf(await gallery.callTool('plan_gallery_cleanup', { galleries: ['Hero/Gallery'] }));
    assert.equal((await gallery.callTool('set_approval', { id: first, entries: ['x1'], approved: true })).isError, false);
    const answered = await gallery.callTool('answer_question', { id: first, answers: [{ question: 'q1', choice: 'keep' }] });
    assert.equal(answered.isError, false, textOf(answered));
    assert.match(textOf(answered), /File:Figure\.jpg → keep/);

    const replanned = await gallery.callTool('replan', { id: first });
    assert.match(textOf(replanned), new RegExp(`replacing ${first}`));
    const second = await loadManifest(idOf(replanned), dir);
    assert.notEqual(second.id, first);
    assert.deepEqual(summary(second), [
      ['x1', 'file-nominate', 'File:Only here.png', true],
      ['p1', 'page-delete', 'Hero/Gallery', false],
      ['t1', 'category-tag', 'File:Only here.png', true],
      ['t2', 'category-tag', 'File:Kept.png', true],
      ['t3', 'category-tag', 'File:Figure.jpg', true],
    ]);
  });

  test('answers in the user\'s own words are asked again, with the answer', async () => {
    const first = idOf(await gallery.callTool('plan_gallery_cleanup', { galleries: ['Hero/Gallery'] }));
    await gallery.callTool('answer_question', { id: first, answers: [{ question: 'q1', choice: 'other', text: 'Put it in the Merchandise section.' }] });
    const second = await loadManifest(idOf(await gallery.callTool('replan', { id: first })), dir);
    const question = second.entries[0];
    assert.ok(question?.kind === 'question');
    assert.equal(question.answer, 'Put it in the Merchandise section.');
  });

  test('answer_question refuses unknown questions, choices not offered, and "other" without words', async () => {
    const id = idOf(await gallery.callTool('plan_gallery_cleanup', { galleries: ['Hero/Gallery'] }));
    const refused = await gallery.callTool('answer_question', {
      id,
      answers: [
        { question: 'q9', choice: 'keep' },
        { question: 'd1', choice: 'keep' },
        { question: 'q1', choice: 'other' },
      ],
    });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /q9 isn't a question/);
    assert.match(textOf(refused), /d1 isn't a question/);
    assert.match(textOf(refused), /q1: "other" needs the user's words/);
  });

  test('replan refuses manifests that do not say what they were planned from', async () => {
    const result = await mcp.callTool('plan_renames', { files: [{ from: 'Barret.jpg', to: 'Barret Wallace from FFVII battle model.jpg' }] });
    const refused = await gallery.callTool('replan', { id: idOf(result) });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /only gallery-cleanup manifests can be planned again/);
  });
});
