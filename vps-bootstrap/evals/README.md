# vps-bootstrap evals

Eval harness for the six skills in this bundle. Each skill has 2 realistic test prompts with checkable assertions in `<skill>/evals/evals.json`.

## Layout

```
skills/<skill-name>/
├── SKILL.md
└── evals/
    └── evals.json   ← prompts + assertions
```

## How to run a single skill's evals

For each prompt, spawn two subagents in parallel — one with the skill, one without — and compare. Use the skill-creator's pattern:

```
Spawn (with-skill):
- Skill path: <bundle>/skills/<skill-name>
- Task: <prompt from evals.json>
- Save outputs to: <workspace>/iteration-1/eval-<id>/with_skill/outputs/

Spawn (baseline, same turn):
- Task: <same prompt>
- No skill
- Save outputs to: <workspace>/iteration-1/eval-<id>/without_skill/outputs/
```

Capture `total_tokens` + `duration_ms` from the notification to `timing.json` in each run dir.

## Grading

Each assertion in `evals.json` has a `text` (what's being checked) and a `check` (how — `contains`, `regex`, or `manual`). Run the grader inline or spawn a grader subagent that reads `~/.claude/skills/skill-generator/agents/grader.md`. Write `grading.json` per run dir using fields `text`, `passed`, `evidence`.

## Aggregation + viewer

```bash
python -m scripts.aggregate_benchmark <workspace>/iteration-1 --skill-name <name>
python ~/.claude/skills/skill-generator/eval-viewer/generate_review.py \
   <workspace>/iteration-1 \
   --skill-name <name> \
   --benchmark <workspace>/iteration-1/benchmark.json \
   --static <workspace>/iteration-1/review.html
```

(`--static` because there's no display server on this machine.)

## Demo workspace

`workspace/mcp-bearer-gateway-demo/` contains a live first-iteration run of one prompt (the systemd unit task) with both configurations, as a worked example.

## When to actually run these

- Before a first real VPS provisioning, run all 12 prompts (6 skills × 2) end-to-end to confirm skills trigger on realistic phrasings
- After any skill edit, re-run just that skill's evals
- Quarterly, re-run the full set to catch regressions from upstream tool changes (Tailscale, supergateway, systemd directives)
