// Loads and validates a wiki profile (profiles/<name>/profile.json): every
// setting that is specific to one wiki. Validation is hand-written so it
// needs no schema library, and it reports every problem at once, by path.

import { readFile } from 'node:fs/promises';

export interface Profile {
  readonly name: string;
  /** Full URL of api.php. */
  readonly api: string;
  /** Who to contact about the bot; goes in the User-Agent. */
  readonly userAgentContact: string;
  /** Required before any write: a policy URL, or a note on who approved the bot. */
  readonly botPolicy: { readonly url: string | null; readonly note: string };
  readonly rate: { readonly editIntervalSeconds: number; readonly maxlag: number };
  readonly redirects: 'suppress' | 'keep';
  readonly emptiedCategories: { readonly action: 'delete' } | { readonly action: 'softRedirect'; readonly template: string };
  readonly releases: CodenameReleases;
  readonly vocabulary: VocabularyOverrides;
  readonly fileNaming: { readonly types: readonly string[] };
  /** How new category pages start, e.g. {{category |name=… |contains=all image |namespace=file}}. Optional. */
  readonly categoryPages?: CategoryPages;
  /** How /Gallery subpages are replaced by image categories. Optional; the gallery cleanup needs it. */
  readonly galleries?: GallerySettings;
}

export interface GallerySettings {
  /** The category a subject's images belong in, with "{subject}" for the gallery's page: "Category:Images of {subject}". */
  readonly imageCategory: string;
  /** The text of a new image category, with "{subject}" too, for subjects that don't have one yet. */
  readonly categoryText: string;
  /** Template parameters on the subject's page that link to its gallery, e.g. "gallery" (|gallery=true on an infobox). */
  readonly linkParameters: readonly string[];
  /** Templates that point readers to a page ({{main|/Gallery}}); removed with the gallery. */
  readonly pointerTemplates: readonly string[];
  /** Words in a heading whose images belong on the article instead (e.g. "Merchandise"); matched case-insensitively. */
  readonly moveSections: readonly string[];
}

export interface CategoryPages {
  /** The header template every category page starts with. */
  readonly headerTemplate: string;
  /** Parameters it always gets, after `name`. */
  readonly headerParams: Readonly<Record<string, string>>;
}

/** Release data from a Module:Codename-style Lua data module. */
export interface CodenameReleases {
  readonly adapter: 'codename';
  /** Where to read the data: the JSON export module, or parsing the Lua. */
  readonly source: 'export-module' | 'parse-lua';
  readonly exportModule: string;
  readonly dataModule: string;
  /** Also parse the Lua and compare it with the export. */
  readonly crossCheck: boolean;
}

export interface VocabularyOverrides {
  /** Release id → token used in file names, when it isn't the id. */
  readonly releaseTokens: Readonly<Record<string, string>>;
  /** Release id → version key → token. Overrides a version in the data, or adds one it lacks. */
  readonly versionTokens: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Releases whose versions look the same, so file names never carry a version. */
  readonly versionNeutral: readonly string[];
}

export class ProfileError extends Error {
  readonly problems: readonly string[];

  constructor(source: string, problems: string[]) {
    super(`Invalid profile ${source}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ProfileError';
    this.problems = problems;
  }
}

const PROFILES_DIR = new URL('../profiles/', import.meta.url);

/** Reads profiles/<name>/profile.json from the repo. */
export async function loadProfile(name: string): Promise<Profile> {
  const file = new URL(`${name}/profile.json`, PROFILES_DIR);
  const text = await readFile(file, 'utf8');
  return parseProfile(JSON.parse(text), file.pathname);
}

/**
 * The profile's guide for the LLM (profiles/<name>/guide.md): the wiki's own
 * naming rules and judgement calls. Optional; undefined if there is none.
 */
export async function loadGuide(name: string): Promise<string | undefined> {
  try {
    return await readFile(new URL(`${name}/guide.md`, PROFILES_DIR), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Validates already-parsed JSON. `source` is only used in error messages. */
export function parseProfile(json: unknown, source: string): Profile {
  const problems: string[] = [];
  const check = new Checker(problems);

  const root = check.object(json, '');
  const botPolicy = check.object(root?.botPolicy, 'botPolicy');
  const rate = check.object(root?.rate, 'rate');
  const emptied = check.object(root?.emptiedCategories, 'emptiedCategories');
  const releases = check.object(root?.releases, 'releases');
  const vocabulary = check.object(root?.vocabulary, 'vocabulary');
  const fileNaming = check.object(root?.fileNaming, 'fileNaming');
  const categoryPages = root?.categoryPages === undefined ? undefined : check.object(root.categoryPages, 'categoryPages');
  const galleries = root?.galleries === undefined ? undefined : check.object(root.galleries, 'galleries');

  const emptiedAction = check.oneOf(emptied?.action, 'emptiedCategories.action', ['delete', 'softRedirect'] as const);

  const profile = {
    name: check.string(root?.name, 'name'),
    api: check.url(root?.api, 'api'),
    userAgentContact: check.string(root?.userAgentContact, 'userAgentContact'),
    botPolicy: {
      url: botPolicy?.url === null ? null : check.url(botPolicy?.url, 'botPolicy.url'),
      note: check.string(botPolicy?.note, 'botPolicy.note', { allowEmpty: true }),
    },
    rate: {
      editIntervalSeconds: check.positiveNumber(rate?.editIntervalSeconds, 'rate.editIntervalSeconds'),
      maxlag: check.positiveNumber(rate?.maxlag, 'rate.maxlag'),
    },
    redirects: check.oneOf(root?.redirects, 'redirects', ['suppress', 'keep'] as const),
    emptiedCategories:
      emptiedAction === 'softRedirect'
        ? { action: emptiedAction, template: check.string(emptied?.template, 'emptiedCategories.template') }
        : { action: emptiedAction },
    releases: {
      adapter: check.oneOf(releases?.adapter, 'releases.adapter', ['codename'] as const),
      source: check.oneOf(releases?.source, 'releases.source', ['export-module', 'parse-lua'] as const),
      exportModule: check.string(releases?.exportModule, 'releases.exportModule'),
      dataModule: check.string(releases?.dataModule, 'releases.dataModule'),
      crossCheck: check.boolean(releases?.crossCheck, 'releases.crossCheck'),
    },
    vocabulary: {
      releaseTokens: check.stringRecord(vocabulary?.releaseTokens, 'vocabulary.releaseTokens'),
      versionTokens: Object.fromEntries(
        Object.entries(check.object(vocabulary?.versionTokens, 'vocabulary.versionTokens') ?? {}).map(([release, tokens]) => [
          release,
          check.stringRecord(tokens, `vocabulary.versionTokens.${release}`),
        ]),
      ),
      versionNeutral: check.stringArray(vocabulary?.versionNeutral, 'vocabulary.versionNeutral'),
    },
    fileNaming: {
      types: check.stringArray(fileNaming?.types, 'fileNaming.types', { nonEmpty: true }),
    },
    ...(root?.categoryPages === undefined
      ? {}
      : {
          categoryPages: {
            headerTemplate: check.string(categoryPages?.headerTemplate, 'categoryPages.headerTemplate'),
            headerParams: check.stringRecord(categoryPages?.headerParams, 'categoryPages.headerParams'),
          },
        }),
    ...(root?.galleries === undefined
      ? {}
      : {
          galleries: {
            imageCategory: check.string(galleries?.imageCategory, 'galleries.imageCategory'),
            categoryText: check.string(galleries?.categoryText, 'galleries.categoryText'),
            linkParameters: check.stringArray(galleries?.linkParameters, 'galleries.linkParameters'),
            pointerTemplates: check.stringArray(galleries?.pointerTemplates, 'galleries.pointerTemplates'),
            moveSections: check.stringArray(galleries?.moveSections, 'galleries.moveSections'),
          },
        }),
  };
  if (profile.galleries !== undefined && !profile.galleries.imageCategory.includes('{subject}')) {
    problems.push(`galleries.imageCategory must contain {subject} (got ${JSON.stringify(profile.galleries.imageCategory)})`);
  }

  if (problems.length > 0) {
    throw new ProfileError(source, problems);
  }
  // Placeholder values returned for invalid fields never escape: any problem
  // throws above.
  return profile;
}

/** Whether the profile says how the bot was approved; write tools require it. */
export function hasBotPolicy(profile: Profile): boolean {
  return profile.botPolicy.url !== null || profile.botPolicy.note.trim() !== '';
}

/** Collects problems instead of throwing, so one run reports them all. */
class Checker {
  readonly #problems: string[];

  constructor(problems: string[]) {
    this.#problems = problems;
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    this.#problem(path, 'must be an object', value);
    return undefined;
  }

  string(value: unknown, path: string, { allowEmpty = false } = {}): string {
    if (typeof value === 'string' && (allowEmpty || value.trim() !== '')) {
      return value;
    }
    this.#problem(path, allowEmpty ? 'must be a string' : 'must be a non-empty string', value);
    return '';
  }

  url(value: unknown, path: string): string {
    const text = this.string(value, path);
    if (text !== '' && !URL.canParse(text)) {
      this.#problem(path, 'must be a URL', value);
    }
    return text;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    this.#problem(path, 'must be true or false', value);
    return false;
  }

  positiveNumber(value: unknown, path: string): number {
    if (typeof value === 'number' && value > 0) {
      return value;
    }
    this.#problem(path, 'must be a number greater than 0', value);
    return 0;
  }

  oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    if (allowed.includes(value as T)) {
      return value as T;
    }
    this.#problem(path, `must be one of ${allowed.map((option) => `"${option}"`).join(', ')}`, value);
    return allowed[0] as T;
  }

  stringArray(value: unknown, path: string, { nonEmpty = false } = {}): string[] {
    if (!Array.isArray(value)) {
      this.#problem(path, 'must be an array of strings', value);
      return [];
    }
    if (nonEmpty && value.length === 0) {
      this.#problem(path, 'must not be empty', value);
    }
    return value.map((item, i) => this.string(item, `${path}[${i}]`));
  }

  stringRecord(value: unknown, path: string): Record<string, string> {
    const record = this.object(value, path) ?? {};
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, this.string(item, `${path}.${key}`)]));
  }

  #problem(path: string, message: string, value: unknown): void {
    this.#problems.push(`${path === '' ? '(root)' : path} ${message} (got ${JSON.stringify(value) ?? 'undefined'})`);
  }
}
