# dsh-context-guard

**Compress before it lands.** Every tool result passes one more gate *before* it is written into
context: content-aware structural compression, cross-call deltas, and information-weighted fitting
inside a budget. Every step is explainable and switchable, and nothing happens unless it actually
saves tokens.

> Relationship to [`dsh-ops`](https://github.com/T-Auto/dsh-ops): dsh-ops optimizes the **input**
> side (tool schemas, descriptions, prompt sections) and deliberately does no call-level dedup.
> This plugin works on the **output** side — the moment after a result exists and before its tokens
> are paid — doing structural compression and cross-call deltas. They are complementary. Note that
> `dsh-tool-token-optimizer` hooks the same event; see "Interaction with other plugins" below.

---

## Where it sits

One hook, the public `tools/post-execute` waterfall: the tool has finished, the result is not yet in
the session or the request.

It is registered **once, at the root**. `tools/post-execute` is a scoped event dispatched by
`ToolRuntime` through `scopeTarget(this, exec.agent)`; scoped event routing lets an untagged listener
receive events dispatched to any descendant key. So this single root listener sees **every** agent,
every session, and every nested sub-call (including PTC / `run_code`) — no per-agent registration, no
growth with agent count.

No model-call wrapping, no model catalog patching, no tool registration, no prompt section. The only
thing touched is result text.

---

## The pipeline

### 1. Lossless normalization (always, always safe)

ANSI colour/cursor sequences stripped (with cursor-left sequences resolved to what the terminal
actually shows); `\r` progress bars collapsed to their final state; invisible characters (NBSP,
zero-width, BOM, bidi controls) unified; trailing whitespace removed; runs of 3+ blank lines and
leading/trailing blank lines dropped; generated padding of 4+ identical spaces collapsed to 2.

Deliberately **not** done: no tab→space conversion, no re-indentation, no mid-line space removal, no
merging of "meaningful" repeated lines. Source code and `ls -l` alignment depend on those.

### 2. Content-aware structural compression (only when the type is recognized)

| Type | What happens |
|---|---|
| **JSON** | Re-parsed and compacted: indentation ladder removed, short containers inlined. Keys, values and order unchanged |
| **unified diff** | File headers folded to one `# path (+a/-b)` line; **every added/removed line kept**; surplus context folded to `… (N lines unchanged context)`; `\ No newline at end of file` folded into the previous line |
| **git status** | Files grouped per status, per-line `(use "git ...")` hints dropped; merged line counts stay on the unit, so the file total is still countable |
| **listings / trees** | Uniform `ls -l` mode column dropped once and declared; `├──` / `└──` prefixes flattened to indentation |
| **numbered source** | Gutter aligned to minimal width. **Not one character of code changes** |
| **logs** | Consecutive same-template lines (differing only in timestamps/numbers) folded to `first line …×N (same event repeated; last: <value>)` |
| **build/test output** | Progress lines folded only when **no** failure signal is present; anything containing error/fail/ERR is left untouched |
| **source** | Only runs of 3+ byte-identical consecutive lines are folded |
| **everything else** | The 3rd and later occurrence of an identical line is folded, if the byte savings cover it |

### 3. Information-weighted budget fitting

Past the budget (12000 chars by default, per-tool defaults exist) it does not keep "first N + last N".
It scores lines and picks:

- **up**: errors, failures, exceptions, stack frames, `expected/actual`, `:line:col`, file paths,
  `exit code`, `not found` / `permission denied`, hunk headers, test summaries;
- **down**: blank lines, copyright headers, `Please/Note/Hint` boilerplate, bare links;
- first 6 and last 8 lines are always kept (command, header, conclusion, summary live at the ends);
- every gap becomes `… (N lines omitted, low-signal lines dropped)`.

### 4. Cross-call deltas

When the same "tool name + arguments" produces output again, the previous copy is *already in
context*; pasting it again is pure duplicate spend:

- byte-identical → one line: `(unchanged: byte-identical to the previous result of this same call, N lines, <hash>)`;
- appended or locally edited → `(delta vs the previous result of this same call: N lines unchanged)`
  plus verbatim `- old` / `+ new` lines for what changed;
- more than 40% changed → returned as-is, no delta.

Modes: `delta` (default) / `identical` / `off`.

---

## Three promises it does not break

1. **Never silently drops information.** Every omission leaves a marker stating how many lines are
   gone. Those numbers are *self-checked*: each unit carries how many original lines it represents,
   and the total is reconciled at the end; if the arithmetic does not close, the whole result rolls
   back to the original text (better to save nothing than to hand the model a wrong number).
2. **Never grows.** Below `minSavingRatio` (12% by default), or larger than the input → roll back.
   Any thrown error logs one warning and returns the upstream decision untouched.
3. **Error results are untouched** by default. Error context is the most expensive context there is;
   `compressErrors` opts in.

`test/invariant.test.js` locks these in as regression tests over the whole corpus in
`tools/corpus.mjs`, including real captured outputs.

---

## Measured (`node tools/bench.mjs`, this machine)

Estimation matches DSH's own: UTF-16 code units / 4, rounded up, plus 4 per block.

| Corpus | Kind | Est. tokens | Saved |
|---|---|---:|---:|
| 600 numbered source lines | numbered-source | 6519 → 4034 | 38.1% |
| 6-file unified diff | diff | 2032 → 519 | 74.5% |
| 400-line `ls -l` | listing | 6073 → 1502 | 75.3% |
| 500-line app log | log | 7016 → 837 | 88.1% |
| build + test output | build | 383 → 40 | 89.6% |
| 150-item nested JSON | json | 10092 → 4951 | 50.9% |
| `git status` (68 files) | status | 500 → 69 | 86.2% |
| directory tree (25 dirs) | tree | 687 → 369 | 46.3% |
| repeated stacks ×40 | log | 3270 → 1343 | 58.9% |
| 4 real captured outputs | real | 2489 → 2343 | 5.9% |
| **total** | | **39135 → 16647** | **57.5%** |

All three invariants pass on every row.

**These numbers show what the compressors save on realistically-shaped corpora — not what a whole
task saves.** The total also depends on call count and mix, how often the model re-reads the same
thing, cache pricing, and how much of a session never passes through a tool. Small real files
(hundreds of bytes to a few KB) barely compress, because normalization alone has little to remove —
which is exactly what the net-gain gate is for.

```bash
node --test "test/*.test.js"   # 84 cases
node tools/bench.mjs           # the table above
node tools/bench.mjs --json
```

---

## Install

```bash
# 1) add the plugin to a profile's dependencies (link: to this checkout)
cd <DSH_HOME>/profiles/<profile>
#    add to package.json dependencies:
#      "dsh-context-guard": "link:/absolute/path/dsh-context-guard"
pnpm install

# 2) restart that profile (DSH Desktop: restart the app; plugin rows load at startup)
```

The package ships `cordis.patch.yml` (`dsh.bundle.patch`), so the `id: context-guard` row is inserted
automatically. You can also write it yourself:

```yaml
- insert:
    - id: context-guard
      name: 'dsh-context-guard'
      config:
        enabled: true
        incremental: delta
        budgetChars: 12000
```

To uninstall: remove the dependency line, `pnpm install`, remove the inserted row, restart. No global
state is written.

---

## Configuration

Every key is optional. A misspelled key fails loudly at load (never silently no-ops); a failed
validation falls back to all defaults.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch; off makes the listener a pass-through |
| `budgetChars` | `12000` | fallback per-result character budget |
| `toolBudgets` | `{}` | per-tool overrides, e.g. `{ bash: 4000 }` |
| `minChars` | `400` | results smaller than this are left alone |
| `minSavingRatio` | `0.12` | below this saving ratio, do not touch |
| `incremental` | `'delta'` | `off` / `identical` / `delta` |
| `incrementalMinChars` | `600` | minimum size for delta comparison |
| `memoryEntries` | `64` | delta ledger capacity |
| `repeatRun` | `3` | consecutive-repeat fold threshold |
| `repeatMinLength` | `24` | global dedup minimum line length |
| `repeatMinSaved` | `64` | global dedup minimum byte saving |
| `diffContext` | `3` | context lines kept around each change |
| `maxBlankRun` | `1` | maximum consecutive blank lines |
| `jsonIndent` | `0` | JSON indent; 0 collapses to one line |
| `conservative` | `false` | normalization only, no structural rewrites |
| `compressErrors` | `false` | also compress error results |
| `skipTools` | `[]` | tool names to leave alone |
| `log` | `false` | print per-result detail |

Per-tool default budgets: `read` 16000, `web_fetch` 14000, `bash`/`task`/`workflow` 12000, `univer`
10000, `grep`/`web_search` 8000, `glob`/`list` 6000. `read` / `write` / `edit` are treated as
high-risk content: normalization, dedup and budget only — no structural rewrites.

When a `webServer` service is present, a read-only `/dsh-context-guard/stats` endpoint reports
counters (results seen, changed, delta hits, rollbacks, estimated tokens saved, per-step and per-kind
hits). It never returns result content.

---

## Interaction with other plugins

- **`dsh-tool-token-optimizer`** hooks the same `tools/post-execute` and does head/tail/error-line
  budget trimming. Stacking them is not unsafe (this plugin is idempotent per result and reconciles
  its own totals) but the two do not see each other's accounting and the combined saving is not the
  sum. Pick one: this plugin if you want information-weighted selection, content-aware compression and
  deltas; set `enabled: false` here if you want to keep the other one's tuned behaviour.
- **`dsh-ops`** optimizes the input side and ships bash/Rust tooling; no conflict.

## Layout

```
lib/units.js     units & markers: every output line carries how many source lines it stands for
lib/text.js      lossless normalization and fingerprints
lib/detect.js    content-type detection (unrecognized content gets no structural rewrite)
lib/compact.js   structural compressors (diff / status / listing / tree / gutter / log / build / dedup)
lib/budget.js    scoring, budget fitting, JSON compaction
lib/replay.js    cross-call deltas (ledger, prefix+suffix diff, rendering)
lib/policy.js    pipeline orchestration, net-gain gate, marker rendering and reconciliation
lib/schema.js    config validation (Standard Schema v1, unknown keys rejected)
lib/index.js     host plugin (hook registration, stats, diagnostics endpoint)
tools/corpus.mjs corpus generator (includes real captured outputs)
tools/bench.mjs  benchmark + the three invariants
```

One rule runs through all of it: **recognize before you touch; if you touched it, say what you did;
and make the numbers add up.**

## License

MIT.

## Known limits

- Only `text` blocks are processed; images, files and structured blocks pass through untouched.
- Detection is heuristic. A misdetection costs savings, not correctness: each compressor only does
  what it explicitly defines, and the total is reconciled.
- Cross-call deltas assume the previous result is still in context. If the platform pruned it, the
  model may not see what a marker refers to — set `incremental: off` if that happens.
- The delta ledger keeps the last 64 (tool, arguments) pairs in process memory and is cleared on
  restart.
