// Sevari owner app. Plain JavaScript, no dependencies, nothing loaded from anywhere else.
// Every tap is acknowledged on screen with the server's own words (§74.1).
const $ = (s) => document.querySelector(s);
const KEY = 'sevari.session';
let memory = null;
const store = {
  get: () => { try { return localStorage.getItem(KEY) ?? memory; } catch { return memory; } },
  set: (v) => { memory = v; try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode: memory only */ } },
};
const say = (text) => { $('#status').textContent = text; };
let me = null;

async function api(path, opts = {}) {
  const token = store.get();
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && token) { store.set(null); show('welcome'); throw new Error('Please sign in again.'); }
  return res;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const bodyOf = async (res) => res.json().catch(() => ({}));

function show(which) {
  for (const id of ['welcome', 'inbox', 'setup']) $(`#${id}`).hidden = id !== which;
  $('#nav').hidden = which === 'welcome';
  $('#main').focus();
}

// ---------- Signed out: sign in, sign up, and the links from emails ----------
$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await post('/v1/signin', { email: $('#signin-email').value });
  say((await bodyOf(res)).message ?? (await bodyOf(res)).error ?? 'Something went wrong. Please try again.');
});

let termsVersion = null;
async function loadSignup() {
  const t = await bodyOf(await fetch('/v1/signup/terms'));
  $('#signup-form').hidden = !t.open;
  $('#signup-closed').hidden = Boolean(t.open);
  if (t.open) {
    termsVersion = t.terms_version;
    $('#su-terms-link').href = t.terms_url;
    $('#su-privacy-link').href = t.privacy_url;
  }
}
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#su-terms').checked) { say('Please read and agree to the terms first.'); return; }
  const res = await post('/v1/signup', { name: $('#su-name').value, business: $('#su-business').value, email: $('#su-email').value, terms_version: termsVersion });
  const b = await bodyOf(res);
  say(b.message ?? b.error ?? 'Something went wrong. Please try again.');
});

async function fromEmailLink() {
  const m = /^#(signup|signin)=([A-Za-z0-9_.-]+)$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname); // the link is single-use; keep it out of history
  say(m[1] === 'signup' ? 'Confirming your email…' : 'Signing you in…');
  const res = await post(m[1] === 'signup' ? '/v1/signup/verify' : '/v1/signin/verify', { token: m[2] });
  const b = await bodyOf(res);
  if (!res.ok) { say(b.error ?? 'That link didn\'t work. Please ask for a new one.'); return false; }
  store.set(b.session);
  say(m[1] === 'signup' ? 'Email confirmed. Let\'s set up your business.' : 'Signed in.');
  return true;
}

$('#signout').addEventListener('click', async () => {
  await post('/v1/owner/signout').catch(() => {});
  store.set(null);
  me = null;
  $('#business').textContent = '';
  show('welcome');
  say('Signed out.');
});
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => go(b.dataset.go).catch((e) => say(e.message)));

// ---------- Inbox ----------
async function answer(q, response, detail) {
  say('Sending your answer…');
  const res = await post(`/v1/owner/questions/${q.id}/answer`, { response, digest: q.digest, ...(detail ? { detail } : {}) });
  const body = await bodyOf(res);
  say(body.ack ?? 'Something went wrong. Nothing was changed.');
  await loadInbox();
  if (me?.status !== 'active') await refreshMe();
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

async function loadBrief() {
  const b = await bodyOf(await api('/v1/owner/brief'));
  $('#brief').hidden = !b.kind;
  if (!b.kind) return;
  const at = new Date(b.period_end).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  $('#brief-title').textContent = `${b.kind === 'morning' ? 'Morning brief' : 'Evening summary'} · ${at}`;
  const order = ['waiting', 'check', 'activity', 'outcomes'];
  $('#brief-lines').replaceChildren(...[...b.lines].sort((x, y) => order.indexOf(x.section) - order.indexOf(y.section)).map((l) => {
    const li = document.createElement('li');
    li.className = `brief-${l.section}`;
    li.textContent = l.text;
    return li;
  }));
}

async function loadInbox() {
  loadBrief().catch(() => {});
  const res = await api('/v1/owner/inbox');
  if (res.status === 403) { say('This sign-in can’t act for a business.'); return; }
  const data = await res.json();
  $('#questions').replaceChildren(...data.questions.map(renderQuestion));
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

// ---------- Set-up ----------
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
function buildHours() {
  $('#hours').replaceChildren(...DAYS.map(([d, name], i) => {
    const row = document.createElement('div');
    row.className = 'row day';
    row.dataset.day = d;
    const weekend = i >= 5;
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    row.append(
      el('span', { className: 'dayname', textContent: name }),
      el('label', { className: 'inline' }, el('input', { type: 'checkbox', className: 'open', checked: !weekend }), ' Open'),
      el('label', { className: 'inline' }, 'from ', el('input', { type: 'time', className: 'start', value: '08:00' })),
      el('label', { className: 'inline' }, 'to ', el('input', { type: 'time', className: 'end', value: '17:00' })),
    );
    return row;
  }));
}
function addService() {
  const node = $('#service-tpl').content.firstElementChild.cloneNode(true);
  const basis = node.querySelector('.s-basis');
  const sync = () => {
    node.querySelector('.prices').hidden = basis.value === 'on_inspection';
    node.querySelector('.s-max-wrap').hidden = basis.value !== 'range';
  };
  basis.addEventListener('change', sync);
  sync();
  node.querySelector('.s-remove').addEventListener('click', () => { if ($('#services').children.length > 1) node.remove(); });
  $('#services').append(node);
}
$('#add-service').addEventListener('click', addService);

/** Owners type "mysite.co.uk"; the server needs a full secure address. */
const site = (v) => { const t = v.trim(); return !t ? '' : /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https:/${'/'}${t}`; };
function answers() {
  const opt = (v) => (v.trim() ? v.trim() : undefined);
  const pounds = (v) => Number.parseFloat(v);
  const services = [...document.querySelectorAll('#services .service')].map((s) => {
    const basis = s.querySelector('.s-basis').value;
    const price = basis === 'on_inspection' ? { basis }
      : basis === 'range' ? { basis, pounds: pounds(s.querySelector('.s-pounds').value), max_pounds: pounds(s.querySelector('.s-max').value) }
      : { basis, pounds: pounds(s.querySelector('.s-pounds').value) };
    return {
      name: s.querySelector('.s-name').value.trim(), price, emergency: s.querySelector('.s-emergency').checked,
      everyday_names: s.querySelector('.s-words').value.split(',').map((w) => w.trim()).filter((w) => w.length >= 2),
    };
  });
  const weekly = {};
  for (const row of document.querySelectorAll('#hours .day')) {
    weekly[row.dataset.day] = row.querySelector('.open').checked ? [{ start: row.querySelector('.start').value, end: row.querySelector('.end').value }] : [];
  }
  const codes = $('#a-codes').value.toUpperCase().split(/[\s,]+/).filter(Boolean);
  const cancel = $('#p-cancel').value.trim();
  return {
    business: {
      trading_name: $('#b-name').value.trim(), description: $('#b-desc').value.trim(), reply_time_statement: $('#b-reply').value,
      privacy_notice_url: site($('#b-privacy').value), vat: $('#b-vat').value,
      phone: opt($('#b-phone').value), email: opt($('#b-email').value), website: opt(site($('#b-web').value)),
    },
    services,
    hours: { weekly, timezone: 'Europe/London', emergency_always: false },
    area: { outward_codes: codes.filter((c) => /\d/.test(c)), postcode_areas: codes.filter((c) => !/\d/.test(c)), description: $('#a-desc').value.trim() },
    policies: cancel ? [{ topic: 'cancellation', text: cancel }] : [],
  };
}

function step(n) {
  $('#setup-form').hidden = n !== 1;
  $('#review').hidden = n !== 2;
  $('#connect').hidden = n !== 3 && n !== 4;
  $('#golive').hidden = n !== 4;
  for (let i = 1; i <= 4; i++) $(`#step-${i}-label`).classList.toggle('current', i === n);
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!e.target.reportValidity()) return;
  say('Reading your answers…');
  const res = await post('/v1/owner/onboarding/answers', answers());
  const b = await bodyOf(res);
  if (!res.ok) { say(b.issues ? `Please check: ${b.issues.join('; ')}` : (b.error ?? 'Something went wrong.')); return; }
  $('#review-summary').textContent = `Sevari drafted ${b.records_to_confirm} records from your answers and tried ${b.practice_enquiries.total} practice enquiries: ${b.practice_enquiries.passed ? 'all handled correctly' : 'some need a look (see below)'}.`;
  $('#regulated').replaceChildren(...b.regulated.map((r) => { const li = document.createElement('li'); li.textContent = `Regulated work spotted: ${r.activity.replace(/_/g, ' ')} (${r.why}). Veylith will also need to approve going live.`; return li; }));
  await loadRecords();
  step(2);
  say('Please check these. Nothing is used until you confirm.');
});
$('#edit-answers').addEventListener('click', () => step(1));

async function loadRecords() {
  const b = await bodyOf(await api('/v1/owner/onboarding/records'));
  $('#records').replaceChildren(...(b.records ?? []).map((r) => {
    const li = document.createElement('li');
    li.className = 'record';
    const h = document.createElement('strong'); h.textContent = r.heading;
    const p = document.createElement('div'); p.textContent = r.text;
    li.append(h, p);
    return li;
  }));
}
$('#confirm-records').addEventListener('click', async () => {
  const b = await bodyOf(await post('/v1/owner/onboarding/confirm'));
  say(`Confirmed ${b.confirmed ?? 0} records. Sevari will only ever quote these.`);
  step(3);
  await loadChannels();
});

let lastChannel = null;
$('#channel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await post('/v1/owner/channels', { channel: 'webform', site: site($('#c-site').value) });
  const b = await bodyOf(res);
  if (!res.ok) { say(b.error ?? 'Something went wrong.'); return; }
  lastChannel = b.id;
  $('#snippet').value = b.snippet;
  $('#snippet-box').hidden = false;
  $('#test-box').hidden = false;
  say('Your enquiry form is ready. Copy it into your website, then send a test message.');
  await loadChannels();
});
$('#email-channel').addEventListener('click', async () => {
  const res = await post('/v1/owner/channels', { channel: 'email' });
  const b = await bodyOf(res);
  if (!res.ok) { say(b.error ?? 'Something went wrong.'); return; }
  lastChannel = b.id;
  $('#email-address').hidden = false;
  $('#email-address').textContent = b.instructions;
  $('#test-box').hidden = false;
  say('Your Sevari email address is ready. Send a test message to check it.');
  await loadChannels();
});
$('#copy-snippet').addEventListener('click', async () => {
  $('#snippet').select();
  try { await window.navigator.clipboard.writeText($('#snippet').value); say('Copied.'); } catch { say('Select the text and copy it.'); }
});
$('#test-channel').addEventListener('click', async () => {
  if (!lastChannel) return;
  const b = await bodyOf(await post('/v1/owner/onboarding/channel-check', { endpoint_public_id: lastChannel }));
  $('#test-code').hidden = false;
  $('#test-code').textContent = b.instructions ?? b.error ?? '';
});

async function loadChannels() {
  const b = await bodyOf(await api('/v1/owner/channels'));
  const names = { webform: 'Website form', email: 'Email', sms: 'Text messages', api: 'Connected system' };
  $('#channel-list').replaceChildren(...(b.channels ?? []).map((c) => {
    const li = document.createElement('li');
    li.textContent = `${names[c.channel] ?? c.channel}${c.sites?.length ? ` on ${c.sites.join(', ')}` : ''}${c.address ? ` (${c.address})` : ''}: ${c.tested ? 'tested ✓' : 'not tested yet'}`;
    return li;
  }));
  if ((b.channels ?? []).some((c) => c.tested)) { step(4); await loadChecklist(); }
}

async function loadChecklist() {
  const b = await bodyOf(await api('/v1/owner/onboarding/checklist'));
  $('#checklist').replaceChildren(...(b.items ?? []).map((i) => {
    const li = document.createElement('li');
    li.className = i.ok ? 'ok' : 'todo';
    li.textContent = `${i.ok ? '✓' : '○'} ${i.text}`;
    return li;
  }));
  $('#go-live').disabled = !b.ok;
}
$('#refresh-checklist').addEventListener('click', () => loadChannels().then(loadChecklist).catch((e) => say(e.message)));
$('#go-live').addEventListener('click', async () => {
  const res = await post('/v1/owner/onboarding/go-live');
  const b = await bodyOf(res);
  if (b.status === 'asked') { say('One last check: confirm going live in your inbox.'); await go('inbox'); }
  else if (b.status === 'already_live') say('You are live.');
  else say(`Not yet: ${(b.missing ?? []).join(' ')}`);
});

// ---------- Navigation ----------
async function refreshMe() {
  const res = await api('/v1/owner/me');
  if (!res.ok) throw new Error('Please sign in again.');
  me = await res.json();
  $('#business').textContent = `· ${me.business}`;
  $('#nav-setup').hidden = me.role !== 'owner' || me.status === 'active';
}

async function go(where) {
  if (where === 'setup') {
    show('setup');
    if (!$('#services').children.length) { buildHours(); addService(); $('#b-name').value = me?.business ?? ''; }
    step(1);
    return;
  }
  show('inbox');
  await loadInbox();
}

async function start() {
  await fromEmailLink();
  if (!store.get()) { show('welcome'); await loadSignup(); return; }
  try {
    await refreshMe();
    await go(me.role === 'owner' && me.status === 'onboarding' ? 'setup' : 'inbox');
  } catch {
    show('welcome');
    await loadSignup();
  }
}
start().catch((e) => say(e.message));
setInterval(() => { if (!$('#inbox').hidden) loadInbox().catch(() => {}); }, 30_000);
