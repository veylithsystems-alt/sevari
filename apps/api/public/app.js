// Sevari owner inbox (Phase 6). Plain JavaScript, no dependencies, no third-party requests.
// Every tap is acknowledged on screen with the server's own acknowledgement text (§74.1).
const $ = (s) => document.querySelector(s);
const KEY = 'sevari.token';
const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem(KEY, v); } catch { /* private mode: keep in memory */ } memory = v; },
};
let memory = null;
const token = () => store.get() ?? memory;
const say = (text) => { $('#status').textContent = text; };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
  if (res.status === 401) { show('signin'); throw new Error('Please sign in again.'); }
  return res;
}

function show(which) {
  $('#signin').hidden = which !== 'signin';
  $('#inbox').hidden = which !== 'inbox';
  $('#refresh').hidden = which !== 'inbox';
}

async function answer(q, response, detail) {
  say('Sending your answer…');
  const res = await api(`/v1/owner/questions/${q.id}/answer`, { method: 'POST', body: JSON.stringify({ response, digest: q.digest, ...(detail ? { detail } : {}) }) });
  const body = await res.json().catch(() => ({}));
  say(body.ack ?? 'Something went wrong. Nothing was changed.');
  await load();
}

function renderQuestion(q) {
  const node = $('#question-tpl').content.firstElementChild.cloneNode(true);
  const b = q.body ?? {};
  node.querySelector('.q-title').textContent = b.title ?? 'Decision needed';
  node.querySelector('.q-summary').textContent = b.summary ?? '';
  const preview = node.querySelector('.q-preview');
  if (b.preview) preview.textContent = b.preview; else preview.remove();
  const facts = node.querySelector('.q-facts');
  if (b.facts?.length) for (const f of b.facts) { const li = document.createElement('li'); li.textContent = f; facts.querySelector('ul').append(li); } else facts.remove();
  node.querySelector('.q-default').textContent = `If nobody answers: ${b.safeDefaultText ?? 'nothing is sent.'}`;
  const actions = node.querySelector('.q-actions');
  const edit = node.querySelector('.q-edit');
  for (const opt of q.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.optionLabels?.[opt] ?? opt;
    if (opt !== q.options[0]) btn.className = 'ghost';
    const needsText = opt === 'edit' || opt === 'reply';
    btn.addEventListener('click', () => {
      if (needsText) {
        edit.hidden = false;
        const ta = edit.querySelector('textarea');
        ta.value = opt === 'edit' ? (b.preview ?? '') : '';
        ta.focus();
        edit.onsubmit = (e) => { e.preventDefault(); answer(q, opt, ta.value); };
      } else {
        answer(q, opt);
      }
    });
    actions.append(btn);
  }
  edit.querySelector('.cancel').addEventListener('click', () => { edit.hidden = true; });
  return node;
}

async function load() {
  const res = await api('/v1/owner/inbox');
  if (res.status === 403) { say('This sign-in can’t act for a business.'); return; }
  const data = await res.json();
  show('inbox');
  const qs = $('#questions');
  qs.replaceChildren(...data.questions.map(renderQuestion));
  $('#empty').hidden = data.questions.length > 0;
  const labels = { question: 'Needs you', ack: 'Received', outcome: 'Done', failure: 'Not done', escalation: 'Passed on', alert: 'Check', warning: 'Warning', info: 'Info' };
  $('#notes').replaceChildren(...data.notifications.slice(0, 30).map((n) => {
    const li = document.createElement('li');
    li.className = n.kind;
    const k = document.createElement('div'); k.className = 'kind'; k.textContent = `${labels[n.kind] ?? n.kind} · ${new Date(n.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
    const t = document.createElement('div'); t.textContent = n.text;
    li.append(k, t);
    return li;
  }));
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  store.set($('#token').value.trim());
  try { await load(); say('Signed in.'); } catch (err) { say(err.message); }
});
$('#refresh').addEventListener('click', () => load().catch((e) => say(e.message)));
if (token()) load().catch(() => show('signin')); else show('signin');
setInterval(() => { if (!$('#inbox').hidden) load().catch(() => {}); }, 30_000);
