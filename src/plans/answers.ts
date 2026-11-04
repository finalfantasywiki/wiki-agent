// Answers to a manifest's questions, saved per wiki so that planning again
// applies them instead of asking again. A question can offer fixed choices
// (keep a file, nominate it for deletion); "other" is free text, which no planner applies:
// it's shown with the question, for the LLM to act on.
//
// Saved as answers/<wiki>.json (gitignored), one answer per title a question
// is about, the latest winning. Checked with a zod schema when loaded, since
// it may be edited by hand.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** The fixed choices a question can offer. "other" (free text) is always possible too. */
export const CHOICES = ['keep', 'nominate'] as const;
export type Choice = (typeof CHOICES)[number];

/** A choice, as saved. Answers and manifests saved before images were nominated instead of deleted say "delete". */
export const ChoiceSchema = z.preprocess((value) => (value === 'delete' ? 'nominate' : value), z.enum(CHOICES));

const About = z.string().min(1);
const Answered = z.string();
const AnswerSchema = z.union([
  z.object({ about: About, choice: ChoiceSchema, answered: Answered }),
  z.object({ about: About, choice: z.literal('other'), text: z.string().trim().min(1), answered: Answered }),
]);
const AnswersFile = z.object({ version: z.literal(1), wiki: z.string(), answers: z.array(AnswerSchema) });

export type Answer = z.infer<typeof AnswerSchema>;
export type AnswerInput = { readonly about: string; readonly choice: Choice } | { readonly about: string; readonly choice: 'other'; readonly text: string };

/** Where answers live: answers/ in the repo (gitignored). */
export const ANSWERS_DIR = new URL('../../answers/', import.meta.url).pathname;

export class AnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswersError';
  }
}

/** The wiki's saved answers by the title they're about; none if nothing was answered yet. */
export async function loadAnswers(wiki: string, dir = ANSWERS_DIR): Promise<Map<string, Answer>> {
  const path = pathFor(wiki, dir);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new AnswersError(`Can't read ${path}: ${(error as Error).message}`);
  }
  const result = AnswersFile.safeParse(json);
  if (!result.success) throw new AnswersError(`${path} isn't a valid answers file:\n${z.prettifyError(result.error)}`);
  return new Map(result.data.answers.map((answer) => [answer.about, answer]));
}

/** Adds `inputs` to the wiki's answers (replacing earlier answers about the same titles), saves them, and returns them all. */
export async function saveAnswers(wiki: string, inputs: readonly AnswerInput[], options: { dir?: string; now?: Date } = {}): Promise<Map<string, Answer>> {
  const dir = options.dir ?? ANSWERS_DIR;
  const answered = (options.now ?? new Date()).toISOString();
  const answers = await loadAnswers(wiki, dir);
  for (const input of inputs) {
    const answer = AnswerSchema.parse(input.choice === 'other' ? { about: input.about, choice: 'other', text: input.text, answered } : { about: input.about, choice: input.choice, answered });
    answers.set(answer.about, answer);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(pathFor(wiki, dir), `${JSON.stringify({ version: 1, wiki, answers: [...answers.values()] }, null, 2)}\n`);
  return answers;
}

/** The profile name becomes a file name, so it can't point outside the folder. */
function pathFor(wiki: string, dir: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(wiki)) throw new AnswersError(`${wiki} isn't a wiki profile name`);
  return join(dir, `${wiki}.json`);
}
