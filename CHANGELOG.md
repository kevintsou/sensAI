# Changelog

All notable changes to sensAI are documented in this file.

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
