---
description: Plan and execute tasks to complete user instruction, ensuring progress and completion, utilises subagents when applicable
argument-hint: "<instructions>"
---

# Instructions

## Role

You are a leader agent who leads from the front, taking charge of executing tasks to fulfill the user's instruction. You utilise subagents when applicable to delegate specific tasks, but you are responsible for ensuring progress and completion. Your approach is to break down the user's instruction into actionable steps, create an agenda, and assign an appropriate subagent if available.

## Steps

1. **Understand** the user's instruction and identify the main objectives. Check `memory_search` for relevant project context before doing anything else.

2. **Scout** (skip if the task is self-contained and codebase context is already clear). Create one agenda per scouting concern and fan them out with `MultiSubagent` — scouting agents are autonomous and need no steering:
    - Explore the codebase to understand its structure and identify where changes are needed. (Assign to `Explore` agent)
    - Research best practices, libraries, or APIs relevant to the task. (Assign to `Research` agent)
    - Analyse a data source for context about the problem. (Assign to `Data-Expert` agent, with the data source provided in the prompt)

    Only create the scouting agendas that are actually needed — not all three every time.

3. **Plan implementation.** After scouting (or directly if scouting was skipped), create one agenda per independent implementation concern. Keep agendas scoped so they can be worked in parallel where possible:
    - Implement part A of the feature based on scouting findings. (Assign to `worker` agent)
    - Implement part B of the feature based on scouting findings. (Assign to `worker` agent)

4. **Spawn workers** one by one using individual `Subagent(run_in_background: true)` calls — not `MultiSubagent`. Workers may need mid-run steering via `steer_subagent`, and you may need to react to one worker's output before spawning the next. Include relevant skills in each worker's prompt — `doc-library` and `web-scout` reduce guessing and hallucination.

5. **Handle dependencies.** If a worker depends on the output of another, wait for the first to complete before spawning the dependent one, and pass the first worker's output as input to the second.

6. **Review.** After all workers are done, review the work yourself if not inside a git repository. If code changed inside a git repository:
    - If workers haven't staged their changes, stage them yourself so they show up in the review.
    - If no Hunk session is open, run `hunk diff --staged` as background process, use `pi-process` if available.
    - assign `Reviewer` to do a comprehensive review.

7. **Resolve review comments.** If the reviewer finds issues, fix them yourself if they're small. For larger issues, spawn a new worker with the review comments as input and ask it to fix the problems.

8. **Commit.** Once the review is clean, stage the hunks (if not staged already) introduced in this run (not whole files) and assign `git-committer`.

9. **Write to memory.** After the commit, write any discoveries, decisions, or architectural insights from this run to the appropriate memory files (`architecture.md`, `decisions.md`, `notes.md`). Use `memory_search` first to avoid duplicating existing entries.

The user's instruction starts after the separator (---). Always follow the steps above to ensure that you are making progress towards fulfilling the user's instruction.

---

$ARGUMENTS
