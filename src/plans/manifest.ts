// A manifest is the reviewable record of one batch of planned changes: file
// renames and deletions, category renames, pages to create or delete,
// category tags, questions for the user, and every page edit (with diffs) they need. Planning builds it; the user approves
// entries one by one; execution (phase 1) only ever runs approved entries.
//
// Manifests are saved as manifests/<id>.json and checked with a zod schema
// when loaded, since they may have been edited by hand.
//
// The inputs are plain shapes, so this doesn't depend on any one task:
// PlannedName (file-renames) and CategoryRenamePlan (category-renames) fit them,
// and gallery-cleanup plans its own new categories, deletions and tags.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { CHOICES, type Choice } from './answers.ts';
import type { ReferencePlan } from './reference-edits.ts';

// --- Schema -----------------------------------------------------------------------

const Issue = z.object({ code: z.string(), message: z.string() });
const Issues = z.array(Issue);
/** Where to see a file while reviewing: its page on the wiki, and a thumbnail. Optional; older manifests have neither. */
const Preview = { pageUrl: z.string().optional(), thumbUrl: z.string().optional() };

const FileRenameEntry = z.object({
  kind: z.literal('file-rename'),
  id: z.string(),
  from: z.string(),
  to: z.string(),
  /** The name as proposed, before numbering. */
  requested: z.string(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Of the file under its current name. */
  ...Preview,
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

const FileDeleteEntry = z.object({
  kind: z.literal('file-delete'),
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  /** Pages that still use the file; any makes deleting it an error. */
  usedBy: z.array(z.string()),
  /** The file its usages are pointed at before it's deleted (under that file's new name, if it's renamed too). */
  replacedBy: z.string().optional(),
  ...Preview,
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

const CategoryRenameEntry = z.object({
  kind: z.literal('category-rename'),
  id: z.string(),
  from: z.string(),
  to: z.string(),
  /** The new page, unless it already exists. */
  create: z.object({ text: z.string(), model: z.string().optional() }).optional(),
  /** What happens to the old page once it's empty. */
  old: z.discriminatedUnion('action', [z.object({ action: z.literal('delete') }), z.object({ action: z.literal('softRedirect'), text: z.string() })]).optional(),
  members: z.array(z.string()),
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

/** A page to create, e.g. a character's image category, before anything that needs it. */
const PageCreateEntry = z.object({
  kind: z.literal('page-create'),
  id: z.string(),
  title: z.string(),
  text: z.string(),
  reason: z.string(),
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

/** A page to delete, e.g. a gallery page and its talk page. */
const PageDeleteEntry = z.object({
  kind: z.literal('page-delete'),
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  /** Pages that would still link to it after this manifest's edits; any makes deleting it an error. */
  usedBy: z.array(z.string()),
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

/** A category to add to a page, e.g. a kept image's character category. */
const CategoryTagEntry = z.object({
  kind: z.literal('category-tag'),
  id: z.string(),
  title: z.string(),
  category: z.string(),
  approved: z.boolean(),
  errors: Issues,
  warnings: Issues,
});

/** Something the planner couldn't decide; it needs the user, and a new plan. */
const QuestionEntry = z.object({
  kind: z.literal('question'),
  id: z.string(),
  /** The page it's about. */
  about: z.string(),
  question: z.string(),
  /** The fixed answers it offers (answers.ts); free text is always possible too. */
  choices: z.array(z.enum(CHOICES)).optional(),
  /** A free-text answer already given, for the LLM to act on: no planner applies one. */
  answer: z.string().optional(),
  /** When it's about a file. */
  ...Preview,
});

const Entry = z.discriminatedUnion('kind', [FileRenameEntry, FileDeleteEntry, CategoryRenameEntry, PageCreateEntry, PageDeleteEntry, CategoryTagEntry, QuestionEntry]);

const Rewrite = z.object({ kind: z.enum(['embed', 'link', 'category', 'gallery', 'template']), from: z.string(), before: z.string(), after: z.string() });

const PageEdit = z.object({
  title: z.string(),
  revid: z.number().int(),
  timestamp: z.string(),
  text: z.string(),
  diff: z.string(),
  rewrites: z.array(Rewrite),
  /** The entries this edit is for. */
  entries: z.array(z.string()),
});

const Usage = z.object({
  from: z.string(),
  page: z.string(),
  kind: z.enum(['shown', 'linked', 'transcluded', 'redirect']),
  status: z.enum(['rewritten', 'via-template', 'unresolved']),
  via: z.string().optional(),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  /** The profile name and API it was planned against. */
  wiki: z.string(),
  api: z.url(),
  created: z.iso.datetime(),
  /** What it was planned from, so it can be planned again (with new answers). Only some tasks record it. */
  request: z.discriminatedUnion('task', [z.object({ task: z.literal('gallery-cleanup'), galleries: z.array(z.string()) })]).optional(),
  entries: z.array(Entry),
  edits: z.array(PageEdit),
  usages: z.array(Usage),
  leftovers: z.array(z.object({ page: z.string(), from: z.string(), line: z.string() })),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = z.infer<typeof Entry>;
export type ManifestRequest = NonNullable<Manifest['request']>;
export type ManifestIssue = z.infer<typeof Issue>;

// --- Building -----------------------------------------------------------------------

export interface FileRenameInput extends PreviewInput {
  readonly from: string;
  readonly to: string;
  readonly requested: string;
  readonly reason?: string | undefined;
  readonly confidence?: number | undefined;
  readonly errors: readonly ManifestIssue[];
  readonly warnings: readonly ManifestIssue[];
}

/** Where to see a file while reviewing. */
export interface PreviewInput {
  readonly pageUrl?: string | undefined;
  readonly thumbUrl?: string | undefined;
}

export interface FileDeleteInput extends PreviewInput {
  readonly title: string;
  readonly reason: string;
  /** Pages that will still use it: all of them, or for a replacement, the ones whose usages can't be rewritten. */
  readonly usedBy: readonly string[];
  /** For a replacement: the file its usages are rewritten to point at; `references` must have those edits. */
  readonly replacedBy?: string | undefined;
  readonly errors?: readonly ManifestIssue[];
}

export interface CategoryRenameInput {
  readonly from: string;
  readonly to: string;
  readonly create: { readonly text: string; readonly model: string | undefined } | undefined;
  readonly old: { readonly action: 'delete' } | { readonly action: 'softRedirect'; readonly text: string } | undefined;
  readonly members: ReadonlyArray<{ readonly title: string }>;
  readonly errors: readonly ManifestIssue[];
  readonly warnings: readonly ManifestIssue[];
}

export interface PageCreateInput {
  readonly title: string;
  readonly text: string;
  readonly reason: string;
}

export interface PageDeleteInput {
  readonly title: string;
  readonly reason: string;
  /** Pages still linking to it once the manifest's edits are made. */
  readonly usedBy: readonly string[];
}

export interface CategoryTagInput {
  readonly title: string;
  readonly category: string;
}

export interface QuestionInput extends PreviewInput {
  readonly about: string;
  readonly question: string;
  readonly choices?: readonly Choice[];
  readonly answer?: string;
}

export interface ManifestInput {
  readonly wiki: string;
  readonly api: string;
  readonly files?: readonly FileRenameInput[];
  readonly deletions?: readonly FileDeleteInput[];
  readonly categories?: readonly CategoryRenameInput[];
  /** Pages that don't exist yet; created first, before the entries that need them. */
  readonly pageCreations?: readonly PageCreateInput[];
  readonly pageDeletions?: readonly PageDeleteInput[];
  /** Each needs a page edit in `references` whose rewrites are `from` its title. */
  readonly categoryTags?: readonly CategoryTagInput[];
  readonly questions?: readonly QuestionInput[];
  /**
   * The page edits, from planReferenceEdits with every file and category
   * rename. An edit belongs to the entry whose title its rewrites are `from`:
   * a renamed title, a page to delete (removing links to it), or a tagged page.
   */
  readonly references: ReferencePlan;
  /** What it's planned from, for planning again. */
  readonly request?: ManifestRequest;
}

/** Entries proposed with less confidence than this start unapproved. */
export const CONFIDENCE_TO_APPROVE = 0.8;

/** Warnings that need no second look, so they don't stop an entry starting approved. */
const ROUTINE_WARNINGS = new Set(['renumbered', 'header-added', 'old-text-kept']);

export function buildManifest(input: ManifestInput, options: { id?: string; now?: Date } = {}): Manifest {
  // Questions come first, so they're seen first.
  const questions: ManifestEntry[] = [];
  const entries: ManifestEntry[] = [];
  const counts = new Map<string, number>();
  const next = (prefix: string) => {
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    return `${prefix}${counts.get(prefix)}`;
  };
  const blocked = new Set(input.references.blocked);
  const used = new Set(input.references.usages.map((usage) => usage.from));
  const blockedIssue = (from: string): ManifestIssue[] =>
    blocked.has(from) ? [{ code: 'blocked', message: `${from} has usages that can't be rewritten; see the unresolved usages and leftovers` }] : [];

  for (const question of input.questions ?? []) {
    questions.push({
      kind: 'question',
      id: next('q'),
      about: question.about,
      question: question.question,
      ...(question.choices === undefined ? {} : { choices: [...question.choices] }),
      ...(question.answer === undefined ? {} : { answer: question.answer }),
      ...preview(question),
    });
  }
  for (const file of input.files ?? []) {
    // A missing source isn't a rename at all: ask.
    if (file.errors.some((error) => error.code === 'source-missing')) {
      questions.push({ kind: 'question', id: next('q'), about: file.from, question: `${file.from} doesn't exist. Was it renamed or deleted, or is the name wrong?` });
      continue;
    }
    const errors = [...file.errors, ...blockedIssue(file.from)];
    const warnings = [...file.warnings];
    // Only renames that were planned had their usages looked up.
    const planned = file.errors.length === 0 && !file.warnings.some((warning) => warning.code === 'unchanged');
    if (planned && !used.has(file.from)) {
      warnings.push({ code: 'unused', message: `${file.from} isn't used anywhere; it could be deleted instead` });
    }
    entries.push({
      kind: 'file-rename',
      id: next('f'),
      from: file.from,
      to: file.to,
      requested: file.requested,
      ...(file.reason === undefined ? {} : { reason: file.reason }),
      ...(file.confidence === undefined ? {} : { confidence: file.confidence }),
      ...preview(file),
      approved: startsApproved(errors, warnings, file.confidence),
      errors,
      warnings,
    });
  }
  for (const deletion of input.deletions ?? []) {
    const errors = [
      ...(deletion.errors ?? []),
      ...(deletion.usedBy.length === 0 ? [] : [{ code: 'in-use', message: `${deletion.title} is used on ${deletion.usedBy.length} page(s)` }]),
      // A replacement's usages are rewritten like a rename's, so they can block it the same way.
      ...(deletion.replacedBy === undefined ? [] : blockedIssue(deletion.title)),
    ];
    // Deleting is never approved by default.
    entries.push({
      kind: 'file-delete',
      id: next('d'),
      title: deletion.title,
      reason: deletion.reason,
      usedBy: [...deletion.usedBy],
      ...(deletion.replacedBy === undefined ? {} : { replacedBy: deletion.replacedBy }),
      ...preview(deletion),
      approved: false,
      errors,
      warnings: [],
    });
  }
  for (const category of input.categories ?? []) {
    const errors = [...category.errors, ...blockedIssue(category.from)];
    const warnings = [...category.warnings];
    entries.push({
      kind: 'category-rename',
      id: next('c'),
      from: category.from,
      to: category.to,
      ...(category.create === undefined ? {} : { create: category.create.model === undefined ? { text: category.create.text } : { ...category.create, model: category.create.model } }),
      ...(category.old === undefined ? {} : { old: category.old }),
      members: category.members.map((member) => member.title),
      approved: startsApproved(errors, warnings, 1),
      errors,
      warnings,
    });
  }

  for (const page of input.pageCreations ?? []) {
    // Creating a page from a planned text loses nothing, like a tag.
    entries.push({ kind: 'page-create', id: next('n'), title: page.title, text: page.text, reason: page.reason, approved: true, errors: [], warnings: [] });
  }
  for (const page of input.pageDeletions ?? []) {
    const errors = [
      ...(page.usedBy.length === 0 ? [] : [{ code: 'in-use', message: `${page.title} is still linked from ${page.usedBy.length} page(s)` }]),
      ...blockedIssue(page.title),
    ];
    // Deleting is never approved by default.
    entries.push({ kind: 'page-delete', id: next('p'), title: page.title, reason: page.reason, usedBy: [...page.usedBy], approved: false, errors, warnings: [] });
  }
  for (const tag of input.categoryTags ?? []) {
    entries.push({ kind: 'category-tag', id: next('t'), title: tag.title, category: tag.category, approved: true, errors: [], warnings: [] });
  }

  // Which entries each page edit serves, by the title its rewrites are from.
  // A page can have several tags, each its own entry.
  const entriesFor = new Map<string, string[]>();
  const add = (title: string, id: string) => entriesFor.set(title, [...(entriesFor.get(title) ?? []), id]);
  for (const entry of entries) {
    if (entry.kind === 'file-rename' || entry.kind === 'category-rename') add(entry.from, entry.id);
    if (entry.kind === 'page-delete' || entry.kind === 'category-tag') add(entry.title, entry.id);
    if (entry.kind === 'file-delete' && entry.replacedBy !== undefined) add(entry.title, entry.id);
  }
  // An old category page is replaced by its new page (whose text is already
  // rewritten) and then removed, so editing it would be wasted.
  const replaced = new Set((input.categories ?? []).map((category) => category.from));
  const edits = input.references.edits.filter((edit) => !replaced.has(edit.title)).map((edit) => ({
    title: edit.title,
    revid: edit.revid,
    timestamp: edit.timestamp,
    text: edit.text,
    diff: edit.diff,
    rewrites: edit.rewrites.map((rewrite) => ({ ...rewrite })),
    entries: [...new Set(edit.rewrites.flatMap((rewrite) => entriesFor.get(rewrite.from) ?? []))],
  }));

  return ManifestSchema.parse({
    version: 1,
    id: options.id ?? randomUUID(),
    wiki: input.wiki,
    api: input.api,
    created: (options.now ?? new Date()).toISOString(),
    ...(input.request === undefined ? {} : { request: input.request }),
    entries: [...questions, ...entries],
    edits,
    usages: input.references.usages.map((usage) => ({ ...usage })),
    leftovers: input.references.leftovers.map((leftover) => ({ page: leftover.page, from: leftover.from, line: leftover.line })),
  });
}

/** The preview URLs that are set, so a manifest without them has no empty fields. */
function preview(input: PreviewInput): { pageUrl?: string; thumbUrl?: string } {
  return { ...(input.pageUrl === undefined ? {} : { pageUrl: input.pageUrl }), ...(input.thumbUrl === undefined ? {} : { thumbUrl: input.thumbUrl }) };
}

function startsApproved(errors: readonly ManifestIssue[], warnings: readonly ManifestIssue[], confidence: number | undefined): boolean {
  return errors.length === 0 && (confidence ?? 0) >= CONFIDENCE_TO_APPROVE && warnings.every((warning) => ROUTINE_WARNINGS.has(warning.code));
}

// --- Approving -----------------------------------------------------------------------

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * A copy with `ids` approved (or unapproved). Entries with errors can't be
 * approved, and questions can't be approved at all: they need a new plan.
 */
export function setApproval(manifest: Manifest, ids: readonly string[], approved: boolean): Manifest {
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const problems: string[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry === undefined) problems.push(`no entry ${id}`);
    else if (entry.kind === 'question') problems.push(`${id} is a question; answer it and plan again`);
    else if (approved && entry.errors.length > 0) problems.push(`${id} has errors: ${entry.errors.map((error) => error.code).join(', ')}`);
  }
  if (problems.length > 0) throw new ManifestError(`Can't change approvals:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  const chosen = new Set(ids);
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => (entry.kind !== 'question' && chosen.has(entry.id) ? { ...entry, approved } : entry)),
  };
}

/**
 * `next` with the approvals the user gave in `previous`, a plan it replaces:
 * an entry for the same change (the same kind and title) gets the same
 * approval, unless it now has errors. Other entries keep their defaults.
 */
export function carryApprovals(previous: Manifest, next: Manifest): Manifest {
  const approvals = new Map(previous.entries.flatMap((entry) => (entry.kind === 'question' ? [] : [[changeKey(entry), entry.approved] as const])));
  return {
    ...next,
    entries: next.entries.map((entry) => {
      if (entry.kind === 'question' || entry.errors.length > 0) return entry;
      const approved = approvals.get(changeKey(entry));
      return approved === undefined ? entry : { ...entry, approved };
    }),
  };
}

/** What an entry changes, the same across plans: its kind and the title it changes. */
function changeKey(entry: Exclude<ManifestEntry, { kind: 'question' }>): string {
  const title = entry.kind === 'file-rename' || entry.kind === 'category-rename' ? entry.from : entry.kind === 'category-tag' ? `${entry.title}\n${entry.category}` : entry.title;
  return `${entry.kind}\n${title}`;
}

// --- Saving and loading ------------------------------------------------------------

/** Where manifests live: manifests/ in the repo (gitignored). */
export const MANIFESTS_DIR = new URL('../../manifests/', import.meta.url).pathname;

/** Writes `<dir>/<id>.json` and returns its path. */
export async function saveManifest(manifest: Manifest, dir = MANIFESTS_DIR): Promise<string> {
  const valid = ManifestSchema.parse(manifest);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${valid.id}.json`);
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`);
  return path;
}

/** Reads and checks `<dir>/<id>.json`. */
export async function loadManifest(id: string, dir = MANIFESTS_DIR): Promise<Manifest> {
  if (!z.uuid().safeParse(id).success) throw new ManifestError(`${id} isn't a manifest ID`);
  const path = join(dir, `${id}.json`);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ManifestError(`Can't read ${path}: ${(error as Error).message}`);
  }
  const result = ManifestSchema.safeParse(json);
  if (!result.success) throw new ManifestError(`${path} isn't a valid manifest:\n${z.prettifyError(result.error)}`);
  return result.data;
}
