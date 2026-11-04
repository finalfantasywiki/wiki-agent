import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAnswers, saveAnswers } from '../../src/plans/answers.ts';

const temp = () => mkdtemp(join(tmpdir(), 'answers-'));
const NOW = new Date('2026-11-02T12:00:00Z');

describe('answers', () => {
  test('none before anything is answered', async () => {
    assert.equal((await loadAnswers('example', await temp())).size, 0);
  });

  test('saved and loaded by the title they are about', async () => {
    const dir = await temp();
    await saveAnswers(
      'example',
      [
        { about: 'File:Figure.jpg', choice: 'keep' },
        { about: 'File:Scan.png', choice: 'other', text: 'Ask the uploader first.' },
      ],
      { dir, now: NOW },
    );
    assert.deepEqual([...(await loadAnswers('example', dir)).values()], [
      { about: 'File:Figure.jpg', choice: 'keep', answered: '2026-11-02T12:00:00.000Z' },
      { about: 'File:Scan.png', choice: 'other', text: 'Ask the uploader first.', answered: '2026-11-02T12:00:00.000Z' },
    ]);
  });

  test('a later answer about the same title replaces the earlier one, and others are kept', async () => {
    const dir = await temp();
    await saveAnswers('example', [{ about: 'File:A.png', choice: 'keep' }, { about: 'File:B.png', choice: 'keep' }], { dir, now: NOW });
    const answers = await saveAnswers('example', [{ about: 'File:A.png', choice: 'nominate' }], { dir, now: NOW });
    assert.deepEqual([...answers.entries()].map(([about, answer]) => [about, answer.choice]), [
      ['File:A.png', 'nominate'],
      ['File:B.png', 'keep'],
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'example.json'), 'utf8')).answers.length, 2);
  });

  test('free text must say something', async () => {
    await assert.rejects(saveAnswers('example', [{ about: 'File:A.png', choice: 'other', text: '  ' }], { dir: await temp() }));
  });

  test('an answer saved as "delete", before images were nominated instead, reads as "nominate"', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'example.json'), JSON.stringify({ version: 1, wiki: 'example', answers: [{ about: 'File:A.png', choice: 'delete', answered: 'T' }] }));
    assert.equal((await loadAnswers('example', dir)).get('File:A.png')?.choice, 'nominate');
  });

  test('a hand-edited file is checked', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'example.json'), JSON.stringify({ version: 1, wiki: 'example', answers: [{ about: 'File:A.png', choice: 'maybe', answered: 'T' }] }));
    await assert.rejects(loadAnswers('example', dir), /isn't a valid answers file/);
  });

  test('the wiki name cannot point outside the folder', async () => {
    await assert.rejects(loadAnswers('../package', await temp()), /isn't a wiki profile name/);
  });
});
