import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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

describe('plan_gallery_cleanup', () => {
  // Its own wiki, so the request counts above stay the renames' own.
  const galleries = fakeWorld({
    pages: {
      'Hero/Gallery': '<gallery>\nOnly here.png\nKept.png\n</gallery>',
      Hero: '{{Infobox|gallery=true}}\nIntro.\n\n==Gallery==\n{{main|/Gallery}}',
      'Category:Images of Hero': '{{category}}',
      'File:Only here.png': '',
      'File:Kept.png': 'Kept.',
    },
    shownOn: { 'File:Only here.png': ['Hero/Gallery'], 'File:Kept.png': ['Hero/Gallery', 'Hero'] },
    linkedFrom: { 'Hero/Gallery': ['Hero'] },
  });
  let gallery: TestClient;
  before(async () => {
    gallery = await connect(createServer({ profile: await loadProfile('finalfantasy'), client: galleries, rules, manifestsDir: dir }));
  });
  after(() => gallery.close());

  test('saves the manifest, and says to show the files to delete first', async () => {
    const result = await gallery.callTool('plan_gallery_cleanup', { galleries: ['Hero/Gallery'] });
    assert.equal(result.isError, false, textOf(result));
    assert.match(textOf(result), /1 file\(s\) to delete: show them to the user with get_file_info/);
    const id = /Saved manifest ([0-9a-f-]{36})/.exec(textOf(result))?.[1];
    assert.ok(id !== undefined);
    const manifest = await loadManifest(id, dir);
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.id, entry.kind, 'title' in entry ? entry.title : '', entry.kind !== 'question' && entry.approved]),
      [
        ['d1', 'file-delete', 'File:Only here.png', false],
        ['p1', 'page-delete', 'Hero/Gallery', false],
        ['t1', 'category-tag', 'File:Kept.png', true],
      ],
    );
    assert.deepEqual(manifest.edits.map((edit) => [edit.title, edit.text]), [
      ['Hero', '{{Infobox}}\nIntro.'],
      ['File:Kept.png', 'Kept.\n\n[[Category:Images of Hero]]'],
    ]);
  });
});
