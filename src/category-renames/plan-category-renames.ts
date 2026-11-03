// Plans category renames ("Category:Final Fantasy VII character images" →
// "Category:Character images from Final Fantasy VII"): the new category page,
// the members to re-tag, and what happens to the old page once it's empty.
//
// The new page's text is copied from a `model` sibling that follows the
// naming convention "<Kind> from <Release title>" (or "<Kind> for <Release
// title>"), with the model's release title swapped for the target's: modeling
// "Character images from Final Fantasy VII" on "Character images from Final
// Fantasy VII Remake" turns "''Final Fantasy VII Remake''" into "''Final
// Fantasy VII''" throughout. Text can also be given directly; with neither,
// the old page's text is kept. Either way, references to other categories
// renamed in the same batch are rewritten, so parents get their new names.
//
// With the profile's `categoryPages`, a page without the header template gets
// one, the way correctly named categories start:
//   {{category |name=Character artwork from ''Final Fantasy VII'' |contains=all image |namespace=file |related=… }}
// followed by the page's category tags; any other text is dropped (and warned
// about), since the header describes the category.
//
// Re-tagging is left to planReferenceEdits (src/plans/reference-edits.ts):
// pass it every plan's `rename`, with the `members` as `alsoEdit`, then use
// `taggedByTemplate` to find members whose own text doesn't add the category.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import type { CategoryPages, Profile } from '../profile.ts';
import type { PageEdit, ReferencePlan } from '../plans/reference-edits.ts';
import type { WikiClient } from '../wiki/client.ts';
import { getPages, listCategoryMembers, pagesExist, type CategoryMember } from '../wiki/read.ts';
import { rewriteReferences, type Rename } from '../wikitext/references.ts';

export interface CategoryRenameRequest {
  readonly from: string;
  readonly to: string;
  /** An existing category to copy the new page's text from. */
  readonly model?: string;
  /** The new page's text, instead of a model. */
  readonly text?: string;
  /** The header's `related` parameter, e.g. "[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']]". */
  readonly related?: string;
}

export interface CategoryRenameOptions {
  /** Release titles, e.g. "Final Fantasy VII", for reading "<Kind> from <Release title>". */
  readonly releaseTitles: readonly string[];
  /** What to do with an old category page once it's empty (from the profile). */
  readonly emptied: Profile['emptiedCategories'];
  /** The header new category pages start with (from the profile). */
  readonly header?: CategoryPages;
}

export type CategoryIssueCode =
  | 'source-missing'
  | 'no-text'
  | 'model-missing'
  | 'not-conventional'
  | 'model-kind-differs'
  | 'model-unchanged'
  | 'old-text-kept'
  | 'header-added'
  | 'old-text-dropped'
  | 'no-related'
  | 'target-exists'
  | 'missing-parent'
  | 'tagged-by-template';

export interface CategoryIssue {
  readonly code: CategoryIssueCode;
  readonly message: string;
}

export interface CategoryRenamePlan {
  readonly from: string;
  readonly to: string;
  /** For planReferenceEdits: re-tags members and rewrites links. */
  readonly rename: Rename;
  /** Direct members (pages, files, subcategories), all to be re-tagged. */
  readonly members: readonly CategoryMember[];
  /** The new page, unless `to` already exists. */
  readonly create: { readonly text: string; readonly model: string | undefined } | undefined;
  /** What happens to the old page once it's empty and nothing links to it. */
  readonly old: { readonly action: 'delete' } | { readonly action: 'softRedirect'; readonly text: string } | undefined;
  /** Any error blocks the rename. */
  readonly errors: readonly CategoryIssue[];
  readonly warnings: readonly CategoryIssue[];
}

/**
 * Plans several category renames together, so a new category can be the
 * parent of another one in the same batch (e.g. the artwork category under
 * the images category).
 */
export async function planCategoryRenames(
  client: WikiClient,
  requests: readonly CategoryRenameRequest[],
  options: CategoryRenameOptions,
): Promise<CategoryRenamePlan[]> {
  const category = (title: string) => new client.Title(title, 14).toText();
  const normalized = requests.map((request) => ({
    ...request,
    from: category(request.from),
    to: category(request.to),
    model: request.model === undefined ? undefined : category(request.model),
  }));

  const titles = [...new Set(normalized.flatMap((request) => [request.from, request.to, ...(request.model === undefined ? [] : [request.model])]))];
  const pages = new Map((await getPages(client, titles)).map((page, i) => [titles[i]!, page]));
  const planned = new Set(normalized.map((request) => request.to));
  const renames = normalized.map((request) => ({ from: request.from, to: request.to }));

  const plans: CategoryRenamePlan[] = [];
  for (const request of normalized) {
    const errors: CategoryIssue[] = [];
    const warnings: CategoryIssue[] = [];
    const members = await listCategoryMembers(client, request.from);
    const source = pages.get(request.from);
    if (source?.exists !== true && members.length === 0) {
      errors.push({ code: 'source-missing', message: `${request.from} has no page and no members` });
    }

    let create: CategoryRenamePlan['create'];
    if (pages.get(request.to)?.exists === true) {
      warnings.push({ code: 'target-exists', message: `${request.to} already exists, so it is kept as it is and only the members move` });
    } else {
      const oldText = source?.content;
      let text: string | undefined;
      if (request.text !== undefined) {
        text = request.text;
      } else if (request.model !== undefined || oldText === undefined) {
        text = textFromModel(request, pages.get(request.model ?? '')?.content, options.releaseTitles, errors, warnings);
      } else {
        text = oldText;
        warnings.push({ code: 'old-text-kept', message: `no model or text given, so ${request.to} gets ${request.from}'s text` });
      }
      if (text !== undefined) {
        text = rewriteReferences(client, text, renames).text;
        if (options.header !== undefined && !startsWithTemplate(text, options.header.headerTemplate)) {
          text = withHeader(request, text, options.header, options.releaseTitles, errors, warnings);
        }
      }
      if (text !== undefined) create = { text, model: request.text === undefined ? request.model : undefined };
    }

    if (create !== undefined) {
      const wikitext = new client.Wikitext(create.text);
      wikitext.parseLinks();
      const parents = [...new Set(wikitext.categories.map((link) => link.target.toText()))].filter((parent) => !planned.has(parent));
      for (const parent of await pagesExist(client, parents)) {
        if (!parent.exists) warnings.push({ code: 'missing-parent', message: `${parent.title} doesn't exist` });
      }
    }

    plans.push({
      from: request.from,
      to: request.to,
      rename: { from: request.from, to: request.to },
      members,
      create,
      old: source?.exists !== true ? undefined : oldPageAction(options.emptied, request.to),
      errors,
      warnings,
    });
  }
  return plans;
}

/**
 * Members whose own text doesn't add the category: they get it from a
 * template, so re-tagging needs the template changed, and the old category
 * won't empty until it is. Pass the plan made with this rename.
 */
export function taggedByTemplate(plan: CategoryRenamePlan, references: ReferencePlan): CategoryIssue[] {
  const edits = new Map<string, PageEdit>(references.edits.map((edit) => [edit.title, edit]));
  return plan.members
    .filter((member) => !edits.get(member.title)?.rewrites.some((rewrite) => rewrite.kind === 'category' && rewrite.from === plan.from))
    .map((member) => ({ code: 'tagged-by-template', message: `${member.title} isn't tagged with ${plan.from} in its own text` }));
}

function textFromModel(
  request: { from: string; to: string; model: string | undefined },
  modelText: string | undefined,
  releaseTitles: readonly string[],
  errors: CategoryIssue[],
  warnings: CategoryIssue[],
): string | undefined {
  if (request.model === undefined) {
    errors.push({ code: 'no-text', message: `${request.to} needs a model category or text` });
    return undefined;
  }
  if (modelText === undefined) {
    errors.push({ code: 'model-missing', message: `${request.model} doesn't exist` });
    return undefined;
  }
  const target = splitCategoryName(request.to, releaseTitles);
  const model = splitCategoryName(request.model, releaseTitles);
  if (target === undefined || model === undefined) {
    const which = target === undefined ? request.to : request.model;
    errors.push({ code: 'not-conventional', message: `${which} isn't "<Kind> from <Release title>" with a known release` });
    return undefined;
  }
  if (target.kind !== model.kind) {
    warnings.push({ code: 'model-kind-differs', message: `${request.model} is "${model.kind}", not "${target.kind}"; only the release is changed` });
  }
  const text = replaceRelease(modelText, model.release, target.release, releaseTitles);
  if (text === modelText) {
    warnings.push({ code: 'model-unchanged', message: `"${model.release}" isn't in ${request.model}'s text, so it is copied unchanged` });
  }
  return text;
}

const CATEGORY_TAG = /\[\[\s*Category\s*:[^\]]*\]\]/gi;

/** Whether `text` calls `template` (first letter in either case) before anything else. */
function startsWithTemplate(text: string, template: string): boolean {
  // RegExp.escape isn't in TypeScript's ES2025 types yet.
  const rest = template.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = `[${template[0]!.toUpperCase()}${template[0]!.toLowerCase()}]${rest}`;
  return new RegExp(`^\\s*\\{\\{\\s*${name}\\s*[|}]`).test(text);
}

/** The profile's header, then `text`'s category tags. Other text is dropped. */
function withHeader(
  request: { to: string; related?: string },
  text: string,
  header: CategoryPages,
  releaseTitles: readonly string[],
  errors: CategoryIssue[],
  warnings: CategoryIssue[],
): string | undefined {
  const split = splitCategoryName(request.to, releaseTitles);
  if (split === undefined) {
    errors.push({ code: 'not-conventional', message: `${request.to} isn't "<Kind> from <Release title>" with a known release, so no header can be made` });
    return undefined;
  }
  const params = [`name=${split.kind} ''${split.release}''`, ...Object.entries(header.headerParams).map(([key, value]) => `${key}=${value}`)];
  if (request.related === undefined) {
    warnings.push({ code: 'no-related', message: `the {{${header.headerTemplate}}} header has no "related" parameter` });
  } else {
    params.push(`related=${request.related}`);
  }
  const tags = text.match(CATEGORY_TAG) ?? [];
  const dropped = text.replace(CATEGORY_TAG, '').trim();
  if (dropped !== '') {
    warnings.push({ code: 'old-text-dropped', message: `"${dropped}" is replaced by the {{${header.headerTemplate}}} header` });
  }
  warnings.push({ code: 'header-added', message: `${request.to} gets a {{${header.headerTemplate}}} header` });
  return [`{{${header.headerTemplate} |${params.join(' |')} }}`, '', ...tags].join('\n');
}

/**
 * "Category:Character images from Final Fantasy VII" → kind "Character
 * images", release "Final Fantasy VII"; "Concept art for Final Fantasy VII"
 * → kind "Concept art". The kind keeps its own word ("from" or "for").
 */
export function splitCategoryName(title: string, releaseTitles: readonly string[]): { kind: string; release: string } | undefined {
  const name = title.replace(/^Category:/, '');
  // The longest matching release wins: "… from Final Fantasy VII Remake" isn't FFVII.
  for (const release of [...releaseTitles].sort((a, b) => b.length - a.length)) {
    for (const word of ['from', 'for']) {
      const suffix = ` ${word} ${release}`;
      if (name.endsWith(suffix) && name.length > suffix.length) return { kind: `${name.slice(0, -suffix.length)} ${word}`, release };
    }
  }
  return undefined;
}

/**
 * Replaces each whole-word `from` with `to`, except where it's part of a longer
 * release title ("Final Fantasy VII" in "Final Fantasy VII Remake").
 */
export function replaceRelease(text: string, from: string, to: string, releaseTitles: readonly string[]): string {
  const containing = releaseTitles.filter((title) => title !== from && title.includes(from));
  const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
  let result = '';
  let last = 0;
  for (let at = text.indexOf(from); at !== -1; at = text.indexOf(from, at + from.length)) {
    const wholeWord = !isWordChar(text[at - 1]) && !isWordChar(text[at + from.length]);
    const partOfLonger = containing.some((title) => {
      for (let offset = title.indexOf(from); offset !== -1; offset = title.indexOf(from, offset + 1)) {
        if (text.startsWith(title, at - offset)) return true;
      }
      return false;
    });
    if (!wholeWord || partOfLonger) continue;
    result += text.slice(last, at) + to;
    last = at + from.length;
  }
  return result + text.slice(last);
}

function oldPageAction(emptied: Profile['emptiedCategories'], to: string): CategoryRenamePlan['old'] {
  return emptied.action === 'delete' ? { action: 'delete' } : { action: 'softRedirect', text: `{{${emptied.template}|${to.replace(/^Category:/, '')}}}` };
}
