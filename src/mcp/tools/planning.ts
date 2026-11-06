// The planning tools: plan a batch (renames or gallery cleanup) into a
// manifest, answer its questions, plan it again, show it, and approve its
// entries. These write manifests and answers to local folders, never to the
// wiki. The planning tools and show_manifest open the review page in hosts
// that draw MCP Apps.

import { writeFile } from 'node:fs/promises';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { planGalleryCleanup } from '../../tasks/gallery-cleanup/plan-gallery-cleanup.ts';
import { planBatch, type BatchRequest } from '../../tasks/plan-batch.ts';
import { CHOICES, loadAnswers, saveAnswers, withAnswers, type AnswerInput } from '../../shared/plans/answers.ts';
import { carryApprovals, loadManifest, saveManifest, setApproval, type Manifest } from '../../shared/plans/manifest.ts';
import { renderManifest } from '../../shared/plans/render-manifest.ts';
import { OPENS_REVIEW_PAGE } from '../review/app.ts';
import { LOCAL_WRITE, READ_ONLY, text, titles, type ToolContext } from './common.ts';

export function registerPlanningTools(server: McpServer, context: ToolContext): void {
  const { profile, client, wiki, rules, siteInfo, manifestsDir, answersDir } = context;

  /** Plans galleries with the saved answers (keeping `previous`'s approvals, when it's planned again), saves it, and says where. */
  async function planGalleries(galleries: readonly string[], previous?: Manifest) {
    await siteInfo();
    const planned = await planGalleryCleanup(client, profile, galleries, { answers: await loadAnswers(profile.name, answersDir) });
    const manifest = previous === undefined ? planned : carryApprovals(previous, planned);
    const nominations = manifest.entries.filter((entry) => entry.kind === 'file-nominate').length;
    const look = nominations === 0 ? '' : `\n\n${nominations} file(s) to nominate for deletion: show them to the user with get_file_info (thumbnails: true) before any are approved.`;
    return saved(manifest, previous, look);
  }

  /** Plans a batch of renames (keeping `previous`'s approvals, when it's planned again), saves it, and says where. */
  async function planRenames(request: BatchRequest, previous?: Manifest) {
    await siteInfo();
    const planned = withAnswers(await planBatch(client, profile, (await rules()).rules, request), await loadAnswers(profile.name, answersDir));
    const manifest = previous === undefined ? planned : carryApprovals(previous, planned);
    return saved(manifest, previous, '');
  }

  /** Saves a newly planned manifest and tells the LLM where it is, with its summary. */
  async function saved(manifest: Manifest, previous: Manifest | undefined, note: string) {
    const paths = await save(manifest, manifestsDir);
    const replaced = previous === undefined ? '' : ` (replacing ${previous.id})`;
    return {
      ...text(`Saved manifest ${manifest.id}${replaced}\n- JSON: ${paths.json}\n- Review (with diffs): ${paths.markdown}${note}\n\n${renderManifest(manifest, { edits: 'none' })}`),
      structuredContent: { manifestId: manifest.id },
    };
  }

  const issue = z.object({ about: z.string().min(1), question: z.string().min(1) });
  registerAppTool(
    server,
    'plan_renames',
    {
      title: 'Plan renames',
      description: [
        `Plans a batch of changes on ${wiki} and saves it as a manifest for the user to review. Nothing is changed on the wiki.`,
        'File renames: propose names without numbers; they are validated and numbered here.',
        'Category renames: give a model category (its text is copied with the release swapped), or text, or neither to keep the old page\'s text; "related" fills the header.',
        'Deletions: files nothing uses, or a copy to replace with a better one (replaceWith, e.g. the high-resolution version): its usages are pointed at that file, under its new name if this batch renames it. Questions: anything you can\'t decide (who is pictured, which version) — ask rather than guess.',
        'Returns the manifest summary and where its files are; usages that can\'t be rewritten block their entries.',
      ].join(' '),
      inputSchema: z.object({
        files: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().optional(), confidence: z.number().min(0).max(1).optional() }))
          .optional(),
        categories: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1), model: z.string().optional(), text: z.string().optional(), related: z.string().optional() }))
          .optional(),
        deletions: z.array(z.object({ title: z.string().min(1), reason: z.string().min(1), replaceWith: z.string().min(1).optional() })).optional(),
        questions: z.array(issue).optional(),
      }),
      annotations: LOCAL_WRITE,
      _meta: OPENS_REVIEW_PAGE,
    },
    async (request) => planRenames(request),
  );

  registerAppTool(
    server,
    'plan_gallery_cleanup',
    {
      title: 'Plan gallery cleanup',
      description: [
        `Plans deleting a batch of /Gallery pages on ${wiki} (e.g. one game's character galleries) and saves it as a manifest for the user to review. Nothing is changed on the wiki.`,
        "Each gallery is handled whole: images shown only on /Gallery pages are nominated for deletion (never deleted), every image is tagged with the subject's image category,",
        'and the gallery, its talk page and redirects are deleted, with links to them removed. Nominations and page deletions start unapproved.',
        'Returns the manifest summary and where its files are.',
      ].join(' '),
      inputSchema: z.object({ galleries: titles.describe('/Gallery pages, e.g. "Tifa Lockhart/Gallery"') }),
      annotations: LOCAL_WRITE,
      _meta: OPENS_REVIEW_PAGE,
    },
    async ({ galleries }) => planGalleries(galleries),
  );

  server.registerTool(
    'answer_question',
    {
      title: 'Answer questions',
      description: [
        "Saves the user's answers to a saved manifest's questions (by question ID, e.g. \"q3\"), for planning again with replan. Nothing is changed on the wiki.",
        `Give one of the question's choices (${CHOICES.join(', ')}), or "other" with the user's own words in "text".`,
        'Answers are kept per wiki, so later plans apply them too. Only answer what the user said.',
      ].join(' '),
      inputSchema: z.object({
        id: z.uuid(),
        answers: z
          .array(z.object({ question: z.string().min(1), choice: z.enum([...CHOICES, 'other']), text: z.string().optional().describe('The user\'s words, for "other"') }))
          .min(1),
      }),
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    async ({ id, answers }) => {
      const manifest = await loadManifest(id, manifestsDir);
      const questions = new Map(manifest.entries.flatMap((entry) => (entry.kind === 'question' ? [[entry.id, entry] as const] : [])));
      const problems: string[] = [];
      const inputs: AnswerInput[] = [];
      for (const answer of answers) {
        const question = questions.get(answer.question);
        if (question === undefined) problems.push(`${answer.question} isn't a question in ${id}`);
        else if (answer.choice === 'other') {
          if (answer.text === undefined || answer.text.trim() === '') problems.push(`${answer.question}: "other" needs the user's words in "text"`);
          else inputs.push({ about: question.about, choice: 'other', text: answer.text.trim() });
        } else if (!(question.choices ?? []).includes(answer.choice)) {
          problems.push(`${answer.question} doesn't offer "${answer.choice}"; answer it with "other" and the user's words`);
        } else inputs.push({ about: question.about, choice: answer.choice });
      }
      if (problems.length > 0) throw new Error(`Can't save the answers:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      await saveAnswers(profile.name, inputs, { dir: answersDir });
      return text(`Saved ${inputs.length} answer(s): ${inputs.map((input) => `${input.about} → ${input.choice === 'other' ? `"${input.text}"` : input.choice}`).join('; ')}. Plan again with replan to apply them.`);
    },
  );

  registerAppTool(
    server,
    'replan',
    {
      title: 'Plan again',
      description: `Plans a saved manifest (gallery cleanup or renames) again on ${wiki}, as a new manifest: the same request against the wiki as it is now, with every saved answer applied, and the approvals the user gave carried over. Nothing is changed on the wiki.`,
      inputSchema: z.object({ id: z.uuid() }),
      annotations: LOCAL_WRITE,
      _meta: OPENS_REVIEW_PAGE,
    },
    async ({ id }) => {
      const previous = await loadManifest(id, manifestsDir);
      if (previous.wiki !== profile.name) throw new Error(`${id} was planned for ${previous.wiki}, not ${profile.name}`);
      const request = previous.request;
      if (request === undefined) throw new Error(`${id} doesn't record what it was planned from (it's older than that), so it can't be planned again`);
      return request.task === 'gallery-cleanup' ? planGalleries(request.galleries, previous) : planRenames(request, previous);
    },
  );

  registerAppTool(
    server,
    'show_manifest',
    {
      title: 'Show manifest',
      description: 'A saved manifest as Markdown: a summary, questions, every entry with its issues, what blocks entries, and the page edits (as a list by default; diffs can be very long).',
      inputSchema: z.object({
        id: z.uuid(),
        edits: z.enum(['none', 'list', 'diffs']).optional().describe('How to show page edits (default "list")'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
      _meta: OPENS_REVIEW_PAGE,
    },
    async ({ id, edits }) => ({ ...text(renderManifest(await loadManifest(id, manifestsDir), { edits: edits ?? 'list' })), structuredContent: { manifestId: id } }),
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
}

/** Saves the manifest and its Markdown rendering (with diffs) side by side. */
async function save(manifest: Manifest, dir: string): Promise<{ json: string; markdown: string }> {
  const json = await saveManifest(manifest, dir);
  const markdown = json.replace(/\.json$/, '.md');
  await writeFile(markdown, renderManifest(manifest));
  return { json, markdown };
}
