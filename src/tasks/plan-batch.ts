// Plans one batch of changes from start to finish and returns its manifest:
// numbered, validated file names; category renames; the page edits all of
// them need (one pass, so chains and re-tags combine); checks that files to
// delete are unused, or that a replacement's usages can all be pointed at the
// file replacing it; and questions for the user. Nothing is written to the
// wiki. Combines the file-renames and category-renames tasks, so it lives
// above both. The manifest records the request, so it can be planned again.
//
// The client must have loaded the wiki's namespaces first:
//   await client.getSiteInfo();

import { planCategoryRenames, taggedByTemplate, type CategoryRenameRequest } from './category-renames/plan-category-renames.ts';
import type { NamingRules } from './file-renames/file-name.ts';
import { planNames, type RenameProposal } from './file-renames/plan-names.ts';
import { buildManifest, type FileDeleteInput, type Manifest, type ManifestIssue, type ManifestRequest, type QuestionInput } from '../shared/plans/manifest.ts';
import { planReferenceEdits, type ReferencePlan } from '../shared/plans/reference-edits.ts';
import { applyRules } from '../shared/plans/rules.ts';
import type { Profile } from '../shared/profile/profile.ts';
import type { WikiClient } from '../shared/wiki/client.ts';
import { findUsages, namespaceName, pagesExist } from '../shared/wiki/read.ts';
import type { Rename } from '../shared/wikitext/references.ts';

export interface BatchRequest {
  readonly files?: readonly RenameProposal[];
  readonly categories?: readonly CategoryRenameRequest[];
  /**
   * Files to delete because nothing uses them, or replaced by another file
   * (`replaceWith`, e.g. a higher-resolution copy) that their usages are
   * pointed at first.
   */
  readonly deletions?: ReadonlyArray<{ readonly title: string; readonly reason: string; readonly replaceWith?: string }>;
  /** Things the planner couldn't decide, for the user. */
  readonly questions?: readonly QuestionInput[];
}

export async function planBatch(client: WikiClient, profile: Profile, rules: NamingRules, request: BatchRequest): Promise<Manifest> {
  const names = await planNames(client, rules, request.files ?? []);
  const categories = await planCategoryRenames(client, request.categories ?? [], {
    releaseTitles: rules.vocabulary.releases.map((release) => release.title),
    emptied: profile.emptiedCategories,
    ...(profile.categoryPages === undefined ? {} : { header: profile.categoryPages }),
  });

  const fileTitle = (title: string) => `File:${title.replace(/^(File|Image):/i, '')}`;
  const goAhead = names.filter((name) => name.errors.length === 0 && !name.warnings.some((warning) => warning.code === 'unchanged'));

  // A replacement's usages point at the file replacing it under its final
  // name: its new name if this batch renames it, else its current one.
  const deleting = new Set((request.deletions ?? []).map((deletion) => fileTitle(deletion.title)));
  const renamedTo = new Map(goAhead.map((name) => [name.from, name.to]));
  const kept = (request.deletions ?? []).flatMap((deletion) => (deletion.replaceWith === undefined ? [] : [fileTitle(deletion.replaceWith)]));
  const existing = new Map((await pagesExist(client, [...new Set(kept.filter((title) => !renamedTo.has(title)))])).map((existence) => [existence.title, existence.exists]));
  const replacements = (request.deletions ?? []).map((deletion) => {
    const title = fileTitle(deletion.title);
    if (deletion.replaceWith === undefined) return { title, errors: [] };
    const target = fileTitle(deletion.replaceWith);
    const errors: ManifestIssue[] = [];
    if (target === title) errors.push({ code: 'replacement-missing', message: `${title} can't replace itself` });
    else if (deleting.has(target)) errors.push({ code: 'replacement-missing', message: `${target} is being deleted too` });
    else if (!renamedTo.has(target) && existing.get(target) !== true) errors.push({ code: 'replacement-missing', message: `${target} does not exist` });
    return { title, errors, replacedBy: renamedTo.get(target) ?? target };
  });

  // Only renames and replacements that can go ahead get their usages rewritten.
  const renames: Rename[] = [
    ...goAhead.map(({ from, to }) => ({ from, to })),
    ...replacements.flatMap((replacement) => (replacement.replacedBy === undefined || replacement.errors.length > 0 ? [] : [{ from: replacement.title, to: replacement.replacedBy }])),
    ...categories.filter((category) => category.errors.length === 0).map((category) => category.rename),
  ];
  const references: ReferencePlan =
    renames.length === 0
      ? { edits: [], usages: [], leftovers: [], blocked: [] }
      : await planReferenceEdits(client, renames, {
          alsoEdit: categories.filter((category) => category.errors.length === 0).flatMap((category) => category.members.map((member) => member.title)),
        });

  const deletions: FileDeleteInput[] = [];
  for (const [index, deletion] of (request.deletions ?? []).entries()) {
    const { title, errors, replacedBy } = replacements[index]!;
    let usedBy: string[];
    if (replacedBy !== undefined && errors.length === 0) {
      // Still used only where a usage can't be rewritten.
      usedBy = [...new Set(references.usages.filter((usage) => usage.from === title && usage.status === 'unresolved').map((usage) => usage.page))];
    } else {
      const usages = await findUsages(client, title);
      usedBy = [...new Set([...usages.fileUsage, ...usages.links, ...usages.transclusions, ...usages.redirects].map((page) => page.title))];
    }
    deletions.push({ title, reason: deletion.reason, usedBy, ...(replacedBy === undefined ? {} : { replacedBy }), errors });
  }

  const manifest = buildManifest({
    wiki: profile.name,
    api: profile.api,
    files: names,
    deletions,
    categories: categories.map((category) => ({ ...category, warnings: [...category.warnings, ...taggedByTemplate(category, references)] })),
    questions: request.questions ?? [],
    references,
    request: renamesRequest(request),
  });
  return applyRules(manifest, profile.rules, (title) => namespaceName(client, title));
}

/** The request as the manifest records it: what was proposed, before validation and numbering. */
function renamesRequest(request: BatchRequest): ManifestRequest {
  return {
    task: 'renames',
    files: (request.files ?? []).map(({ from, to, reason, confidence }) => ({ from, to, ...(reason === undefined ? {} : { reason }), ...(confidence === undefined ? {} : { confidence }) })),
    categories: (request.categories ?? []).map(({ from, to, model, text, related }) => ({
      from,
      to,
      ...(model === undefined ? {} : { model }),
      ...(text === undefined ? {} : { text }),
      ...(related === undefined ? {} : { related }),
    })),
    deletions: (request.deletions ?? []).map(({ title, reason, replaceWith }) => ({ title, reason, ...(replaceWith === undefined ? {} : { replaceWith }) })),
    // Only what was asked: answers and previews are added when it's planned.
    questions: (request.questions ?? []).map(({ about, question }) => ({ about, question })),
  };
}
