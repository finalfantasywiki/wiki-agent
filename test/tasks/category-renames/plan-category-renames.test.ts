import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planCategoryRenames,
  replaceRelease,
  splitCategoryName,
  taggedByTemplate,
  type CategoryRenameOptions,
} from '../../../src/tasks/category-renames/plan-category-renames.ts';
import type { ReferencePlan } from '../../../src/shared/plans/reference-edits.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../../helpers/siteinfo.ts';

const RELEASES = ['Final Fantasy VII', 'Final Fantasy VII Remake', 'Crisis Core -Final Fantasy VII-', 'Final Fantasy VI'];
const OPTIONS: CategoryRenameOptions = { releaseTitles: RELEASES, emptied: { action: 'delete' } };

const IMAGES_OLD = 'Category:Final Fantasy VII character images';
const IMAGES_NEW = 'Category:Character images from Final Fantasy VII';
const IMAGES_MODEL = 'Category:Character images from Final Fantasy VII Remake';
const ARTWORK_OLD = 'Category:Final Fantasy VII character artwork';
const ARTWORK_NEW = 'Category:Character artwork from Final Fantasy VII';
const ARTWORK_MODEL = 'Category:Character artwork from Final Fantasy VII Remake';

const MODEL_TEXT = [
  "{{category |name=Character images from ''Final Fantasy VII Remake'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII Remake|characters in ''Final Fantasy VII Remake'']] }}",
  '',
  '[[Category:Images from Final Fantasy VII Remake]]',
  '[[Category:Character images]]',
].join('\n');

interface World {
  readonly pages: Record<string, string>;
  readonly members?: Record<string, Array<{ title: string; ns: number; type: 'page' | 'file' | 'subcat' }>>;
}

function wiki(world: World) {
  const client = fakeWiki((params) => {
    const titles = params.get('titles')?.split('|') ?? [];
    if (params.get('list') === 'categorymembers') {
      return { query: { categorymembers: world.members?.[params.get('cmtitle')!] ?? [] } };
    }
    if (params.get('prop') === 'revisions') {
      return {
        query: {
          pages: titles.map((title) =>
            world.pages[title] === undefined
              ? { title, missing: true }
              : { title, revisions: [{ revid: 1, timestamp: 'T', slots: { main: { content: world.pages[title] } } }] },
          ),
        },
      };
    }
    // pagesExist
    return { query: { pages: titles.map((title) => (world.pages[title] === undefined ? { title, missing: true } : { title })) } };
  });
  loadSiteInfo(client);
  return client;
}

const file = (title: string) => ({ title, ns: 6, type: 'file' as const });

describe('planCategoryRenames', () => {
  const world: World = {
    pages: {
      [IMAGES_OLD]: '{{category}}',
      [ARTWORK_OLD]: '{{category}}',
      [IMAGES_MODEL]: MODEL_TEXT,
      [ARTWORK_MODEL]: `{{category}}\n[[Category:${IMAGES_MODEL.slice(9)}]]\n[[Category:Final Fantasy VII Remake artwork]]`,
      'Category:Images from Final Fantasy VII': '',
      'Category:Character images': '',
    },
    members: {
      [IMAGES_OLD]: [file('File:A.png'), { title: ARTWORK_OLD, ns: 14, type: 'subcat' }],
      [ARTWORK_OLD]: [file('File:B.png')],
      'Category:Pageless': [file('File:C.png')],
    },
  };

  test('copies the model with its release swapped, and lists the members', async () => {
    const [plan] = await planCategoryRenames(wiki(world), [{ from: IMAGES_OLD, to: IMAGES_NEW, model: IMAGES_MODEL }], OPTIONS);
    assert.equal(
      plan?.create?.text,
      [
        "{{category |name=Character images from ''Final Fantasy VII'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']] }}",
        '',
        '[[Category:Images from Final Fantasy VII]]',
        '[[Category:Character images]]',
      ].join('\n'),
    );
    assert.equal(plan?.create?.model, IMAGES_MODEL);
    assert.deepEqual(plan?.rename, { from: IMAGES_OLD, to: IMAGES_NEW });
    assert.deepEqual(plan?.members.map((member) => member.title), ['File:A.png', ARTWORK_OLD]);
    assert.deepEqual(plan?.old, { action: 'delete' });
    assert.deepEqual(plan?.errors, []);
    assert.deepEqual(plan?.warnings, []);
  });

  test('a parent created in the same batch is not missing; other missing parents are warned about', async () => {
    const plans = await planCategoryRenames(
      wiki(world),
      [
        { from: IMAGES_OLD, to: IMAGES_NEW, model: IMAGES_MODEL },
        { from: ARTWORK_OLD, to: ARTWORK_NEW, model: ARTWORK_MODEL },
      ],
      OPTIONS,
    );
    assert.deepEqual(plans[1]?.warnings, [{ code: 'missing-parent', message: "Category:Final Fantasy VII artwork doesn't exist" }]);
  });

  test('text can be given instead of a model', async () => {
    const [plan] = await planCategoryRenames(wiki(world), [{ from: IMAGES_OLD, to: IMAGES_NEW, text: '[[Category:Character images]]' }], OPTIONS);
    assert.deepEqual(plan?.create, { text: '[[Category:Character images]]', model: undefined });
    assert.deepEqual(plan?.errors, []);
  });

  test('with no model or text, the old text is kept, with renamed parents', async () => {
    const plans = await planCategoryRenames(
      wiki({
        pages: {
          [ARTWORK_OLD]: 'Concept and promotional artwork.\n[[Category:Final Fantasy VII artwork]]\n[[Category:Final Fantasy VII character images]]',
          'Category:Final Fantasy VII artwork': '[[Category:Images from Final Fantasy VII]]\n[[Category:Artwork]]',
          [IMAGES_OLD]: 'x',
          'Category:Images from Final Fantasy VII': '',
          'Category:Artwork': '',
        },
      }),
      [
        { from: IMAGES_OLD, to: IMAGES_NEW, text: 'x' },
        { from: ARTWORK_OLD, to: ARTWORK_NEW },
        { from: 'Category:Final Fantasy VII artwork', to: 'Category:Concept art for Final Fantasy VII' },
      ],
      OPTIONS,
    );
    assert.equal(
      plans[1]?.create?.text,
      'Concept and promotional artwork.\n[[Category:Concept art for Final Fantasy VII]]\n[[Category:Character images from Final Fantasy VII]]',
    );
    assert.deepEqual(plans[1]?.warnings.map((warning) => warning.code), ['old-text-kept']);
    assert.equal(plans[2]?.create?.text, '[[Category:Images from Final Fantasy VII]]\n[[Category:Artwork]]');
  });

  test('errors: no model or text, a missing model, an unconventional name, a missing source', async () => {
    const plans = await planCategoryRenames(
      wiki(world),
      [
        { from: 'Category:Pageless', to: IMAGES_NEW },
        { from: IMAGES_OLD, to: IMAGES_NEW, model: 'Category:No such model from Final Fantasy VII' },
        { from: IMAGES_OLD, to: 'Category:Odd name', model: IMAGES_MODEL },
        { from: 'Category:Gone', to: IMAGES_NEW, text: 'x' },
      ],
      OPTIONS,
    );
    assert.deepEqual(plans.map((plan) => plan.errors.map((error) => error.code)), [['no-text'], ['model-missing'], ['not-conventional'], ['source-missing']]);
    assert.equal(plans[3]?.old, undefined, 'no old page to delete');
  });

  test('a target that already exists is kept; only the members move', async () => {
    const [plan] = await planCategoryRenames(wiki({ ...world, pages: { ...world.pages, [IMAGES_NEW]: 'existing' } }), [{ from: IMAGES_OLD, to: IMAGES_NEW, model: IMAGES_MODEL }], OPTIONS);
    assert.equal(plan?.create, undefined);
    assert.deepEqual(plan?.warnings.map((warning) => warning.code), ['target-exists']);
  });

  test('a model of a different kind, and one that never names its release, are warned about', async () => {
    const [plan] = await planCategoryRenames(
      wiki({ ...world, pages: { ...world.pages, [ARTWORK_MODEL]: 'No release here.' } }),
      [{ from: IMAGES_OLD, to: IMAGES_NEW, model: ARTWORK_MODEL }],
      OPTIONS,
    );
    assert.deepEqual(plan?.warnings.map((warning) => warning.code), ['model-kind-differs', 'model-unchanged']);
  });

  test('names are normalized, and a soft redirect is used when the profile says so', async () => {
    const [plan] = await planCategoryRenames(
      wiki(world),
      [{ from: 'Final_Fantasy_VII_character_images', to: 'Character images from Final Fantasy VII', text: 'x' }],
      { ...OPTIONS, emptied: { action: 'softRedirect', template: 'Category redirect' } },
    );
    assert.equal(plan?.from, IMAGES_OLD);
    assert.equal(plan?.to, IMAGES_NEW);
    assert.deepEqual(plan?.old, { action: 'softRedirect', text: '{{Category redirect|Character images from Final Fantasy VII}}' });
  });
});

describe('the header', () => {
  const HEADER: CategoryRenameOptions = { ...OPTIONS, header: { headerTemplate: 'category', headerParams: { contains: 'all image', namespace: 'file' } } };
  const pages = {
    [ARTWORK_OLD]: 'Concept and promotional artwork.\n[[Category:Final Fantasy VII artwork]]\n[[Category:Final Fantasy VII character images]]',
    'Category:Final Fantasy VII artwork': '[[Category:Images from Final Fantasy VII]]\n[[Category:Artwork]]',
    [IMAGES_OLD]: 'x',
    [IMAGES_MODEL]: MODEL_TEXT,
    'Category:Images from Final Fantasy VII': '',
    'Category:Artwork': '',
    'Category:Character images': '',
  };

  test('a page without one gets it, then its category tags; other text is dropped', async () => {
    const plans = await planCategoryRenames(
      wiki({ pages }),
      [
        { from: IMAGES_OLD, to: IMAGES_NEW, model: IMAGES_MODEL },
        {
          from: ARTWORK_OLD,
          to: ARTWORK_NEW,
          related: "[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']]",
        },
        { from: 'Category:Final Fantasy VII artwork', to: 'Category:Concept art for Final Fantasy VII', related: "''[[Final Fantasy VII]]''" },
      ],
      HEADER,
    );
    assert.equal(
      plans[1]?.create?.text,
      [
        "{{category |name=Character artwork from ''Final Fantasy VII'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']] }}",
        '',
        '[[Category:Concept art for Final Fantasy VII]]',
        '[[Category:Character images from Final Fantasy VII]]',
      ].join('\n'),
    );
    assert.deepEqual(plans[1]?.warnings.map((warning) => warning.code), ['old-text-kept', 'old-text-dropped', 'header-added']);
    assert.equal(
      plans[2]?.create?.text,
      "{{category |name=Concept art for ''Final Fantasy VII'' |contains=all image |namespace=file |related=''[[Final Fantasy VII]]'' }}\n\n[[Category:Images from Final Fantasy VII]]\n[[Category:Artwork]]",
    );
  });

  test('a page that already starts with it is left alone', async () => {
    const [plan] = await planCategoryRenames(wiki({ pages }), [{ from: IMAGES_OLD, to: IMAGES_NEW, model: IMAGES_MODEL }], HEADER);
    assert.ok(plan?.create?.text.startsWith("{{category |name=Character images from ''Final Fantasy VII''"));
    assert.deepEqual(plan?.warnings, []);
  });

  test('without "related", the header is made anyway, with a warning', async () => {
    const [plan] = await planCategoryRenames(wiki({ pages }), [{ from: IMAGES_OLD, to: IMAGES_NEW, text: '[[Category:Character images]]' }], HEADER);
    assert.equal(plan?.create?.text, "{{category |name=Character images from ''Final Fantasy VII'' |contains=all image |namespace=file }}\n\n[[Category:Character images]]");
    assert.deepEqual(plan?.warnings.map((warning) => warning.code), ['no-related', 'header-added']);
  });
});

describe('taggedByTemplate', () => {
  test('members whose own text was not re-tagged', async () => {
    const [plan] = await planCategoryRenames(
      wiki({ pages: { [IMAGES_OLD]: 'x' }, members: { [IMAGES_OLD]: [file('File:A.png'), file('File:B.png')] } }),
      [{ from: IMAGES_OLD, to: IMAGES_NEW, text: 'x' }],
      OPTIONS,
    );
    const references: ReferencePlan = {
      edits: [
        {
          title: 'File:A.png',
          revid: 1,
          timestamp: 'T',
          text: '',
          diff: '',
          rewrites: [{ kind: 'category', from: IMAGES_OLD, before: '', after: '' }],
        },
      ],
      usages: [],
      leftovers: [],
      blocked: [],
    };
    assert.deepEqual(taggedByTemplate(plan!, references).map((issue) => issue.message), [`File:B.png isn't tagged with ${IMAGES_OLD} in its own text`]);
  });
});

describe('splitCategoryName', () => {
  test('the longest release wins', () => {
    assert.deepEqual(splitCategoryName(IMAGES_MODEL, RELEASES), { kind: 'Character images from', release: 'Final Fantasy VII Remake' });
    assert.deepEqual(splitCategoryName(IMAGES_NEW, RELEASES), { kind: 'Character images from', release: 'Final Fantasy VII' });
    assert.equal(splitCategoryName(IMAGES_OLD, RELEASES), undefined);
  });

  test('"for" as well as "from"; the word is part of the kind', () => {
    assert.deepEqual(splitCategoryName('Category:Concept art for Final Fantasy VII', RELEASES), { kind: 'Concept art for', release: 'Final Fantasy VII' });
    assert.notDeepEqual(splitCategoryName('Category:Concept art for Final Fantasy VII', RELEASES)?.kind, splitCategoryName('Category:Concept art from Final Fantasy VII', RELEASES)?.kind);
  });
});

describe('replaceRelease', () => {
  test('skips longer release titles and partial words', () => {
    assert.equal(
      replaceRelease('Final Fantasy VII, Final Fantasy VII Remake, Crisis Core -Final Fantasy VII-, Final Fantasy VIII', 'Final Fantasy VII', 'Final Fantasy VI', RELEASES),
      'Final Fantasy VI, Final Fantasy VII Remake, Crisis Core -Final Fantasy VII-, Final Fantasy VIII',
    );
  });
});
