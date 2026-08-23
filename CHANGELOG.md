# Changelog

All notable changes to sensAI are documented in this file.

## Unreleased

### Changed

- Dropped the six `asm-*` rules from the sample rule set. Every one of them restated a category the assembly prompt already names, and the architecture facts they leaned on are injected from `src/abi.ts` anyway. Removing them changed nothing measurable: the assembly example still yields all seven expected findings on the same lines with no decoys. The one piece of knowledge they held that lived nowhere else -- that a program entry point has no caller to return to, so callee-saved rules do not apply to it -- moved into `src/abi.ts`, where the project's own guidance says architecture facts belong.

### Fixed

- Rule ids reported by the model are now checked against the rules actually sent, and dropped to "no rule" when they do not match. The model invents ids that follow the naming convention of the rules it has seen: with every `asm-*` rule removed from the project, and none of those names anywhere in the prompt, it still attributed findings to `asm-stack-alignment` and `asm-callee-saved`. It does this only some of the time, which is what made silently trusting it dangerous -- a fabricated id points at a rule the reader cannot find, and mute keys built on one stop matching as soon as the model words it differently. The finding itself is kept; only the attribution is cleared, and the invented id goes to the output channel.

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
