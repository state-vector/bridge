# Continuous Engineering

*A manifesto for the supervisory loop.*

Agents now run the inner loop of software development: write, build, test, debug. They need less and less help. What's left for humans has a name: *supervisory engineering*, the work of directing agents, evaluating their output, and correcting it. The consensus is that this is the engineer's new job.

Supervision is the next loop to automate. Continuous engineering automates the supervision of coding agents through explicit workflows, independent verification, and human decision points. The move is the same one continuous integration made for integration: make the loop explicit, automate it, and keep humans where judgment actually lives.

Defined plainly: **continuous engineering is agents doing the work, machines running the loop (dispatching, verifying, integrating, escalating), and humans holding the trust definitions, the key steering decisions, and the goals. Machines do everything else.**

## The bottleneck moved

Agents take on multi-file changes as the norm and run for hours unattended. But studies of real teams keep finding the same thing: the time agents save gets spent auditing what they produced. DORA calls this the *verification tax*, and concludes that AI amplifies the system it lands in. The returns come from the system, not the tools. Code review was already the constraint before agents; agents just removed every other excuse. One controlled trial found experienced developers were 19% *slower* with AI while believing they were 20% faster. That matters here: self-report, human or agent, is not evidence.

The constraint is no longer producing change, but absorbing it safely.

## The practice

Continuous engineering treats supervision as an engineering problem with a small set of plain rules.

- **Trust is a property of the process, not the agent.** Work earns trust through evidence and independent verification, not how confident its author sounds. Every accepted change should have a clear record of what was checked and why it was approved.
- **Keep main ready to release.** New changes must not outrun the system's ability to check them. When a change breaks the shared codebase, restoring it takes priority over adding more work.
- **Focused context, clear roles.** Long context hides what matters and keeps old mistakes alive. Give each stage the context it needs, with clear responsibility for analysis, implementation, and verification.
- **Progress must be checkable.** Work advances when its requirements are met, not when an agent says it is done. Waiting work must have a clear reason and a path forward; unfinished work must not disappear from view.
- **Ask humans for judgment, not supervision.** When automation cannot decide, present a clear question, the relevant evidence, and meaningful options. Human decisions remain authoritative until explicitly superseded. These requests should be few and easy to answer.
- **Unattended operation is the test.** Use fixed rules for routine coordination and models where judgment is needed. Adding a model supervisor introduces another possible source of error; it does not by itself establish trust. The test is whether the system operates correctly at 3 a.m. with nobody watching.

## What humans do

Humans keep three responsibilities:

- **Trust definitions.** What counts as verified: which gates a change must pass, what evidence it must carry. Humans define the standards. The system applies them identically, every time, to every change.
- **Key steering decisions.** The calls automation cannot make: priorities, trade-offs, exceptions, go/no-go. Each one arrives as a single question with the evidence attached. The answer is recorded, and the fleet steers by it.
- **Goals.** What the work is for. Humans set direction. The loop breaks it into work, hands out each piece, and reports progress against it.

Machines do everything else. And the *everything else* grows every time a trust definition is written down, because a defined standard can be enforced by machine and a private habit cannot.

The job stops being writing every change and becomes defining what a trusted one looks like. The scarce skills are saying what "done" means, making the hard calls, and picking the right goals. The rest is loop.

## What it predicts

If the practice is right, a system run this way shows three measurable outcomes: the main branch spends less time broken, and failures are easier to trace; human interventions become judgment calls rather than status checks; and throughput rises without more reverted changes, because verification scales with the work rather than with reviewer attention.

We run such a system on our own development. Its board holds over 1,500 completed tasks, and each automated check addresses an incident we encountered. The practice wasn't specified and then followed. It was discovered by operating the loop and keeping what survived.

The middle loop is currently a burden handed to humans. It doesn't have to be. It can be engineered the way integration was: deliberately, mechanically, continuously. Not to remove human judgment; to spend it only where it is judgment.

---

*Further reading: DORA, [State of AI-assisted Software Development 2025](https://dora.dev/research/2025/dora-report/); M. Fowler, [The middle loop](https://martinfowler.com/fragments/2026-03-16.html); METR, [AI productivity RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).*
