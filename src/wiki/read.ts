// Read-only queries the bot needs: category members, page text, file info,
// where a page or file is used, and whether pages exist, with typed results.
// mwn does the requests and continuation; on top of it this batches titles 50
// at a time (the limit without the apihighlimits right) and merges pages that
// continuation splits across responses, which mwn's read()/massQuery() don't.

import type { WikiClient } from './client.ts';

const TITLES_PER_REQUEST = 50;

/** A page as list modules return it. */
export interface PageRef {
  readonly title: string;
  /** Namespace number: 0 articles, 2 User, 6 File, 10 Template, 14 Category, ... */
  readonly ns: number;
}

export interface CategoryMember extends PageRef {
  readonly type: 'page' | 'file' | 'subcat';
}

export interface Page {
  readonly title: string;
  readonly exists: boolean;
  /** Current revision, for detecting edits between planning and executing. */
  readonly revid: number | undefined;
  readonly timestamp: string | undefined;
  readonly content: string | undefined;
}

export interface FileInfo {
  readonly title: string;
  readonly exists: boolean;
  readonly url: string | undefined;
  /** A scaled-down image, for the LLM (or a reviewer) to look at. */
  readonly thumbUrl: string | undefined;
  /** The file's description page on the wiki. */
  readonly pageUrl: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly size: number | undefined;
  readonly mime: string | undefined;
  readonly sha1: string | undefined;
  readonly uploader: string | undefined;
  readonly uploaded: string | undefined;
  readonly categories: readonly string[];
}

export interface Usages {
  readonly title: string;
  /** Pages that show the file (imageusage); empty for non-files. */
  readonly fileUsage: readonly PageRef[];
  /** Pages that link to it, e.g. [[:File:X]] or [[:Category:X]] (backlinks). */
  readonly links: readonly PageRef[];
  /** Pages that transclude it (embeddedin). */
  readonly transclusions: readonly PageRef[];
  /** Redirects to it. */
  readonly redirects: readonly PageRef[];
}

export interface Existence {
  readonly title: string;
  /** The title after MediaWiki's normalization (case of first letter, underscores). */
  readonly normalized: string;
  readonly exists: boolean;
  /** Where it redirects to, if it's a redirect. */
  readonly redirectsTo: string | undefined;
}

// --- Queries --------------------------------------------------------------------

/** Members of a category; with `recursive`, also members of its subcategories. */
export async function listCategoryMembers(
  client: WikiClient,
  category: string,
  options: { types?: ReadonlyArray<CategoryMember['type']>; recursive?: boolean } = {},
): Promise<CategoryMember[]> {
  const seen = new Set<string>();
  const members: CategoryMember[] = [];
  const pending = [withNamespace(category, 'Category')];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (seen.has(current)) continue; // categories can contain each other
    seen.add(current);
    for await (const body of queryAll<{ categorymembers: CategoryMember[] }>(client, {
      list: 'categorymembers',
      cmtitle: current,
      cmprop: 'title|type',
      cmlimit: 'max',
    })) {
      for (const member of body.query?.categorymembers ?? []) {
        if (options.recursive === true && member.type === 'subcat') pending.push(member.title);
        if (options.types === undefined || options.types.includes(member.type)) members.push(member);
      }
    }
  }
  return members;
}

/** Current text and revision of each title. */
export async function getPages(client: WikiClient, titles: readonly string[]): Promise<Page[]> {
  type Raw = { title: string; missing?: boolean; revisions?: Array<{ revid: number; timestamp: string; slots: { main: { content: string } } }> };
  const pages = await queryPages<Raw>(client, titles, { prop: 'revisions', rvprop: 'ids|timestamp|content', rvslots: 'main' });
  return titles.map((title) => {
    const page = pages.get(title);
    const revision = page?.revisions?.[0];
    return {
      title: page?.title ?? title,
      exists: page !== undefined && page.missing !== true,
      revid: revision?.revid,
      timestamp: revision?.timestamp,
      content: revision?.slots.main.content,
    };
  });
}

/**
 * The pages each title transcludes, directly or through other templates
 * (prop=templates). With `among`, only those pages are checked for, which is
 * much cheaper than listing every template on a page.
 */
export async function getTransclusions(client: WikiClient, titles: readonly string[], among?: readonly string[]): Promise<Map<string, string[]>> {
  type Raw = { title: string; templates?: PageRef[] };
  const result = new Map<string, string[]>(titles.map((title) => [title, []]));
  if (among?.length === 0) return result;
  // tltemplates takes at most 50 titles, like titles itself.
  const chunks = among === undefined ? [undefined] : Array.from({ length: Math.ceil(among.length / TITLES_PER_REQUEST) }, (_, i) => among.slice(i * TITLES_PER_REQUEST, (i + 1) * TITLES_PER_REQUEST));
  for (const chunk of chunks) {
    const pages = await queryPages<Raw>(client, titles, { prop: 'templates', tllimit: 'max', ...(chunk === undefined ? {} : { tltemplates: chunk.join('|') }) });
    for (const title of titles) {
      result.get(title)!.push(...(pages.get(title)?.templates ?? []).map((template) => template.title));
    }
  }
  return result;
}

/** Image details (with a thumbnail `thumbWidth` pixels wide) and categories. */
export async function getFileInfo(client: WikiClient, titles: readonly string[], thumbWidth = 400): Promise<FileInfo[]> {
  type Raw = {
    title: string;
    missing?: boolean;
    imageinfo?: Array<{
      url: string;
      thumburl?: string;
      descriptionurl?: string;
      width: number;
      height: number;
      size: number;
      mime: string;
      sha1: string;
      user: string;
      timestamp: string;
    }>;
    categories?: Array<{ title: string }>;
  };
  const files = titles.map((title) => withNamespace(title, 'File'));
  const pages = await queryPages<Raw>(client, files, {
    prop: 'imageinfo|categories',
    iiprop: 'url|size|mime|sha1|user|timestamp',
    iiurlwidth: String(thumbWidth),
    cllimit: 'max',
  });
  return files.map((title) => {
    const page = pages.get(title);
    const info = page?.imageinfo?.[0];
    return {
      title: page?.title ?? title,
      exists: page !== undefined && page.missing !== true && info !== undefined,
      url: info?.url,
      thumbUrl: info?.thumburl,
      pageUrl: info?.descriptionurl,
      width: info?.width,
      height: info?.height,
      size: info?.size,
      mime: info?.mime,
      sha1: info?.sha1,
      uploader: info?.user,
      uploaded: info?.timestamp,
      categories: (page?.categories ?? []).map((category) => category.title),
    };
  });
}

/** Everywhere `title` is used: shown (files), linked, transcluded, redirected to. */
export async function findUsages(client: WikiClient, title: string): Promise<Usages> {
  const isFile = /^(File|Image):/i.test(title);
  const collect = async <K extends string>(key: K, params: Record<string, string>): Promise<PageRef[]> => {
    const refs: PageRef[] = [];
    for await (const body of queryAll<Record<K, PageRef[]>>(client, params)) {
      refs.push(...(body.query?.[key] ?? []).map(({ title: refTitle, ns }) => ({ title: refTitle, ns })));
    }
    return refs;
  };
  const [fileUsage, links, transclusions, redirects] = await Promise.all([
    isFile ? collect('imageusage', { list: 'imageusage', iutitle: title, iulimit: 'max' }) : Promise.resolve([]),
    collect('backlinks', { list: 'backlinks', bltitle: title, blfilterredir: 'nonredirects', bllimit: 'max' }),
    collect('embeddedin', { list: 'embeddedin', eititle: title, eilimit: 'max' }),
    collect('backlinks', { list: 'backlinks', bltitle: title, blfilterredir: 'redirects', bllimit: 'max' }),
  ]);
  return { title, fileUsage, links, transclusions, redirects };
}

/**
 * `findUsages` for many files at once, without transclusions (files aren't
 * transcluded): 50 files per request instead of four requests per file.
 * Keyed by the requested title.
 */
export async function getFileUsages(client: WikiClient, titles: readonly string[]): Promise<Map<string, Omit<Usages, 'transclusions'>>> {
  type Raw = { title: string; fileusage?: PageRef[]; linkshere?: PageRef[]; redirects?: PageRef[] };
  const files = titles.map((title) => withNamespace(title, 'File'));
  const pages = await queryPages<Raw>(client, files, {
    prop: 'fileusage|linkshere|redirects',
    fulimit: 'max',
    lhlimit: 'max',
    lhshow: '!redirect',
    rdlimit: 'max',
  });
  const refs = (list: PageRef[] | undefined) => (list ?? []).map(({ title, ns }) => ({ title, ns }));
  return new Map(
    titles.map((title, index) => {
      const page = pages.get(files[index]!);
      return [title, { title: page?.title ?? files[index]!, fileUsage: refs(page?.fileusage), links: refs(page?.linkshere), redirects: refs(page?.redirects) }];
    }),
  );
}

/** Whether each title exists, after normalization and following redirects. */
export async function pagesExist(client: WikiClient, titles: readonly string[]): Promise<Existence[]> {
  const result = new Map<string, Existence>();
  for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
    const batch = titles.slice(i, i + TITLES_PER_REQUEST);
    const body = (await client.request({ action: 'query', titles: batch.join('|'), redirects: '1' })) as {
      query: {
        normalized?: Array<{ from: string; to: string }>;
        redirects?: Array<{ from: string; to: string }>;
        pages: Array<{ title: string; missing?: boolean; invalid?: boolean }>;
      };
    };
    const normalized = new Map((body.query.normalized ?? []).map((entry) => [entry.from, entry.to]));
    const redirects = new Map((body.query.redirects ?? []).map((entry) => [entry.from, entry.to]));
    const pages = new Map(body.query.pages.map((page) => [page.title, page]));
    for (const title of batch) {
      const name = normalized.get(title) ?? title;
      const target = redirects.get(name);
      const page = pages.get(target ?? name);
      result.set(title, {
        title,
        normalized: name,
        exists: page !== undefined && page.missing !== true && page.invalid !== true,
        redirectsTo: target,
      });
    }
  }
  return titles.map((title) => result.get(title)!);
}

// --- Plumbing -----------------------------------------------------------------

type QueryBody<T> = { query?: Partial<T> };

/** action=query, with mwn following `continue` until the result is complete. */
async function* queryAll<T>(client: WikiClient, params: Record<string, string>): AsyncGenerator<QueryBody<T>> {
  for await (const body of client.continuedQueryGen({ action: 'query', ...params })) {
    yield body as QueryBody<T>;
  }
}

/**
 * prop= queries over many titles. Batches titles, follows continuation, and
 * merges the parts of each page that continuation splits across responses
 * (e.g. a long category list). Keyed by the requested title.
 */
async function queryPages<P extends { title: string }>(
  client: WikiClient,
  titles: readonly string[],
  params: Record<string, string>,
): Promise<Map<string, P>> {
  const byRequested = new Map<string, P>();
  for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
    const batch = titles.slice(i, i + TITLES_PER_REQUEST);
    const merged = new Map<string, P>();
    const normalized = new Map<string, string>();
    for await (const body of queryAll<{ pages: P[]; normalized: Array<{ from: string; to: string }> }>(client, {
      ...params,
      titles: batch.join('|'),
    })) {
      for (const entry of body.query?.normalized ?? []) normalized.set(entry.from, entry.to);
      for (const page of body.query?.pages ?? []) {
        merged.set(page.title, mergePage(merged.get(page.title), page));
      }
    }
    for (const title of batch) {
      const page = merged.get(normalized.get(title) ?? title);
      if (page !== undefined) byRequested.set(title, page);
    }
  }
  return byRequested;
}

/** Concatenates array properties (categories, imageinfo...) of two partial pages. */
function mergePage<P extends object>(existing: P | undefined, next: P): P {
  if (existing === undefined) return next;
  const result: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  for (const [key, value] of Object.entries(next)) {
    const current = result[key];
    result[key] = Array.isArray(current) && Array.isArray(value) ? [...current, ...value] : value;
  }
  return result as P;
}

/** Adds `File:` / `Category:` to a title that lacks a namespace prefix. */
function withNamespace(title: string, namespace: 'File' | 'Category'): string {
  const prefixes = namespace === 'File' ? /^(File|Image):/i : /^Category:/i;
  return prefixes.test(title) ? title : `${namespace}:${title}`;
}
