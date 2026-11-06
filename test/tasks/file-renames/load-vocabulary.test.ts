import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNamingRules } from '../../../src/tasks/file-renames/load-vocabulary.ts';
import { loadProfile, type Profile } from '../../../src/shared/profile/profile.ts';
import { fixtureClient } from '../../helpers/codename-fixture.ts';

const base = await loadProfile('finalfantasy');
const profile = (releases: Partial<Profile['releases']>): Profile => ({ ...base, releases: { ...base.releases, ...releases } });
/** What each request was: an action, or for action=query its prop. */
const kinds = (client: ReturnType<typeof fixtureClient>) =>
  client.requests.map((params) => (params.get('action') === 'query' ? params.get('prop') : params.get('action')));

describe('loadNamingRules', () => {
  test('from the export module, cross-checked against the Lua', async () => {
    const client = fixtureClient();
    const loaded = await loadNamingRules(client, profile({ source: 'export-module', crossCheck: true }));
    assert.equal(loaded.source, 'export-module');
    assert.deepEqual(loaded.differences, []);
    assert.equal(loaded.rules.vocabulary.byId.get('FFVII')?.token, 'FFVII');
    assert.deepEqual(loaded.rules.types, base.fileNaming.types);
    assert.ok(kinds(client).includes('expandtemplates') && kinds(client).includes('revisions'));
  });

  test('without a cross-check, only the chosen source is read', async () => {
    const exportOnly = fixtureClient();
    await loadNamingRules(exportOnly, profile({ source: 'export-module', crossCheck: false }));
    assert.deepEqual(kinds(exportOnly), ['expandtemplates']);

    const luaOnly = fixtureClient();
    const loaded = await loadNamingRules(luaOnly, profile({ source: 'parse-lua', crossCheck: false }));
    assert.ok(!kinds(luaOnly).includes('expandtemplates'));
    assert.equal(loaded.rules.vocabulary.byId.get('FFVII')?.token, 'FFVII');
  });

  test('reports where the export and the Lua disagree', async () => {
    const client = fixtureClient();
    const original = client.request;
    // The export claims FFVII's title is something else.
    client.request = async (params) => {
      const body = await original.call(client, params);
      if (params.action !== 'expandtemplates') return body;
      const data = JSON.parse((body as { expandtemplates: { wikitext: string } }).expandtemplates.wikitext);
      const ffvii = (data.rel as Array<{ id: string; title?: string }>).find((release) => release.id === 'FFVII');
      if (ffvii !== undefined) ffvii.title = 'Changed';
      return { expandtemplates: { wikitext: JSON.stringify(data) } };
    };
    const loaded = await loadNamingRules(client, profile({ source: 'export-module', crossCheck: true }));
    assert.equal(loaded.differences.length, 1);
    assert.equal(loaded.differences[0]?.exported, 'Changed');
  });
});
