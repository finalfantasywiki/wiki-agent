import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findUsages, getFileInfo, getFileUsages, getPages, getTransclusions, listCategoryMembers, namespaceName, pagesExist, revisionHistory } from '../../../src/shared/wiki/read.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';
import { loadSiteInfo } from '../../helpers/siteinfo.ts';

const member = (title: string, type: 'page' | 'file' | 'subcat') => ({ title, ns: type === 'file' ? 6 : type === 'subcat' ? 14 : 0, type });

describe('listCategoryMembers', () => {
  const categories: Record<string, Array<ReturnType<typeof member>>> = {
    'Category:Images': [member('File:A.png', 'file'), member('Category:Artwork', 'subcat'), member('File:B.png', 'file')],
    'Category:Artwork': [member('File:C.png', 'file'), member('Category:Images', 'subcat')],
  };
  // Serves two members per response, with cmcontinue holding the offset.
  const wiki = () =>
    fakeWiki((params) => {
      const all = categories[params.get('cmtitle')!] ?? [];
      const offset = Number(params.get('cmcontinue') ?? '0');
      const next = offset + 2;
      return {
        query: { categorymembers: all.slice(offset, next) },
        ...(next < all.length ? { continue: { cmcontinue: String(next), continue: '-||' } } : {}),
      };
    });

  test('follows continuation', async () => {
    const client = wiki();
    const members = await listCategoryMembers(client, 'Category:Images');
    assert.deepEqual(members.map((m) => m.title), ['File:A.png', 'Category:Artwork', 'File:B.png']);
    assert.equal(client.requests.length, 2);
    assert.equal(client.requests[1]?.get('cmcontinue'), '2');
  });

  test('adds the Category: prefix and filters by type', async () => {
    const members = await listCategoryMembers(wiki(), 'Images', { types: ['file'] });
    assert.deepEqual(members.map((m) => m.title), ['File:A.png', 'File:B.png']);
  });

  test('recursive, without looping on categories that contain each other', async () => {
    const members = await listCategoryMembers(wiki(), 'Category:Images', { recursive: true, types: ['file'] });
    assert.deepEqual(members.map((m) => m.title), ['File:A.png', 'File:B.png', 'File:C.png']);
  });
});

describe('getPages', () => {
  test('content and revision, missing pages, and normalized titles', async () => {
    const client = fakeWiki(() => ({
      query: {
        normalized: [{ from: 'cloud_Strife', to: 'Cloud Strife' }],
        pages: [
          { title: 'Cloud Strife', revisions: [{ revid: 7, timestamp: '2026-01-01T00:00:00Z', slots: { main: { content: 'text' } } }] },
          { title: 'Nope', missing: true },
        ],
      },
    }));
    const [cloud, nope] = await getPages(client, ['cloud_Strife', 'Nope']);
    assert.deepEqual(cloud, { title: 'Cloud Strife', exists: true, revid: 7, timestamp: '2026-01-01T00:00:00Z', content: 'text' });
    assert.deepEqual(nope, { title: 'Nope', exists: false, revid: undefined, timestamp: undefined, content: undefined });
  });

  test('batches 50 titles per request', async () => {
    const client = fakeWiki((params) => ({
      query: { pages: params.get('titles')!.split('|').map((title) => ({ title, missing: true })) },
    }));
    const titles = Array.from({ length: 120 }, (_, i) => `Page ${i}`);
    const pages = await getPages(client, titles);
    assert.equal(pages.length, 120);
    assert.deepEqual(client.requests.map((params) => params.get('titles')!.split('|').length), [50, 50, 20]);
  });
});

describe('getFileInfo', () => {
  test('merges a page split across continued responses', async () => {
    const client = fakeWiki((params) => {
      const info = { url: 'https://img/A.png', thumburl: 'https://img/A-300.png', descriptionurl: 'https://wiki/File:A.png', width: 10, height: 20, size: 30, mime: 'image/png', sha1: 'abc', user: 'Uploader', timestamp: 'T' };
      return params.has('clcontinue')
        ? { query: { pages: [{ title: 'File:A.png', categories: [{ title: 'Category:Two' }] }] } }
        : {
            continue: { clcontinue: '1|Two', continue: '||imageinfo' },
            query: { pages: [{ title: 'File:A.png', imageinfo: [info], categories: [{ title: 'Category:One' }] }] },
          };
    });
    const [file] = await getFileInfo(client, ['A.png'], 300);
    assert.equal(client.requests[0]?.get('titles'), 'File:A.png', 'adds the File: prefix');
    assert.equal(client.requests[0]?.get('iiurlwidth'), '300');
    assert.deepEqual(file, {
      title: 'File:A.png',
      exists: true,
      url: 'https://img/A.png',
      thumbUrl: 'https://img/A-300.png',
      pageUrl: 'https://wiki/File:A.png',
      width: 10,
      height: 20,
      size: 30,
      mime: 'image/png',
      sha1: 'abc',
      uploader: 'Uploader',
      uploaded: 'T',
      categories: ['Category:One', 'Category:Two'],
    });
  });

  test('a missing file', async () => {
    const client = fakeWiki(() => ({ query: { pages: [{ title: 'File:Gone.png', missing: true }] } }));
    const [file] = await getFileInfo(client, ['File:Gone.png']);
    assert.equal(file?.exists, false);
    assert.deepEqual(file?.categories, []);
  });
});

describe('findUsages', () => {
  const handler = (params: URLSearchParams) => {
    switch (params.get('list')) {
      case 'imageusage':
        return { query: { imageusage: [{ pageid: 1, ns: 0, title: 'Cloud Strife' }, { pageid: 2, ns: 2, title: 'User:Fan' }] } };
      case 'backlinks':
        return params.get('blfilterredir') === 'redirects'
          ? { query: { backlinks: [{ pageid: 3, ns: 6, title: 'File:Old name.png' }] } }
          : { query: { backlinks: [{ pageid: 4, ns: 0, title: 'Gallery' }] } };
      case 'embeddedin':
        return { query: { embeddedin: [] } };
      default:
        throw new Error(`unexpected list ${params.get('list')}`);
    }
  };

  test('a file: shown, linked, transcluded and redirected to', async () => {
    const usages = await findUsages(fakeWiki(handler), 'File:Cloud.png');
    assert.deepEqual(usages, {
      title: 'File:Cloud.png',
      fileUsage: [
        { title: 'Cloud Strife', ns: 0 },
        { title: 'User:Fan', ns: 2 },
      ],
      links: [{ title: 'Gallery', ns: 0 }],
      transclusions: [],
      redirects: [{ title: 'File:Old name.png', ns: 6 }],
    });
  });

  test('a category skips imageusage', async () => {
    const client = fakeWiki(handler);
    const usages = await findUsages(client, 'Category:Images');
    assert.deepEqual(usages.fileUsage, []);
    assert.ok(client.requests.every((params) => params.get('list') !== 'imageusage'));
  });
});

describe('getFileUsages', () => {
  test('shown, linked and redirected to, merged across continuation, keyed by the requested title', async () => {
    let call = 0;
    const client = fakeWiki(() => {
      call++;
      return call === 1
        ? {
            query: {
              normalized: [{ from: 'File:a.png', to: 'File:A.png' }],
              pages: [
                { title: 'File:A.png', fileusage: [{ ns: 0, title: 'Tifa Lockhart' }], linkshere: [{ ns: 2, title: 'User:Fan' }] },
                { title: 'File:B.png', missing: true },
              ],
            },
            continue: { fucontinue: '1', continue: '||' },
          }
        : { query: { pages: [{ title: 'File:A.png', fileusage: [{ ns: 0, title: 'Tifa Lockhart/Gallery' }], redirects: [{ ns: 6, title: 'File:Old A.png' }] }] } };
    });
    const usages = await getFileUsages(client, ['File:a.png', 'B.png']);
    assert.deepEqual(usages.get('File:a.png'), {
      title: 'File:A.png',
      fileUsage: [
        { title: 'Tifa Lockhart', ns: 0 },
        { title: 'Tifa Lockhart/Gallery', ns: 0 },
      ],
      links: [{ title: 'User:Fan', ns: 2 }],
      redirects: [{ title: 'File:Old A.png', ns: 6 }],
    });
    assert.deepEqual(usages.get('B.png'), { title: 'File:B.png', fileUsage: [], links: [], redirects: [] });
    assert.equal(client.requests[0]?.get('prop'), 'fileusage|linkshere|redirects');
    assert.equal(client.requests[0]?.get('lhshow'), '!redirect');
  });
});

describe('pagesExist', () => {
  test('normalizes, follows redirects, and reports missing pages', async () => {
    const client = fakeWiki(() => ({
      query: {
        normalized: [{ from: 'cloud_Strife', to: 'Cloud Strife' }],
        redirects: [{ from: 'Aeris', to: 'Aerith Gainsborough' }],
        pages: [{ title: 'Cloud Strife' }, { title: 'Aerith Gainsborough' }, { title: 'No such page', missing: true }],
      },
    }));
    assert.deepEqual(await pagesExist(client, ['cloud_Strife', 'Aeris', 'No such page']), [
      { title: 'cloud_Strife', normalized: 'Cloud Strife', exists: true, redirectsTo: undefined },
      { title: 'Aeris', normalized: 'Aeris', exists: true, redirectsTo: 'Aerith Gainsborough' },
      { title: 'No such page', normalized: 'No such page', exists: false, redirectsTo: undefined },
    ]);
  });
});

describe('getTransclusions', () => {
  // Page "A" transcludes Template:Aerith and Template:Infobox; "B" transcludes nothing.
  const transcluded: Record<string, string[]> = { A: ['Template:Aerith', 'Template:Infobox'], B: [] };
  const wiki = () =>
    fakeWiki((params) => {
      const only = params.get('tltemplates')?.split('|');
      const pages = params.get('titles')!.split('|').map((title) => {
        const templates = (transcluded[title] ?? []).filter((template) => only === undefined || only.includes(template));
        return templates.length === 0 ? { title } : { title, templates: templates.map((template) => ({ title: template, ns: 10 })) };
      });
      return { query: { pages } };
    });

  test('lists every transcluded page', async () => {
    const result = await getTransclusions(wiki(), ['A', 'B']);
    assert.deepEqual([...result], [['A', ['Template:Aerith', 'Template:Infobox']], ['B', []]]);
  });

  test('with `among`, asks only about those pages', async () => {
    const client = wiki();
    const result = await getTransclusions(client, ['A', 'B'], ['Template:Aerith']);
    assert.deepEqual(result.get('A'), ['Template:Aerith']);
    assert.equal(client.requests[0]?.get('tltemplates'), 'Template:Aerith');
  });

  test('more than 50 pages in `among` are asked about in chunks', async () => {
    const client = wiki();
    const among = [...Array.from({ length: 60 }, (_, i) => `Template:T${i}`), 'Template:Infobox'];
    const result = await getTransclusions(client, ['A'], among);
    assert.deepEqual(result.get('A'), ['Template:Infobox']);
    assert.equal(client.requests.length, 2);
  });

  test('an empty `among` makes no request', async () => {
    const client = wiki();
    assert.deepEqual([...(await getTransclusions(client, ['A'], []))], [['A', []]]);
    assert.equal(client.requests.length, 0);
  });
});

describe('namespaceName', () => {
  test("the namespace's name, or \"\" for main; a colon alone isn't a namespace", () => {
    const client = fakeWiki(() => assert.fail('no requests'));
    loadSiteInfo(client);
    assert.equal(namespaceName(client, 'Category:Images of Cloud Strife'), 'Category');
    assert.equal(namespaceName(client, 'file:Cloud.png'), 'File');
    assert.equal(namespaceName(client, 'Cloud Strife'), '');
    assert.equal(namespaceName(client, 'Final Fantasy VII: Advent Children'), '');
  });
});

describe('revisionHistory', () => {
  const revision = (revid: number) => ({ revid, timestamp: `2026-01-0${revid}T00:00:00Z`, slots: { main: { content: `text ${revid}` } } });
  const wiki = () =>
    fakeWiki((params) =>
      params.get('rvcontinue') === null
        ? { continue: { rvcontinue: 'next', continue: '||' }, query: { pages: [{ title: 'User:Bot', revisions: [revision(3), revision(2)] }] } }
        : { query: { pages: [{ title: 'User:Bot', revisions: [revision(1)] }] } },
    );

  test('newest first, across continuation', async () => {
    const revisions = [];
    for await (const rev of revisionHistory(wiki(), 'User:Bot', 2)) revisions.push(rev);
    assert.deepEqual(revisions.map((rev) => [rev.revid, rev.content]), [[3, 'text 3'], [2, 'text 2'], [1, 'text 1']]);
  });

  test('stopping early fetches no more', async () => {
    const client = wiki();
    for await (const rev of revisionHistory(client, 'User:Bot', 2)) if (rev.revid === 3) break;
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0]!.get('rvlimit'), '2');
  });

  test('a missing page has none', async () => {
    const client = fakeWiki(() => ({ query: { pages: [{ title: 'User:Nobody', missing: true }] } }));
    const revisions = [];
    for await (const rev of revisionHistory(client, 'User:Nobody')) revisions.push(rev);
    assert.deepEqual(revisions, []);
  });
});
