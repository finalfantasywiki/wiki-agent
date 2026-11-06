import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProfileReview, differences, loadReviewedFiles, readReviewText, reviewText, type ReviewedFiles } from '../../../src/shared/profile/review.ts';
import type { Profile } from '../../../src/shared/profile/profile.ts';
import { fakeWiki } from '../../helpers/fake-wiki.ts';

const FILES: ReviewedFiles = { 'profile.json': '{\n  "name": "example"\n}\n', 'guide.md': '# Guide\n\nName files well.\n' };
const OLD: ReviewedFiles = { ...FILES, 'guide.md': '# Guide\n' };
const PAGE = 'User:Example Bot';
const profile = { rules: { profileReview: { page: PAGE, days: 2 } } } as unknown as Profile;
const NOW = new Date('2026-11-10T12:00:00Z');

/** A user page with the review text in the middle, as an operator would post it. */
const userPage = (files: ReviewedFiles, intro = 'I rename files.') => `${intro}\n\n== Profile ==\n${reviewText(files)}\n\n[[Category:Bots]]`;

/** A wiki whose PAGE has these revisions, newest first; `batch` per response. */
function wiki(revisions: Array<[timestamp: string, content: string]>, batch = 20) {
  return fakeWiki((params) => {
    const start = Number(params.get('rvcontinue') ?? 0);
    const part = revisions.slice(start, start + batch);
    return {
      ...(start + batch < revisions.length ? { continue: { rvcontinue: String(start + batch), continue: '||' } } : {}),
      query: {
        pages: [
          revisions.length === 0
            ? { title: PAGE, missing: true }
            : { title: PAGE, revisions: part.map(([timestamp, content], i) => ({ revid: 100 - start - i, timestamp, slots: { main: { content } } })) },
        ],
      },
    };
  });
}

describe('reviewText', () => {
  test('marks each file, and reads back as the same files', () => {
    const text = reviewText(FILES);
    assert.match(text, /<!-- wiki-agent: profile\.json -->\n<syntaxhighlight lang="json">\n\{\n {2}"name": "example"\n\}\n<\/syntaxhighlight>/);
    assert.match(text, /<syntaxhighlight lang="markdown">\n# Guide/);
    assert.deepEqual(differences(userPage(FILES), FILES), []);
  });

  test('a profile without a guide has one block', () => {
    const text = reviewText({ 'profile.json': '{}' });
    assert.deepEqual(readReviewText(text), { 'profile.json': '{}' });
    assert.deepEqual(differences(text, { 'profile.json': '{}', 'guide.md': '# Guide' }), ['guide.md']);
  });

  test("a file that would close its block can't be posted", () => {
    assert.throws(() => reviewText({ 'profile.json': '{}', 'guide.md': 'Use </syntaxhighlight>.' }), /guide\.md contains <\/syntaxhighlight>/);
  });

  test('line endings and trailing whitespace are not differences', () => {
    assert.deepEqual(differences(userPage(FILES), { 'profile.json': FILES['profile.json'].replaceAll('\n', '\r\n'), 'guide.md': `${FILES['guide.md']}\n\n` }), []);
  });

  test('the FF Wiki files can be posted', async () => {
    const files = await loadReviewedFiles('finalfantasy');
    assert.deepEqual(differences(reviewText(files), files), []);
  });
});

describe('checkProfileReview', () => {
  test('nothing to check without the rule', async () => {
    assert.equal(await checkProfileReview(wiki([]), {} as Profile, FILES, NOW), undefined);
  });

  test('a missing page', async () => {
    assert.deepEqual(await checkProfileReview(wiki([]), profile, FILES, NOW), { state: 'missing', page: PAGE });
  });

  test("a page that doesn't show the current files says which differ", async () => {
    const status = await checkProfileReview(wiki([['2026-11-01T00:00:00Z', userPage(OLD)]]), profile, FILES, NOW);
    assert.deepEqual(status, { state: 'outdated', page: PAGE, differs: ['guide.md'] });
  });

  test('the clock starts when the files were posted, not at the last edit to the page', async () => {
    const client = wiki([
      ['2026-11-09T00:00:00Z', userPage(FILES, 'I rename files, and tidy galleries.')],
      ['2026-11-07T00:00:00Z', userPage(FILES)],
      ['2026-11-06T00:00:00Z', userPage(OLD)],
    ]);
    assert.deepEqual(await checkProfileReview(client, profile, FILES, NOW), { state: 'ready', page: PAGE, since: '2026-11-07T00:00:00Z' });
  });

  test('waiting, with when it will be ready', async () => {
    const client = wiki([
      ['2026-11-09T00:00:00Z', userPage(FILES)],
      ['2026-11-01T00:00:00Z', userPage(OLD)],
    ]);
    assert.deepEqual(await checkProfileReview(client, profile, FILES, NOW), { state: 'waiting', page: PAGE, since: '2026-11-09T00:00:00Z', readyAt: '2026-11-11T00:00:00Z' });
  });

  test('changing the files back and forth restarts the clock', async () => {
    const client = wiki([
      ['2026-11-10T00:00:00Z', userPage(FILES)],
      ['2026-11-09T00:00:00Z', userPage(OLD)],
      ['2026-11-01T00:00:00Z', userPage(FILES)],
    ]);
    assert.equal((await checkProfileReview(client, profile, FILES, NOW))?.state, 'waiting');
  });

  test('stops reading the history once the files have been up long enough', async () => {
    const revisions: Array<[string, string]> = [
      ['2026-11-09T12:00:00Z', userPage(FILES)],
      ['2026-11-09T00:00:00Z', userPage(FILES)],
      ['2026-11-08T00:00:00Z', userPage(FILES)],
      ['2026-10-01T00:00:00Z', userPage(FILES)],
      ['2026-09-01T00:00:00Z', userPage(FILES)],
    ];
    const client = wiki(revisions, 2);
    assert.deepEqual(await checkProfileReview(client, profile, FILES, NOW), { state: 'ready', page: PAGE, since: '2026-11-08T00:00:00Z' });
    assert.equal(client.requests.length, 2, 'the third batch is never fetched');
  });
});
