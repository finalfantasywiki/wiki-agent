// The review page's React app. It runs in the host's sandboxed frame, not in
// the server: review-app.ts bundles it with esbuild, together with React and
// ext-apps, into the page it serves. The planning tools' results name a
// manifest; the page loads its view (review_manifest) and calls the tools
// back as the user answers, approves and plans again.

import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReviewCategoryRename, ReviewFile, ReviewFileRename, ReviewItem, ReviewView } from './review-view.ts';

type Question = ReviewView['questions'][number];
type Status = { readonly text: string; readonly error: boolean };
/** Anything with an approve box. */
type Approvable = Pick<ReviewItem, 'id' | 'approved' | 'errors'>;

const IDLE: Status = { text: '', error: false };

function ReviewPage() {
  const [manifestId, setManifestId] = useState<string>();
  const { app, error } = useApp({
    appInfo: { name: 'wiki-agent review', version: '0.1.0' },
    capabilities: {},
    // Set before connecting, so the planning tool's result isn't missed.
    onAppCreated: (created) => {
      created.ontoolresult = (params) => {
        const id = (params.structuredContent as Record<string, unknown> | undefined)?.['manifestId'];
        if (typeof id === 'string') setManifestId(id);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  const [view, setView] = useState<ReviewView>();
  /** Answers given on this page, by question ID, until the next plan. */
  const [answered, setAnswered] = useState<ReadonlyMap<string, string>>(new Map());
  const [status, setStatus] = useState<Status>(IDLE);
  const [busy, setBusy] = useState(false);

  /** Runs an action, showing that it's busy and what came of it. */
  async function act(action: (app: App) => Promise<void>, done: string): Promise<void> {
    if (app === null || busy) return;
    setBusy(true);
    setStatus({ text: 'Working…', error: false });
    try {
      await action(app);
      setStatus({ text: done, error: false });
    } catch (failure) {
      setStatus({ text: failure instanceof Error ? failure.message : String(failure), error: true });
    }
    setBusy(false);
  }

  async function show(app: App, id: string): Promise<void> {
    setView((await call(app, 'review_manifest', { id })) as unknown as ReviewView);
    setAnswered(new Map());
  }

  useEffect(() => {
    if (manifestId !== undefined) void act((app) => show(app, manifestId), '');
  }, [app, manifestId]);

  if (view === undefined) {
    const failed = error ?? (status.error ? new Error(status.text) : undefined);
    return <p className={failed ? 'status error' : 'muted'}>{failed?.message ?? 'Loading the manifest…'}</p>;
  }

  const answer = (question: Question, choice: string, text?: string) =>
    act(async (app) => {
      await call(app, 'answer_question', { id: view.id, answers: [{ question: question.id, choice, ...(text === undefined ? {} : { text }) }] });
      const given = text ?? question.choices.find((option) => option.choice === choice)?.label ?? choice;
      setAnswered((before) => new Map(before).set(question.id, given));
    }, 'Answer saved. Re-plan to apply your answers.');

  const approve = (items: readonly Approvable[], approved: boolean) => {
    const ids = items.filter((item) => item.errors.length === 0 && item.approved !== approved).map((item) => item.id);
    if (ids.length === 0) return;
    void act(async (app) => {
      await call(app, 'set_approval', { id: view.id, entries: ids, approved });
      const changed = new Set(ids);
      const update = <T extends Approvable>(list: readonly T[]) => list.map((item) => (changed.has(item.id) ? { ...item, approved } : item));
      setView((before) => before && {
        ...before,
        fileRenames: update(before.fileRenames),
        categoryRenames: update(before.categoryRenames),
        fileDeletions: update(before.fileDeletions),
        fileNominations: update(before.fileNominations),
        pageCreations: update(before.pageCreations),
        pageDeletions: update(before.pageDeletions),
      });
    }, `${approved ? 'Approved' : 'Unapproved'} ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}.`);
  };

  const replan = () =>
    act(async (app) => {
      const previous = view.id;
      const id = (await call(app, 'replan', { id: previous }))['manifestId'];
      if (typeof id !== 'string') throw new Error('replan returned no manifest');
      await show(app, id);
      try {
        await app.updateModelContext({ content: [{ type: 'text', text: `The user re-planned manifest ${previous} from the review page; the current manifest is ${id}.` }] });
      } catch {
        // Not every host takes context updates.
      }
    }, 'Planned again with your answers.');

  const page: PageProps = { app, busy, approve };
  return (
    <>
      <h1>Manifest for {view.wiki}</h1>
      <div className="muted">
        {view.id} · planned {new Date(view.created).toLocaleString()} · {view.edits} page edit(s) · {view.tags.total} category tag(s)
      </div>
      <div className="bar">
        {view.replannable && (
          <button className="primary" disabled={busy} onClick={() => void replan()}>
            {answered.size > 0 ? `Re-plan with ${answered.size} new answer(s)` : 'Re-plan'}
          </button>
        )}
        <span className={status.error ? 'status error' : 'status'} role="status">{status.text}</span>
      </div>
      <Summary rows={view.summary} />
      {view.questions.length > 0 && (
        <>
          <h2>Questions ({view.questions.length})</h2>
          {view.questions.map((question) => (
            <QuestionCard key={question.id} app={app} question={question} given={answered.get(question.id)} busy={busy} onAnswer={(choice, text) => void answer(question, choice, text)} />
          ))}
        </>
      )}
      {view.categoryRenames.length > 0 && <CategoryRenames categories={view.categoryRenames} {...page} />}
      {view.fileRenames.length > 0 && <FileRenames files={view.fileRenames} {...page} />}
      {view.fileNominations.length > 0 && (
        <>
          <Heading title="Files to nominate for deletion" items={view.fileNominations} {...page} />
          <p className="muted">Each file's page gets the deletion template, for editors to decide on; nothing here deletes a file.</p>
          <FileCards files={view.fileNominations} {...page} />
        </>
      )}
      {view.fileDeletions.length > 0 && (
        <>
          <Heading title="Files to delete" items={view.fileDeletions} {...page} />
          <FileCards files={view.fileDeletions} {...page} />
        </>
      )}
      {view.pageCreations.length > 0 && (
        <>
          <Heading title="Pages to create" items={view.pageCreations} {...page} />
          {view.pageCreations.map((created) => (
            <div key={created.id} className="question">
              <div className="body">
                <Approval item={created} {...page} />
                <div>{created.title}<span className="muted"> · {created.reason}</span></div>
                <pre>{created.text}</pre>
              </div>
            </div>
          ))}
        </>
      )}
      {view.pageDeletions.length > 0 && (
        <>
          <Heading title="Pages to delete" items={view.pageDeletions} {...page} />
          <ul className="plain">
            {view.pageDeletions.map((deleted) => (
              <li key={deleted.id}>
                <Approval item={deleted} {...page} />
                <div>{deleted.title}<span className="muted"> · {deleted.reason}</span></div>
                {deleted.usedBy.length > 0 && <div className="error">Still linked from: {deleted.usedBy.join(', ')}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.blocked.length > 0 && (
        <>
          <h2>What blocks entries</h2>
          <ul className="plain">{view.blocked.map((line) => <li key={line}>{line}</li>)}</ul>
        </>
      )}
    </>
  );
}

/** A tool's structured result; a failed call becomes an error with its text. */
async function call(app: App, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n') || `${name} failed`);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

interface PageProps {
  readonly app: App | null;
  readonly busy: boolean;
  readonly approve: (items: readonly Approvable[], approved: boolean) => void;
}

function Summary({ rows }: { readonly rows: ReviewView['summary'] }) {
  return (
    <table>
      <tbody>
        <tr><th></th><th>Entries</th><th>Approved</th><th>With errors</th></tr>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td>{row.total}</td>
            <td>{row.label === 'Questions' ? '' : row.approved}</td>
            <td>{row.label === 'Questions' ? '' : row.withErrors}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QuestionCard({ app, question, given, busy, onAnswer }: {
  readonly app: App | null;
  readonly question: Question;
  readonly given: string | undefined;
  readonly busy: boolean;
  readonly onAnswer: (choice: string, text?: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    if (text.trim() !== '') onAnswer('other', text.trim());
  };
  return (
    <div className="question">
      <Thumbnail app={app} title={question.about} pageUrl={question.pageUrl} thumbUrl={question.thumbUrl} />
      <div className="body">
        <div><strong>{question.id}</strong> · <Link app={app} url={question.pageUrl}>{question.about}</Link></div>
        <div>{question.question}</div>
        {question.answer !== undefined && <div className="muted">Your earlier answer: {question.answer}</div>}
        {given !== undefined ? (
          <div className="answered">Answered: {given}</div>
        ) : (
          <div className="bar">
            {question.choices.map((option) => (
              <button key={option.choice} disabled={busy} onClick={() => onAnswer(option.choice)}>{capitalize(option.label)}</button>
            ))}
            <input
              type="text"
              placeholder="Or answer in your own words"
              aria-label={`Answer ${question.id} in your own words`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
            />
            <button disabled={busy} onClick={submit}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Files as cards: thumbnail, approval, link and reason. */
function FileCards({ files, ...page }: PageProps & { readonly files: readonly ReviewFile[] }) {
  return (
    <div className="cards">
      {files.map((file) => (
        <div key={file.id} className={file.errors.length > 0 ? 'card blocked' : 'card'}>
          <Thumbnail app={page.app} title={file.title} pageUrl={file.pageUrl} thumbUrl={file.thumbUrl} />
          <Approval item={file} {...page} />
          <div className="title"><Link app={page.app} url={file.pageUrl}>{file.title}</Link></div>
          <div className="muted">{file.reason}</div>
          {file.errors.map((message) => <div key={message} className="error">{message}</div>)}
        </div>
      ))}
    </div>
  );
}

/**
 * File renames as cards, the ones that need a look first: low confidence,
 * warnings or errors (`flagged`). "Approve all" acts on the cards shown.
 */
function FileRenames({ files, ...page }: PageProps & { readonly files: readonly ReviewFileRename[] }) {
  const flagged = files.filter((file) => file.flagged);
  const [onlyFlagged, setOnlyFlagged] = useState(flagged.length > 0);
  const shown = onlyFlagged ? flagged : files;
  return (
    <>
      <Heading title="File renames" items={shown} count={onlyFlagged ? `${flagged.length} of ${files.length}` : undefined} {...page} />
      <div className="bar">
        <label className="check">
          <input type="checkbox" checked={onlyFlagged} onChange={(event) => setOnlyFlagged(event.target.checked)} />
          Only the ones that need a look ({flagged.length}): low confidence, warnings or errors
        </label>
      </div>
      {shown.length === 0 && <p className="muted">None need a look.</p>}
      <div className="cards wide">
        {shown.map((file) => (
          <div key={file.id} className={file.errors.length > 0 ? 'card blocked' : 'card'}>
            <Thumbnail app={page.app} title={file.from} pageUrl={file.pageUrl} thumbUrl={file.thumbUrl} />
            <Approval item={file} {...page} />
            <div className="title"><Link app={page.app} url={file.pageUrl}>{file.from}</Link></div>
            <div className="title">→ <strong>{file.to}</strong></div>
            {file.confidence !== undefined && (
              <div className={file.confidence < 0.8 ? 'warn' : 'muted'}>Confidence {Math.round(file.confidence * 100)}%</div>
            )}
            {file.reason !== undefined && <div className="muted">{file.reason}</div>}
            <Issues item={file} />
          </div>
        ))}
      </div>
    </>
  );
}

/** Category renames: the new page's text, and what happens to the members and the old page. */
function CategoryRenames({ categories, ...page }: PageProps & { readonly categories: readonly ReviewCategoryRename[] }) {
  const old = { deleted: 'deleted once empty', 'soft redirect': 'a soft redirect once empty', none: 'no old page' } as const;
  return (
    <>
      <Heading title="Category renames" items={categories} {...page} />
      {categories.map((category) => (
        <div key={category.id} className="question">
          <div className="body">
            <Approval item={category} {...page} />
            <div className="title">{category.from} → <strong>{category.to}</strong></div>
            <div className="muted">{category.members} member(s) re-tagged · old page: {old[category.oldPage]}</div>
            <Issues item={category} />
            {category.newPage !== undefined ? (
              <details>
                <summary>New page text</summary>
                <pre>{category.newPage}</pre>
              </details>
            ) : (
              <div className="muted">The new page exists already.</div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/** A rename's errors, then its warnings. */
function Issues({ item }: { readonly item: Pick<ReviewFileRename, 'errors' | 'warnings'> }) {
  return (
    <>
      {item.errors.map((message) => <div key={message} className="error">{message}</div>)}
      {item.warnings.map((message) => <div key={message} className="warn">{message}</div>)}
    </>
  );
}

/** A section heading with "Approve all" and "Unapprove all" for its entries. */
function Heading({ title, items, count, busy, approve }: PageProps & { readonly title: string; readonly items: readonly Approvable[]; readonly count?: string | undefined }) {
  const open = items.some((item) => item.errors.length === 0);
  return (
    <h2>
      {title} ({count ?? items.length})
      {open && <button disabled={busy} onClick={() => approve(items, true)}>Approve all</button>}
      {open && <button disabled={busy} onClick={() => approve(items, false)}>Unapprove all</button>}
    </h2>
  );
}

function Approval({ item, busy, approve }: PageProps & { readonly item: Approvable }) {
  const blocked = item.errors.length > 0;
  return (
    <label className="check">
      <input type="checkbox" checked={item.approved} disabled={busy || blocked} onChange={(event) => approve([item], event.target.checked)} />
      <strong>{item.id}</strong>
      {blocked ? <span className="error">blocked</span> : item.approved ? 'approved' : 'not approved'}
    </label>
  );
}

/** A link the host opens: pages in this sandbox can't navigate. */
function Link({ app, url, children }: { readonly app: App | null; readonly url: string | undefined; readonly children: ReactNode }) {
  if (url === undefined) return <>{children}</>;
  return (
    <a href={url} onClick={(event) => { event.preventDefault(); app?.openLink({ url }).catch(() => {}); }}>
      {children}
    </a>
  );
}

function Thumbnail({ app, title, pageUrl, thumbUrl }: { readonly app: App | null; readonly title: string; readonly pageUrl?: string | undefined; readonly thumbUrl?: string | undefined }) {
  if (thumbUrl === undefined) return null;
  return <Link app={app} url={pageUrl}><img src={thumbUrl} alt={title} loading="lazy" /></Link>;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

createRoot(document.getElementById('root')!).render(<ReviewPage />);
