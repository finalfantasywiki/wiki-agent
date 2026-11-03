import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, loadManifest, ManifestError, saveManifest, setApproval, type ManifestInput } from '../../src/plans/manifest.ts';
import type { ReferencePlan } from '../../src/plans/reference-edits.ts';

const ID = '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88';
const NOW = new Date('2026-11-02T12:00:00Z');

const OLD_CAT = 'Category:Final Fantasy VII character images';
const NEW_CAT = 'Category:Character images from Final Fantasy VII';

const references: ReferencePlan = {
  edits: [
    {
      title: 'Barret Wallace',
      revid: 10,
      timestamp: '2026-11-01T00:00:00Z',
      text: '[[File:Barret Wallace from FFVII battle render.jpg]]',
      diff: '-old\n+new',
      rewrites: [{ kind: 'embed', from: 'File:Barret.jpg', before: '[[File:Barret.jpg]]', after: '[[File:Barret Wallace from FFVII battle render.jpg]]' }],
    },
    {
      title: 'File:Barret.jpg',
      revid: 11,
      timestamp: '2026-11-01T00:00:00Z',
      text: `[[${NEW_CAT}]]`,
      diff: '-old\n+new',
      rewrites: [{ kind: 'category', from: OLD_CAT, before: `[[${OLD_CAT}]]`, after: `[[${NEW_CAT}]]` }],
    },
  ],
  usages: [
    { from: 'File:Barret.jpg', page: 'Barret Wallace', kind: 'shown', status: 'rewritten' },
    { from: 'File:Tifa-Hot.jpg', page: 'Broken', kind: 'shown', status: 'unresolved' },
  ],
  leftovers: [],
  blocked: ['File:Tifa-Hot.jpg'],
};

const rename = (from: string, to: string, extra: Partial<ManifestInput['files'] extends readonly (infer F)[] | undefined ? F : never> = {}) => ({
  from,
  to,
  requested: to,
  confidence: 0.95,
  errors: [],
  warnings: [],
  ...extra,
});

const input: ManifestInput = {
  wiki: 'finalfantasy',
  api: 'https://finalfantasy.fandom.com/api.php',
  files: [
    rename('File:Barret.jpg', 'File:Barret Wallace from FFVII battle render.jpg', { reason: 'battle model' }),
    rename('File:Tifa-Hot.jpg', 'File:Tifa original attire from Advent Children promo render 1.jpg'),
    rename('File:Gone.png', 'File:Cloud Strife from FFVII render.png', { errors: [{ code: 'source-missing', message: 'gone' }] }),
    rename('File:Aeris.png', 'File:Aeris Gainsborough from FFVII render.png', { confidence: 0.5 }),
  ],
  deletions: [
    { title: 'File:Unused.png', reason: 'not used anywhere', usedBy: [] },
    { title: 'File:Used.png', reason: 'duplicate', usedBy: ['Cloud Strife'] },
  ],
  categories: [
    { from: OLD_CAT, to: NEW_CAT, create: { text: '{{category}}', model: undefined }, old: { action: 'delete' }, members: [{ title: 'File:Barret.jpg' }], errors: [], warnings: [{ code: 'header-added', message: 'header' }] },
  ],
  questions: [{ about: 'File:Mystery.png', question: 'Who is this?' }],
  references,
};

const build = () => buildManifest(input, { id: ID, now: NOW });

/** Whether entry `id` is approved; undefined for questions and unknown IDs. */
function approvedOf(manifest: ReturnType<typeof build>, id: string): boolean | undefined {
  const entry = manifest.entries.find((candidate) => candidate.id === id);
  return entry === undefined || entry.kind === 'question' ? undefined : entry.approved;
}

describe('buildManifest', () => {
  test('entries get short IDs by kind, with questions first', () => {
    const manifest = build();
    assert.deepEqual(
      manifest.entries.map((entry) => `${entry.id}:${entry.kind}`),
      ['q1:question', 'q2:question', 'f1:file-rename', 'f2:file-rename', 'f3:file-rename', 'd1:file-delete', 'd2:file-delete', 'c1:category-rename'],
    );
    assert.equal(manifest.id, ID);
    assert.equal(manifest.created, '2026-11-02T12:00:00.000Z');
  });

  test('a missing source becomes a question for the user', () => {
    const question = build().entries.find((entry) => entry.id === 'q2');
    assert.deepEqual(question, {
      kind: 'question',
      id: 'q2',
      about: 'File:Gone.png',
      question: "File:Gone.png doesn't exist. Was it renamed or deleted, or is the name wrong?",
    });
  });

  test('only confident, clean entries start approved; deletions never do', () => {
    const approved = Object.fromEntries(build().entries.filter((entry) => entry.kind !== 'question').map((entry) => [entry.id, entry.approved]));
    assert.deepEqual(approved, { f1: true, f2: false, f3: false, d1: false, d2: false, c1: true });
  });

  test('blocked renames get an error; unused files a warning; used files cannot be deleted', () => {
    const entries = new Map(build().entries.map((entry) => [entry.id, entry]));
    const codes = (id: string, field: 'errors' | 'warnings') => {
      const entry = entries.get(id);
      return entry === undefined || entry.kind === 'question' ? [] : entry[field].map((issue) => issue.code);
    };
    assert.deepEqual(codes('f2', 'errors'), ['blocked']);
    assert.deepEqual(codes('f3', 'warnings'), ['unused']);
    assert.deepEqual(codes('d2', 'errors'), ['in-use']);
  });

  test('old category pages being replaced get no edits', () => {
    const manifest = buildManifest(
      {
        ...input,
        references: {
          ...references,
          edits: [
            ...references.edits,
            { title: OLD_CAT, revid: 12, timestamp: 'T', text: '', diff: '', rewrites: [{ kind: 'category', from: OLD_CAT, before: '', after: '' }] },
          ],
        },
      },
      { id: ID, now: NOW },
    );
    assert.ok(!manifest.edits.some((edit) => edit.title === OLD_CAT));
  });

  test('each page edit lists the entries it is for', () => {
    assert.deepEqual(
      build().edits.map((edit) => [edit.title, edit.entries]),
      [
        ['Barret Wallace', ['f1']],
        ['File:Barret.jpg', ['c1']],
      ],
    );
  });
});

describe('setApproval', () => {
  test('approves and unapproves, returning a copy', () => {
    const manifest = build();
    const changed = setApproval(setApproval(manifest, ['f3', 'd1'], true), ['f1'], false);
    assert.deepEqual(['f1', 'f3', 'd1'].map((id) => approvedOf(changed, id)), [false, true, true]);
    assert.deepEqual(['f1', 'f3', 'd1'].map((id) => approvedOf(manifest, id)), [true, false, false], 'the original is unchanged');
  });

  test('refuses entries with errors, questions and unknown IDs, all at once', () => {
    assert.throws(() => setApproval(build(), ['f2', 'q1', 'x9'], true), (error: unknown) => {
      assert.ok(error instanceof ManifestError);
      assert.match(error.message, /f2 has errors: blocked/);
      assert.match(error.message, /q1 is a question/);
      assert.match(error.message, /no entry x9/);
      return true;
    });
  });

  test('entries with errors can still be unapproved', () => {
    assert.doesNotThrow(() => setApproval(build(), ['f2'], false));
  });
});

describe('saving and loading', () => {
  test('round-trips through <id>.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-agent-manifests-'));
    const manifest = build();
    const path = await saveManifest(manifest, dir);
    assert.equal(path, join(dir, `${ID}.json`));
    assert.deepEqual(await loadManifest(ID, dir), manifest);
  });

  test('a hand-edited manifest that breaks the schema says where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-agent-manifests-'));
    const path = await saveManifest(build(), dir);
    const json = JSON.parse(await readFile(path, 'utf8'));
    json.entries[2].approved = 'yes';
    await writeFile(path, JSON.stringify(json));
    await assert.rejects(loadManifest(ID, dir), (error: unknown) => {
      assert.ok(error instanceof ManifestError);
      assert.match(error.message, /entries\[2\]\.approved/);
      return true;
    });
  });

  test('IDs must be UUIDs, so they cannot point outside the folder', async () => {
    await assert.rejects(loadManifest('../package', '/tmp'), /isn't a manifest ID/);
  });
});

describe('pages to create and delete, and category tags', () => {
  const GALLERY = 'Tifa Lockhart/Gallery';
  const manifest = buildManifest(
    {
      wiki: 'finalfantasy',
      api: 'https://finalfantasy.fandom.com/api.php',
      deletions: [{ title: 'File:Only on the gallery.png', reason: `only shown on ${GALLERY}`, usedBy: [] }],
      pageCreations: [{ title: 'Category:Images of Tifa Lockhart', text: '{{category |contains=all |namespace=file |related=[[Tifa Lockhart]] }}\n[[Category:Images by character]]', reason: 'for the images kept from Tifa Lockhart/Gallery' }],
      pageDeletions: [
        { title: GALLERY, reason: 'replaced by Category:Images of Tifa Lockhart', usedBy: [] },
        { title: 'Talk:Tifa Lockhart/Gallery', reason: 'talk page of a deleted gallery', usedBy: ['Forum:Old thread'] },
      ],
      categoryTags: [{ title: 'File:Kept.png', category: 'Category:Images of Tifa Lockhart' }],
      references: {
        edits: [
          { title: 'Tifa Lockhart', revid: 1, timestamp: 'T', text: '', diff: '', rewrites: [{ kind: 'template', from: GALLERY, before: '|gallery=true', after: '' }] },
          { title: 'File:Kept.png', revid: 2, timestamp: 'T', text: '', diff: '', rewrites: [{ kind: 'category', from: 'File:Kept.png', before: '', after: '[[Category:Images of Tifa Lockhart]]' }] },
        ],
        usages: [],
        leftovers: [],
        blocked: [],
      },
    },
    { id: ID, now: NOW },
  );
  const entry = (id: string) => manifest.entries.find((candidate) => candidate.id === id);

  test('get n, p and t IDs; page deletions never start approved, new pages and tags do', () => {
    assert.deepEqual(manifest.entries.map((candidate) => `${candidate.id}:${candidate.kind}`), [
      'd1:file-delete',
      'n1:page-create',
      'p1:page-delete',
      'p2:page-delete',
      't1:category-tag',
    ]);
    assert.deepEqual(
      manifest.entries.map((candidate) => candidate.kind !== 'question' && candidate.approved),
      [false, true, false, false, true],
    );
  });

  test('a new page keeps its text and reason', () => {
    const n1 = entry('n1');
    assert.ok(n1?.kind === 'page-create');
    assert.deepEqual([n1.title, n1.text, n1.reason], ['Category:Images of Tifa Lockhart', '{{category |contains=all |namespace=file |related=[[Tifa Lockhart]] }}\n[[Category:Images by character]]', 'for the images kept from Tifa Lockhart/Gallery']);
  });

  test('a page still linked from elsewhere cannot be deleted', () => {
    const p2 = entry('p2');
    assert.ok(p2?.kind === 'page-delete');
    assert.deepEqual(p2.errors.map((error) => error.code), ['in-use']);
  });

  test('link removals belong to the page deletion, category edits to the tag', () => {
    assert.deepEqual(manifest.edits.map((edit) => [edit.title, edit.entries]), [
      ['Tifa Lockhart', ['p1']],
      ['File:Kept.png', ['t1']],
    ]);
  });

  test('a link that cannot be removed blocks the page deletion', () => {
    const blocked = buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        pageDeletions: [{ title: GALLERY, reason: 'r', usedBy: [] }],
        references: { edits: [], usages: [{ from: GALLERY, page: 'Cloud Strife', kind: 'linked', status: 'unresolved' }], leftovers: [], blocked: [GALLERY] },
      },
      { id: ID, now: NOW },
    );
    const p1 = blocked.entries[0];
    assert.ok(p1?.kind === 'page-delete');
    assert.deepEqual(p1.errors.map((error) => error.code), ['blocked']);
  });

  test('survives a save and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    await saveManifest(manifest, dir);
    assert.deepEqual(await loadManifest(ID, dir), manifest);
  });
});
