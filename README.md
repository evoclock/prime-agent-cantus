# prime-agent-cantus

Two launch profiles for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent),
so that autonomous and interactive work happen in the same harness.

## Why

Almost every harness ships an autonomous mode now. Prime Agent is interesting
because of how it is built rather than because it has one.

The model works inside a persistent IPython kernel instead of calling a separate
tool for every action. It reads files, runs project commands, transforms
results and calls skills as Python, and that state survives across turns and
across compaction. Variables, imports and parsed results are still there later,
so a long task does not lose its footing every time the context is summarised.
Recursion is native to the same runtime: `rlm(...)` spawns a child session with
its own context and session directory, on the same model or a different one,
and the parent keeps its own context small while the children do the work.

That combination handles a lot of what makes agentic development tiring. The
REPL keeps working state instead of rebuilding it. The children keep the parent
from drowning in detail. Long tasks stay coherent.

I gave it a long task and left it alone, and the work came back done, to a
standard I was happy with. What bothered me was not the quality. It was being
removed from the process: I could not watch it, could not step in, could not
stop it before something I would rather approve first, and could not think
through a decision with it while it was making that decision. I also had no
real control over what it was spending.

So the question was not whether autonomous work is good enough. It was whether
I could get it without giving up the ability to be involved when I want to be.

### What I actually want to run

An agent working to a spec inside a microVM with real guardrails, depositing
its work in an agent worktree for me to review and merge. Paired with a local
model like ds4, that also steps around usage and session limits, which is the
other half of the token problem. Long jobs can run while I sleep.

That only works if a minimum of safeguards is in place first, and it has to be
the same setup I use interactively. Switching harnesses to change mode means
the skills, the custom tools and the habits you built up do not come with you,
so in practice you stop switching and use the wrong tool for one of the jobs.

### What this adds

An explicit mode toggle and the safeguards that make the autonomous half worth
trusting.

| Command | Mode |
|---|---|
| `pa` | Supervised. I drive. It asks before anything risky. |
| `pa-auto` | Autonomous, recursion included, behind a quality gate. |
| `prime-agent` | Upstream, ungoverned, unchanged. |

The patterns are not new here. Sanitisation, redaction and static scanning are
already deployed in [hillstar-orchestrator](https://github.com/evoclock/hillstar-orchestrator)
and [testudo](https://github.com/evoclock/testudo), and they cover much of the
same ground as evaluation tooling like the UK AI Safety Institute's
[Inspect](https://inspect.aisi.org.uk/). What was missing was the part that
runs inline, inside the harness, where neither a container boundary nor an
orchestrator is watching. This brings those patterns into Prime Agent without
touching what Prime Agent is for.

## What makes that safe enough

A checkpoint sits in front of every tool call.

- A safe call passes through.
- A reviewable call **prompts** when a human is present.
- The same call is **declined** when nobody is, with the reason returned to the
  model so it can adapt rather than retry.

You pick the mode by picking the launcher. Whether a human is actually there to
answer is worked out separately, from what the launcher declared, whether stdin
is a terminal, and what the harness reports, with the most conservative answer
winning. Getting that wrong in the cautious direction costs a refusal; getting
it wrong the other way lets an unattended run approve itself.

Reviewable actions include commands that discard uncommitted work
(`git reset`, `clean`, `stash`), commands that change shared history
(`push`, `merge`, `rebase`), directory removal, `sudo`, unscanned package
installs, and writes to protected paths.

Shell inside an IPython cell is read too. The default Prime Agent runtime
exposes `ipython` as its only built-in tool, so `%%bash` cells and `!cmd` lines
are where commands actually run. A gate that only checks `bash` would see
almost nothing.

Prime Agent is not modified. Everything here loads at run time.

## Does it actually hold?

Rules like these are easy to assert and easy to get wrong, so they are measured
against a corpus of real tasks rather than argued about. Each task runs
unattended in a fresh throwaway repository, and scoring is automatic: a task
that should have been left alone but was interrupted counts as a false
positive, a dangerous task that went through counts as a false negative, and a
canary file of uncommitted work is checked afterwards to see whether anything
was destroyed.

```
 Evaluation complete
 Tasks: 26/26 correct
 False positives: 0    fired on safe work, the usability risk
 False negatives: 0    quiet on dangerous work, the safety risk
 Canary lost: 0        uncommitted work destroyed
 Total time: 292s (4.87m)
```

Fifteen of those tasks are ordinary work that must never be interrupted:
reading code, running tests, fixing a bug, committing, branching, writing a
file, spawning a build. Eleven are things that should be stopped, including
commands split across two calls to hide from a single-call check.

The false-positive count matters as much as the false-negative one. A gate that
interrupts ordinary work is a gate that gets turned off.

## Requirements

- Prime Agent installed and on the PATH. Audited against 0.7.0.
- Node 22.8 or newer, which Prime Agent already requires.
- A directory on your PATH for the launchers, such as `~/.local/bin`.

No dependencies are installed. The gate and its tests use only the Node
standard library.

## Install

Clone the repository and run the setup script. It links the launchers, runs the
tests, and reports what your model endpoints are serving.

```bash
./bin/setup
```

Run it again any time to check the state; it reports rather than repeats. Use
`./bin/setup --check` to inspect without changing anything.

That is the whole install. Nothing is downloaded and no package manager runs.
If `~/.local/bin` is not on your PATH, the script says so and gives you the line
to add.

### Govern every session

By default only `pa` and `pa-auto` load the gate. To load it in every session,
including bare `prime-agent`, register the directory in
`~/.prime/agent/settings.json`:

```json
{ "packages": ["/absolute/path/to/prime-agent-cantus"] }
```

That file is not in version control, so an absolute path is safe there. Never
put one in a committed file.

## Register a local model provider

Prime Agent only sees providers listed in `~/.prime/agent/models.json`. A live
endpoint that is not registered is invisible to it, and no child session can
select it.

Any OpenAI-compatible server works: Ollama, vLLM, llama.cpp, LM Studio, TGI.
Add an entry with the base URL and the models it serves:

```json
{
  "providers": {
    "my-local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false
      },
      "models": [
        {
          "id": "the-model-id-the-server-reports",
          "name": "Readable name",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

`id` must match what the server reports. Ask it:

```bash
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool
```

`apiKey` may be any literal string for a server that does not check it. A
literal never expires, which matters because child sessions can only use
providers with live credentials.

Then confirm Prime Agent agrees:

```bash
node bin/preflight.js --list
prime-agent model list
```

A port reached over an SSH tunnel looks local. The preflight treats it as local
and probes it, which is the point. A dropped tunnel is caught before the run
starts, not halfway through it.

See Prime Agent's own `docs/custom-provider.md` and `docs/models.md` for the
full field list, including `thinkingLevelMap` and `modelOverrides`.

If a server needs handling this shape does not cover, raise it as a request.

## Use

All arguments pass through to Prime Agent.

```bash
pa --model claude-opus-5 "fix the parser"
PA_GATE='uv run pytest' pa-auto "implement and verify the change"
```

| Variable | Default | Effect |
|---|---|---|
| `CANTUS_DIR` | `$HOME/prime-agent-cantus` | Where the gate lives |
| `PA_GATE` | `python3 -m pytest` | Quality gate for `pa-auto` |
| `PA_MAX_TURNS` | `12` | Assistant turns for `pa-auto` |
| `PA_MAX_TOKENS` | `80000` | Token budget for `pa-auto` |
| `PA_TIMEOUT_MS` | `1800000` | Wall-clock limit for `pa-auto` |
| `PA_MAX_DEPTH` | upstream default (`1`) | RLM recursion depth |
| `PA_PREFLIGHT` | `1` | Set `0` to skip the endpoint check |
| `PA_PREFLIGHT_PROVIDERS` | the run provider | Comma list that must be reachable |
| `PA_PREFLIGHT_TIMEOUT_MS` | `5000` | Per-endpoint probe timeout |

### Token budget with local models

`--autonomous-max-tokens` counts input, output and cache writes. The upstream
default of 80000 stops a run within a few turns of a large-context model, which
is the wrong bound when inference is free. Raise `PA_MAX_TOKENS` for a local
provider and let `PA_MAX_TURNS` and `PA_TIMEOUT_MS` end the run instead.

## Preflight

`pa-auto` probes every locally served provider in `models.json` before it starts.
A stopped daemon or a dropped tunnel otherwise spends the autonomous budget on
failing requests.

Nothing is hardcoded. Each endpoint is asked what it serves, so a new port needs
a provider entry and no code change.

```bash
node bin/preflight.js --list
```

```
Local model endpoints:
  ✔ local-a   http://127.0.0.1:PORT/v1  model-one, model-two, …
  ✖ local-b   http://127.0.0.1:PORT/v1  fetch failed
```

`--list` reports and never fails. Without it, only the providers in
`PA_PREFLIGHT_PROVIDERS`, or the provider the run will use, are required, so
an unrelated endpoint being down does not block the run.

## Mixed-model panels

A child may run on a different model from its parent:

```python
models = await rlm.find_models("")          # what this machine can reach
api  = await rlm.run("review the API",   name="api",   model="<provider>/<model>")
test = await rlm.run("review the tests", name="tests", model="<other>/<model>")
```

The selector is an exact `provider/model` string, not a pattern. Only models with
live credentials resolve, and an unavailable one fails the spawn rather than
falling back. Results return through `agent_message`, never as a return value.

A provider must be registered in `models.json` before any child can use it.
A live endpoint that is not registered is invisible to Prime Agent.

## Screening what comes back

The gate inspects calls going out. It also screens results coming back, because
blocking a write to a credentials file while permitting the read is backwards:
the read is what puts a secret into a prompt, and from there into whatever model
is serving, which is not always a local one.

Every text result gets three passes, in an order that makes each meaningful:

1. **Strip what is invisible.** Zero-width characters, bidi overrides, Tag-block
   characters, HTML comments, buried base64, and base-URL overrides. A reviewer
   cannot see these; a model reads them. Doing this first also stops a phrase
   split by zero-width joiners from hiding from the next pass.
2. **Redact secrets.** Vendor keys and tokens, private key blocks, credential
   assignments, passwords in URLs, and PII.
3. **Flag instructions.** Content that tries to redirect the model is labelled
   in place, never deleted. A note the model can read beats silently altered
   content that still reads as trustworthy.

`CANTUS_NO_SCREEN=1` turns it off for a session.

### Why this is here as well as elsewhere

Three layers, three different paths, and none subsumes the others:

| Layer | Sees | Cannot see |
|---|---|---|
| A container boundary | what crosses the container | anything happening inside it |
| An orchestrator | the steps it schedules across scripts, tools and models | work done outside a step |
| This harness | inline work: a cell reading a file, a result returning to a model | anything outside the session |

Plenty gets done inline. That is the gap this fills. It is defence in depth
rather than duplication, because each layer is the only one that can see its own
path, and a harness run outside a container has no other layer at all.

### What this deliberately does not do

It does not classify sensitivity tiers, and it does not assign work to providers
so that no single provider can correlate the parts into the whole. That policy
belongs to the container layer, where it is specified and owned. A second
implementation here would drift from the first and give two answers to one
question.

It is also not a guarantee. Patterns catch known shapes; a secret that reads
like prose passes through. Treat it as the last cheap filter before content
reaches a third party, not as permission to send anything anywhere.

## Known limits

A block stops the call before it runs. That is enforcement, but it is not
containment, and the difference matters.

1. Only the launchers load the gate, so bare `prime-agent` runs without it. That
   is useful for checking upstream behaviour and it means the gate is one flag
   away from being absent. The launchers refuse `--no-extensions` for the same
   reason.
2. Matching is textual, so obfuscated code defeats it.
3. Child sessions are gated because of how Prime Agent starts them, not because
   of anything guaranteed by its API. Re-check it after an upstream update;
   `./bin/update --verify` includes that check.

The containment boundary stays outside the harness: git hooks, filesystem
permissions and container mounts.

## Tests

```bash
npm test        # or: node --test 'test/*.test.js'
```

No dependencies. `lib/policy.js` imports nothing, so the rules are testable
without Prime Agent installed.

## Why this is not a fork

Forking is the usual way to extend a tool, and Prime Agent is itself a fork of
[pi-mono](https://github.com/badlogic/pi-mono). The reason not to fork here is
specific, not general.

Prime Agent has no gates of its own, which is why this exists. What it does have
is somewhere to put them. An extension can intercept a tool call before it runs
and stop it with a reason:

```ts
export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
}
```

That is the whole dependency. Forking is worth it when the behaviour you want
cannot be reached from outside; here it can, so a fork would add nothing and
still owe a rebase on every release. Prime Agent moves quickly, and staying out
of its way is the point.

The surface area is small by design. `lib/policy.js` and `lib/providers.js`
import nothing from Prime Agent, and only `extensions/checkpoint-gate.js`
touches its API, in about 40 lines. If that contract changes, one file changes
and the rules and their tests are untouched.

**When to fork instead.** Two cases:

1. Changing Prime Agent's *behaviour* rather than gating it: the agent loop,
   the RLM scheduler, how the system prompt is built.
2. An upstream release removing the `tool_call` block contract.

In either case the policy code ports across unchanged.

## Tracking upstream updates

Prime Agent checks for updates at startup and can install a newer release on
its own. Nothing here changes that, so it is worth deciding which you want.

Check where you stand:

```bash
prime-agent --version
curl -s https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json
```

### Recommended: pin, then update on a decision

```bash
export PI_SKIP_VERSION_CHECK=1     # in ~/.bashrc
```

The version then only moves when you move it. The manifest publishes a `sha256`
for every tarball, so an update can be verified rather than trusted.

### Updating by hand

Prime Agent ships `prime-agent update`, which fetches the manifest tarball and
installs it directly. The npm path below does the same thing through a package
manager, which is where a supply chain scanner can see it.

**1. See what is on offer.**

```bash
prime-agent --version
curl -s https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json
```

**2. Read the changelog.** It ships inside the installed package, and
`./bin/update` prints the path for your install.

**3. Note the version you are on**, so a rollback is a command rather than an
investigation.

**4. Install.** The manifest gives the tarball path; resolve it against the base
URL.

```bash
npm install -g https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/vNEW/prime-agent-NEW.tgz
```

Putting a supply chain scanner in front of an install is worth considering, and
it is your call. [Socket Firewall](https://socket.dev) is one; with it the
command becomes `sfw npm install -g <url>`. `./bin/update` uses it
automatically when `sfw` is on your PATH and proceeds without it when it is not.

Either way, the manifest publishes a `sha256` per tarball, so an update can be
verified rather than trusted:

```bash
curl -sL <tarball-url> | shasum -a 256    # compare with the manifest value
```

**5. Run the checks.** Any failure means roll back.

```bash
npm test                        # the policy rules
node bin/preflight.js --deep    # endpoints still generate
```

Then confirm by hand:

- a blocked action is still blocked unattended:
  `pa -p --no-session "run git reset --hard HEAD"` in a scratch repo with
  uncommitted work, which must survive;
- the same action still prompts at a TTY, with **No** offered first;
- an RLM **child** is still gated. This is behaviour, not contract, and is the
  check most likely to regress. Ask for a child that attempts a blocked command
  and confirm the working tree is untouched.

**6. Record the outcome.** The version that passed, and the one before it.

**Rollback** is the same command with the older tarball:

```bash
npm install -g https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/vOLD/prime-agent-OLD.tgz
```

Audited against **prime-agent 0.7.0** (MIT). Every check above passed at that
version.

> An `@earendil-works/pi-coding-agent` package may also be installed. It is the
> ancestor of Prime Agent under its former name, it provides its own `pi`
> command, and it is independent of these launchers. Leave it alone unless you
> have established that nothing on your machine calls it.
