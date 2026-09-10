import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_INSTRUCTIONS } from './prompt.js';
import {
  handleRequestFix,
  handleCheckFix,
  handleListFixes,
  handleAddNote,
  handleResumeFix,
  handlePauseFix,
  handleArchiveFix,
} from './tools.js';

export function createMcpServer(mcpContext) {
  const server = new McpServer(
    { name: 'code-agent', version: '2.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.tool(
    'request_fix',
    'Start authorized work asynchronously in an isolated branch/worktree. Returns a full job ID promptly; source WIP is excluded. Check status before claiming deployment.',
    {
      premise: z
        .string()
        .describe(
          'The observation or desired change, with explicit user requirements and constraints. ' +
            'Plain language is sufficient. Label uncertain diagnoses as guesses; an implementation plan is optional.',
        ),
    },
    (args) => handleRequestFix(args, mcpContext),
  );

  server.tool(
    'check_fix',
    'Read job status, report, retained worktree/recovery ref, validation, and application outcome. Use the same ID across chat turns; poll at 30–60s intervals, not in a tight loop.',
    {
      job_id: z.string().describe('The job id returned by request_fix.'),
      include_diff: z
        .boolean()
        .optional()
        .describe('Return the full diff as well as the summary. Large — ask only if you need it.'),
    },
    (args) => handleCheckFix(args, mcpContext),
  );

  server.tool(
    'resume_fix',
    'Continue a retained paused/needs_input/tests_failed job in its original Claude session and worktree, or retry awaiting_integration without repeating completed investigation. Never resume a completed/archived/legacy job.',
    {
      job_id: z
        .string()
        .describe(
          'The full ID of the retained job. For needs_input, first add the user answer with add_note.',
        ),
    },
    (args) => handleResumeFix(args, mcpContext),
  );

  server.tool(
    'add_note',
    'Record a correction or user answer. Before integration, a newer note invalidates old completion acknowledgement. After integration begins it is record-only; read the receipt. Notes do not restart paused jobs.',
    {
      job_id: z.string().describe('The job to add to.'),
      note: z
        .string()
        .describe(
          'The correction, constraint, or user answer to convey. Use pause_fix if the user wants work stopped.',
        ),
    },
    (args) => handleAddNote(args, mcpContext),
  );

  server.tool(
    'list_fixes',
    'Find full job IDs and retained jobs after a lost/truncated ID or a chat restart. Prefer resuming the existing job to filing a duplicate.',
    {
      limit: z.number().optional().describe('How many recent jobs to list. Defaults to 10.'),
    },
    (args) => handleListFixes(args, mcpContext),
  );

  server.tool(
    'pause_fix',
    'Request a pause without discarding work. The model subprocess stops; a preparation/test/build command may finish before the pause is confirmed. Integration already in flight cannot be interrupted safely.',
    { job_id: z.string().describe('Full job ID to pause.') },
    (args) => handlePauseFix(args, mcpContext),
  );
  server.tool(
    'archive_fix',
    'Close a retained job only when the user wants it closed. Preserve source edits in a recovery ref, then remove the owned worktree when safe. Unknown ignored files cause cleanup to be deferred. This does not revert deployed work.',
    { job_id: z.string().describe('Full job ID the user wants to close.') },
    (args) => handleArchiveFix(args, mcpContext),
  );

  return server;
}
