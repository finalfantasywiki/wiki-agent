// The MCP server: wraps the library as tools for an LLM. Tools are thin: they
// check their input with zod, call the library, and return JSON. Everything
// here is read-only (phase 0); write tools come in phase 1 and will only
// take approved manifest IDs.
//
// Step 5a: the wiki tools (category members, pages, file info, usages).
// Step 5b: the naming tools (vocabulary, validating names).
// Step 5c: the planning tools (plan a batch into a manifest, show it, approve
// entries). These write manifests to a local folder, never to the wiki.
// Gallery cleanup: plan deleting a batch of /Gallery pages into a manifest.

import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { validateFileName, type FileNameParts } from '../file-renames/file-name.ts';
import { loadNamingRules, type LoadedRules } from '../file-renames/load-vocabulary.ts';
import type { ReleaseVocab } from '../file-renames/vocabulary.ts';
import { planGalleryCleanup } from '../gallery-cleanup/plan-gallery-cleanup.ts';
import { planBatch } from '../plan-batch.ts';
import { loadManifest, MANIFESTS_DIR, saveManifest, setApproval, type Manifest } from '../plans/manifest.ts';
import { renderManifest } from '../plans/render-manifest.ts';
import type { Profile } from '../profile.ts';
import { userAgent, type WikiClient } from '../wiki/client.ts';
import { findUsages, getFileInfo, getPages, listCategoryMembers } from '../wiki/read.ts';

export interface ServerContext {
  readonly profile: Profile;
  readonly client: WikiClient;
  /** For thumbnails; replaceable in tests. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** The naming rules; replaceable in tests. Defaults to loading them from the wiki, once. */
  readonly rules?: () => Promise<LoadedRules>;
  /** Where manifests are saved. Defaults to manifests/ in the repo. */
  readonly manifestsDir?: string;
  /** The profile's guide (profiles/<name>/guide.md), added to the server's instructions. */
  readonly guide?: string;
}

/** How to work with this server on any wiki; sent to the LLM as the server's instructions. */
export const WORKFLOW = `# wiki-agent

You help maintain a MediaWiki wiki: renaming files and categories, fixing every reference, clearing out unused files, and replacing /Gallery pages with image categories. Nothing you do here changes the wiki. You plan; the user reviews and approves; edits happen later, outside these tools.

## How to work
1. Find the files: \`list_category_members\` (with \`types: ["file"]\`).
2. Look at each file before naming it: \`get_file_info\` with \`thumbnails: true\` (10 images per call), and where it's used (\`find_usages\`, \`get_pages\` for captions and context). Current names are often meaningless.
3. Name it with the vocabulary (\`get_vocabulary\`) and the wiki's guide below, then check the names with \`validate_name\`. Leave numbers to planning.
4. Plan with \`plan_renames\`, in batches: files, category renames, deletions and questions. It saves a manifest and tells you where; give the user the path to the Markdown file to review.
5. Approve entries with \`set_approval\` only when the user tells you which.

## Deleting /Gallery pages
1. A batch is one game's galleries: list them with \`list_category_members\` (e.g. on "Character galleries from Final Fantasy VII").
2. Plan with \`plan_gallery_cleanup\`. Images shown only on /Gallery pages are deleted; the rest are tagged with the subject's image category, which is created first if it's missing (show the user its text); the galleries, their talk pages and redirects are deleted, and links to them removed.
3. Before the user approves a file deletion, show them the files: \`get_file_info\` with \`thumbnails: true\` on the deletions. Point out odd ones (a name like "File:File:…", a file that may be worth keeping).
4. Questions in the plan (merchandise to move to the article, a gallery line that isn't a file) are for the user; don't answer them yourself.

## Rules
- **Don't guess.** If a file is missing, or you can't tell the subject, release, version or type with confidence, add a question to the plan instead of a rename. Give honest confidence values: below 0.8, an entry starts unapproved.
- **Unused files are deleted, not renamed.** A file nothing uses goes in \`deletions\` with a reason.
- Entries with errors (e.g. a usage that can't be rewritten) can't be approved; tell the user why, from the manifest.`;

/** Most titles one call takes, so a call stays reviewable and quick. */
const MAX_TITLES = 50;
/** Most thumbnails one call returns as images. */
const MAX_THUMBNAILS = 10;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** Writes a local manifest file; never the wiki. */
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const titles = z.array(z.string().min(1)).min(1).max(MAX_TITLES);

export function createServer(context: ServerContext): McpServer {
  const { profile, client } = context;
  const instructions = context.guide === undefined ? WORKFLOW : `${WORKFLOW}\n\n${context.guide}`;
  const server = new McpServer({ name: 'wiki-agent', version: '0.1.0' }, { instructions });
  const wiki = `${profile.name} (${profile.api})`;
  const rules = once(context.rules ?? (() => loadNamingRules(client, profile)));
  const siteInfo = once(() => client.getSiteInfo());
  const manifestsDir = context.manifestsDir ?? MANIFESTS_DIR;

  server.registerTool(
    'list_category_members',
    {
      title: 'List category members',
      description: `Members of a category on ${wiki}: pages, files and subcategories, each with its namespace number.`,
      inputSchema: z.object({
        category: z.string().min(1).describe('With or without the "Category:" prefix'),
        types: z.array(z.enum(['page', 'file', 'subcat'])).optional().describe('Only these kinds of member'),
        recursive: z.boolean().optional().describe('Also list the members of subcategories'),
      }),
      annotations: READ_ONLY,
    },
    async ({ category, types, recursive }) => {
      const members = await listCategoryMembers(client, category, { ...(types === undefined ? {} : { types }), recursive: recursive ?? false });
      return json({ category, count: members.length, members });
    },
  );

  server.registerTool(
    'get_pages',
    {
      title: 'Get pages',
      description: `The current wikitext and revision of up to ${MAX_TITLES} pages on ${wiki}.`,
      inputSchema: z.object({ titles }),
      annotations: READ_ONLY,
    },
    async ({ titles }) => json({ pages: await getPages(client, titles) }),
  );

  server.registerTool(
    'get_file_info',
    {
      title: 'Get file info',
      description: [
        `Details of up to ${MAX_TITLES} files on ${wiki}: uploader, upload date, size, MIME type, categories and a thumbnail URL.`,
        `With "thumbnails", the first ${MAX_THUMBNAILS} thumbnails are also returned as images to look at.`,
        'Use them to name files whose current names say little (e.g. "Tifa-Hot.jpg").',
      ].join(' '),
      inputSchema: z.object({
        titles,
        thumbnails: z.boolean().optional().describe(`Return the first ${MAX_THUMBNAILS} thumbnails as images`),
        thumbWidth: z.number().int().min(50).max(1000).optional().describe('Thumbnail width in pixels (default 400)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ titles, thumbnails, thumbWidth }) => {
      const files = await getFileInfo(client, titles, thumbWidth);
      const result = json({ files });
      if (thumbnails !== true) return result;
      const images = await Promise.all(
        files
          .filter((file) => file.thumbUrl !== undefined)
          .slice(0, MAX_THUMBNAILS)
          .map(async (file) => {
            const image = await fetchImage(context.fetch ?? fetch, file.thumbUrl!, profile.userAgentContact);
            return [{ type: 'text' as const, text: file.title }, image];
          }),
      );
      return { content: [...result.content, ...images.flat()] };
    },
  );

  server.registerTool(
    'find_usages',
    {
      title: 'Find usages',
      description: `Everywhere a page or file on ${wiki} is used: pages showing it (files), linking to it, transcluding it, and redirects to it.`,
      inputSchema: z.object({ title: z.string().min(1).describe('Full title, e.g. "File:Aeris-ffvii-battle.png"') }),
      annotations: READ_ONLY,
    },
    async ({ title }) => json(await findUsages(client, title)),
  );

  server.registerTool(
    'get_vocabulary',
    {
      title: 'Get naming vocabulary',
      description: [
        `The vocabulary for file names on ${wiki}: "<Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>".`,
        'Without "release", lists every release token (with its versions and whether it is version-neutral) and the known types.',
        'With "release" (an ID, token or title), gives that release in full.',
      ].join(' '),
      inputSchema: z.object({ release: z.string().min(1).optional().describe('e.g. "FFVI", "FFVII Remake" or "Final Fantasy VI"') }),
      annotations: READ_ONLY,
    },
    async ({ release }) => {
      const loaded = await rules();
      const { vocabulary, types } = loaded.rules;
      if (release !== undefined) {
        const found = vocabulary.byId.get(release) ?? vocabulary.byToken.get(release) ?? vocabulary.releases.find((candidate) => candidate.title === release);
        if (found === undefined) throw new Error(`No release "${release}"; call get_vocabulary without "release" to list them`);
        return json(found);
      }
      return json({
        format: '<Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>, or <Quest> from <Release>[ <Version>][ <N>].<ext>, or (only for a subject that is itself a release missing from the list, e.g. a tech demo) <Release title>[ <more>] <Type>[ <N>].<ext>',
        types,
        typeRule: 'A type is one of these, or a more specific type ending in one (e.g. "battle render")',
        releases: vocabulary.releases.map(summarize),
        warnings: vocabulary.warnings,
        source: loaded.source,
        differences: loaded.differences,
      });
    },
  );

  server.registerTool(
    'validate_name',
    {
      title: 'Validate file names',
      description: [
        `Checks up to ${MAX_TITLES} proposed file names on ${wiki} against the naming grammar and vocabulary, and reads each into its parts.`,
        'Errors make a name unusable; warnings need a second look. Numbers are assigned when planning, so propose names without them.',
      ].join(' '),
      inputSchema: z.object({
        names: titles.describe('Proposed names, with or without "File:"'),
        originalExtension: z.string().min(1).optional().describe('The current file\'s extension, to catch a changed file type'),
      }),
      annotations: READ_ONLY,
    },
    async ({ names, originalExtension }) => {
      const { rules: naming } = await rules();
      return json({
        results: names.map((name) => {
          const result = validateFileName(name, naming, originalExtension === undefined ? {} : { originalExtension });
          return { name, ok: result.ok, parts: result.parts === undefined ? undefined : flatten(result.parts), errors: result.errors, warnings: result.warnings };
        }),
      });
    },
  );

  const issue = z.object({ about: z.string().min(1), question: z.string().min(1) });
  server.registerTool(
    'plan_renames',
    {
      title: 'Plan renames',
      description: [
        `Plans a batch of changes on ${wiki} and saves it as a manifest for the user to review. Nothing is changed on the wiki.`,
        'File renames: propose names without numbers; they are validated and numbered here.',
        'Category renames: give a model category (its text is copied with the release swapped), or text, or neither to keep the old page\'s text; "related" fills the header.',
        'Deletions: files nothing uses. Questions: anything you can\'t decide (who is pictured, which version) — ask rather than guess.',
        'Returns the manifest summary and where its files are; usages that can\'t be rewritten block their entries.',
      ].join(' '),
      inputSchema: z.object({
        files: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().optional(), confidence: z.number().min(0).max(1).optional() }))
          .optional(),
        categories: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1), model: z.string().optional(), text: z.string().optional(), related: z.string().optional() }))
          .optional(),
        deletions: z.array(z.object({ title: z.string().min(1), reason: z.string().min(1) })).optional(),
        questions: z.array(issue).optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    async (request) => {
      await siteInfo();
      const manifest = await planBatch(client, profile, (await rules()).rules, request);
      const paths = await save(manifest, manifestsDir);
      return text(`Saved manifest ${manifest.id}\n- JSON: ${paths.json}\n- Review (with diffs): ${paths.markdown}\n\n${renderManifest(manifest, { edits: 'none' })}`);
    },
  );

  server.registerTool(
    'plan_gallery_cleanup',
    {
      title: 'Plan gallery cleanup',
      description: [
        `Plans deleting a batch of /Gallery pages on ${wiki} (e.g. one game's character galleries) and saves it as a manifest for the user to review. Nothing is changed on the wiki.`,
        "Each gallery is handled whole: images shown only on /Gallery pages are deleted, the rest tagged with the subject's image category,",
        'and the gallery, its talk page and redirects deleted, with links to them removed. File and page deletions start unapproved.',
        'Returns the manifest summary and where its files are.',
      ].join(' '),
      inputSchema: z.object({ galleries: titles.describe('/Gallery pages, e.g. "Tifa Lockhart/Gallery"') }),
      annotations: LOCAL_WRITE,
    },
    async ({ galleries }) => {
      await siteInfo();
      const manifest = await planGalleryCleanup(client, profile, galleries);
      const paths = await save(manifest, manifestsDir);
      const deletions = manifest.entries.filter((entry) => entry.kind === 'file-delete').length;
      const look = deletions === 0 ? '' : `\n\n${deletions} file(s) to delete: show them to the user with get_file_info (thumbnails: true) before any are approved.`;
      return text(`Saved manifest ${manifest.id}\n- JSON: ${paths.json}\n- Review (with diffs): ${paths.markdown}${look}\n\n${renderManifest(manifest, { edits: 'none' })}`);
    },
  );

  server.registerTool(
    'show_manifest',
    {
      title: 'Show manifest',
      description: 'A saved manifest as Markdown: a summary, questions, every entry with its issues, what blocks entries, and the page edits (as a list by default; diffs can be very long).',
      inputSchema: z.object({
        id: z.uuid(),
        edits: z.enum(['none', 'list', 'diffs']).optional().describe('How to show page edits (default "list")'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async ({ id, edits }) => text(renderManifest(await loadManifest(id, manifestsDir), { edits: edits ?? 'list' })),
  );

  server.registerTool(
    'set_approval',
    {
      title: 'Approve manifest entries',
      description: 'Approves (or unapproves) entries of a saved manifest by ID, e.g. ["f1", "c2"], when the user says so. Entries with errors and questions can\'t be approved.',
      inputSchema: z.object({ id: z.uuid(), entries: z.array(z.string().min(1)).min(1), approved: z.boolean() }),
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    async ({ id, entries, approved }) => {
      const manifest = setApproval(await loadManifest(id, manifestsDir), entries, approved);
      await save(manifest, manifestsDir);
      return text(`${approved ? 'Approved' : 'Unapproved'} ${entries.join(', ')} in ${id}\n\n${renderManifest(manifest, { edits: 'none' })}`);
    },
  );

  return server;
}

/** Saves the manifest and its Markdown rendering (with diffs) side by side. */
async function save(manifest: Manifest, dir: string): Promise<{ json: string; markdown: string }> {
  const json = await saveManifest(manifest, dir);
  const markdown = json.replace(/\.json$/, '.md');
  await writeFile(markdown, renderManifest(manifest));
  return { json, markdown };
}

/** A release as get_vocabulary lists it. */
function summarize(release: ReleaseVocab) {
  return {
    id: release.id,
    title: release.title,
    token: release.token,
    ...(release.parent === undefined ? {} : { parent: release.parent }),
    ...(release.versionNeutral ? { versionNeutral: true } : {}),
    // A version-neutral release's names never carry a version, so its versions aren't offered.
    ...(release.versionNeutral || release.versions.length === 0 ? {} : { versions: release.versions.map((version) => version.token) }),
  };
}

/** Parts with the release and version as tokens, for JSON. */
function flatten(parts: FileNameParts) {
  return {
    form: parts.form,
    subject: parts.subject,
    release: parts.release.token,
    releaseId: parts.release.id,
    version: parts.version?.token,
    type: parts.type,
    baseType: parts.baseType,
    number: parts.number,
    extension: parts.extension,
  };
}

/** Runs `load` on first call and shares its result; a failure is not kept, so the next call retries. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** A thumbnail as MCP image content, or a note saying why it's missing. */
async function fetchImage(fetchFn: typeof fetch, url: string, contact: string) {
  try {
    const response = await fetchFn(url, { headers: { 'User-Agent': userAgent(contact) } });
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !mimeType.startsWith('image/')) {
      return { type: 'text' as const, text: `(no thumbnail: HTTP ${response.status} ${mimeType})` };
    }
    return { type: 'image' as const, data: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType };
  } catch (error) {
    return { type: 'text' as const, text: `(no thumbnail: ${(error as Error).message})` };
  }
}
