# Rule authoring

Rules describe the hardware facts and team conventions that a general AI model
cannot infer. Keep the actual rule file in each firmware repository, normally
at `.sensai/rules.yaml`, and review changes through the same process as source
code changes.

## Rule format

```yaml
- id: w1c-status-bits
  languages: [c, asm]
  severity: error
  rule: |
    Interrupt flags in this status register are write-one-to-clear. Do not use
    read-modify-write to clear one flag: it can clear other pending flags.
  except: |
    Read-only status bits do not apply.
  examples:
    bad: |
      UART0->STATUS |= UART_STATUS_TXDONE;
    good: |
      UART0->STATUS = UART_STATUS_TXDONE;
```

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Stable, unique identifier. |
| `rule` | Yes | The condition and consequence, in natural language. |
| `languages` | No | `c`, `asm`, or both; omitted means both. |
| `severity` | No | `error`, `warning`, or `info`; default is `warning`. |
| `except` | No | Team-approved cases that must not be reported. |
| `examples` | No | `bad` and `good` examples; strongly recommended. |

Write a rule around a concrete failure mode. State what triggers the problem,
what goes wrong, and which local API or hardware behaviour matters. A short
bad/good pair is usually more valuable than making the prose longer.

## Shared rule repositories

For a central private rules repository, set a workspace-relative or absolute
path in the target project:

```json
{
  "sensai.rulesPath": "../firmware-review-rules/andestar-v5.yaml"
}
```

This changes only the rules source. Keep `.sensai/config.yaml` in the firmware
project because privacy exclusions and audit settings are project-specific.

Changing the selected rules file reloads it automatically. You can also run
**sensAI: Reload Rules**.
