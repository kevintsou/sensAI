# Privacy and project configuration

sensAI sends the reviewed source file and project-local headers it resolves to
the endpoint configured by `sensai.endpoint`. Configure exclusions before using
it with confidential firmware code.

Create `.sensai/config.yaml` in each firmware repository:

```yaml
privacy:
  never_send:
    - "src/secure/**"
    - "**/crypto/**"
  audit_log: .sensai/sent.log

assembly:
  arch: riscv32-andes-v5
```

If the reviewed source file or any header included in its review context matches
`never_send`, sensAI skips the entire review. It does not redact a matching file
and send the rest, because partial source still leaks useful structure.

`audit_log` writes a local JSONL record for each sent review. The generated
`.sensai/.gitignore` excludes the audit log and local mute list from version
control.

Supported assembly architecture IDs are `riscv32-andes-v5` and `armv7e-m`.
