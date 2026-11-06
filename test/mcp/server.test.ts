import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LoadedRules } from '../../src/tasks/file-renames/load-vocabulary.ts';
import { buildVocabulary } from '../../src/tasks/file-renames/vocabulary.ts';
import { createServer, WORKFLOW } from '../../src/mcp/server.ts';
import { reviewText, type ReviewedFiles } from '../../src/shared/profile/review.ts';
import { loadProfile, type Profile } from '../../src/shared/profile/profile.ts';
import { fakeWiki } from '../helpers/fake-wiki.ts';
import { connect, type TestClient } from '../helpers/mcp-client.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** A wiki with one category (two files) and file info for File:A.png and File:B.png. */
const client = fakeWiki((params) => {
  if (params.get('list') === 'categorymembers') {
    return { query: { categorymembers: [{ title: 'File:A.png', ns: 6, type: 'file' }, { title: 'File:B.png', ns: 6, type: 'file' }] } };
  }
  if (params.get('list') === 'imageusage') return { query: { imageusage: [{ title: 'Cloud Strife', ns: 0 }] } };
  if (params.get('list') === 'backlinks' || params.get('list') === 'embeddedin') return { query: { [params.get('list')!]: [] } };
  const titles = params.get('titles')!.split('|');
  if (params.get('prop') === 'revisions') {
    return { query: { pages: titles.map((title) => ({ title, revisions: [{ revid: 7, timestamp: 'T', slots: { main: { content: `Text of ${title}` } } }] })) } };
  }
  // imageinfo|categories
  return {
    query: {
      pages: titles.map((title) => ({
        title,
        imageinfo: [{ url: `https://img.test/${title}`, thumburl: `https://img.test/thumb/${title}`, width: 1, height: 1, size: 1, mime: 'image/png', sha1: 'x', user: 'U', timestamp: 'T' }],
      })),
    },
  };
});

/** Thumbnails: File:A.png is an image, File:B.png fails. */
const fetchStub: typeof fetch = async (url) =>
  String(url).endsWith('A.png') ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });

/** Naming rules from the hand-written Codename sample; counts how often they're loaded. */
const sample: unknown = JSON.parse(readFileSync(new URL('../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));
let rulesLoaded = 0;
const rules = async (): Promise<LoadedRules> => {
  rulesLoaded++;
  return {
    rules: { vocabulary: buildVocabulary(sample, { releaseTokens: {}, versionTokens: {}, versionNeutral: [] }), types: ['render', 'model', 'gameplay', 'concept art'] },
    source: 'export-module',
    differences: [],
  };
};

let mcp: TestClient;
before(async () => {
  mcp = await connect(createServer({ profile: await loadProfile('finalfantasy'), client, fetch: fetchStub, rules }));
});
after(() => mcp.close());

const parse = (block: unknown) => JSON.parse((block as { text: string }).text);

describe('MCP server', () => {
  test('lists the tools; only the ones that save manifests are not read-only', async () => {
    const { tools } = (await mcp.request('tools/list')) as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'answer_question',
      'check_profile_review',
      'find_usages',
      'get_file_info',
      'get_pages',
      'get_vocabulary',
      'list_category_members',
      'plan_gallery_cleanup',
      'plan_renames',
      'replan',
      'review_manifest',
      'set_approval',
      'show_manifest',
      'validate_name',
    ]);
    assert.deepEqual(tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name).sort(), ['answer_question', 'plan_gallery_cleanup', 'plan_renames', 'replan', 'set_approval']);
  });

  test('list_category_members', async () => {
    const result = await mcp.callTool('list_category_members', { category: 'Final Fantasy VII character images', types: ['file'] });
    assert.equal(result.isError, false);
    assert.deepEqual(parse(result.content[0]), {
      category: 'Final Fantasy VII character images',
      count: 2,
      members: [
        { title: 'File:A.png', ns: 6, type: 'file' },
        { title: 'File:B.png', ns: 6, type: 'file' },
      ],
    });
  });

  test('get_pages', async () => {
    const result = await mcp.callTool('get_pages', { titles: ['Cloud Strife'] });
    assert.deepEqual(parse(result.content[0]).pages, [{ title: 'Cloud Strife', exists: true, revid: 7, timestamp: 'T', content: 'Text of Cloud Strife' }]);
  });

  test('get_file_info without thumbnails returns only JSON', async () => {
    const result = await mcp.callTool('get_file_info', { titles: ['File:A.png'] });
    assert.equal(result.content.length, 1);
    assert.equal(parse(result.content[0]).files[0].thumbUrl, 'https://img.test/thumb/File:A.png');
  });

  test('get_file_info with thumbnails returns each image after its title, or why it is missing', async () => {
    const result = await mcp.callTool('get_file_info', { titles: ['File:A.png', 'File:B.png'], thumbnails: true });
    assert.deepEqual(result.content.slice(1), [
      { type: 'text', text: 'File:A.png' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'File:B.png' },
      { type: 'text', text: '(no thumbnail: HTTP 404 text/plain)' },
    ]);
  });

  test('find_usages', async () => {
    const result = await mcp.callTool('find_usages', { title: 'File:A.png' });
    assert.deepEqual(parse(result.content[0]).fileUsage, [{ title: 'Cloud Strife', ns: 0 }]);
  });

  test('invalid input is an error result, and the wiki is not called', async () => {
    const before = client.requests.length;
    const result = await mcp.callTool('get_pages', { titles: [] });
    assert.equal(result.isError, true);
    assert.equal(client.requests.length, before);
  });
});

describe('naming tools', () => {
  test('get_vocabulary lists releases and types', async () => {
    const vocabulary = parse((await mcp.callTool('get_vocabulary', {})).content[0]);
    assert.deepEqual(vocabulary.types, ['render', 'model', 'gameplay', 'concept art']);
    const byId = new Map(vocabulary.releases.map((release: { id: string }) => [release.id, release]));
    assert.deepEqual(byId.get('FFVII'), { id: 'FFVII', title: 'Final Fantasy VII', token: 'FFVII', versionNeutral: true });
    assert.deepEqual((byId.get('FFVI') as { versions: string[] }).versions.toSorted(), ['GBA', 'PS', 'Pixel Remaster', 'SNES', 'mobile']);
  });

  test('get_vocabulary gives one release by ID, token or title', async () => {
    for (const release of ['FFVI', 'Final Fantasy VI']) {
      const found = parse((await mcp.callTool('get_vocabulary', { release })).content[0]);
      assert.equal(found.id, 'FFVI', release);
      assert.ok(found.versions.some((version: { key: string; token: string }) => version.key === 'advance' && version.token === 'GBA'));
    }
    const missing = await mcp.callTool('get_vocabulary', { release: 'FFXX' });
    assert.equal(missing.isError, true);
  });

  test('validate_name reads names into parts, with errors and warnings', async () => {
    const { results } = parse(
      (await mcp.callTool('validate_name', { names: ['Terra Branford from FFVI GBA render 1.png', 'Cloud from FFVII PS render.png', 'Tifa-Hot.jpg'], originalExtension: 'png' }))
        .content[0],
    );
    assert.deepEqual(results[0], {
      name: 'Terra Branford from FFVI GBA render 1.png',
      ok: true,
      parts: { form: 'standard', subject: 'Terra Branford', release: 'FFVI', releaseId: 'FFVI', version: 'GBA', type: 'render', baseType: 'render', number: 1, extension: 'png' },
      errors: [],
      warnings: [],
    });
    assert.deepEqual(results[1].warnings.map((warning: { code: string }) => warning.code), ['type-looks-like-version']);
    assert.deepEqual(results[2].errors.map((error: { code: string }) => error.code).sort(), ['extension-changed', 'not-parsed']);
  });

  test('the rules are loaded once and shared', () => {
    assert.equal(rulesLoaded, 1);
  });
});

describe('instructions', () => {
  test('the workflow, then the profile guide when there is one', async () => {
    assert.equal(mcp.initialized.instructions, WORKFLOW);
    const guided = await connect(createServer({ profile: await loadProfile('finalfantasy'), client, rules, guide: '# Guide\nUse sprites.' }));
    assert.equal(guided.initialized.instructions, `${WORKFLOW}\n\n# Guide\nUse sprites.`);
    await guided.close();
  });
});

describe('check_profile_review', () => {
  const FILES: ReviewedFiles = { 'profile.json': '{}', 'guide.md': '# Guide' };
  /** A wiki whose review page has one revision, or none. */
  const reviewWiki = (revision?: { timestamp: string; content: string }) =>
    fakeWiki(() => ({
      query: { pages: [revision === undefined ? { title: 'User:Omega Mk.II Bot', missing: true } : { title: 'User:Omega Mk.II Bot', revisions: [{ revid: 1, ...revision, slots: { main: { content: revision.content } } }] }] },
    }));
  const call = async (wiki: ReturnType<typeof reviewWiki>, profile?: Profile) => {
    const server = await connect(createServer({ profile: profile ?? (await loadProfile('finalfantasy')), client: wiki, rules, reviewedFiles: async () => FILES }));
    try {
      return await server.callTool('check_profile_review', {});
    } finally {
      await server.close();
    }
  };
  const textOf = (result: Awaited<ReturnType<typeof call>>) => (result.content[0] as { text: string }).text;

  test('a missing page: says so, and gives the text to post', async () => {
    const result = await call(reviewWiki());
    assert.equal(result.isError, false);
    assert.match(textOf(result), /^User:Omega Mk\.II Bot doesn't exist yet\. The bot can run 2 day\(s\) after/);
    assert.ok(textOf(result).endsWith(reviewText(FILES)));
  });

  test('an out-of-date page says which file differs', async () => {
    const result = await call(reviewWiki({ timestamp: '2026-01-01T00:00:00Z', content: reviewText({ ...FILES, 'guide.md': '# Old' }) }));
    assert.match(textOf(result), /doesn't show the current guide\.md/);
    assert.ok(textOf(result).endsWith(reviewText(FILES)));
  });

  test('a page that has shown the files long enough: ready, with no text to post', async () => {
    const result = await call(reviewWiki({ timestamp: '2026-01-01T00:00:00Z', content: `About the bot.\n${reviewText(FILES)}` }));
    assert.equal(textOf(result), 'User:Omega Mk.II Bot has shown the current profile since at least 2026-01-01T00:00:00Z: the 2-day review is over.');
  });

  test('a profile without the rule needs no review', async () => {
    const { rules: _, ...profile } = await loadProfile('finalfantasy');
    const result = await call(reviewWiki(), profile);
    assert.equal(parse(result.content[0]).state, 'not-required');
  });
});
