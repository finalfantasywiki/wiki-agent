import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, type ManifestInput } from '../../../src/shared/plans/manifest.ts';
import { renderManifest } from '../../../src/shared/plans/render-manifest.ts';

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
        nominations: [
          { title: 'File:Only here.png', reason: 'Only shown on Tifa Lockhart/Gallery', pageUrl: 'https://wiki.test/wiki/File:Only_here.png', thumbUrl: 'https://img.test/thumb/Only.png' },
          { title: 'File:Also here.png', reason: 'Only shown on Tifa Lockhart/Gallery' },
        ],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
    ),
  );

  test('in the summary', () => {
    assert.ok(markdown.includes('| Nominated for deletion | 2 | 0 | 0 |'));
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

  test('files to nominate, with their thumbnails, saying nothing is deleted', () => {
    assert.ok(markdown.includes("## Files to nominate for deletion\n\nEach file's page gets the deletion template, for editors to decide on; nothing here deletes a file.\n\n| ID | Approved | Image | File | Reason |"));
    assert.ok(markdown.includes('| x1 | ⬜ | <a href="https://wiki.test/wiki/File:Only_here.png"><img src="https://img.test/thumb/Only.png"'));
    assert.ok(markdown.includes('| x2 | ⬜ |  | File:Also here.png | Only shown on Tifa Lockhart/Gallery |'));
  });
});

describe('renderManifest: file previews', () => {
  const CAIT = 'File:Cait Sith (FFVII).png';
  const markdown = renderManifest(
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        files: [
          {
            from: 'File:Cait.png',
            to: 'File:Cait Sith from FFVII render.png',
            requested: 'File:Cait Sith from FFVII render.png',
            confidence: 0.9,
            errors: [],
            warnings: [],
            pageUrl: 'https://wiki.test/wiki/File:Cait.png',
            thumbUrl: 'https://img.test/thumb/Cait.png',
          },
          { from: 'File:Plain.png', to: 'File:Barret Wallace from FFVII render.png', requested: 'File:Barret Wallace from FFVII render.png', confidence: 0.9, errors: [], warnings: [] },
        ],
        deletions: [
          { title: CAIT, reason: 'only shown on Cait Sith/Gallery', usedBy: [], pageUrl: 'https://wiki.test/wiki/File:Cait_Sith_(FFVII).png', thumbUrl: 'https://img.test/thumb/Cait (FFVII).png' },
          { title: 'File:No preview.png', reason: 'r', usedBy: [] },
        ],
        questions: [{ about: 'File:Figure.jpg', question: 'Add it to Hero.', pageUrl: 'https://wiki.test/wiki/File:Figure.jpg', thumbUrl: 'https://img.test/thumb/Figure.jpg' }],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
    ),
  );

  test('deletions show a thumbnail linking to the file page, and link the name; parentheses are escaped', () => {
    assert.ok(markdown.includes('| ID | Approved | Image | File | Reason | Issues |'));
    assert.ok(
      markdown.includes(
        '| d1 | ⬜ | <a href="https://wiki.test/wiki/File:Cait_Sith_%28FFVII%29.png"><img src="https://img.test/thumb/Cait%20%28FFVII%29.png" alt="" loading="lazy" referrerpolicy="no-referrer"></a> | [File:Cait Sith (FFVII).png](https://wiki.test/wiki/File:Cait_Sith_%28FFVII%29.png) | only shown on Cait Sith/Gallery |  |',
      ),
    );
  });

  test('file renames show a thumbnail that sends no referrer, and link the old name', () => {
    assert.ok(markdown.includes('| ID | Approved | Image | From | To | Confidence | Issues |'));
    assert.ok(
      markdown.includes(
        '| f1 | ⬜ | <a href="https://wiki.test/wiki/File:Cait.png"><img src="https://img.test/thumb/Cait.png" alt="" loading="lazy" referrerpolicy="no-referrer"></a> | [File:Cait.png](https://wiki.test/wiki/File:Cait.png) | File:Cait Sith from FFVII render.png | 0.90 | unused |',
      ),
    );
    assert.ok(markdown.includes('| f2 | ⬜ |  | File:Plain.png | File:Barret Wallace from FFVII render.png | 0.90 | unused |'));
  });

  test('quotes and ampersands in URLs are escaped in the image tag', () => {
    const tricky = renderManifest(
      buildManifest(
        {
          wiki: 'finalfantasy',
          api: 'https://finalfantasy.fandom.com/api.php',
          deletions: [{ title: 'File:Q.png', reason: 'r', usedBy: [], thumbUrl: 'https://img.test/a.png?x=1&y="2"' }],
          references: { edits: [], usages: [], leftovers: [], blocked: [] },
        },
        { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
      ),
    );
    assert.ok(tricky.includes('<img src="https://img.test/a.png?x=1&amp;y=&quot;2&quot;" alt=""'));
  });

  test('a file without URLs is plain text', () => {
    assert.ok(markdown.includes('| d2 | ⬜ |  | File:No preview.png | r |  |'));
  });

  test('questions about a file show it too', () => {
    assert.ok(markdown.includes('- **q1** · <a href="https://wiki.test/wiki/File:Figure.jpg"><img src="https://img.test/thumb/Figure.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"></a> [File:Figure.jpg](https://wiki.test/wiki/File:Figure.jpg): Add it to Hero.'));
  });

  test('manifests without previews render as before', () => {
    const plain = renderManifest(buildManifest({ ...input }, { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') }));
    assert.ok(plain.includes('| ID | Approved | File | Reason | Issues |'));
  });
});

describe('renderManifest: answering questions', () => {
  const markdown = renderManifest(
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        questions: [
          { about: 'File:Figure.jpg', question: 'Add it to Hero.', choices: ['keep', 'nominate'] },
          { about: 'File:Scan.png', question: 'Add it to Guide book.', choices: ['keep', 'nominate'], answer: 'Ask the uploader first.' },
          { about: 'Hero/Gallery', question: 'Which file is Bad<name>.png?' },
        ],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
    ),
  );

  test('a question with choices lists them, and free text', () => {
    assert.ok(markdown.includes('- **q1** · File:Figure.jpg: Add it to Hero.\n  - Answer: keep it and tag it · nominate it for deletion · or in your own words'));
  });

  test('a free-text answer is shown instead', () => {
    assert.ok(markdown.includes('- **q2** · File:Scan.png: Add it to Guide book.\n  - Your answer: Ask the uploader first.'));
  });

  test('a question without choices is just the question', () => {
    assert.ok(markdown.includes('- **q3** · Hero/Gallery: Which file is Bad<name>.png?\n'));
  });
});

describe('renderManifest: replacements', () => {
  const markdown = renderManifest(
    buildManifest(
      {
        wiki: 'finalfantasy',
        api: 'https://finalfantasy.fandom.com/api.php',
        deletions: [
          { title: 'File:Reno small.jpg', reason: 'low-res copy', usedBy: [], replacedBy: 'File:Reno from FFVII render.png' },
          { title: 'File:Rude small.jpg', reason: 'low-res copy', usedBy: ['Broken'], replacedBy: 'File:Rude.png' },
          { title: 'File:Unused.png', reason: 'not used', usedBy: [] },
        ],
        references: { edits: [], usages: [], leftovers: [], blocked: [] },
      },
      { id: '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88', now: new Date('2026-11-02T12:00:00Z') },
    ),
  );

  test('a Replaced by column, empty for plain deletions', () => {
    assert.ok(markdown.includes('| ID | Approved | File | Replaced by | Reason | Issues |'));
    assert.ok(markdown.includes('| d1 | ⬜ | File:Reno small.jpg | File:Reno from FFVII render.png | low-res copy |  |'));
    assert.ok(markdown.includes('| d3 | ⬜ | File:Unused.png |  | not used |  |'));
  });

  test('what still uses a deletion', () => {
    assert.ok(markdown.includes('| d2 | ⛔ | File:Rude small.jpg | File:Rude.png | low-res copy | **in-use** |'));
    assert.ok(markdown.includes('- **d2** is still used on: Broken'));
  });
});
