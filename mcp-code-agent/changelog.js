import fs from 'fs/promises';
import path from 'path';
import { REPO, git, revertCommand } from './git.js';

const FILE = 'CHANGELOG-agent.md';

const HEADER = `# Agent changelog

Every change made to this stack by a model rather than by a person, newest first.

Each entry carries the premise **verbatim, as the model wrote it** — not a tidied
summary. Kept that way on purpose: over months this file is the only readable
record of what the models on this stack keep deciding is wrong with their own
senses, and a paraphrase would launder exactly the drift it exists to show.

The \`Undo\` line on each entry is a real command. It is the point of the whole
arrangement.
`;

function fmt(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function renderEntry({ jobId, premise, sender, report, commits, diffstat, tests, deploy }) {
  const undo = revertCommand(commits);
  return [
    `## ${fmt(new Date())} — \`${jobId}\``,
    '',
    `**Premise**${sender ? ` (from a model on *${sender}*)` : ''}:`,
    '',
    premise
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n'),
    '',
    '**What the agent reported back:**',
    '',
    report.trim(),
    '',
    commits.length
      ? `**Commits:**\n\n${commits.map((c) => `- \`${c.short}\` ${c.subject}`).join('\n')}`
      : '**Commits:** none — the agent deliberately changed nothing.',
    '',
    diffstat ? `\`\`\`\n${diffstat}\n\`\`\`\n` : '',
    `**Tests:** ${tests || 'not run'}`,
    '',
    `**Deploy:** ${deploy || 'not attempted'}`,
    '',
    undo ? `**Undo:** \`${undo}\`` : '**Undo:** nothing to undo.',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Prepend the entry and commit it as its own commit.
 *
 * Prepend rather than append so the newest is at the top where it will actually
 * be read, and a separate commit so that reverting the *change* does not also
 * revert the record that the change happened.
 */
export async function writeEntry(entry, jobId) {
  const file = path.join(REPO, FILE);
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    existing = HEADER;
  }
  const body = existing.startsWith(HEADER) ? existing.slice(HEADER.length) : `\n${existing}`;
  await fs.writeFile(file, `${HEADER}\n${entry}${body}`);

  await git(['add', FILE]);
  const { err, stderr } = await git([
    'commit',
    '-m',
    `Changelog: agent job ${jobId}`,
    '-m',
    'Recorded by mcp-code-agent. Separate commit so reverting the change does\nnot also revert the record of it.',
  ]);
  return err ? `changelog commit failed: ${stderr.trim()}` : null;
}
