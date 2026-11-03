// test/fixtures/codename-sample is a small hand-written sample in the shape of
// the FF Wiki's Module:Codename/data (no wiki content is copied): lua/*.lua
// are the data pages ("/" in a title is "__" in the file name), and
// export.json is what Module:Codename/export would return for them.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crossCheck, fromExport, fromLua } from '../../src/sources/codename.ts';
import { fixtureClient } from '../helpers/codename-fixture.ts';

const exportFixture: unknown = JSON.parse(readFileSync(new URL('../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));

describe('fromExport', () => {
  test('parses the JSON returned by the export module', async () => {
    const data = (await fromExport(fixtureClient(), 'Codename/export')) as { rel: unknown[]; ser: unknown[] };
    assert.equal(data.rel.length, 8);
    assert.equal(data.ser.length, 2);
  });
});

describe('fromLua', () => {
  test('follows every require() of the data pages', async () => {
    const client = fixtureClient();
    const data = (await fromLua(client, 'Module:Codename/data')) as { rel: Array<{ id: string; title?: string }> };
    assert.deepEqual(
      data.rel.map((release) => release.id),
      ['FFIIHnD', 'FFVI', 'FFVII', 'FFVIIR', 'VIICC', 'VIIRToTP', 'FFX', 'XIV1'],
    );
    assert.equal(data.rel[0]?.title, 'Final Fantasy II Hihō no Dragon');
    assert.ok(!JSON.stringify(data).includes('$require'), 'no unresolved require() left');
  });

  test('batches each level of requires into one request', async () => {
    const client = fixtureClient();
    await fromLua(client, 'Module:Codename/data');
    // data → rel + ser → rel's subpages
    assert.equal(client.requests.length, 3);
  });

  test('can start from a subpage', async () => {
    const data = (await fromLua(fixtureClient(), 'Module:Codename/data/rel/FFVI')) as { versions: Record<string, { name: string }> };
    assert.equal(data.versions['advance']?.name, 'Advance');
  });

  test('treats underscores in titles as spaces', async () => {
    const client = fixtureClient({
      'Module:Release data': "return { require('Module:Release_data/FFVI') }",
      'Module:Release data/FFVI': "return { id = 'FFVI' }",
    });
    assert.deepEqual(await fromLua(client, 'Module:Release_data'), [{ id: 'FFVI' }]);
  });

  test('throws when a required module is missing', async () => {
    const client = fixtureClient({ 'Module:A': "return { require('Module:B') }" });
    await assert.rejects(fromLua(client, 'Module:A'), /Module:B does not exist/);
  });

  test('throws on a require() cycle', async () => {
    const client = fixtureClient({
      'Module:A': "return { b = require('Module:B') }",
      'Module:B': "return { a = require('Module:A') }",
    });
    await assert.rejects(fromLua(client, 'Module:A'), /cycle: Module:A → Module:B → Module:A/);
  });
});

describe('crossCheck', () => {
  test('the export and the parsed Lua agree, despite key order and {} vs []', async () => {
    const client = fixtureClient();
    const differences = crossCheck(await fromExport(client, 'Codename/export'), await fromLua(client, 'Module:Codename/data'));
    assert.deepEqual(differences, []);
  });

  test('reports the path of a changed value', () => {
    const differences = crossCheck({ rel: [{ id: 'FFVI', tag: 'VI' }] }, { rel: [{ id: 'FFVI', tag: 'Six' }] });
    assert.deepEqual(differences, [{ path: 'rel[0].tag', exported: 'VI', parsed: 'Six' }]);
  });

  test('reports keys missing on either side', () => {
    const differences = crossCheck({ a: 1 }, { b: 2 });
    assert.deepEqual(differences, [
      { path: 'a', exported: 1, parsed: undefined },
      { path: 'b', exported: undefined, parsed: 2 },
    ]);
  });

  test('ignores key order and treats {"1","2"} objects as arrays', () => {
    assert.deepEqual(crossCheck({ x: ['a', 'b'], y: 1, z: 2 }, { z: 2, y: 1, x: { '1': 'a', '2': 'b' } }), []);
  });
});
