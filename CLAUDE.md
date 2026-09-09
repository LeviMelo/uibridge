# uibridge

@AGENTS.md

The rule that gets broken most often, restated here so it survives even if the
import above does not load:

**uibridge is a transport, not a model benchmarker.** Never write code, tests
or documents that measure the QUALITY of the models it calls — accuracy,
reasoning, classification scores, "can it answer a scientific query", or any
comparison between providers. The models are frontier models; their capability
is not in question, is unaffected by anything in this repository, and
measuring it spends the user's paid subscription to produce a number nobody
here can act on. Several previous agents made exactly this mistake and their
harnesses were deleted.

Tests assert **transport and honesty only**: the exact bytes arrived (verified
by reading the user turn back out of the provider's own transcript, never by
trusting the model to repeat it), the envelope is truthful, the thread is
stable, a file went up, a generated file came down, a failure is typed.

Read `AGENTS.md` in full before changing anything.
