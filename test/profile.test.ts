import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileError, hasBotPolicy, loadGuide, loadProfile, parseProfile } from '../src/profile.ts';

const valid = {
  name: 'example',
  api: 'https://wiki.test/api.php',
  userAgentContact: 'User:Example',
  botPolicy: { url: null, note: 'approved by User:Example' },
  rate: { editIntervalSeconds: 5, maxlag: 5 },
  redirects: 'suppress',
  emptiedCategories: { action: 'delete' },
  releases: {
    adapter: 'codename',
    source: 'export-module',
    exportModule: 'Codename/export',
    dataModule: 'Module:Codename/data',
    crossCheck: true,
  },
  vocabulary: { releaseTokens: {}, versionTokens: {}, versionNeutral: [] },
  fileNaming: { types: ['render'] },
};

/** `valid` with one top-level field replaced. */
const withField = (key: string, value: unknown) => ({ ...valid, [key]: value });

function problemsOf(json: unknown): readonly string[] {
  try {
    parseProfile(json, 'test');
  } catch (error) {
    if (error instanceof ProfileError) {
      return error.problems;
    }
    throw error;
  }
  assert.fail('expected a ProfileError');
}

describe('loadProfile', () => {
  test('loads the Final Fantasy Wiki profile', async () => {
    const profile = await loadProfile('finalfantasy');
    assert.equal(profile.api, 'https://finalfantasy.fandom.com/api.php');
    assert.equal(profile.releases.source, 'export-module');
    // FF tokens live in Module:Codename/data, so the profile overrides nothing.
    assert.deepEqual(profile.vocabulary, { releaseTokens: {}, versionTokens: {}, versionNeutral: [] });
    assert.ok(hasBotPolicy(profile));
  });

  test('loads the guide, if the profile has one', async () => {
    assert.match((await loadGuide('finalfantasy')) ?? '', /^# Final Fantasy Wiki: naming guide/);
    assert.equal(await loadGuide('no-such-wiki'), undefined);
  });

  test('rejects an unknown profile', async () => {
    await assert.rejects(loadProfile('no-such-wiki'), { code: 'ENOENT' });
  });
});

describe('parseProfile', () => {
  test('accepts a valid profile', () => {
    assert.equal(parseProfile(valid, 'test').name, 'example');
  });

  test('reports every problem at once, by path', () => {
    const problems = problemsOf({ ...valid, api: 'not a url', redirects: 'maybe', rate: { editIntervalSeconds: 0, maxlag: 5 } });
    assert.equal(problems.length, 3);
    assert.match(problems[0]!, /^api must be a URL/);
    assert.match(problems[1]!, /^rate\.editIntervalSeconds must be a number greater than 0/);
    assert.match(problems[2]!, /^redirects must be one of "suppress", "keep"/);
  });

  test('reports missing sections', () => {
    const { releases: _, ...withoutReleases } = valid;
    assert.ok(problemsOf(withoutReleases).includes('releases must be an object (got undefined)'));
  });

  test('a soft redirect needs a template', () => {
    assert.deepEqual(problemsOf(withField('emptiedCategories', { action: 'softRedirect' })), [
      'emptiedCategories.template must be a non-empty string (got undefined)',
    ]);
    const profile = parseProfile(withField('emptiedCategories', { action: 'softRedirect', template: 'Category redirect' }), 'test');
    assert.deepEqual(profile.emptiedCategories, { action: 'softRedirect', template: 'Category redirect' });
  });

  test('checks vocabulary entries', () => {
    const problems = problemsOf(
      withField('vocabulary', { releaseTokens: { FFVIIR: 7 }, versionTokens: { FFVI: { advance: '' } }, versionNeutral: 'FFVII' }),
    );
    assert.deepEqual(problems, [
      'vocabulary.releaseTokens.FFVIIR must be a non-empty string (got 7)',
      'vocabulary.versionTokens.FFVI.advance must be a non-empty string (got "")',
      'vocabulary.versionNeutral must be an array of strings (got "FFVII")',
    ]);
  });

  test('category page settings are optional, and checked when given', () => {
    assert.equal(parseProfile(valid, 'test').categoryPages, undefined);
    const profile = parseProfile(withField('categoryPages', { headerTemplate: 'category', headerParams: { namespace: 'file' } }), 'test');
    assert.deepEqual(profile.categoryPages, { headerTemplate: 'category', headerParams: { namespace: 'file' } });
    assert.deepEqual(problemsOf(withField('categoryPages', { headerParams: { namespace: 6 } })), [
      'categoryPages.headerTemplate must be a non-empty string (got undefined)',
      'categoryPages.headerParams.namespace must be a non-empty string (got 6)',
    ]);
  });

  test('gallery settings are optional, and checked when given', () => {
    assert.equal(parseProfile(valid, 'test').galleries, undefined);
    const galleries = { imageCategory: 'Category:Images of {subject}', categoryText: '{{category |related=[[{subject}]] }}', linkParameters: ['gallery'], pointerTemplates: ['main'], moveSections: ['merchandise'] };
    assert.deepEqual(parseProfile(withField('galleries', galleries), 'test').galleries, galleries);
    assert.deepEqual(problemsOf(withField('galleries', { ...galleries, imageCategory: 'Category:Images', pointerTemplates: 'main' })), [
      'galleries.pointerTemplates must be an array of strings (got "main")',
      'galleries.imageCategory must contain {subject} (got "Category:Images")',
    ]);
  });

  test('needs at least one file type', () => {
    assert.deepEqual(problemsOf(withField('fileNaming', { types: [] })), ['fileNaming.types must not be empty (got [])']);
  });
});

describe('hasBotPolicy', () => {
  test('needs a URL or a note', () => {
    assert.equal(hasBotPolicy(parseProfile(withField('botPolicy', { url: null, note: ' ' }), 'test')), false);
    assert.equal(hasBotPolicy(parseProfile(withField('botPolicy', { url: 'https://wiki.test/wiki/Bot_policy', note: '' }), 'test')), true);
  });
});
