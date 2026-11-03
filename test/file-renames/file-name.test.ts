import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatFileName, parseFileName, validateFileName, type NamingRules } from '../../src/file-renames/file-name.ts';
import { buildVocabulary } from '../../src/file-renames/vocabulary.ts';

const NO_OVERRIDES = { releaseTokens: {}, versionTokens: {}, versionNeutral: [] };
const sample: unknown = JSON.parse(readFileSync(new URL('../fixtures/codename-sample/export.json', import.meta.url), 'utf8'));
const rules: NamingRules = { vocabulary: buildVocabulary(sample, NO_OVERRIDES), types: ['render', 'gameplay', 'concept art'] };

const validate = (name: string, originalExtension?: string) =>
  validateFileName(name, rules, originalExtension === undefined ? {} : { originalExtension });
const errorCodes = (name: string, originalExtension?: string) => validate(name, originalExtension).errors.map((issue) => issue.code);
const warningCodes = (name: string) => validate(name).warnings.map((issue) => issue.code);

describe('parsing', () => {
  test('the standard form, with every slot', () => {
    const { parts, ok } = validate('Cloud Strife from FFVII battle render 2.png');
    assert.ok(ok);
    assert.equal(parts?.form, 'standard');
    assert.equal(parts?.subject, 'Cloud Strife');
    assert.equal(parts?.release.id, 'FFVII');
    assert.equal(parts?.version, undefined);
    assert.equal(parts?.type, 'battle render');
    assert.equal(parts?.baseType, 'render');
    assert.equal(parts?.number, 2);
    assert.equal(parts?.extension, 'png');
  });

  test('a version between the release and the type', () => {
    const { parts } = validate('Terra Branford from FFVI Pixel Remaster render.png');
    assert.equal(parts?.version?.key, 'pixel remaster');
    assert.equal(parts?.type, 'render');
  });

  test('a version token from files.shorthand', () => {
    assert.equal(validate('Terra Branford from FFVI GBA gameplay.png').parts?.version?.key, 'advance');
  });

  test('a release token with spaces', () => {
    assert.equal(validate('Cloud Strife from FFVII Remake concept art.png').parts?.release.id, 'FFVIIR');
  });

  test('the quest form, with and without a number', () => {
    assert.equal(validate('Infiltration from FFVII Remake.jpg').parts?.form, 'quest');
    const numbered = validate('Infiltration from FFVII Remake 2.jpg').parts;
    assert.equal(numbered?.form, 'quest');
    assert.equal(numbered?.number, 2);
  });

  test('a subject that contains "from"', () => {
    assert.equal(validate('Letter from Aerith from FFVII render.png').parts?.subject, 'Letter from Aerith');
  });

  test('non-ASCII release tokens', () => {
    assert.equal(validate('Firion from Hihō no Dragon concept art.png').parts?.release.id, 'FFIIHnD');
  });

  test('a File: prefix and underscores are accepted', () => {
    assert.equal(validate('File:Cloud_Strife_from_FFVII_render.png').parts?.subject, 'Cloud Strife');
  });

  test('parseFileName returns every reading', () => {
    assert.equal(parseFileName('Cloud Strife from FFVII render.png', rules).length, 1);
    assert.deepEqual(parseFileName('Aeris-ffvii-battle.png', rules), []);
  });
});

describe('rules', () => {
  test('version-neutral releases take no version', () => {
    assert.deepEqual(errorCodes('Cloud Strife from FFVII International render.png'), ['version-not-allowed']);
    assert.deepEqual(errorCodes('Cloud Strife from FFVII Remake Intergrade render.png'), ['version-not-allowed']);
  });

  test('a release with versions warns when none is given', () => {
    assert.deepEqual(warningCodes('Terra Branford from FFVI render.png'), ['version-missing']);
    assert.deepEqual(warningCodes('Zack Fair from Crisis Core render.png'), [], 'Crisis Core has no versions');
  });

  test('a type that starts with a version token is flagged', () => {
    assert.deepEqual(warningCodes('Cloud Strife from FFVII PS render.png'), ['type-looks-like-version']);
    assert.match(validate('Cloud Strife from FFVII PS render.png').warnings[0]!.message, /version-neutral/);
  });

  test('numbers start at 1, with no leading zeros', () => {
    assert.equal(validate('Cloud from FFVII render 1.png').parts?.number, 1);
    for (const name of ['Cloud from FFVII render 0.png', 'Cloud from FFVII render 02.png']) {
      const result = validate(name);
      assert.deepEqual(result.errors.map((issue) => issue.code), ['not-parsed'], name);
      assert.match(result.errors[0]!.message, /starts at 1/, name);
    }
  });

  test('the extension must keep its file type', () => {
    assert.deepEqual(errorCodes('Cloud from FFVII render.jpg', 'png'), ['extension-changed']);
    assert.deepEqual(errorCodes('Cloud from FFVII render.jpg', 'jpeg'), [], 'jpeg and jpg are the same type');
    assert.deepEqual(errorCodes('Cloud from FFVII render.PNG', 'png'), [], 'case does not change the type');
  });

  test('characters MediaWiki forbids', () => {
    assert.ok(errorCodes('Cloud [Advent] from FFVII render.png').includes('bad-characters'));
  });

  test('spacing', () => {
    assert.ok(errorCodes('Cloud  Strife from FFVII render.png').includes('bad-spacing'));
    assert.ok(errorCodes(' Cloud from FFVII render.png').includes('bad-spacing'));
  });

  test('length', () => {
    assert.ok(errorCodes(`${'Cloud '.repeat(40)}from FFVII render.png`).includes('too-long'));
  });
});

describe('explaining failures', () => {
  const message = (name: string) => validate(name).errors.find((issue) => issue.code === 'not-parsed')?.message;

  test('no "from"', () => {
    assert.match(message('Aeris-ffvii-battle.png')!, /no " from <release>" part/);
  });

  test('an unknown release', () => {
    assert.match(message('Tidus from FFZ render.png')!, /doesn't name a known release after "from" \(found "FFZ render"\)/);
  });

  test('an unknown type lists the versions and types it expected', () => {
    const text = message('Terra from FFVI sprite.png')!;
    assert.match(text, /expected an optional version \(.*GBA.*\) and then a type ending in "render", "gameplay", "concept art"/);
  });

  test('a capitalized type', () => {
    assert.match(message('Tidus from FFX HD Render.png')!, /must be written in lowercase, e.g. "render"/);
  });

  test('no extension', () => {
    assert.match(message('Cloud from FFVII render')!, /no file extension/);
  });
});

describe('ambiguity', () => {
  test('the longest release token wins', () => {
    // "FF" + type "Legend render" vs "FF Legend" + type "render".
    const vocabulary = buildVocabulary(
      { rel: [{ id: 'FF', title: 'FF' }, { id: 'FFL', title: 'Legend', files: { shorthand: 'FF Legend' } }] },
      NO_OVERRIDES,
    );
    const result = validateFileName('Hero from FF Legend render.png', { vocabulary, types: ['render'] });
    assert.equal(result.parts?.release.id, 'FFL');
    assert.equal(result.parts?.type, 'render');
  });

  test('a token only matches whole words', () => {
    // "FFVII Remake-era" doesn't start with the token "FFVII Remake" as a whole
    // word, so this is FFVII + type "Remake-era render".
    assert.equal(validate('Cloud from FFVII Remake-era render.png').parts?.release.id, 'FFVII');
  });

  test('two readings from different "from"s are reported', () => {
    const result = validate('Cloud from FFVII render from FFVI render.png');
    assert.deepEqual(result.errors.map((issue) => issue.code), ['ambiguous']);
    assert.equal(result.parts, undefined);
  });
});

describe('the titled form', () => {
  test('a subject that starts with a release title, then a type', () => {
    const result = validate('Final Fantasy VII Technical Demo for PS3 render.jpg');
    assert.ok(result.ok);
    assert.equal(result.parts?.form, 'titled');
    assert.equal(result.parts?.subject, 'Final Fantasy VII Technical Demo for PS3');
    assert.equal(result.parts?.release.id, 'FFVII');
    assert.equal(result.parts?.type, 'render');
    assert.equal(result.parts?.number, undefined);
  });

  test('always warns', () => {
    assert.deepEqual(warningCodes('Final Fantasy VII Technical Demo for PS3 render.jpg'), ['titled-form']);
  });

  test('the longest title wins', () => {
    assert.equal(validate('Final Fantasy VII Remake Intergrade demo gameplay.png').parts?.release.id, 'FFVIIR');
  });

  test('with a number', () => {
    const parts = validate('Final Fantasy VII Technical Demo for PS3 render 2.jpg').parts;
    assert.equal(parts?.subject, 'Final Fantasy VII Technical Demo for PS3');
    assert.equal(parts?.number, 2);
    assert.deepEqual(errorCodes('Final Fantasy VII Technical Demo for PS3 render 02.jpg'), ['not-parsed']);
  });

  test('a title only matches whole words', () => {
    assert.deepEqual(errorCodes('Final Fantasy VIII demo render.png'), ['not-parsed']);
  });

  test('a known type is required', () => {
    const message = validate('Final Fantasy VII Technical Demo for PS3.jpg').errors[0]?.message;
    assert.match(message!, /starts with the title "Final Fantasy VII" but .* doesn't end in a type/);
  });

  test('never tried for names with "from"', () => {
    assert.match(validate('Final Fantasy VII logo from FFZ render.png').errors[0]!.message, /doesn't name a known release/);
  });

  test('formatFileName builds it when there is no release', () => {
    const name = formatFileName({ subject: 'Final Fantasy VII Technical Demo for PS3', type: 'render', number: 2, extension: 'jpg' });
    assert.equal(name, 'Final Fantasy VII Technical Demo for PS3 render 2.jpg');
    assert.equal(validate(name).parts?.form, 'titled');
  });
});

describe('formatFileName', () => {
  test('builds names that parse back to the same parts', () => {
    const name = formatFileName({ subject: 'Terra Branford', release: 'FFVI', version: 'GBA', type: 'battle render', number: 3, extension: 'png' });
    assert.equal(name, 'Terra Branford from FFVI GBA battle render 3.png');
    const parts = validate(name).parts;
    assert.deepEqual([parts?.subject, parts?.release.id, parts?.version?.key, parts?.type, parts?.number], ['Terra Branford', 'FFVI', 'advance', 'battle render', 3]);
  });

  test('leaves out empty slots', () => {
    assert.equal(formatFileName({ subject: 'Infiltration', release: 'FFVII Remake', extension: 'jpg' }), 'Infiltration from FFVII Remake.jpg');
  });
});
