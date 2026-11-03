import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, type ManifestInput } from '../../src/plans/manifest.ts';
import { renderManifest } from '../../src/plans/render-manifest.ts';

const OLD_CAT = 'Category:Final Fantasy VII character images';
const NEW_CAT = 'Category:Character images from Final Fantasy VII';

const input: ManifestInput = {
  wiki: 'finalfantasy',
  api: 'https://finalfantasy.fandom.com/api.php',
  files: [
    { from: 'File:Barret.jpg', to: 'File:Barret Wallace from FFVII battle render.jpg', requested: 'File:Barret Wallace from FFVII battle render.jpg', reason: 'battle model', confidence: 0.95, errors: [], warnings: [] },
    { from: 'File:Tifa-Hot.jpg', to: 'File:Tifa original attire from Advent Children promo render 1.jpg', requested: 'File:Tifa original attire from Advent Children promo render.jpg', confidence: 0.7, errors: [], warnings: [{ code: 'renumbered', message: 'taken' }] },
    { from: 'File:Gone.png', to: 'File:X from FFVII render.png', requested: 'File:X from FFVII render.png', errors: [{ code: 'source-missing', message: 'gone' }], warnings: [] },
  ],
  deletions: [{ title: 'File:Unused.png', reason: 'not used | anywhere', usedBy: [] }],
  categories: [
    {
      from: OLD_CAT,
      to: NEW_CAT,
      create: { text: "{{category |name=Character images from ''Final Fantasy VII'' }}\n\n[[Category:Character images]]", model: 'Category:Character images from Final Fantasy VII Remake' },
      old: { action: 'delete' },
      members: [{ title: 'File:Barret.jpg' }, { title: 'File:Tifa-Hot.jpg' }],
      errors: [],
      warnings: [],
    },
  ],
  references: {
    edits: [
      {
        title: 'Barret Wallace',
        revid: 10,
        timestamp: '2026-11-01T00:00:00Z',
        text: 'new',
        diff: '--- Barret Wallace\n+++ Barret Wallace\n-[[File:Barret.jpg]]\n+[[File:Barret Wallace from FFVII battle render.jpg]]\n',
        rewrites: [{ kind: 'embed', from: 'File:Barret.jpg', before: 'a', after: 'b' }],
      },
      {
        title: 'Code <sample>',
        revid: 11,
        timestamp: '2026-11-01T00:00:00Z',
        text: 'new',
        diff: '-```[[File:Barret.jpg]]```\n+```[[File:Barret Wallace from FFVII battle render.jpg]]```\n',
        rewrites: [{ kind: 'embed', from: 'File:Barret.jpg', before: 'a', after: 'b' }],
      },
    ],
    usages: [
      { from: 'File:Barret.jpg', page: 'Barret Wallace', kind: 'shown', status: 'rewritten' },
      { from: 'File:Barret.jpg', page: 'Party', kind: 'shown', status: 'via-template', via: 'Template:Barret' },
      { from: 'File:Tifa-Hot.jpg', page: 'Broken', kind: 'shown', status: 'unresolved' },
    ],
    leftovers: [{ page: 'Prose', from: 'File:Tifa-Hot.jpg', line: 'image=Tifa-Hot.jpg in `prose`' }],
    blocked: ['File:Tifa-Hot.jpg'],
  },
};

const manifest = buildManifest(input, { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') });
const markdown = renderManifest(manifest);

describe('renderManifest', () => {
  test('a summary of entries by kind', () => {
    assert.match(markdown, /^# Manifest 3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88$/m);
    assert.ok(markdown.includes('| Questions | 1 |  |  |'));
    assert.ok(markdown.includes('| Category renames | 1 | 1 | 0 |'));
    assert.ok(markdown.includes('| File renames | 2 | 1 | 1 |'));
    assert.ok(markdown.includes('| Deletions | 1 | 0 | 0 |'));
  });

  test('questions come first', () => {
    assert.ok(markdown.indexOf('## Questions') < markdown.indexOf('## Category renames'));
    assert.ok(markdown.includes("- **q1** · File:Gone.png: File:Gone.png doesn't exist."));
  });

  test('a category rename shows its new page and model', () => {
    assert.ok(markdown.includes(`### c1 ✅ ${OLD_CAT} → ${NEW_CAT}`));
    assert.ok(markdown.includes('- Members to re-tag: 2'));
    assert.ok(markdown.includes('- New page, modeled on Category:Character images from Final Fantasy VII Remake:\n\n```wikitext\n{{category'));
  });

  test('file renames as a table; errors are bold, and blocked entries marked', () => {
    assert.ok(markdown.includes('| f1 | ✅ | File:Barret.jpg | File:Barret Wallace from FFVII battle render.jpg | 0.95 |  |'));
    assert.ok(markdown.includes('| f2 | ⛔ | File:Tifa-Hot.jpg | File:Tifa original attire from Advent Children promo render 1.jpg | 0.70 | **blocked**, renumbered |'));
    assert.ok(markdown.includes('- **f1** · battle model'));
    assert.ok(markdown.includes('  - ⛔ blocked: File:Tifa-Hot.jpg has usages'));
  });

  test('pipes in table cells are escaped', () => {
    assert.ok(markdown.includes('| d1 | ⬜ | File:Unused.png | not used \\| anywhere |  |'));
  });

  test('what blocks entries: unresolved usages and leftovers', () => {
    assert.ok(markdown.includes("- Broken (shown) uses File:Tifa-Hot.jpg, and its text can't be rewritten"));
    assert.ok(markdown.includes('- Prose still mentions File:Tifa-Hot.jpg: `` image=Tifa-Hot.jpg in `prose` ``'));
  });

  test('page edits: diffs in collapsible blocks, with a fence longer than any backticks inside', () => {
    assert.ok(markdown.includes('## Page edits (2)'));
    assert.ok(markdown.includes('1 more usage(s) are covered by editing a template the page transcludes.'));
    assert.ok(markdown.includes('<details><summary>Barret Wallace (f1): 1 change(s)</summary>\n\n```diff\n--- Barret Wallace'));
    assert.ok(markdown.includes('<summary>Code &lt;sample&gt; (f1)'));
    assert.ok(markdown.includes('````diff\n-```[[File:Barret.jpg]]```'));
  });

  test('page edits as a list, or only their number', () => {
    const list = renderManifest(manifest, { edits: 'list' });
    assert.ok(list.includes('- Barret Wallace (f1): 1 change(s)'));
    assert.ok(!list.includes('```diff'));
    const none = renderManifest(manifest, { edits: 'none' });
    assert.ok(none.includes('## Page edits (2)'));
    assert.ok(!none.includes('Barret Wallace (f1)'));
  });

  test('empty sections are left out', () => {
    const empty = renderManifest(
      buildManifest({ wiki: 'finalfantasy', api: 'https://finalfantasy.fandom.com/api.php', references: { edits: [], usages: [], leftovers: [], blocked: [] } }),
    );
    for (const heading of ['## Questions', '## Category renames', '## File renames', '## Deletions', '## What blocks entries']) {
      assert.ok(!empty.includes(heading), heading);
    }
    assert.ok(empty.includes('## Page edits (0)'));
  });
});

describe('renderManifest: pages to create and delete, and category tags', () => {
  const markdown = renderManifest(
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        pageCreations: [{ title: 'Category:Images of Tifa Lockhart', text: '{{category |contains=all |namespace=file |related=[[Tifa Lockhart]] }}\n[[Category:Images by character]]', reason: 'for the images kept from Tifa Lockhart/Gallery' }],
        pageDeletions: [
          { title: 'Tifa Lockhart/Gallery', reason: 'replaced by Category:Images of Tifa Lockhart', usedBy: [] },
          { title: 'Talk:Tifa Lockhart/Gallery', reason: 'talk page of a deleted gallery', usedBy: ['Forum:Old thread'] },
        ],
        categoryTags: [{ title: 'File:Kept.png', category: 'Category:Images of Tifa Lockhart' }],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
    ),
  );

  test('in the summary', () => {
    assert.ok(markdown.includes('| Pages to create | 1 | 1 | 0 |'));
    assert.ok(markdown.includes('| Pages to delete | 2 | 0 | 1 |'));
    assert.ok(markdown.includes('| Category tags | 1 | 1 | 0 |'));
  });

  test('pages to delete, with what still links to them', () => {
    assert.ok(markdown.includes('| p1 | ⬜ | Tifa Lockhart/Gallery | replaced by Category:Images of Tifa Lockhart |  |'));
    assert.ok(markdown.includes('| p2 | ⛔ | Talk:Tifa Lockhart/Gallery | talk page of a deleted gallery | **in-use** |'));
    assert.ok(markdown.includes('- **p2** is still linked from: Forum:Old thread'));
  });

  test('pages to create, with their text', () => {
    assert.ok(markdown.includes('### n1 ✅ Category:Images of Tifa Lockhart\n\nfor the images kept from Tifa Lockhart/Gallery.\n\n```wikitext\n{{category |contains=all |namespace=file |related=[[Tifa Lockhart]] }}\n[[Category:Images by character]]\n```'));
  });

  test('category tags', () => {
    assert.ok(markdown.includes('| t1 | ✅ | File:Kept.png | Category:Images of Tifa Lockhart |  |'));
  });
});
