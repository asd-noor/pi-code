
## extract-instruction-add-to-subagents

Extracted AGENDA_INSTRUCTION into extensions/agenda/instruction.ts and imported it from extensions/agenda/index.ts. Updated extensions/subagents/agent-runner.ts to append AGENDA_INSTRUCTION to buildSystemPrompt() output in both append-mode and replace-mode, so subagent sessions receive agenda discipline instructions when extensions are enabled. Goal: enable subagents to create and track agendas and make their work visible in the parent session's agenda widget via the shared DB poller.
