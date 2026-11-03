import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planReferenceEdits } from '../../src/plans/reference-edits.ts';
import type { Rename } from '../../src/wikitext/references.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../helpers/siteinfo.ts';

const BARRET: Rename = { from: 'File:Barret battle render.jpg', to: 'File:Barret Wallace from FFVII battle render.jpg' };
const CATEGORY: Rename = { from: 'Category:Final Fantasy VII character images', to: 'Category:Character images from Final Fantasy VII' };

interface World {
  /** Page texts; revision IDs are assigned in order. */
  readonly pages: Record<string, string>;
  /** Usages per renamed title. */
  readonly usages: Record<string, { shown?: string[]; linked?: string[]; transcluded?: string[]; redirects?: string[] }>;
  /** Pages each page transcludes. */
  readonly transcludes?: Record<string, string[]>;
}

const NS: Record<string, number> = { File: 6, Template: 10, Category: 14, Talk: 1 };
const ref = (title: string) => ({ title, ns: NS[title.split(':')[0]!] ?? 0 });

function wiki(world: World) {
  const revids = new Map(Object.keys(world.pages).map((title, i) => [title, 100 + i]));
  const client = fakeWiki((params) => {
    const titles = params.get('titles')?.split('|') ?? [];
    switch (params.get('list') ?? params.get('prop')) {
      case 'imageusage':
        return { query: { imageusage: (world.usages[params.get('iutitle')!]?.shown ?? []).map(ref) } };
      case 'backlinks': {
        const usage = world.usages[params.get('bltitle')!];
        const pages = params.get('blfilterredir') === 'redirects' ? usage?.redirects : usage?.linked;
        return { query: { backlinks: (pages ?? []).map(ref) } };
      }
      case 'embeddedin':
        return { query: { embeddedin: (world.usages[params.get('eititle')!]?.transcluded ?? []).map(ref) } };
      case 'revisions':
        return {
          query: {
            pages: titles.map((title) =>
              world.pages[title] === undefined
                ? { title, missing: true }
                : { title, revisions: [{ revid: revids.get(title), timestamp: '2026-11-01T00:00:00Z', slots: { main: { content: world.pages[title] } } }] },
            ),
          },
        };
      case 'templates': {
        const only = params.get('tltemplates')?.split('|');
        return {
          query: {
            pages: titles.map((title) => ({
              title,
              templates: (world.transcludes?.[title] ?? []).filter((template) => only?.includes(template) ?? true).map(ref),
            })),
          },
        };
      }
      default:
        throw new Error(`unexpected request: ${params}`);
    }
  });
  loadSiteInfo(client);
  return client;
}

describe('planReferenceEdits', () => {
  const world: World = {
    pages: {
      'Barret Wallace': 'Intro.\n[[File:Barret battle render.jpg|thumb|Barret]]\nMore.',
      'Template:Barret': '[[File:Barret battle render.jpg|20px]]',
      Party: 'Members: {{Barret}}',
      Broken: '{{#if:{{{x|}}}|[[File:{{{img}}}]]}}',
      Prose: 'image=Barret_battle render.jpg in prose',
      'File:Barret old.jpg': '#REDIRECT [[File:Barret battle render.jpg]]',
      'Talk:Barret Wallace': 'See [[:File:Barret battle render.jpg]].',
    },
    usages: {
      'File:Barret battle render.jpg': {
        shown: ['Barret Wallace', 'Template:Barret', 'Party', 'Broken', 'Prose'],
        linked: ['Talk:Barret Wallace'],
        redirects: ['File:Barret old.jpg'],
      },
    },
    transcludes: { Party: ['Template:Barret'], Broken: ['Template:Other'] },
  };

  test('edits every page whose text mentions the file, with a diff from the planned revision', async () => {
    const plan = await planReferenceEdits(wiki(world), [BARRET]);
    assert.deepEqual(plan.edits.map((edit) => edit.title), ['Barret Wallace', 'Template:Barret', 'Talk:Barret Wallace', 'File:Barret old.jpg']);
    const [article] = plan.edits;
    assert.equal(article?.revid, 100);
    assert.equal(article?.text, 'Intro.\n[[File:Barret Wallace from FFVII battle render.jpg|thumb|Barret]]\nMore.');
    assert.match(article?.diff ?? '', /^-\[\[File:Barret battle render\.jpg\|thumb\|Barret\]\]$/m);
    assert.match(article?.diff ?? '', /^\+\[\[File:Barret Wallace from FFVII battle render\.jpg\|thumb\|Barret\]\]$/m);
    assert.match(article?.diff ?? '', /revision 100/);
    assert.doesNotMatch(article?.diff ?? '', /No newline at end of file/);
  });

  test('sorts each usage into rewritten, via a template, or unresolved', async () => {
    const plan = await planReferenceEdits(wiki(world), [BARRET]);
    assert.deepEqual(
      plan.usages.map(({ page, kind, status, via }) => [page, kind, status, via]),
      [
        ['Barret Wallace', 'shown', 'rewritten', undefined],
        ['Template:Barret', 'shown', 'rewritten', undefined],
        ['Party', 'shown', 'via-template', 'Template:Barret'],
        ['Broken', 'shown', 'unresolved', undefined],
        ['Prose', 'shown', 'unresolved', undefined],
        ['Talk:Barret Wallace', 'linked', 'rewritten', undefined],
        ['File:Barret old.jpg', 'redirect', 'rewritten', undefined],
      ],
    );
  });

  test('unresolved usages and leftovers block the rename', async () => {
    const plan = await planReferenceEdits(wiki(world), [BARRET]);
    assert.deepEqual(plan.leftovers, [{ page: 'Prose', from: 'File:Barret battle render.jpg', line: 'image=Barret_battle render.jpg in prose' }]);
    assert.deepEqual(plan.blocked, ['File:Barret battle render.jpg']);
  });

  test('a rename whose usages are all handled is not blocked', async () => {
    const plan = await planReferenceEdits(
      wiki({
        pages: { 'Barret Wallace': '[[File:Barret battle render.jpg]]', Party: '{{Barret}}', 'Template:Barret': '[[File:barret_battle_render.jpg]]' },
        usages: { 'File:Barret battle render.jpg': { shown: ['Barret Wallace', 'Party', 'Template:Barret'] } },
        transcludes: { Party: ['Template:Barret'] },
      }),
      [BARRET],
    );
    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(plan.usages.map((usage) => usage.status), ['rewritten', 'via-template', 'rewritten']);
  });

  test('asks about transclusions only for unexplained usages, and only of edited pages', async () => {
    const client = wiki(world);
    await planReferenceEdits(client, [BARRET]);
    const asked = client.requests.find((params) => params.get('prop') === 'templates');
    assert.deepEqual(asked?.get('titles')?.split('|'), ['Party', 'Broken', 'Prose']);
    assert.deepEqual(asked?.get('tltemplates')?.split('|'), ['Barret Wallace', 'Template:Barret', 'Talk:Barret Wallace', 'File:Barret old.jpg']);
  });

  test('several renames in one pass, with extra pages such as category members', async () => {
    const plan = await planReferenceEdits(
      wiki({
        pages: {
          'Barret Wallace': '[[File:Barret battle render.jpg]]',
          'File:Barret battle render.jpg': 'Barret.\n[[Category:Final Fantasy VII character images]]',
          'File:Untagged.png': 'Nothing here.',
        },
        usages: { 'File:Barret battle render.jpg': { shown: ['Barret Wallace'] } },
      }),
      [BARRET, CATEGORY],
      { alsoEdit: ['File:Barret battle render.jpg', 'File:Untagged.png'] },
    );
    assert.deepEqual(plan.edits.map((edit) => [edit.title, edit.rewrites.map((rewrite) => rewrite.kind)]), [
      ['Barret Wallace', ['embed']],
      ['File:Barret battle render.jpg', ['category']],
    ]);
    assert.deepEqual(plan.blocked, []);
  });

  test('a page deleted since the usage lists were built is skipped', async () => {
    const plan = await planReferenceEdits(
      wiki({ pages: {}, usages: { 'File:Barret battle render.jpg': { shown: ['Gone'] } } }),
      [BARRET],
    );
    assert.deepEqual(plan.edits, []);
    assert.deepEqual(plan.usages.map((usage) => usage.status), ['unresolved']);
  });
});
