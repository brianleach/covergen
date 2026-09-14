# Uber AutoCover and related LLM test-generation systems: sourced dossier

Compiled 2026-09-02. Every number below is traced to a source. Items marked **[unverified]** come from secondary writeups (ZenML, blogs, talk summaries) and were not confirmed against a primary document. Items marked **[not in paper]** are things the task asked about that the ICSE paper does not actually state.

Local copies used: `scratchpad/autocover.pdf` (+ `autocover.txt`), `scratchpad/testgen.txt` (TestGen-LLM), `scratchpad/coverup.txt` (CoverUp).

---

## Part 1. Sources

### 1.1 Primary: the ICSE-SEIP 2026 AutoCover paper

**Rastenis, Chou, Roy Choudhary, Just. "Automated Software Test Generation at Industry Scale Using a Multi-Agent Architecture and Workflow Integration." ICSE-SEIP 2026, Rio de Janeiro, April 12-18 2026. 11 pages, CC-BY 4.0.**
- PDF: https://homes.cs.washington.edu/~rjust/publ/auto_cover_icse_2026.pdf
- ACM DOI: https://dl.acm.org/doi/10.1145/3786583.3786918
- Conference page: https://conf.researchr.org/details/icse-2026/icse-2026-software-engineering-in-practice/58/Automated-Software-Test-Generation-at-Industry-Scale-Using-a-Multi-Agent-Architecture
- arXiv: **not found**. Searches for the exact title return only the UW PDF and ACM DL. Treat the UW PDF as canonical.

Summary: AutoCover is Uber's production LLM test generator, deployed to all engineers between Sept 2024 and Sept 2025, now producing about 11% of all new tests reviewed and added to Uber's codebase. It is a LangGraph pipeline of five agents (Preparer, Generator, Executor, Validator, Fixer) with language/repository adapters for Go, Java, TypeScript, Python, tightly coupled to Bazel so it can build, run codegen/mocks, collect per-test coverage and run bounded mutation testing. Three surfaces: CLI, Headless (shard the monorepo, open merge requests routed to owning teams), IDE (background precompute on a 5-minute save debounce, results shown as VS Code comments with insert/dismiss command links). Reported success rates for viable tests (pass and raise line or scenario coverage): ~20% Java, ~40% Go, ~80% Python; IDE viable tests explicitly accepted by users ~44%. Full extraction in Part 2.

### 1.2 Uber talks and secondary writeups on AutoCover

Note: no post on uber.com/blog about AutoCover was found (site: search returns nothing). The Uber-authored material is the paper plus three conference talks.

**Talk A. GitHub Universe 2024: "Building agentic systems with VS Code extensibility and GitHub Copilot at Uber" (Matas Rastenis, Sourabh Shirhatti).**
- Video: https://www.youtube.com/watch?v=8rkA5vWUE4Y (title confirmed via page fetch; speakers per LangChain post)
- LangChain post pointing at it: https://x.com/LangChainAI/status/1872341615756324968 and https://www.linkedin.com/posts/langchain_how-uber-uses-langgraph-to-build-autocover-activity-7278107301373267969-u7nq
- ZenML summary: https://www.zenml.io/llmops-database/llm-driven-developer-experience-and-code-migrations-at-scale

Summary: This is the source of the "Copilot Chat Participants API" claim. Per the ZenML summary, AutoCover was surfaced in VS Code as a Copilot chat participant invoked with `@AutoCover` plus slash commands, streaming tests into the editor. The pipeline is described as a state machine alternating deterministic and LLM steps: Prepare (deterministic: mocks, test file) -> Generate (LLM) -> Build/Run (deterministic) -> Fix (LLM), looping until a coverage target (example given: 80%). A validation step checks function comments against assertions, flags redundant tests, and enforces Uber's table-test pattern. **[unverified]** The ZenML page attributes the talk to "Adam and Ty, 2023" which conflicts with the LangChain attribution (Matas and Sourabh, GitHub Universe Oct 2024); the LangChain attribution is more credible. Note the ICSE paper itself never mentions Copilot or chat participants; by 2025 the IDE surface had moved to background precompute plus comment-pane actions (section 6.4). So "Copilot chat participant" describes the 2024 IDE surface, not the current one. **[not in paper]**

**Talk B. LangChain Interrupt 2025: "From Pilot to Platform: Agentic Developer Products with LangGraph" (Sourabh Shirhatti, Matas Rastenis).**
- Video: https://www.youtube.com/watch?v=Bugs0dVcNI8 (title: "How Uber Built AI Agents That Save 21,000 Developer Hours with LangGraph | LangChain Interrupt")
- Attendee notes: https://cameronrohn.com/docs/discover/LangChain-Interrupt-2025/presentations/2.12-From-Pilot-to-Platform-Agentic-Developer-Products-wit-LangGraph/
- ZenML summaries: https://www.zenml.io/llmops-database/building-ai-developer-tools-using-langgraph-for-large-scale-software-development and https://www.zenml.io/llmops-database/ai-powered-developer-tools-for-code-quality-and-test-generation
- Blog recap: https://blog.tmcnet.com/blog/rich-tehrani/ai/how-uber-built-ai-agents-that-saved-21000-developer-hours.html (403 on fetch; not read)

Summary: Describes AutoCover as a graph of "domain expert agents" (Scaffolder, Generator, Executor, Validator) built on an internal framework wrapping LangGraph/LangChain (called "Lang Effect" in ZenML, "LangFX" in the attendee notes; same thing). Claims: up to 100 (or "hundreds of") concurrent generation and execution iterations on a large file; 2-3x more coverage than industry agentic tools in half the time; raised Developer Platform coverage by 10%, approximately 21,000 developer hours saved; thousands of tests per month. **[unverified]** The 21,000 figure is "developer hours" in most summaries but "lines of code" in the cameronrohn notes; hours is the dominant reading. Validator is reused as a component inside AutoCover. Lessons: specialized agents with rich context beat generic ones; mix deterministic tools with LLM steps; bounded, encapsulated agents get reused across products (the build-system agent serves both AutoCover and Validator).

**Talk C / press: Pragmatic Engineer, "How Uber uses AI for development: inside look" (2026).**
- https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development

Summary: Free preview lists Uber's AI tool suite: Minion (background agent platform), Shepherd (migrations), uReview (AI code review), Code Inbox, and "Autocover: generates 5,000+ unit tests per month." Also 84% of devs using agentic tools, 11% of PRs opened by agents, 92% of developers using agents monthly, AI costs up 6x since 2024. Detailed sections are paywalled. **Reconcile:** 5,000+/month is far below the paper's "hundreds of thousands (IDE), tens of thousands (Headless), thousands (CLI)" per month; the paper counts generated candidates, the newsletter almost certainly counts landed/merged tests. Treat them as different denominators.

**Other Uber tools named in the task.**
- Validator: IDE agent flagging best-practice and security violations with precomputed fixes; hybrid LLM + deterministic linters; "thousands of fix interactions daily" (Talk B). In the paper, Validator is also the quality gate inside AutoCover and "automatically fixes tens of thousands of developer-written tests."
- uReview: AI code review at PR time, reusing Validator/AutoCover components (ZenML "AI-Augmented Code Review": https://www.zenml.io/llmops-database/ai-augmented-code-review-system-for-large-scale-software-development).
- Genie: Uber's Gen AI on-call copilot (Slack RAG bot), not a test tool: https://uber.com/blog/genie-ubers-gen-ai-on-call-copilot
- Picasso: Uber's workflow management platform; embeds a conversational "Genie" assistant. **[unverified]**, only from ZenML summaries.
- "uGenie": **no source found** under that name. Likely conflation with Genie or "Uber Assistant Builder" (internal custom-GPT store). Marked unverified.
- Uber Assistant Builder: internal chatbot builder, per Talk B summaries.

### 1.3 Meta TestGen-LLM

**Alshahwan et al. "Automated Unit Test Improvement using Large Language Models at Meta." FSE 2024. arXiv:2402.09171.**
- https://arxiv.org/abs/2402.09171 (PDF read locally as `testgen.txt`)

Summary: Extends existing human-written Kotlin test classes (Instagram, Facebook Android) using two internal Meta LLMs. It is the canonical "Assured Offline LLMSE" pipeline: candidate test cases must clear three filters in order: (1) builds; (2) passes reliably, where the test is run 5 times and any failure marks it flaky and discards it; (3) increases line coverage relative to all existing test classes sharing the same build target. Prompts: `extend_coverage` (default; gets test class + class under test), `extend_test`, `corner_cases`, `statement_to_complete`; temperature 0 was best (small effect size), users could run a temperature sweep 0.0-1.0. Evaluation on 86 Kotlin components (31 Stories, 55 Reels): 75% of test classes got at least one test that builds, 57% at least one that builds and passes, 25% at least one that builds, passes and adds coverage. Deployment (29 Oct - 29 Dec 2023, three test-a-thons): 1,979 test classes targeted, 196 improved (~10%; abstract says 11.5%), 73% of recommendations accepted and landed. Per-trial success (build + pass + add coverage): Facebook 490/8,996 = 5%, Instagram 831/23,535 = 4%. In the fully automated December run: 42 diffs submitted, 36 accepted, 2 withdrawn, remainder rejected. Reviewers asked for per-test-case coverage attribution, which led to filtering per test case rather than per class. Compared favorably to Meta's earlier automated repair (SapFix) at 50% acceptance.

### 1.4 Related academic / open systems

**CoverUp (Altmayer Pizzorno, Berger). FSE 2025. arXiv:2403.16218. Python.**
- https://arxiv.org/abs/2403.16218 (PDF read locally as `coverup.txt`); code: https://github.com/plasma-umass/coverup

Summary: Coverage-guided loop for Python. Measures line+branch coverage with SlipCover, walks the AST of files missing coverage to cut "segments" (function, or class up to a max length, default 50 lines), then prompts per segment with the excerpt, the specific missing lines/branches, import hints, and instructions such as "include assertions" and "avoid state pollution." Each returned test is executed; on failure the chat is continued with the error so the LLM repairs it; on success coverage is remeasured and only tests that add coverage are kept. Runs segments in parallel with timeouts. Handles state pollution by executing tests in isolation (default), or by searching for and disabling polluting tests (pytest-cleanslate). Results with gpt-4o-2024-05-13, temperature 0: per-module median line+branch 80% vs CodaMosa 47%, overall 60% vs 45%; vs MuTAP 89% vs 77%; 82% median per-module line coverage on a 4,116-function suite. Cost: ~18x faster than CodaMosa but ~48% more tokens. Reusable: the segment-selection algorithm, the prompt template, the keep-only-if-coverage-increases rule, and the pollution defenses.

**TestPilot (Schaefer, Nadi, Eghbali, Tip). TSE 2024. arXiv:2302.06527. JavaScript/TypeScript.**
- https://arxiv.org/abs/2302.06527 ; code: https://github.com/githubnext/testpilot

Summary: GitHub Next's LLM unit-test generator for npm packages using Mocha. Prompt contains the function signature, its body, doc comments and usage snippets mined from docs; failing tests are re-prompted with the error message for repair. On 25 npm packages / 1,684 API functions: median statement coverage 70.2% and branch 52.8% with gpt-3.5-turbo (vs 51.3% / 25.6% for the Nessie feedback-directed baseline); 68.2% statement with code-cushman-002; 54.0% with StarCoder. 92.8% of tests had <50% similarity to existing tests (not memorized). Reusable: the API-explorer that enumerates a package's exported functions, the doc-snippet retrieval, and the error-feedback repair loop; it is the closest open reference for a JS/TS pipeline.

**ChatUniTest (ZJU). FSE 2024 Demo. arXiv:2305.04764. Java/JUnit/Maven.**
- https://arxiv.org/abs/2305.04764 ; code: https://github.com/ZJU-ACES-ISE/ChatUniTest (175 stars, Maven plugin)

Summary: Generation-validation-repair framework with an "adaptive focal context" that picks which dependent code to put in the prompt. Validation compiles and runs each test; repair first applies rule-based fixes (imports, syntax) then LLM re-prompting. The repo doubles as a research harness: it hosts reference implementations of ChatTester, TestSpark, SymPrompt, HITS, MuTAP, TELPA and CoverUp for Java selectable via a phaseType flag. Claims to beat TestSpark and EvoSuite on line coverage in half the evaluated projects (exact numbers not in abstract; **[unverified]**). Reusable: the cheap rule-based repair before spending an LLM call, and the focal-context selection heuristic.

**Meta ACH (Foster et al.). arXiv:2501.12862. Kotlin/Android, mutation-guided.**
- https://arxiv.org/abs/2501.12862

Summary: "Automated Compliance Hardening." Instead of chasing coverage, an LLM generates a small number of mutants that simulate a specific fault class (privacy violations), an LLM agent filters equivalent mutants (precision 0.79 / recall 0.47 raw, 0.95 / 0.96 with preprocessing), then an LLM generates tests that kill the surviving mutants; tests still pass the build/pass/kill filters. Applied to 10,795 Kotlin classes across 7 Meta platforms: 9,095 mutants, 571 privacy-hardening tests, 73% engineer acceptance, 36% judged privacy-relevant. Reusable: mutation as the acceptance signal instead of (or in addition to) coverage, and concern-targeted mutant generation; AutoCover's Validator uses a bounded version of the same idea.

**Qodo Cover / Cover-Agent (Qodo, formerly CodiumAI). AGPL-3.0. Unmaintained.**
- https://github.com/qodo-ai/qodo-cover

Summary: Open implementation of the TestGen-LLM loop: build a prompt from the source file, existing test file and coverage report; ask for N tests; run each; keep only those that pass and raise coverage; repeat until a target coverage or max iterations. Parses Cobertura XML, lcov and JaCoCo, so it is language-agnostic wherever a coverage report exists (examples for Python, Go, Java). Uses LiteLLM for 100+ model backends. README states the repo is no longer maintained; the hosted "Qodo Cover" GitHub Action (qodo-ci) is the commercial successor. Reusable: the lcov/Cobertura parsers and the loop skeleton; license (AGPL) matters if embedding.

### 1.5 2025-2026 follow-ups relevant to TypeScript/JavaScript and Ruby

**ASTER (IBM). ICSE-SEIP 2025, Distinguished Paper. arXiv:2409.03093.** https://arxiv.org/abs/2409.03093
Static-analysis-guided multi-language (Java, Python) LLM test generation emphasizing "naturalness"; cited by the AutoCover paper as the closest academic peer. Not JS/TS but the pipeline generalizes.

**YATE: "The Role of Test Repair in LLM-Based Unit Test Generation." arXiv:2507.18316 (2025).** https://arxiv.org/abs/2507.18316
Repairs rather than discards failing generated tests using rule-based static fixes plus re-prompting; 32% higher line coverage and 22% more mutants killed than baseline LLM methods, ~22%/20%/20% better than HITS, SymPrompt, TestSpark, CoverUp at comparable cost. Language not stated in abstract (Java per the ChatUniTest harness lineage; **[unverified]**). Lesson: a repair stage is cheaper than regenerating.

**MUTGEN: "Mutation-Guided Unit Test Generation with a Large Language Model." arXiv:2506.02954, accepted TSE.** https://arxiv.org/abs/2506.02954
Feeds mutation results into the prompt; iterative kill-more-mutants loop; 204 subjects; beats EvoSuite and vanilla prompting on mutation score. Key stat: some suites reach 100% coverage with 4% mutation score, the argument for AutoCover's "coverage is necessary but insufficient."

**AdverTest: "Test vs Mutant: Adversarial LLM Agents for Robust Unit Test Generation." arXiv:2602.08146 (Feb 2026).** https://arxiv.org/abs/2602.08146
Two agents (test writer vs mutant writer) in an adversarial loop; +8.56% fault detection over LLM baselines, +63.3% over EvoSuite on Defects4J (Java).

**"Testing with AI Agents: An Empirical Study of Test Generation Frequency, Quality, and Coverage." MSR 2026. arXiv:2603.13724.** https://arxiv.org/abs/2603.13724
Mines the AIDev dataset: 650 TypeScript projects, 400 with a detectable framework, Vitest most common (179 projects, 44.8%), then Jest. AI agents authored 16.4% of test-adding commits; AI tests are longer, higher assertion density, lower cyclomatic complexity, and reach coverage comparable to human tests. This is the only 2026 TS/Vitest-specific data point found; it is observational, not a tool.

**Ruby / RSpec: no academic LLM test-generation-with-coverage-filter work found.** Closest items:
- GitAuto (commercial): opens PRs adding tests to raise coverage; consumes SimpleCov output converted to LCOV at `coverage/lcov.info` uploaded as a GitHub Actions artifact; supports `enable_coverage :branch`. https://gitauto.ai/docs/coverage/ruby. Selection and verification internals are not documented.
- simplecov-rspec gem (fail RSpec below a threshold, optionally list uncovered lines): https://github.com/main-branch/simplecov-rspec
- "Collaborative Agents for Automated Program Repair in Ruby" arXiv:2511.03925 (repair, not test gen; shows Ruby agent tooling exists). https://arxiv.org/html/2511.03925
- Cover-Agent's lcov parser plus SimpleCov's lcov formatter (`simplecov-lcov`) is the obvious bridge for an RSpec port; nobody has published one.

---

## Part 2. Consolidated technical description of AutoCover (from the ICSE-SEIP 2026 paper unless noted)

### 2.1 Motivation and why generic assistants failed (sections 1-2)
- Uber targets at least 85% coverage on new code; legacy code lags. Engineers report a median of 4 minutes per covered line (conference abstract).
- Summer 2024 evaluation: Copilot could not invoke build steps or fetch generated artifacts (coverage, mocks). Cursor could run tools but drifted from mocking conventions and had "unacceptably long latency on large files with low existing coverage" because generation was linear.
- Three stated failure modes of generic tools: build-graph and generated-code blindness (wrong build labels, no codegen, missing mock packages); no transitive dependency discovery (miss generated registries/mappers, invent stubs that violate constructor constraints); serialized prepare/build/validate with no fan-out.

### 2.2 The five agents (section 3, Figure 1)
Loop: **Preparer -> Generator -> Executor -> Validator -> Fixer**, parallel where safe. Built on LangGraph with ReAct-style agents; sub-graphs for preparation, generation, execution, validation/repair; language and repository adapters supply tooling and policy; a task-aware code-context retriever feeds only relevant symbols.

1. **Preparer** ("what to test and why"). Inputs: source, build graph, initial coverage. Sub-tasks: scenario discovery (LLM pass summarizing API intent per function, proposing happy-path and edge cases; produces a per-function scenario map with contract notes, edge conditions, invariants); initial coverage check (build + coverage probe to get a baseline and a prioritized target map); test suite scaffolding (canonical test file, minimal imports, table skeletons, adapter hints for linters/build/codegen/mocks); test suite repair (on initial build failure only, calls Fixer to regenerate build files or fix imports).
2. **Generator**. Proposes tests that raise line coverage or satisfy new scenarios. Three modes: per-function generators fanned out in parallel; existing-test extender (append table rows, tighten assertions); full-file generator as fallback when function parsing fails, marking uncovered spans. "Already-tried deduplication": shared store of versioned candidates deduped by normalized content.
3. **Executor**. Emits an artifact plan from the build graph and materializes codegen/mocks concurrently. Pipelines retrieval -> splice -> compile -> run/coverage -> validate with bounded queues, incremental builds and caches. Replicates the Bazel test target per test case (avoids Cursor-style shadow-workspace pitfalls, maximizes cache reuse); isolated Bazel sandboxes, pinned toolchains, stable seeds, no global state. Harvests per-target logs and coverage, attributes failures to specific test cases, collects per-(function, scenario) coverage sets. Integrates via AST-aware edits (imports, table-row insertion) with selective persistence: tests that regress or add no signal are reverted; name/import conflicts resolved by deterministic rename/alias; conflicting cases re-queued to Fixer.
4. **Validator** (quality gate). A test is viable only if it executes successfully and raises code coverage or scenario coverage. Sub-tasks: conventions validation via an LLM-powered best-practices registry of machine-readable rules (id, severity, span, rationale, patch, confidence) with language-scoped examples for hermetic IO, seeded randomness, import aliasing (explicitly aimed at flakiness); mutation testing with bounded mutant types and counts, surviving mutants attributed to tests/scenarios and turned into prompts to tighten oracles; linting (adapters may skip execution for obvious violations; final lint pass on merged tests); persistent memory (stability cache returns prior findings for unchanged files to smooth LLM variance; per-target run logs; suppression of repeated low-severity findings; knobs for re-validation rounds, severity thresholds, tool/token budgets). Accepted tests go back to Executor for splicing; rejected ones go to Fixer. Validator explicitly rejects change-detector tests.
5. **Fixer**. Per-test-case parallel repair from diagnostics, Validator findings, scenario intent and edit history. Prioritizes by expected improvement; freezes chronic non-improvers. Gathers failure context into a compact per-case state; bounded context crawler (ls, tree, read_file) fetches imports/signatures/examples; policy-gated helper can regenerate build files or fix imports. "Do no harm": patches that degrade passing tests are reverted; patches signed and auditable; repairs versioned and merged through Executor's splicer; persistent collisions frozen with rename instructions; successful patterns fed back into same-run prompts.

Design principles listed: specialized agents; reusable nodes; language/repo adapters; determinism first; AST-aware splicing; build-safe parallelism; table-driven tests by default; durable test-case identity/history; scenario coverage as an acceptance signal; Validator as policy gate.

### 2.3 Coverage as a filter, and beyond
- Acceptance = passes AND (line coverage delta > 0 OR covers a previously uncovered scenario). Scenario coverage was added later than line coverage, so 2024 and 2025 coverage numbers are not comparable.
- Coverage is attributed per test case and per (function, scenario), enabling precise reversion of no-signal tests.
- Paper explicitly treats coverage as "necessary but insufficient" and layers mutation testing and best-practice rules on top (cites Ivankovic et al. on misuse of coverage).

### 2.4 Build failures and flakiness
- Initial build failures: Preparer calls Fixer before anything else (regenerate BUILD files, fix imports); codegen/mocks materialized before generation so tests do not fail on missing symbols.
- Flakiness defenses are preventive (rules for hermetic IO, seeded randomness, stable clocks, no global state; sandboxed execution with pinned toolchains) rather than the Meta-style "run 5 times" filter. The paper does not state a repeat-run count. **[not in paper]** Flakiness rate is one of the tracked regression signals (section 5.3).

### 2.5 The three surfaces
- **CLI** (first released): on-demand for folders/files/functions; edits local state; ran on developer containers or remote compute; used for legacy backfill mandates. Thousands of tests/month.
- **Headless**: autonomous over repository shards, opens merge requests routed to owning teams. Tens of thousands of tests/month. Gets lower priority lanes than IDE traffic.
- **IDE**: VS Code and forks (Cursor). Background precompute triggered by a 5-minute debounced timer reset on each save (line-change heuristics were tried and rejected). Runs Bazel at lower priority against the shared build server; refactored so background runs never modify the user's workspace unknowingly. Results appear as VS Code comments with description, preview and command links: (1) insert and ensure it passes, (2) insert, (3) dismiss; progress and cancel in the same pane; explicit on-demand trigger also available. Remote feature flags/kill switches via personnel-based access control because extension release trains took days to a week. Hundreds of thousands of tests/month. Alternatives rejected: CLI watch mode, workstation background agents, chat assistants (context switching). The 2024 GitHub Universe surface was a Copilot chat participant (`@AutoCover`); the paper does not mention it.

### 2.6 Language support and success rates
- Supported: Go, Java (Kotlin mentioned in the Jan-Mar 2025 phase), TypeScript, Python via adapters.
- Viable-test success rate: **~20% Java, ~40% Go, ~80% Python**. No TypeScript rate is reported. **The paper gives no explicit per-language explanation for these gaps** **[not in paper]**; the implicit reasons from sections 2-3 are build-graph/codegen complexity and mocking conventions (heaviest in Java/Go, lightest in Python).
- IDE acceptance: ~44% of viable IDE tests explicitly accepted by users. Expert review found acceptance rates in line with quality ratings.
- Validator fixes tens of thousands of developer-written tests, trending down as generated (valid-by-design) tests grow.

### 2.7 Benchmark (section 4.1-4.2)
- 9 Go subjects (3 basic, 3 infra, 3 product), 60-minute timeout, baselines run autonomously with the same rules/tool docs.
- Median coverage at 5/10/15/30/45/60 min: AutoCover 40.0/93.2/98.5/99.4/100/100%; Cursor 0.46.8 0/0/0/40.8/40.8/40.8%; Cursor 1.7.54 0/0/97.0/98.7/98.7/98.7%; Cursor 2.3 0/0/0/96.7/96.7/96.7%; Claude Code 2.0.75 0/0/90.4/90.4/98.1/100%.
- Median minutes to 40/80/90/95/99/100%: AutoCover 4.7/7.2/8.3/10.8/19.5/41.6; Cursor 0.46.8 30/x/x/x/x/x; Cursor 1.7.54 11.6 to 95% then x; Cursor 2.3 17.0 to 95% then x; Claude Code 12.8/13.8/13.8/41.4/48.9/48.9.
- Two non-author PhD experts rated outputs on a 7-level scale (Very good ... Broken). AutoCover produced no broken tests; both reviewers rated 67% of AutoCover subjects landable-as-is (Good/Very good) vs 33% and 56% for Cursor 0.46.8.

### 2.8 Cost, models, latency (sections 4.3, 5)
- Models and cache hit rates (Table 2): Preparer on OpenAI GPT-5 Thinking, O(10^8) tokens, 9.5% cache hit; Validator on GPT-4.1, CLI/Headless O(10^6) 30.2%, IDE O(10^9) 91.7%; Fixer context crawler on GPT-4.1, O(10^9), 59.5%; Generator on Claude 4 Sonnet, O(10^10) tokens, 53.5%; Fixer (other) on Claude 4 Sonnet, O(10^8), 22.1%. No dollar figures are given.
- Two-tier caching: literal response cache at the inference gateway plus native prompt caching. Prompts restructured into stable (rules registry, adapter guidance, rubric), semi-stable (target function contract, invalidated by file hash) and volatile (test slice, coverage diffs, failure logs) blocks; a pilot Generator call warms the cache before fan-out; diagnostics normalized with stable IDs and non-deterministic log fragments trimmed to raise cache affinity.
- Cost shaping: smaller reasoning tiers for lint-only checks; retry caps per test case; dedup of identical (function, scenario) shards across users by content hash; TTL cache keyed by (file hash, function span, imports); IDE sessions preempt Headless.
- Quota handling: central LLM gateway (cost attribution, anonymization, failover); multi-level fallbacks (primary -> previous-gen -> cross-vendor); per-tenant and global semaphores, token buckets, jittered backoff on 429/5xx; circuit breakers with probation.
- Latency: SLOs on P50/P95/P99 time-to-first-coverage for IDE sessions; benchmark shows ~5 min to 40% and ~7 min to 80% coverage on Go.
- Anonymizer: generic PII scrubbers mangled identifiers like `User`; tuned to distinguish code identifiers, verified with parse round-trip and import-resolution checks.
- Telemetry: correlation IDs across agents; counters for throughput, Validator pass/fail by rule, mutation survivors, coverage deltas, stage latencies, tokens and cache hits per stage, compute per accepted test.
- Regression prevention: E2E scenario suite run pre-merge, nightly in canaries with different model mixes, and on demand; signals are time-to-first-coverage, accepted-test count, scenario coverage, Validator pass rate, flakiness rate.

### 2.9 Rollout timeline (section 3.7)
Jun-Jul 2024 dogfooding -> Aug-Nov 2024 CLI and Headless pilots -> Sep-Dec 2024 Validator-first architecture (rules registry, early mutation checks) -> Jan-Mar 2025 full parallel pipeline and broader Java/Kotlin -> Apr-Aug 2025 IDE integration and background precompute -> GA to all engineers Aug 2025.

### 2.10 User survey (section 4.4), lessons and limitations
- 29 respondents (23 active, 6 inactive). Both groups agree AI test gen encourages more tests (65% vs 67%). Active users: 83% say it improves productivity (inactive 40%), 61% positive UX (40%), usability rated good/excellent 83%, quality 70%, speed 65%; no inactive user rated quality good.
- Requested improvements: match project style/idioms even when they diverge from best practice (6); less bloat (4); speed, especially CLI (4); project-specific guidelines such as prefer table tests or mockgen (4); tighter coverage integration incl. target only new/changed lines and show covered lines (3); ability to interject mid-generation (1).
- Threats acknowledged: coverage targets may bias acceptance; many changes landed during the study so effects are not separable; anonymizer may have caused syntax breakage; coverage is not effectiveness; results tied to Uber's Bazel monorepo; CLI/Headless users may have targeted unusually hard legacy code.
- Talk-level lessons (Interrupt 2025): domain-expert agents over generic ones; deterministic + LLM hybrid; encapsulated reusable agents let non-AI teams contribute; process work for agents also helps humans.

---

## Part 3. What to borrow, by system

| Need | Borrow from | Concretely |
|---|---|---|
| Acceptance gate | TestGen-LLM, Cover-Agent | builds -> passes N times (Meta: 5) -> coverage strictly increases; per test case, not per file |
| Targeting | CoverUp | AST segments of uncovered code, 50-line cap, prompt lists exact missing lines/branches |
| Repair loop | CoverUp, YATE, ChatUniTest | continue the chat with the error; rule-based fixes (imports) before an LLM call; freeze chronic failures |
| Isolation | CoverUp, AutoCover | run each candidate alone; detect state pollution; pinned toolchain, seeded randomness, hermetic IO rules |
| Quality beyond coverage | AutoCover Validator, ACH, MUTGEN | bounded mutation testing on accepted tests; reject change-detector tests; best-practice rule registry with example patches |
| Throughput | AutoCover | fan out per function; clone the test target per candidate; pipeline generate/build/validate with bounded queues |
| Cost | AutoCover | stable/semi-stable/volatile prompt blocks for caching; warm-up call before fan-out; content-hash dedup of candidates |
| Surfaces | AutoCover | start with CLI, add Headless PRs routed to owners, IDE last with debounce and comment-pane insert/dismiss |
| JS/TS specifics | TestPilot | API explorer for exports, doc-snippet mining, Mocha/Jest/Vitest runner with error feedback |
| Ruby specifics | (gap) | SimpleCov -> lcov (`simplecov-lcov`) into a Cover-Agent-style loop; no published prior art |
