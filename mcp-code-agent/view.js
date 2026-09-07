import { getDb } from './db.js';

/**
 * A live page at /agent, next to /cost.
 *
 * The tool results answer "what is my job doing" for a model. This answers the
 * same question for a person who is not in the conversation that filed it —
 * which is most of the time, since the deploy drops that conversation anyway.
 * Self-refreshing, no build step, no client changes: the sidecar already has the
 * data and nginx already fronts this host.
 */
const STATUS = {
  running: ['#d29922', 'working'],
  testing: ['#d29922', 'testing'],
  deploying: ['#d29922', 'deploying'],
  done: ['#3fb950', 'done & deployed'],
  no_change: ['#8b949e', 'no change (deliberate)'],
  tests_failed: ['#f85149', 'tests failed, reverted'],
  rolled_back: ['#f85149', 'deploy failed, reverted'],
  broken: ['#f85149', 'BROKEN — needs a human'],
  error: ['#f85149', 'error'],
};

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(job) {
  const [colour, label] = STATUS[job.status] ?? ['#8b949e', job.status];
  const p = job.progress;
  const live = ['running', 'testing', 'deploying'].includes(job.status);
  const age = Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000);

  return `<article>
    <header>
      <span class="dot" style="background:${colour}${live ? ';animation:pulse 1.4s infinite' : ''}"></span>
      <b style="color:${colour}">${esc(label)}</b>
      <time>${esc(new Date(job.createdAt).toISOString().slice(0, 16).replace('T', ' '))} UTC
        · ${age < 90 ? age + 's' : Math.round(age / 60) + 'm'}${job.sender ? ' · ' + esc(job.sender) : ''}</time>
    </header>
    <blockquote>${esc(job.premise)}</blockquote>
    ${job.notes?.length ? job.notes.map((n) => `<p class="note"><b>note</b> ${esc(n.from ?? '')}: ${esc(n.text)}</p>`).join('') : ''}
    ${p && live ? `<p class="meta">turn ${p.turns}${p.maxTurns ? ` of ~${p.maxTurns}` : ''}</p>` : ''}
    ${p && live ? `<div class="progress">turn ${p.turns}${p.tools ? ` · ${p.tools} tool calls` : ''}
        ${p.lastTool ? `<code>${esc(p.lastTool)}</code>` : ''}
        ${p.files?.length ? `<div class="files">${p.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
      </div>` : ''}
    ${p?.lastText && live ? `<p class="say">${esc(p.lastText)}</p>` : ''}
    ${job.summary && !live ? `<pre>${esc(job.summary.slice(0, 4000))}</pre>` : ''}
    ${job.commits?.length ? `<ul>${job.commits.map((c) => `<li><code>${esc(c.short)}</code> ${esc(c.subject)}</li>`).join('')}</ul>` : ''}
    ${job.deploy ? `<p class="deploy">deploy: ${esc(job.deploy)}</p>` : ''}
    ${job.revert ? `<p class="undo">undo: <code>${esc(job.revert)}</code></p>` : ''}
    ${job.cost != null ? `<p class="meta">${job.elapsed ?? '?'}s · $${Number(job.cost).toFixed(4)}</p>` : ''}
  </article>`;
}

export function mountView(app, health) {
  app.get('/agent', async (_req, res) => {
    let jobs = [];
    try {
      jobs = await getDb()
        .then((db) => db.collection('mcp_code_agent_jobs').find().sort({ createdAt: -1 }).limit(25).toArray());
    } catch (err) {
      return res.status(500).send(`<pre>database unreachable: ${esc(err.message)}</pre>`);
    }
    const h = await health();
    const live = jobs.some((j) => ['running', 'testing', 'deploying'].includes(j.status));

    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>code-agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${live ? 5 : 20}">
<style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#8b949e}
body{background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0;padding:1.5rem;max-width:60rem}
h1{font-size:1.1rem;margin:0 0 .2rem}
code,pre{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.85em}
.bar{color:var(--dim);font-size:.85rem;margin-bottom:1.4rem}
.bar b{color:var(--text)}
article{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:.9rem 1.1rem;margin-bottom:.9rem}
header{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap}
time{color:var(--dim);font-size:.8rem;margin-left:auto}
.dot{width:.6rem;height:.6rem;border-radius:50%;display:inline-block;flex:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
blockquote{margin:.6rem 0;padding-left:.8rem;border-left:2px solid var(--border);color:var(--text)}
.progress{margin:.5rem 0;color:var(--dim)}
.progress code{background:#0d1117;border:1px solid var(--border);border-radius:3px;padding:.05rem .35rem;color:var(--text)}
.files{margin-top:.35rem;display:flex;gap:.3rem;flex-wrap:wrap}
.say{color:var(--dim);font-style:italic;margin:.5rem 0}
.note{background:#1c2128;border-left:2px solid #d29922;padding:.4rem .7rem;margin:.5rem 0;font-size:.9rem}
.note b{color:#d29922}
pre{white-space:pre-wrap;background:#0d1117;border:1px solid var(--border);border-radius:4px;padding:.7rem;max-height:22rem;overflow:auto}
ul{margin:.5rem 0;padding-left:1.1rem}
.deploy,.undo,.meta{color:var(--dim);font-size:.85rem;margin:.35rem 0 0}
.undo code{color:var(--text)}
</style>
<h1>code-agent</h1>
<div class="bar">
  <b>${esc(h.branch)}</b> @ <code>${esc(h.head)}</code>
  · tree ${h.clean ? 'clean' : '<span style="color:#d29922">dirty</span>'}
  · claude ${h.agentAvailable ? 'ok' : '<span style="color:#f85149">unavailable</span>'}
  · ${h.activeJob ? 'job running' : 'idle'}
  · limit ${h.dailyLimit}/day
</div>
${jobs.length ? jobs.map(card).join('') : '<article>No jobs filed yet.</article>'}`);
  });
}
