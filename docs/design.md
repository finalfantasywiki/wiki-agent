# wiki-agent — design

An LLM-driven maintenance bot for MediaWiki wikis. The LLM (Claude, via Claude Code/Desktop) decides *what* to do (proposes names, picks targets). Deterministic code decides *how* (finding usages, building diffs, throttled edits, undo). The wiki is exposed to the LLM as an MCP server.

The tool is generic. Everything specific to one wiki lives in a **wiki profile**. The first profile is the Final Fantasy Wiki.

Status: design only. No code or dependencies yet.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Any MediaWiki wiki, configured through a per-wiki profile (see below) |
| First wiki | Final Fantasy Wiki on Fandom, `https://finalfantasy.fandom.com` (API: `/api.php`) |
| Operator role (FF Wiki) | Bureaucrat (can add the bot account to the `bot` group locally; verify on `Special:UserRights`) |
| Auth | BotPasswords (`Special:BotPasswords`). Works on every MediaWiki, and Fandom doesn't offer third-party OAuth consumers. |
| Redirects | **Suppress** redirects on file moves. Any entry with an unresolved usage is blocked, since without a redirect that usage would break. |
| Emptied categories | **Delete** the old category page once it has no members and no incoming links |
| Gallery images | **Nominate, never delete.** An image only galleries show is nominated with the wiki's deletion template (FF Wiki: `{{delete|reason=…}}`, which fills `Category:Nominated for deletion`) and tagged with its subject's image category. Whether to delete is a judgement call editors are better placed to make (they may know a page the image belongs on), so they save images by removing the template, and an admin or a script deletes the rest. The /Gallery pages themselves are still deleted. |
| Edit rate | Start at 1 edit per 5 s with `maxlag=5`, then tune per profile |
| API etiquette | Send a descriptive User-Agent with a contact (Fandom returns 403 to default library UAs) |
| Language | TypeScript (`target: es2025`), run directly by Node 26 LTS (type stripping), tested with `node --test`. Approved: `luaparse` 0.3.1 (Lua 5.1 parser, MIT, no deps), `mwn` 3.0.3 (MediaWiki API client, LGPL-3.0); dev only: `typescript` 7.0.2 (type-check only), `@types/node` 26.6.6, `@types/luaparse` 0.2.13. Candidates (**not yet approved**): `wikiparser-node` (wikitext parser), `@modelcontextprotocol/sdk` (MCP server). |
| Lua | Parsed in the tool (with `luaparse`) for reading, analysis, and range-based edits. Run only on the wiki (export module, Scribunto console), never in the tool. |
| Runtime, phases 0–3 | Local, driven from Claude Code/Desktop on the operator's subscription. Bulk work stays in code, not in the LLM. |
| Runtime, phase 4+ | Always-on worker with an API key (patrol, Discord). Out of scope for now. |

### BotPassword grants (minimal)

- Phase 0: none needed (anonymous reads), or *Basic rights* only for higher API limits.
- Phase 1+: *High-volume editing*, *Edit existing pages*, *Create, edit, and move pages*, *Upload, replace, and move files*, *Delete pages, revisions, and log entries* (for emptied categories, unused files from rename batches, and /Gallery pages; gallery images are only nominated). Add *Patrol* later for phase 4.
- `suppressredirect` and `delete` come from the account's groups, not from grants. Check `Special:ListGroupRights` to see whether `bot` has them on the wiki. If it doesn't, the bot account also needs a group that does.

## Wiki profiles

A profile is a config directory per wiki (e.g. `profiles/finalfantasy/`). The core tool has no FF-specific logic.

Besides `profile.json`, a profile can have a `guide.md`: the wiki's naming rules and judgement calls, written for the LLM (which subject spelling, which type, when to ask). The MCP server sends it as part of its instructions, after a generic workflow (look at each file, validate names, plan in batches, ask rather than guess, delete unused files, approve only when told).

The bot's login lives in the profile's `credentials.json`, which git ignores (`profiles/*/credentials.json`): `username` is the BotPassword login name (`<account>@<bot password name>`, e.g. `Omega Mk.II Bot@wiki-agent` on the FF Wiki) and `password` the generated bot password. `operator` is the wiki username of the person running the bot, which goes in edit summaries where the profile's `rules.editSummary` asks for it. It lives here rather than in the shared profile because whoever holds the login is the one running the bot. Copy `credentials.example.json` to start one. Phase 0 doesn't read it; login comes in phase 1.

| Field | Purpose |
|---|---|
| `api` | API endpoint URL |
| `userAgentContact` | Contact put in the User-Agent string |
| `botPolicy` | **Required for any write phase.** Either a URL to the wiki's bot policy page, or `"none"` together with a note recording who approved the bot (e.g. "self-approved by bureaucrat X"). Write tools refuse to run without it. |
| `rate` | Edit interval and `maxlag` |
| `redirects` | `suppress` or `keep` for file and category moves |
| `emptiedCategories` | `delete` or `softRedirect` (plus the template name) |
| `fileNaming` | Grammar for file names, plus allowed types |
| `categoryNaming` | Grammar for category names |
| `categoryPages` | Optional. The header template new category pages start with, and the parameters it always gets (FF Wiki: `{{category}}` with `contains=all image`, `namespace=file`) |
| `releases` | Where the release vocabulary comes from: a static list, or an **adapter** that reads it from the wiki |
| `vocabulary` | Optional overrides for file-name tokens and version-neutral releases, for when the wiki's data doesn't have them |
| `galleries` | Optional; needed for gallery cleanup. `imageCategory`, the category a gallery's images go to, with a `{subject}` placeholder (FF Wiki: `Category:Images of {subject}`). `categoryText`, the text of that category when it has to be created, with `{subject}` too. `nominateText`, what goes at the top of a gallery-only image's page to nominate it for deletion, with `{reason}` (FF Wiki: `{{delete|reason={reason}}}`; another template or category is a change here only). `linkParameters`, template parameters that link a page to its gallery (`gallery`, as in an infobox's `|gallery=true`). `pointerTemplates`, templates that only point readers to another page (`main`, `see also`, `see`). `moveSections`, words in gallery headings whose images belong on the article instead (`merchandise`). `fileHomes`, the page kept images belong on, by words in their file name (`"ultimania omega scan": "Final Fantasy VII Ultimania Omega"`). |
| `rules` | Optional. The community's rules for running the bot; each is optional. `editSummary`, the edit summary format, which must contain `{summary}` and `{operator}` (the operator from `credentials.json`), so a human answers for every edit. `profileReview` (`page`, `days`), a wiki page where `profile.json` and `guide.md` are posted, each in a marked `<syntaxhighlight>` block (`reviewText` in `src/shared/profile/review.ts` makes the text): the executor runs only when the blocks match the local files and haven't changed for `days` days, so the community can review every change first. Only the blocks count, so the rest of the page (e.g. the bot's user page) can change without restarting the clock; `checkProfileReview` reads the page history back as far as it needs to find when they last changed. `createPagesIn`, the namespaces (as the wiki names them, `""` for main) the bot may create pages in. `forbiddenTemplates`, templates the bot never adds. The last two are checked at planning time (`applyRules` in `src/shared/plans/rules.ts`, which `planBatch` and `planGalleryCleanup` run on every manifest they build; namespaces are named as the wiki shows them, via `namespaceName` in `src/shared/wiki/read.ts`): an entry that creates a page elsewhere, or a new page or edit that adds a forbidden template, gets an error (`create-not-allowed`, `forbidden-template`) and can't be approved. FF Wiki: operator in summaries, a 2-day review on the bot's user page, `User:Omega Mk.II Bot`, new pages only in Category, and never `{{bot-generated}}` (only Intangir Bot uses it). These are stricter than for the wiki's pywikibot bot, Intangir Bot, at the community's request; the bot doesn't write articles. |
| `imageHosts` | Optional. Origins the in-chat review page may load thumbnails from (FF Wiki: `https://static.wikia.nocookie.net`), sent to the host as the page's content security policy. |

## FF Wiki profile

### Release vocabulary: `Module:Codename/data`

The FF Wiki stores data for each game in `Module:Codename/data`, which loads `.../data/rel` (releases) and `.../data/ser` (series). Each release is a Lua table, e.g.:

```lua
{ id = 'FFVI', title = 'Final Fantasy VI', tag = 'Final Fantasy VI',
  versions = { ['snes'] = { name = 'SNES' }, ['advance'] = { name = 'Advance' },
               ['pixel remaster'] = { name = 'Pixel Remaster' }, ... } }
```

The `codename` adapter builds the allow-list from this data:
- **Release** tokens come from `files.shorthand`, falling back to `id`. Category names use `title` (`Final Fantasy VII`).
- **Version** tokens come from `versions[*].files.shorthand`, falling back to `versions[*].name`.
- `files.versionneutral = true` on a release means its file names never carry a version.
- `sub` links a sub-release to its parent (e.g. `VIIAC` → `FFVII`).

`Module:Codename.json` is a stale export (last edited 2015). Don't use it.

The adapter reads the data in two ways:
- **Export module (fast, authoritative).** A separate module, `Module:Codename/export`, has `json()` return `mw.text.jsonEncode(require('Module:Codename/data'))`. The tool fetches it in one call: `action=expandtemplates&prop=wikitext&text={{#invoke:Codename/export|json}}`. Because no other pages transclude it, editing it never adds work to the job queue.
- **Parsing (fallback, and a cross-check).** Fetch the source of `Module:Codename/data` and its `require`d subpages, parse each with `luaparse`, and evaluate the literal tables. If a page has anything other than literals and `require`, that's an error, never a guess. On the FF Wiki the adapter uses the export and cross-checks it against the parse. On wikis without an export module, it falls back to parsing. Profile setting: `source: "export-module" | "parse-lua"`.

**The wiki data is the source of truth for tokens.** File-name tokens and version neutrality are stored in `Module:Codename/data` itself, in a `files = { shorthand, versionneutral }` sub-table on releases and versions, so editors can read and fix them and templates can use them too. Examples:

| Data | Field | File-name token |
|---|---|---|
| `FFVIIR` | `files = { shorthand = 'FFVII Remake', versionneutral = true }` | `FFVII Remake` |
| `FFVI` › `advance` | `files = { shorthand = 'GBA' }` | `GBA` |
| `FFXII` › `zodiac age` | `files = { shorthand = 'TZA' }` (a new version entry) | `TZA` |
| `FFVII` | `files = { versionneutral = true }` | (no version) |

The profile's `vocabulary` section (`releaseTokens`, `versionTokens`, `versionNeutral`) is an optional override layer. It's for wikis that have no data module to put tokens in, and for the FF Wiki only until the data has the fields. When the profile and the data both set a token and they disagree, the vocabulary step warns.

### File naming convention

```
Standard:  <Subject> from <Release>[ <Version>] <Type>[ <N>].<ext>
Quest:     <Quest or chapter> from <Release>[ <Version>][ <N>].<ext>
Titled:    <Release title>[ <more>] <Type>[ <N>].<ext>
```

The titled form is for a subject that is itself a release missing from the vocabulary (`Final Fantasy VII Technical Demo for PS3 still.jpg`), or for promo art of a whole series (`Final Fantasy VII 10th anniversary promo art.jpg`), so the name already says what it's from. The name has to start with a release's full title (the longest match wins) and end with a known type, which can't be made more specific here. The validator only tries it for names without " from ", and always warns (`titled-form`), so it isn't a way around the standard form.

| Slot | Meaning | Examples |
|---|---|---|
| Subject | The subject's name **as that release's translation spells it** (see below), optionally followed by a descriptor such as an outfit | `Cloud Strife`, `Aeris Gainsborough` (FFVII), `Tifa original attire` |
| Release | Release token from the codename data, after overrides | `FFVII`, `FFVI`, `FFXII`, `FFVII Remake` |
| Version | Version token. Include it only when versions differ in a way that matters (see below). | `SNES`, `GBA`, `Pixel Remaster`, `TZA` |
| Type | Kind of representation | `render`, `model`, `sprite`, `gameplay`, `cutscene`, `dialogue`, `concept art`, `menu portrait`, `still`, `promo art`, or something more specific (`battle render`, `field render`, `field model`, `battle sprite`, `promo render`) |
| N | Disambiguator for files that are alike in every slot above but not duplicates. A file that is alone has no number; files that are alike are numbered as a set from `1`. Names that differ only by extension count as alike, so they are numbered too. | `1`, `2` |
| ext | Unchanged from the original. MediaWiki rejects moves that change the extension. | `png`, `jpg` |

**Version rule.** If a release's versions don't differ noticeably in appearance, drop the version slot. FFVII has many versions in the data (Japanese original, International, PC 1998/2012, iOS…), but its images use plain `FFVII`. Most releases do differ, though: FFVI uses `FFVI SNES`, `FFVI GBA`, and `FFVI Pixel Remaster`. Version-neutral releases are marked with `files = { versionneutral = true }` in the data.

When a release is version-neutral, the validator rejects a version token. Otherwise, a missing version is a warning. The LLM then picks the version from the image and its usages.

**Translation rule.** The subject is named the way that release's translation names it, not by the current article title. FFVII files use `Aeris Gainsborough`, while FFVII Remake files use `Aerith Gainsborough`. The release-specific party member pages show the translated spelling, although their titles use first names only.

**Battle vs. field.** `battle render` / `battle model` show a character in battle; `field render` / `field model` show them out in gameplay (towns, the world map, and so on).

**Sprites.** 2D games use sprites, not models, so their files use `sprite` (`battle sprite`, `field sprite`).

**Screenshots.** Screenshots are typed by what they show:
- `gameplay`: gameplay
- `cutscene`: a cutscene
- `dialogue`: in-game dialogue during gameplay

The subject of a screenshot is what it shows, usually an ability, event or place: `Omnislash from FFVII gameplay.png`. A character is the subject only when the shot shows nothing but that character.

**Promo renders.** A `promo render` is a render Square Enix supplied to promote the game. It isn't an in-game model rendered by someone else, which is a plain `render` (or `battle render` / `field render`).

**Numbered sets.** When a file joins a name that an unnumbered file already holds, the new file gets `1` (or the next free number), and planning flags the unnumbered file (`unnumbered-sibling`) so it can be added to the batch and numbered too.

**Extension-only twins.** Two files whose names would differ only by extension get numbered apart. That case is suspicious, though: either they are duplicates (one should be deleted), or something tells them apart that belongs in the subject or type. Planning warns about it (`extension-twin`), and the LLM has to say why the files differ.

Examples:
- `Cloud Strife from FFVII battle render 2.png` (the second of a set)
- `Terra Branford from FFVI Pixel Remaster render.png`
- `File:Infiltration from FFVII Remake.jpg` (quest/chapter form, used for multi-subject shots)

### Category naming convention

```
<Kind> from <Release title>
<Kind> for <Release title>
```

Which word a kind takes is part of the kind: `Character images from …`, `Character artwork from …`, but `Concept art for …`.

Examples: `Category:Character images from Final Fantasy VII`, `Category:Character artwork from Final Fantasy VII`, `Category:Concept art for Final Fantasy VII`.

A new category page's text comes from a model sibling (with the release title swapped), from text given directly, or, with neither, from the old page. In every case, references to other categories renamed in the same batch are rewritten, so the page gets its parents' new names.

Every category page starts with the profile's header template, the way correctly named categories (e.g. the FFVII Remake ones) do:

```
{{category |name=Character artwork from ''Final Fantasy VII'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']] }}

[[Category:Concept art for Final Fantasy VII]]
[[Category:Character images from Final Fantasy VII]]
```

A page without the header gets one: `name` is the category name with the release title in italics, then the profile's fixed parameters, then `related` from the request (warned about when missing). Only its category tags are kept after it; any other text is dropped, and the review warning shows what was dropped. Old-style names such as `Final Fantasy VII character images` are migrated as part of the file renames.

### Who does what

- **LLM** fills the slots: identifies the subject from the image, current name, description, and the pages using it. It also picks the type and version, and judges whether to use the quest form.
  - Current names are often useless (`Tifa-Hot.jpg`), so the LLM must not lean on them. It looks at the image itself, its description page, its categories, and where and how pages use it (captions, sections), and infers the full name from those: `Tifa-Hot.jpg` → `Tifa original attire from Advent Children promo render`.
  - **When it can't act, it asks.** If a source file is missing, or the LLM can't tell the subject, release, version or type with confidence, the entry becomes a question for the user instead of a guess. It is never approved until answered.
  - **Unused files are deleted, not renamed.** A file with no usages, links or redirects to it gets a `delete` entry in the manifest instead of a rename. Like every entry, it needs approval, and undo restores it with `undelete`.
  - **Lower-quality copies are replaced.** When two files are the same image (e.g. a low-resolution copy), the worse one is a deletion with `replaceWith` naming the one to keep. Its usages are rewritten to point at the kept file under its final name (its new name if the same batch renames it), in the same pass as the renames, and then it's deleted. A page that showed both copies ends up showing the kept file twice; remove the duplicate by hand.
- **Code** owns the vocabulary and checks:
  - `Release` and `Version` must come from the codename-derived allow-list. The version-neutral rule above also applies.
  - `Type` comes from an allow-list plus "specific" variants ending in a known base type (`battle render` → `render`).
  - `Subject` should match an existing article title. A mismatch is a warning, not a hard error.
  - Numbering is assigned by code, never the LLM: it checks existing titles and other entries in the same manifest for collisions.
  - Each proposal gets a confidence score and the reasoning behind it. Low-confidence entries default to *not approved*.

## MCP tool surface

Read-only tools (phase 0):

| Tool | Purpose |
|---|---|
| `list_category_members(category, type?, recursive?)` | Files/pages in a category |
| `get_pages(titles[])` | Wikitext and revision of up to 50 pages |
| `get_file_info(titles[], thumbnails?, thumbWidth?)` | Uploader, upload date, size, MIME type, categories and a thumbnail URL for up to 50 files. With `thumbnails`, the first 10 thumbnails also come back as MCP images for the LLM to look at. |
| `find_usages(title)` | Pages using a file (`imageusage`), links (`backlinks`, including `[[:Category:X]]` links), transclusions (`embeddedin`), and redirects |
| `get_vocabulary(release?)` | Every release token (with versions, unless version-neutral) and the known types; or one release in full, by ID, token or title. Loaded from the wiki once, on first use, with the profile's cross-check. |
| `validate_name(names[], originalExtension?)` | Checks up to 50 proposed names against the grammar and vocabulary, reading each into its parts (subject, release, version, type, number) with errors and warnings |
| `plan_renames(files?, categories?, deletions?, questions?)` | Plans one batch (`planBatch` in `src/tasks/plan-batch.ts`) and saves it as a **manifest**, plus its Markdown rendering with diffs, in `manifests/`. Returns the summary without diffs. **Files** `{from, to, reason?, confidence?}` are validated and numbered. **Categories** `{from, to, model?, text?, related?}` get a new page (from a `model` sibling with the release swapped, from `text`, or from the old page), the profile header, and every member re-tagged; the old page is deleted once empty. **Deletions** `{title, reason, replaceWith?}` are checked to be unused; with `replaceWith`, their usages are pointed at that file instead (a `replacement-missing` error if it doesn't exist, is deleted too, or is the file itself). **Questions** `{about, question}` go to the user; answers the user gave in their own words to earlier questions about the same title are added to them. All page edits are planned in one pass; unresolved usages and leftovers block their entries. The manifest records the request as proposed (before validation and numbering), for `replan`. Opens the review page in hosts that support it. |
| `plan_gallery_cleanup(galleries[])` | Plans deleting up to 50 /Gallery pages (`planGalleryCleanup` in `src/tasks/gallery-cleanup/`) and saves the manifest like `plan_renames` does, applying the wiki's saved answers. The manifest records the galleries it was planned from, for `replan`. See [Gallery cleanup](#gallery-cleanup). When the plan nominates files, the reply tells the LLM to show them to the user (`get_file_info` with thumbnails) before any are approved. Opens the review page in hosts that support it. |
| `answer_question(id, answers[])` | Saves the user's answers to a manifest's questions, by question ID: one of the question's `choices` (`keep`, `nominate`) or `other` with the user's words. Answers are kept per wiki in `answers/<wiki>.json` (gitignored), the latest per title winning, so every later plan applies them. Only what the user said is recorded. |
| `replan(id)` | Plans a saved manifest again as a new one, from the `request` it recorded (gallery cleanup or renames; manifests from before 2026-11-05 recorded none and can't be): the wiki as it is now, with every saved answer applied, and the user's approvals carried over to the same changes (`carryApprovals`), unless they now have errors. A file rename is the same change when it renames the same file to the same proposed name (a new number alone doesn't count); a category rename, when it has the same old and new names. Opens the review page on the new manifest. |
| `show_manifest(id, edits?)` | A saved manifest as Markdown; page edits as a list (default), only their count, or full diffs. Opens the review page. |
| `review_manifest(id)` | For the review page only (`visibility: ["app"]`, so the LLM doesn't see it): the manifest's questions, file and category renames, deletions, new pages and counts (`reviewView`). Each rename is `flagged` when it wouldn't start approved (errors, a warning that isn't routine, or confidence below 0.8), and stays flagged once approved. Page edits are only counted; their diffs stay in the Markdown file. |
| `set_approval(id, entries[], approved)` | Approves or unapproves entries (e.g. `f1`, `c2`) when the user says so, and saves the manifest. Entries with errors and questions can't be approved. |
| `check_profile_review()` | Whether the profile's review page (`rules.profileReview`) shows the current `profile.json` and `guide.md`, and since when (`missing`, `outdated` with the files that differ, `waiting` with when the review ends, `ready`). When it's missing or outdated, it also gives the text to post. Read-only: the user posts it. |
| `get_module(title)` | Lua source, plus a `luaparse` syntax tree summary: functions, `require`s, globals |
| `module_graph(prefix?)` | The `require` / `mw.loadData` graph across modules, plus usage counts from `embeddedin` |

Write tools (phase 1+; every one takes an approved manifest ID, never free-form input, and refuses to run without `botPolicy` set in the profile):

| Tool | Purpose |
|---|---|
| `execute_manifest(id)` | Throttled moves and edits with `maxlag`, edit summaries tagged with the manifest ID, and a double-redirect fix pass |
| `undo_manifest(id)` | Reverses moves and edits from the edit log, skipping pages that were edited since. Deleted categories are restored with `undelete`. |
| `reformat_template(template, rules)` | Phase 3: produces a manifest like `plan_renames` does |

## Flow: plan → manifest → approve → execute → undo

1. **Plan.** The LLM lists a category, inspects each file, and calls `plan_renames` with the files, categories, deletions and questions for the batch.
2. **Manifest.** Code writes `manifests/<id>.json` (a UUID; checked with a zod schema whenever it's loaded). It holds:
   - **Entries**, each with a short ID by kind:
     - `q1`, `q2`, …: questions (a missing source, or something the LLM can't decide). They come first, and can't be approved; answering one means planning again. A question about a file can offer `choices` (`keep`: tag it and stop asking; `nominate`: nominate it for deletion after all; answers saved as `delete` before nominations existed read as `nominate`). The user can always answer in their own words instead; no planner applies those, so the question comes back with the answer for the LLM to act on.
     - `f1`, …: file renames, with `from`, `to`, the requested name, the reason, the confidence, errors and warnings.
     - `d1`, …: file deletions (unused files, or copies with `replacedBy`: the final title of the file replacing them), with the pages still using them. For a replacement, those are only the pages whose usages can't be rewritten, which also block it; its page edits list it in `entries`.
     - `x1`, …: files to nominate for deletion (gallery cleanup), with the reason and a preview. The deletion template is added to the file's page in the same edit as its category tag. They never start approved. wiki-agent never deletes them.
     - `c1`, …: category renames, with the new page's text, the members, and what happens to the old page.
     - `n1`, …: pages to create (e.g. a missing image category), with their text. They start approved, and are created before the entries that need them.
     - `p1`, …: page deletions (galleries, their talk pages, redirects), with the pages still linking to them. Like file deletions, they never start approved, and a page still linking gives an `in-use` error.
     - `t1`, …: category tags added to a page (an image kept from a gallery gets its subject's image category). They start approved.
   - **Request**: what it was planned from, so `replan` can plan it again: the galleries, or the `plan_renames` batch as proposed.
   - **Page edits**: each page's new text, the revision it was planned from, its unified diff, and the entries it's for.
   - **Usages** (rewritten, via a template, or unresolved) and **leftovers**. An unresolved usage or a leftover adds a `blocked` error to its entry.

   An entry starts approved only if it has no errors, a confidence of at least 0.8, and no warnings beyond routine ones (`renumbered`, `header-added`, `old-text-kept`). Deletions never start approved. A file rename for an unused file gets an `unused` warning, suggesting deletion instead.
3. **Approve.** The human reviews the rendered manifest (`renderManifest`: Markdown with a summary table, questions first, each category's new page, tables of file renames (with their issues), file deletions (with what replaces them and what still uses them) and files to nominate for deletion, and questions about files, each with a 160 px thumbnail and a link to the file's page (URLs kept in the manifest at planning time), what blocks entries, and every page edit's diff in a collapsible block) and then flips `approved` per entry, by editing the JSON or by telling Claude which ones (`setApproval`; entries with errors can't be approved). In hosts that support MCP Apps, the planning tools and `show_manifest` also open the **review page** (an `@modelcontextprotocol/ext-apps` resource at `ui://wiki-agent/review.html`) inside the conversation. It's a React app (`src/mcp/review/page.tsx`, using ext-apps' `useApp` and `useHostStyles`) that `src/mcp/review/app.ts` bundles with esbuild into `review/page.html`, in memory, the first time a host asks for it. It shows the summary, the questions with their thumbnails, choice buttons and a box for the user's own words, the category renames (with the new page's text), the file renames as cards (thumbnail, old and new name, confidence, reason, issues; by default only the flagged ones, with a box to show all), and the files to nominate or delete and the pages to create or delete, with approve boxes and "Approve all" (on the entries shown). Names can't be changed there yet: the user tells the LLM, which plans the batch again. It calls the server's tools itself (`answer_question`, `set_approval`, `replan`, `review_manifest`) and tells the LLM what changed (`ui/update-model-context`). Like the tools, it never executes anything. Manifests are immutable once execution starts. Changes after that produce a new manifest.
4. **Execute.** Code re-checks every page's revision ID against the manifest. Any page that changed since planning is skipped and reported. A page edit can serve several entries; when only some are approved, the edit is recomputed from the planned revision with just the approved renames. Edits are keyed by a page's title before any move, so a file's own description page is edited before it's moved. Order of operations:
   1. Create the new category pages, and the approved pages to create (`n`).
   2. For each file: move it without a redirect, then make one edit to its description page that updates both the category and the description.
   3. Rewrite usages on other pages, and edit file pages: category tags (`t`) and nomination templates (`x`).
   4. Re-tag the subcategories.
   5. Delete the approved unused files and replaced copies.
   6. Delete the old categories once they're empty and nothing links to them.
   7. Delete the approved pages (galleries and the like), after the edits that remove links to them.

   Every action is appended to `logs/<id>.jsonl`.
5. **Undo.** Code replays the log in reverse.

### Reference rewriting

File references show up in several forms, and the parser has to handle all of them:
- `[[File:X.png|...]]` and `[[Image:X.png]]`, including case and underscore/space variants of the name
- `<gallery>` lines
- Template parameters that hold a bare filename (`|image=X.png`). `imageusage` finds the page, but the text has no `File:` prefix.
- Anything else gets reported as unresolved. It is never guessed at.

### Link removal

When a page is deleted, links to it are removed rather than left red (`removeLinks` in `src/shared/wikitext/unlink.ts`):
- `[[Target]]`, `[[Target#Section|text]]` and relative `[[/Subpage]]` links become their text.
- Images that link there (`[[File:X.png|link=Target]]`) lose `link=`.
- Named template parameters that make a template link there (the profile's `linkParameters`, e.g. `|gallery=true`) are removed.
- Pointer templates (`{{main|/Gallery}}`) are removed when every page they name is being deleted. A heading left with nothing under it goes too: `==Gallery==\n{{main|/Gallery}}` disappears whole.

Comments, `<nowiki>` and `<pre>` are left alone. Anything that still links afterwards (a parameter naming the page, a link built by a parser function) is a leftover, which blocks the deletion.

## Gallery cleanup

The FF Wiki is replacing `/Gallery` subpages (`Tifa Lockhart/Gallery`) with image categories (`Category:Images of Tifa Lockhart`). A batch is one game's galleries (e.g. the members of `Category:Character galleries from Final Fantasy VII`), and each gallery is handled whole. Character galleries come first; other kinds of gallery follow.

For each gallery, `planGalleryCleanup` reads its `<gallery>` tags and embedded images (`src/tasks/gallery-cleanup/gallery-page.ts`), then sorts each image (`classify.ts`):

| Verdict | When | Planned as |
|---|---|---|
| `nominate` | Shown only on /Gallery pages (`fileusage`) | A nomination (`x`): the profile's `nominateText` at the top of the file's page, with a reason naming the galleries (as plain text: a link would keep them from being deleted), plus the category tag. A page that has the template already isn't nominated again. Redirects to the file are left for whoever deletes it. The entry's reason also notes any gallery outside the batch, and pages still linking to a file the user chose to nominate. An image whose name matches `fileHomes` (an Ultimania Omega scan) is kept and tagged instead, with a question to add it to that page. |
| `move` | Only on galleries, but under a heading matching `moveSections` (merchandise) | A question to add it to the article, and a category tag meanwhile. It is kept. |
| `keep` | Shown on other pages too | A category tag (`t`) if it isn't in the image category yet |
| `linked` | Only on galleries, but a page that stays links to it (`[[:File:Barret ultimania omega scan.png\|(Scan)]]` in an infobox) | Kept and tagged, with a question pointing it out: add it to its `fileHomes` page if it has one, else show it somewhere that stays. Links to files are never removed. |
| `missing` | The file doesn't exist | Nothing; the red link goes with the gallery |

Then the gallery, its talk page and redirects to it become page deletions (`p`), and every link to them from pages that stay is removed (see [Link removal](#link-removal)), old forum and talk discussions included: no dead links anywhere. `|gallery=` is removed only on the gallery's own subject page. Each page gets one edit, with links removed and category tags added together. Pages deleted in the same batch don't count as usages or links.

A subject without an image category gets one: a page to create (`n`), from the profile's `categoryText` with the subject filled in (FF Wiki: `{{category |contains=all |namespace=file |related=[[{subject}]] }}` and `[[Category:Images by character]]`, as on `Category:Images of Tifa Lockhart`). It is created before its images are tagged and before anything is deleted. A gallery becomes a question instead of a plan when the title isn't a /Gallery page or the gallery doesn't exist. A gallery line that isn't a valid file name is a question too. Odd files (e.g. `File:File:MiiCostumeTifaSSBU.webp`) are shown to the user with the other nominations.

Dry run on 2026-11-02, `Tifa Lockhart/Gallery`: 288 unique images; 20 to delete, 11 merchandise images to move, 257 kept, of which 84 need the category tag. Links were removed from 3 pages (the article's infobox and `==Gallery==` section, and two forum pages), with nothing left blocking.

Dry run on 2026-11-03, the 12 galleries in `Category:Character galleries from Final Fantasy VII`, after the switch to nominating: 199 images nominated (none already were) and none deleted, 1,698 category tags, 11 categories to create, 14 page deletions (galleries and talk pages; redirects to images are no longer deleted), 49 questions, 1,635 page edits, nothing blocked.

## Phase 0 scope (read-only)

**Goal:** point the tool at one category and get a reviewable manifest for the category and file renames, without writing anything to the wiki.

In scope:
- An MCP server with only the read-only tools above
- The profile format, plus the FF Wiki profile, using the codename adapter (export module first, `luaparse` cross-check)
- The naming grammar validator (including the version-neutral rule) and collision-safe numbering
- Manifest generation with reference diffs and unresolved usages
- A Markdown or HTML rendering of the manifest for review
- The dry run below

### Target: `Category:Final Fantasy VII character images`

State on 2026-11-01: 344 files and 1 subcategory. Every member adds the category in its own wikitext, so no template edits are needed. Only 1 file name already follows the convention (most look like `Aeris-ffvii-battle.png`).

The manifest covers:

1. **Category renames**, modeled on `Category:Character images from Final Fantasy VII Remake`:
   - `Category:Final Fantasy VII character images` → `Category:Character images from Final Fantasy VII`, a new page with this wikitext:
     ```
     {{category |name=Character images from ''Final Fantasy VII'' |contains=all image |namespace=file |related=[[:Category:Characters in Final Fantasy VII|characters in ''Final Fantasy VII'']] }}

     [[Category:Images from Final Fantasy VII]]
     [[Category:Character images]]
     ```
   - `Category:Final Fantasy VII character artwork` (169 files) → `Category:Character artwork from Final Fantasy VII`. It gets the `{{category}}` header (replacing its one-line description) and keeps its old parent tags, renamed: `Concept art for Final Fantasy VII` and `Character images from Final Fantasy VII`.
   - `Category:Final Fantasy VII artwork` (15 files, 11 subcategories) → `Category:Concept art for Final Fantasy VII`, with the `{{category}}` header and its old parents (`Images from Final Fantasy VII` and `Artwork`).
   - All three old category pages get deleted once they're empty.
2. **File renames** for every file in the two character categories (the files directly in `Concept art for Final Fantasy VII` only move category), e.g. `Aeris-ffvii-battle.png` → `Aeris Gainsborough from FFVII battle render.png` (plain `FFVII`, since it's version-neutral), with every usage rewritten.

Out of scope: logging in with edit grants, any write API call, template reformatting, patrol, Discord.

**Done when:** a manifest for both categories exists, and the operator has reviewed it and agrees that ≥90% of the proposed names are correct and every usage was either diffed or flagged. Because redirects are suppressed, flagged usages also mark those entries as blocked.

### Build steps

Every step ships as a library plus a small CLI script that you can run and test without Claude. The MCP server comes last, as a thin layer over the finished pieces.

1. **Vocabulary and name validator.** Profile loading, the codename adapter (export module + `luaparse` cross-check), and the file-name grammar. Tested offline against saved fixtures.
2. **Read-only wiki client.** Category members, page and file info, and usages, with continuation, `maxlag`, and the User-Agent header.
3. **Reference rewriter.** Finds and rewrites file and category references in wikitext, and lists unresolved ones. (Needs a wikitext parser to be approved.)
4. **Manifests.** Planned names, category renames, page edits with diffs, the manifest and its rendering; `planBatch` runs them together.
5. **MCP server and dry run.** Wraps steps 1–4 as tools (on the official MCP SDK v2, `@modelcontextprotocol/server`, over stdio), then runs the dry run on the FFVII categories.

## Later phases

1. Execute and undo manifests (needs the bot flag, BotPassword grants, and `botPolicy` in the profile)
2. Batch rename by convention across larger categories and other releases (needs version tokens, e.g. FFVI)
3. Reformat templates across pages
4. Review and refactor Lua modules: find dead code, duplicated functions, and stray globals, and suggest improvements. Edits go through the manifest flow as range-based replacements in the syntax tree. Before an edit can be approved, three checks are required:
   1. The new text parses.
   2. It evaluates in Scribunto (`action=scribunto-console`, if Fandom allows it through the API).
   3. Sample pages render the same, by diffing their HTML before and after.

   Edits to heavily used modules are flagged, since saving one re-renders every page that uses it.
5. Patrol new uploads and propose renames
6. Patrol edits and send reports to Discord (cloud worker on an API key)
7. Clear maintenance reports: unused files (`Special:UnusedFiles`), broken redirects (`Special:BrokenRedirects`) and double redirects (`Special:DoubleRedirects`), read through `list=querypage` and turned into manifests like any other task. These reports are cached on the wiki, so each entry is re-checked live before planning.

## Open questions

- Adding `files` settings to `Module:Codename/data`: agreed values are in [codename-files.md](codename-files.md). They'll be edited in as part of the `Module:Codename` cleanup, one edit per data page.
