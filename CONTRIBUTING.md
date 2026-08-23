# Development and release workflow

This document is for extension contributors, not Marketplace users.

## Local development

```bash
git clone https://github.com/kevintsou/sensAI.git
cd sensAI
npm install
npm run typecheck
npm test
```

Run `npm run watch` while developing the extension, then use VS Code's F5
launch configuration to test it in an Extension Development Host.

## Router-free testing

`npm run mock` starts a local Claude Code Router-compatible mock on port 3456.
It exercises the prompt, include, tool-use, and filtering pipeline without an
API key. Its findings are deliberately fake and must not be used to evaluate
review quality.

The test suite also covers the mock router and unit-level pipeline behaviour:

```bash
npm test
```

## CLI reviewer

The CLI invokes the same pipeline as the extension:

```bash
npm run review -- examples/uart_dma.c
npm run review -- examples/uart_dma.s
```

Use real historical firmware defects to evaluate rules and prompts. The
examples are only regression fixtures.

## Release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run `npm run typecheck && npm test && npm run package`.
3. Verify the generated `sensai.vsix` contents.
4. Publish the version through the Visual Studio Marketplace publisher portal.
