import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/mcp/server.ts';
import { REVIEW_PAGE_URI, reviewPageHtml } from '../../src/mcp/review-app.ts';
import { reviewView } from '../../src/mcp/review-view.ts';
import { buildManifest, saveManifest, setApproval } from '../../src/plans/manifest.ts';
import { loadProfile } from '../../src/profile.ts';
import { fakeWorld } from '../helpers/fake-world.ts';
import { connect, type TestClient } from '../helpers/mcp-client.ts';

const ID = '3f1c2a64-8d0e-4c5b-9a7e-2b6d1f0c9e88';
const manifest = buildManifest(
  {
    wiki: 'finalfantasy',
    api: 'https://finalfantasy.fandom.com/api.php',
    request: { task: 'gallery-cleanup', galleries: ['Hero/Gallery'] },
    questions: [{ about: 'File:Figure.jpg', question: 'Add it to Hero.', choices: ['keep', 'nominate'], pageUrl: 'https://wiki.test/File:Figure.jpg', thumbUrl: 'https://img.test/Figure.jpg' }],
    deletions: [
      { title: 'File:Only here.png', reason: 'only shown on Hero/Gallery', usedBy: [], thumbUrl: 'https://img.test/Only.png' },
      { title: 'File:Linked.png', reason: 'r', usedBy: ['Hero'] },
    ],
    nominations: [{ title: 'File:Nominee.png', reason: 'Only shown on Hero/Gallery', thumbUrl: 'https://img.test/Nominee.png' }],
    pageCreations: [{ title: 'Category:Images of Hero', text: '{{category}}', reason: 'for the images kept from Hero/Gallery' }],
    pageDeletions: [{ title: 'Hero/Gallery', reason: 'gallery replaced', usedBy: [] }],
    categoryTags: [{ title: 'File:Kept.png', category: 'Category:Images of Hero' }],
    references: { edits: [], usages: [{ from: 'Hero/Gallery', page: 'Fan page', kind: 'transcluded', status: 'unresolved' }], leftovers: [], blocked: [] },
  },
  { id: ID, now: new Date('2026-11-02T12:00:00Z') },
);

describe('reviewView', () => {
  const view = reviewView(manifest);

  test('questions with their choices, labeled, and their previews', () => {
    assert.deepEqual(view.questions, [
      {
        id: 'q1',
        about: 'File:Figure.jpg',
        question: 'Add it to Hero.',
        choices: [
          { choice: 'keep', label: 'keep it and tag it' },
          { choice: 'nominate', label: 'nominate it for deletion' },
        ],
        pageUrl: 'https://wiki.test/File:Figure.jpg',
        thumbUrl: 'https://img.test/Figure.jpg',
      },
    ]);
  });

  test('deletions and new pages with their approvals and errors; tags only counted', () => {
    assert.deepEqual(view.fileDeletions.map(({ id, approved, errors, thumbUrl }) => ({ id, approved, errors, thumbUrl })), [
      { id: 'd1', approved: false, errors: [], thumbUrl: 'https://img.test/Only.png' },
      { id: 'd2', approved: false, errors: ['File:Linked.png is used on 1 page(s)'], thumbUrl: undefined },
    ]);
    assert.deepEqual(view.pageCreations.map(({ id, title, text, approved }) => ({ id, title, text, approved })), [{ id: 'n1', title: 'Category:Images of Hero', text: '{{category}}', approved: true }]);
    assert.deepEqual(view.tags, { total: 1, approved: 1 });
    assert.equal(view.replannable, true);
  });

  test('files to nominate, with their previews, unapproved', () => {
    assert.deepEqual(view.fileNominations, [{ id: 'x1', title: 'File:Nominee.png', reason: 'Only shown on Hero/Gallery', approved: false, errors: [], thumbUrl: 'https://img.test/Nominee.png' }]);
  });

  test('a summary row per kind, and what blocks entries', () => {
    assert.deepEqual(view.summary.map((row) => [row.label, row.total, row.approved, row.withErrors]), [
      ['Questions', 1, 0, 0],
      ['File deletions', 2, 0, 1],
      ['Files to nominate for deletion', 1, 0, 0],
      ['Pages to create', 1, 1, 0],
      ['Pages to delete', 1, 0, 0],
      ['Category tags', 1, 1, 0],
    ]);
    assert.deepEqual(view.blocked, ["Fan page (transcluded) uses Hero/Gallery, and its text can't be rewritten"]);
  });
});

describe('reviewView of renames', () => {
  const renames = buildManifest(
    {
      wiki: 'finalfantasy',
      api: 'https://finalfantasy.fandom.com/api.php',
      files: [
        {
          from: 'File:Hero-battle.png',
          to: 'File:Hero from FFVII battle render 2.png',
          requested: 'File:Hero from FFVII battle render.png',
          reason: 'battle pose',
          confidence: 0.95,
          warnings: [{ code: 'renumbered', message: 'numbered 2' }],
          errors: [],
          thumbUrl: 'https://img.test/Hero.png',
        },
        { from: 'File:Who.png', to: 'File:Villain from FFVII render.png', requested: 'File:Villain from FFVII render.png', confidence: 0.6, warnings: [], errors: [] },
        { from: 'File:Stuck.png', to: 'File:Hero from FFVII still.png', requested: 'File:Hero from FFVII still.png', confidence: 0.9, warnings: [], errors: [] },
      ],
      categories: [
        {
          from: 'Category:FFVII hero images',
          to: 'Category:Hero images from Final Fantasy VII',
          create: { text: '{{category}}', model: undefined },
          old: { action: 'delete' },
          members: [{ title: 'File:Hero-battle.png' }, { title: 'File:Stuck.png' }],
          warnings: [],
          errors: [],
        },
      ],
      references: { edits: [], usages: [{ from: 'File:Hero-battle.png', page: 'Hero', kind: 'shown', status: 'rewritten' }], leftovers: [{ from: 'File:Stuck.png', page: 'Hero', line: '{{#if:Stuck.png}}' }], blocked: ['File:Stuck.png'] },
    },
    { id: ID, now: new Date('2026-11-05T12:00:00Z') },
  );

  test('file renames with the name as requested, their confidence and previews', () => {
    const [confident] = reviewView(renames).fileRenames;
    assert.deepEqual(confident, {
      id: 'f1',
      from: 'File:Hero-battle.png',
      to: 'File:Hero from FFVII battle render 2.png',
      reason: 'battle pose',
      approved: true,
      flagged: false,
      errors: [],
      warnings: ['numbered 2'],
      requested: 'File:Hero from FFVII battle render.png',
      confidence: 0.95,
      thumbUrl: 'https://img.test/Hero.png',
    });
  });

  test('low confidence and errors are flagged, and stay flagged once approved', () => {
    const flags = (manifest: typeof renames) => reviewView(manifest).fileRenames.map(({ id, approved, flagged, errors }) => ({ id, approved, flagged, errors: errors.length }));
    assert.deepEqual(flags(renames), [
      { id: 'f1', approved: true, flagged: false, errors: 0 },
      { id: 'f2', approved: false, flagged: true, errors: 0 },
      { id: 'f3', approved: false, flagged: true, errors: 1 },
    ]);
    assert.deepEqual(flags(setApproval(renames, ['f2'], true))[1], { id: 'f2', approved: true, flagged: true, errors: 0 });
  });

  test('category renames with their new page, member count and what happens to the old page', () => {
    assert.deepEqual(reviewView(renames).categoryRenames, [
      {
        id: 'c1',
        from: 'Category:FFVII hero images',
        to: 'Category:Hero images from Final Fantasy VII',
        approved: true,
        flagged: false,
        errors: [],
        warnings: [],
        members: 2,
        newPage: '{{category}}',
        oldPage: 'deleted',
      },
    ]);
  });

  test('summary rows for renames; not replannable without a request', () => {
    const view = reviewView(renames);
    assert.deepEqual(view.summary.map((row) => [row.label, row.total, row.approved, row.withErrors]), [
      ['Category renames', 1, 1, 0],
      ['File renames', 3, 1, 1],
    ]);
    assert.equal(view.replannable, false);
    assert.deepEqual(view.blocked, ['Hero still mentions File:Stuck.png: {{#if:Stuck.png}}']);
  });
});

describe('reviewPageHtml', () => {
  let html: string;
  before(async () => {
    html = await reviewPageHtml();
  });

  test('bundles review-page.tsx, with React and ext-apps, into the one script', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotMatch(scripts[0]![0], /\ssrc=/);
    const code = scripts[0]![1]!;
    assert.match(code, /review_manifest/);
    assert.match(code, /ui\/initialize/);
    // Bundled, and React's production build.
    assert.doesNotMatch(code, /^\s*import\s|\bfrom\s*["']react["']/m);
    assert.doesNotMatch(code, /process\.env/);
    assert.match(code, /@license React/);
  });

  test('keeps the page around it: the styles and the root', () => {
    assert.match(html, /<style>[\s\S]*--accent/);
    assert.match(html, /<main id="root">/);
  });

  test('sends no Referer, which Fandom answers with a placeholder image', () => {
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
  });
});

describe('the review page on the server', () => {
  let mcp: TestClient;
  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-'));
    await saveManifest(manifest, dir);
    const client = fakeWorld({ pages: {} });
    mcp = await connect(createServer({ profile: await loadProfile('finalfantasy'), client, manifestsDir: dir, answersDir: dir }));
  });
  after(() => mcp.close());

  test('is an MCP App resource that may load the profile\'s image hosts', async () => {
    const { contents } = (await mcp.request('resources/read', { uri: REVIEW_PAGE_URI })) as { contents: Array<{ mimeType: string; text: string; _meta?: { ui?: { csp?: { resourceDomains?: string[] } } } }> };
    assert.equal(contents[0]?.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(contents[0]?._meta?.ui?.csp?.resourceDomains, ['https://static.wikia.nocookie.net']);
    assert.match(contents[0]!.text, /<title>Manifest review<\/title>/);
  });

  test('the planning tools and show_manifest open it; review_manifest is for the page only', async () => {
    const { tools } = (await mcp.request('tools/list')) as { tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }> };
    const ui = Object.fromEntries(tools.filter((tool) => tool._meta?.ui !== undefined).map((tool) => [tool.name, tool._meta!.ui]));
    assert.deepEqual(Object.keys(ui).sort(), ['plan_gallery_cleanup', 'plan_renames', 'replan', 'review_manifest', 'show_manifest']);
    assert.equal(ui.plan_gallery_cleanup?.resourceUri, REVIEW_PAGE_URI);
    assert.deepEqual(ui.review_manifest?.visibility, ['app']);
  });

  test('show_manifest says which manifest to show; review_manifest gives the page its view', async () => {
    const shown = (await mcp.request('tools/call', { name: 'show_manifest', arguments: { id: ID } })) as { structuredContent?: unknown };
    assert.deepEqual(shown.structuredContent, { manifestId: ID });
    const reviewed = (await mcp.request('tools/call', { name: 'review_manifest', arguments: { id: ID } })) as { structuredContent?: { id?: string; questions?: unknown[] } };
    assert.equal(reviewed.structuredContent?.id, ID);
    assert.equal(reviewed.structuredContent?.questions?.length, 1);
  });
});
