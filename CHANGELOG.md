# Changelog

All notable changes to sensAI are documented in this file.

## 0.5.1 — 2026-09-04

### Fixed

- Findings acted on the wrong file. The panel rendered each finding against its result's `filePath`, but the controller resolved the target file for mute, pin and jump from the active editor — so any action taken after switching tabs landed on whichever file was in front. Muting derived its key from the wrong line's text, so the mute never matched on a later review and silently never took effect. The exported false-positive report, the pin checkbox state and jump-to-line were wrong the same way. The panel now supplies the path from the state that rendered the item, so what is shown and what is acted on cannot diverge. Cancel is routed the same way instead of cancelling whichever file is in front.
- Pin keys included the line number, so inserting a line above a pinned finding changed its key: the checkbox showed unpinned, and clicking again created a duplicate record. The key now binds the line's text, which survives shifts from edits elsewhere and still separates two findings sharing a rule and message.
- Audit entries were only written after a successful review. A request that reached the provider and then failed had already sent the source but left no record — the wrong direction to fail for a log that exists because the sources are under NDA. Entries are now written on every attempted request and carry the outcome.
- The CLI's staged summary said "whole file" even when stage two was scoped to the enclosing function.
- The findings tool description was worded for C, but is used for assembly too.
- Clearing local mutes now triggers a re-review, so the unmuted findings actually reappear.
- `pinKey`'s NUL separator is written as an escape rather than a literal 0x00 byte, which had made `src/pins.ts` binary as far as git, grep and some editors were concerned. Pin keys parse identically, so stored pins are unaffected.

### Performance

- The header index walked the tree synchronously on the extension host and stopped after 20000 entries without reporting it. On a 25600-header tree that indexed 69% of it — and which 69% depended on traversal order — so includes falling in the remainder silently failed to resolve, and the model reviewed without the macro and register definitions the include mechanism exists to supply. The walk is async now, concurrent callers share one build, the limit is far higher, and hitting it is reported.
- `changedRanges` runs the diff first and only asks `ls-files` when the diff comes back empty, which is the only case still needing the tracked/unchanged distinction.

### Added

- Pins can be cleared and reviews cancelled from the command palette.
## 0.5.0 — 2026-08-25

### Added

- Cancel a running review from the panel. A "取消審查" button appears while a review is in flight (and an inline "取消" on the updating note when a previous result is kept on screen). It aborts the in-flight request for the current file -- both stages share one signal -- and clears any pending debounce so the cancel is not immediately followed by another save-triggered review. The panel returns to idle; a cancel is reported as cancelled, not as an error.
- `sensai.apiKey` setting. Recent Claude Code Router builds require an API key; the extension now sends it (via the SDK's `Authorization` header). Empty falls back to the `ANTHROPIC_API_KEY` environment variable and then to a placeholder, so older routers that do not authenticate keep working unchanged. The CLI reviewer takes the same value via `--api-key`. The setting's description warns to keep the key in User Settings rather than a committed `.vscode/settings.json`.
- The panel meta line now shows the time a result was produced (HH:MM:SS), after the duration. When a result lingers on screen while a later review runs, or is left over from an earlier save, the timestamp says when it was actually computed.

### Changed

- The default review scope is smaller. The second stage used to review the whole file; it now reviews only the function the change sits in, found by a brace-matching heuristic (`src/funcscope.ts`). Stage one still reports on the changed lines first. Scoping to the function is faster and cheaper and keeps findings close to the edit; a change outside any function (a global declaration, a macro) falls back to the changed lines. Set the new `sensai.reviewWholeFile` to restore whole-file review as the second stage. The CLI reviewer mirrors this: `--staged` scopes stage two to the function, `--whole-file` widens it back.

### Performance

- The header-index watcher no longer invalidates the cache for headers under build output directories. `buildHeaderIndex` skips `build/out/dist/Debug/Release/obj/node_modules/.git/.vscode`, but the watcher's glob did not, so a build that churned `.h` files under those directories cleared the cache repeatedly and forced a full-tree rescan on the next review -- undoing the caching. The watcher now ignores create/delete events whose path falls in a skipped directory, matching what the index actually scans.
- The project header index is no longer rebuilt on every review. It was a synchronous full-tree scan (`readdirSync` over the whole workspace, up to 20000 entries) that ran on the extension host thread, and because a fresh file-access object was created per review the cache never survived — so with autosave every save could rescan the entire repo and stall the UI. The index is now shared across reviews and invalidated only when a header file is added or removed.
- Closing a file now frees its cached state. `documents` (which held a strong reference to the `TextDocument`, keeping it from being collected) and `lastSource` (a full copy of each reviewed file's text) grew without bound over a session; both, along with the burst bookkeeping, are dropped on `onDidCloseTextDocument`.
- File-system watcher event listeners are now collected as disposables instead of being dropped.

## 0.4.1 — 2026-08-24

### Changed

- Finding labels (trigger, consequence, evidence) are now visually distinct from their body text. The label and its content had nearly the same colour and ran together; labels are now a smaller uppercase bold caption with more space above, and the body text is given an explicit bright foreground.

### Fixed

- A rapid series of saves no longer blanks the panel between reviews. Each new review used to reset the panel to "reviewing", wiping the findings the previous round had just shown and leaving a long empty gap until the next result arrived. When the panel already holds a result, a new review now keeps it on screen with an "updating" note at the top and replaces it only once the fresh result lands. The first review of a file, with nothing to keep, still shows "reviewing" as before.

## 0.4.0 — 2026-08-24

### Added

- Pin a finding to keep it from being replaced by later reviews. Each finding now has a pin checkbox; pinned findings collect into a fixed section at the top of the panel, across files, and survive a VS Code restart. Every pinned finding carries a free-text note box for your own comments. Pins and notes are stored in the workspace state, not in version control.

## 0.3.1 — 2026-08-24

### Fixed

- Burst-mode reviews no longer lose the findings on the lines you just touched. During a burst the catch-up review runs stage two alone and publishing replaces the panel wholesale, so everything stage one had found while the burst was degrading reviews vanished the moment the burst ended. The last burst round's findings are now kept with the source they were computed against and merged into the catch-up the same way the normal two-stage path merges; carried findings are dropped rather than mixed in if the file moved on before the catch-up ran.

## 0.2.3 — 2026-08-24

### Added

- Added a complete installation guide for Marketplace users, extension developers, and automation agents, including endpoint setup, privacy configuration, mock-router verification, troubleshooting, and CLI exit-code behaviour.

## 0.3.0 — 2026-08-24

### Added

- Save-triggered reviews now wait for a quiet period (`sensai.debounceMs`, default 1000ms) before sending, so typing no longer fires a request on every autosave.
- Saves that arrive while a review is running are coalesced into a single re-run on the latest content instead of being dropped or run concurrently, so the last save is always the one that gets reviewed.
- During a burst of saves the re-runs do only stage one (changed lines); the full-file review is deferred and run once the saves settle, halving requests without permanently skipping out-of-range findings.
- Results are marked stale when the file changed while the review was in flight, so shifted line numbers are flagged rather than silently shown.
- `sensai.maxFindings` (default 8) caps how many findings the panel shows directly; lower severities collapse first and `error` never collapses.

### Changed

- Saving a file with no changes relative to git HEAD no longer triggers a review; an on-demand review always runs regardless.
- Dropped the six `asm-*` rules from the sample rule set. Every one of them restated a category the assembly prompt already names, and the architecture facts they leaned on are injected from `src/abi.ts` anyway. Removing them changed nothing measurable: the assembly example still yields all seven expected findings on the same lines with no decoys. The one piece of knowledge they held that lived nowhere else -- that a program entry point has no caller to return to, so callee-saved rules do not apply to it -- moved into `src/abi.ts`, where the project's own guidance says architecture facts belong.

### Fixed

- Rule ids reported by the model are now checked against the rules actually sent, and dropped to "no rule" when they do not match. The model invents ids that follow the naming convention of the rules it has seen: with every `asm-*` rule removed from the project, and none of those names anywhere in the prompt, it still attributed findings to `asm-stack-alignment` and `asm-callee-saved`. It does this only some of the time, which is what made silently trusting it dangerous -- a fabricated id points at a rule the reader cannot find, and mute keys built on one stop matching as soon as the model words it differently. The finding itself is kept; only the attribution is cleared, and the invented id goes to the output channel.
- Include-resolution tests now pass on Windows. Their fake filesystem keyed headers by POSIX paths, which `path.resolve()` never matches on Windows; the fixtures now normalize separators and strip the drive prefix. Production code is unchanged.

## 0.2.2 — 2026-08-23

### Changed

- Reworked the Marketplace README into a concise bilingual user guide.
- Moved rule authoring, privacy configuration, and development workflow into dedicated documents.

## 0.2.1 — 2026-08-23

### Changed

- Added an English overview, setup guide, and privacy summary to the Marketplace listing.

## 0.2.0 — 2026-08-23

### Added

- Reports syntax and type errors, tagged with the `syntax-error` rule id. Previously the prompt suppressed them on the assumption that clangd would catch them, which does not hold on a machine with no compiler or language server installed.
- Two-stage review on save. The first stage reports only problems on the lines changed since git HEAD and returns quickly; the second is the existing whole-file review. Both requests go out in parallel, so the wait is the slower of the two rather than their sum. Findings reported by both stages are merged, not duplicated.
- `sensai.maxFindings` (default 8). When a review returns more findings than this, lower-severity ones collapse into an expandable group so they cannot bury the important ones. Errors never collapse, even when they alone exceed the cap.
- `--staged` flag on the CLI reviewer, which runs the same two-stage path from the terminal.

### Changed

- A project with no applicable rules no longer skips the review entirely. It now narrows the scope to syntax errors alone, whose correctness needs no project knowledge. Generic findings are still suppressed.

### Fixed

- Register names now count as evidence. The grounding check only recognised identifiers of three characters or more, so every RISC-V and ARM register name (`s1`, `a0`, `ra`, `sp`) was invisible to it, and correct assembly findings were discarded as fabricated.

## 0.1.0 — 2026-08-23

- First public release of the VS Code extension.
- Reviews C and assembly files on save through a Claude Code Router endpoint.
- Loads project-specific firmware rules, include context, ABI facts, privacy exclusions, and local false-positive mutes.
- Supports external shared rule files with `sensai.rulesPath`.
