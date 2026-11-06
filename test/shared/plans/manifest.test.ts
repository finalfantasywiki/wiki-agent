import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, carryApprovals, loadManifest, ManifestError, saveManifest, setApproval, type ManifestInput } from '../../../src/shared/plans/manifest.ts';
import type { ReferencePlan } from '../../../src/shared/plans/reference-edits.ts';

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

  test('file renames keep their preview URLs, and leave out missing ones', () => {
    const manifest = buildManifest(
      {
        ...input,
        files: [
          rename('File:Barret.jpg', 'File:Barret Wallace from FFVII battle render.jpg', { pageUrl: 'https://wiki.test/wiki/File:Barret.jpg', thumbUrl: 'https://img.test/thumb/Barret.jpg' }),
          rename('File:Tifa-Hot.jpg', 'File:Tifa original attire from Advent Children promo render 1.jpg'),
        ],
      },
      { id: ID },
    );
    const [barret, tifa] = manifest.entries.filter((entry) => entry.kind === 'file-rename');
    assert.equal(barret?.pageUrl, 'https://wiki.test/wiki/File:Barret.jpg');
    assert.equal(barret?.thumbUrl, 'https://img.test/thumb/Barret.jpg');
    assert.ok(tifa !== undefined && !('pageUrl' in tifa) && !('thumbUrl' in tifa));
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

  test('a replacement is a deletion that names its replacement, blocked like a rename, never approved', () => {
    const manifest = buildManifest(
      {
        ...input,
        files: [],
        categories: [],
        questions: [],
        deletions: [
          { title: 'File:Reno-artwork.jpg', reason: 'low-res copy', usedBy: [], replacedBy: 'File:Reno from FFVII concept art.png' },
          { title: 'File:Rufus-shinra-ff7.jpg', reason: 'low-res copy', usedBy: [], replacedBy: 'File:Rufus from FFVII concept art.png' },
          { title: 'File:Gone.jpg', reason: 'r', usedBy: [], replacedBy: 'File:Missing.png', errors: [{ code: 'replacement-missing', message: 'File:Missing.png does not exist' }] },
        ],
        references: { ...references, blocked: ['File:Rufus-shinra-ff7.jpg'] },
      },
      { id: ID },
    );
    const [reno, rufus, gone] = manifest.entries.filter((entry) => entry.kind === 'file-delete');
    assert.equal(reno?.replacedBy, 'File:Reno from FFVII concept art.png');
    assert.deepEqual(reno?.errors, []);
    assert.equal(reno?.approved, false);
    assert.deepEqual(rufus?.errors.map((error) => error.code), ['blocked']);
    assert.deepEqual(gone?.errors.map((error) => error.code), ['replacement-missing']);
  });

  test('a plain deletion has no replacedBy, and isn\'t blocked by the reference plan', () => {
    const manifest = buildManifest({ ...input, deletions: [{ title: 'File:Unused.png', reason: 'r', usedBy: [] }], references: { ...references, blocked: ['File:Unused.png'] } }, { id: ID });
    const deletion = manifest.entries.find((entry) => entry.kind === 'file-delete');
    assert.ok(deletion !== undefined && !('replacedBy' in deletion));
    assert.deepEqual(deletion?.errors, []);
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

describe('questions with choices and answers', () => {
  const manifest = buildManifest(
    {
      wiki: 'finalfantasy',
      api: 'https://finalfantasy.fandom.com/api.php',
      questions: [
        { about: 'File:Figure.jpg', question: 'Add it to Hero.', choices: ['keep', 'nominate'] },
        { about: 'File:Scan.png', question: 'Add it to Guide book.', answer: 'Ask the uploader first.' },
        { about: 'Hero/Gallery', question: 'Which file?' },
      ],
      references: { edits: [], usages: [], leftovers: [], blocked: [] },
    },
    { id: ID, now: NOW },
  );

  test('keep them, and add no empty fields', () => {
    assert.deepEqual(manifest.entries, [
      { kind: 'question', id: 'q1', about: 'File:Figure.jpg', question: 'Add it to Hero.', choices: ['keep', 'nominate'] },
      { kind: 'question', id: 'q2', about: 'File:Scan.png', question: 'Add it to Guide book.', answer: 'Ask the uploader first.' },
      { kind: 'question', id: 'q3', about: 'Hero/Gallery', question: 'Which file?' },
    ]);
  });

  test('an older manifest offering "delete" loads as offering "nominate"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    const saved = await saveManifest(manifest, dir);
    const json = JSON.parse(await readFile(saved, 'utf8'));
    json.entries[0].choices = ['keep', 'delete'];
    await writeFile(saved, JSON.stringify(json));
    const question = (await loadManifest(ID, dir)).entries[0];
    assert.deepEqual(question?.kind === 'question' ? question.choices : undefined, ['keep', 'nominate']);
  });

  test('survive a save and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    await saveManifest(manifest, dir);
    assert.deepEqual(await loadManifest(ID, dir), manifest);
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

describe('files to nominate for deletion', () => {
  const FILE = 'File:Only on the gallery.png';
  const manifest = buildManifest(
    {
      wiki: 'finalfantasy',
      api: 'https://finalfantasy.fandom.com/api.php',
      nominations: [{ title: FILE, reason: 'only shown on Tifa Lockhart/Gallery', thumbUrl: 'https://img.test/Only.png' }],
      categoryTags: [{ title: FILE, category: 'Category:Images of Tifa Lockhart' }],
      references: {
        edits: [
          {
            title: FILE,
            revid: 3,
            timestamp: 'T',
            text: '',
            diff: '',
            rewrites: [
              { kind: 'nominate', from: FILE, before: '', after: '{{delete|reason=only shown on Tifa Lockhart/Gallery}}' },
              { kind: 'category', from: FILE, before: '', after: '[[Category:Images of Tifa Lockhart]]' },
            ],
          },
        ],
        usages: [],
        leftovers: [],
        blocked: [],
      },
    },
    { id: ID, now: NOW },
  );

  test('get x IDs, keep their preview, and never start approved', () => {
    const [x1, t1] = manifest.entries;
    assert.ok(x1?.kind === 'file-nominate');
    assert.deepEqual([x1.id, x1.title, x1.reason, x1.thumbUrl, x1.approved], ['x1', FILE, 'only shown on Tifa Lockhart/Gallery', 'https://img.test/Only.png', false]);
    assert.equal(t1?.id, 't1');
  });

  test("the file page's one edit is for both the nomination and the tag", () => {
    assert.deepEqual(manifest.edits[0]?.entries, ['x1', 't1']);
  });

  test('an edit that only tags the file is not for the nomination', () => {
    const tagOnly = buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        nominations: [{ title: FILE, reason: 'r' }],
        categoryTags: [{ title: FILE, category: 'Category:Images of Tifa Lockhart' }],
        references: { edits: [{ title: FILE, revid: 3, timestamp: 'T', text: '', diff: '', rewrites: [{ kind: 'category', from: FILE, before: '', after: '' }] }], usages: [], leftovers: [], blocked: [] },
      },
      { id: ID, now: NOW },
    );
    assert.deepEqual(tagOnly.edits[0]?.entries, ['t1']);
  });

  test('survive a save and load, and keep their approval when planned again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    await saveManifest(manifest, dir);
    assert.deepEqual(await loadManifest(ID, dir), manifest);
    const carried = carryApprovals(setApproval(manifest, ['x1'], true), manifest);
    assert.equal(carried.entries[0]?.kind === 'file-nominate' && carried.entries[0].approved, true);
  });
});

describe('carryApprovals', () => {
  const plan = (deletions: Array<{ title: string; usedBy: string[] }>, id: string) =>
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        request: { task: 'gallery-cleanup', galleries: ['Hero/Gallery'] },
        deletions: deletions.map((deletion) => ({ ...deletion, reason: 'r' })),
        categoryTags: [{ title: 'File:Kept.png', category: 'Category:Images of Hero' }],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id, now: NOW },
    );
  const before = setApproval(
    setApproval(plan([{ title: 'File:A.png', usedBy: [] }, { title: 'File:B.png', usedBy: [] }], ID), ['d1', 'd2'], true),
    ['t1'],
    false,
  );
  const next = carryApprovals(before, plan([{ title: 'File:B.png', usedBy: ['Hero'] }, { title: 'File:A.png', usedBy: [] }, { title: 'File:C.png', usedBy: [] }], '00000000-0000-4000-8000-000000000001'));
  const approval = (title: string) => {
    const entry = next.entries.find((candidate) => candidate.kind !== 'question' && 'title' in candidate && candidate.title === title);
    return entry === undefined || entry.kind === 'question' ? undefined : [entry.id, entry.approved];
  };

  test('the same change keeps its approval, whatever its new ID', () => {
    assert.deepEqual(approval('File:A.png'), ['d2', true]);
    assert.deepEqual(approval('File:Kept.png'), ['t1', false]);
  });

  test('an entry that now has errors, or is new, keeps its default', () => {
    assert.deepEqual(approval('File:B.png'), ['d1', false]);
    assert.deepEqual(approval('File:C.png'), ['d3', false]);
  });

  test('the request it was planned from is kept', () => {
    assert.deepEqual(next.request, { task: 'gallery-cleanup', galleries: ['Hero/Gallery'] });
  });
});

describe('carryApprovals of renames', () => {
  const plan = (files: Array<{ from: string; to: string; requested: string }>, to: string, id: string) =>
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        files: files.map(({ from, to, requested }) => rename(from, to, { requested })),
        categories: [{ from: OLD_CAT, to, create: undefined, old: undefined, members: [], errors: [], warnings: [] }],
        references: { edits: [], usages: [{ from: 'File:A.png', page: 'P', kind: 'shown', status: 'rewritten' }, { from: 'File:B.png', page: 'P', kind: 'shown', status: 'rewritten' }], leftovers: [], blocked: [] },
      },
      { id, now: NOW },
    );
  // All start approved; the user unapproves them.
  const before = setApproval(
    plan(
      [
        { from: 'File:A.png', to: 'File:Hero from FFVII render.png', requested: 'File:Hero from FFVII render.png' },
        { from: 'File:B.png', to: 'File:Villain from FFVII render.png', requested: 'File:Villain from FFVII render.png' },
      ],
      NEW_CAT,
      ID,
    ),
    ['f1', 'f2', 'c1'],
    false,
  );

  test('a file renamed to the same proposed name keeps its approval, even with a new number', () => {
    const next = carryApprovals(
      before,
      plan(
        [
          { from: 'File:A.png', to: 'File:Hero from FFVII render 2.png', requested: 'File:Hero from FFVII render.png' },
          { from: 'File:B.png', to: 'File:Villain from FFVII model.png', requested: 'File:Villain from FFVII model.png' },
        ],
        NEW_CAT,
        '00000000-0000-4000-8000-000000000001',
      ),
    );
    assert.deepEqual(next.entries.map((entry) => [entry.id, entry.kind !== 'question' && entry.approved]), [
      ['f1', false],
      // A different name is a different change: it gets its default.
      ['f2', true],
      ['c1', false],
    ]);
  });

  test('a category renamed to a different name gets its default', () => {
    const next = carryApprovals(before, plan([], 'Category:Other images', '00000000-0000-4000-8000-000000000001'));
    assert.deepEqual(next.entries.map((entry) => [entry.id, entry.kind !== 'question' && entry.approved]), [['c1', true]]);
  });
});
