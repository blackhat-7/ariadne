// chat.js
// Exports: saveCfg, loadAgents, renderCfg, filterModels, pickModel, history, probeChat, md, addMsg, initSettings, initChat
// Imports: state: state | drawer: getJSON | hud: level, openCode | main: act | scene: player | theme: LOOK | util: $, clamp, esc
import { state } from './state.js';
import { getJSON } from './drawer.js';
import { level, openCode } from './hud.js';
import { act } from './main.js';
import { player } from './scene.js';
import { LOOK } from './theme.js';
import { $, clamp, esc } from './util.js';

export let saveCfg, history;

export async function loadAgents() {
  if (!location.protocol.startsWith('http')) return;
  try { state.agentList = (await getJSON('/api/agents')).agents || []; } catch { return; }
  if (!state.agentList.length) return;
  if (!state.agentList.some((a) => a.id === state.chatCfg.agent && a.installed)) state.chatCfg.agent = state.agentList.find((a) => a.installed)?.id || state.chatCfg.agent;
  $('#gear').hidden = false; $('#chatset').hidden = false; renderCfg();
}

export function renderCfg() {
  $('#agents').innerHTML = state.agentList.map((a) => `<button data-agent="${esc(a.id)}" class="${a.id === state.chatCfg.agent ? 'on' : ''}" title="${a.installed ? `${a.models.length} models` : 'Not installed'}" ${a.installed ? '' : 'disabled'}>${esc(a.id)}</button>`).join('');
  $('#chatmeta').innerHTML = state.chatCfg.picked
    ? `<span class="dot"></span>${esc(state.chatCfg.agent)} <span>· ${esc(state.chatCfg.model || 'default')}</span>`
    : `<span class="dot"></span>choose a model`;
  filterModels();
}

export function filterModels() {
  const all = state.agentList.find((a) => a.id === state.chatCfg.agent)?.models || [];
  const words = $('#model').value.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter((m) => words.every((w) => m.toLowerCase().includes(w)));
  const cur = state.chatCfg.model;
  // Unfiltered: "Agent default" first, plus a custom model that is not in the list, so the selection is always visible.
  if (!words.length) hits.unshift(...(cur && !all.includes(cur) ? ['', cur] : ['']));
  state.modelHits = hits.slice(0, 80); state.modelIdx = -1;
  $('#models').innerHTML = state.modelHits.map((m, i) => `<div data-i="${i}" class="${state.chatCfg.picked && m === cur ? 'sel' : ''}"><span>${m ? esc(m) : 'Agent default'}</span><span class="sym i-check"></span></div>`).join('')
    + (hits.length > 80 ? `<div class="more">${hits.length - 80} more, keep typing</div>` : '')
    + (!hits.length ? `<div class="more">No match. Press <kbd>return</kbd> to use “${esc($('#model').value.trim())}”.</div>` : '');
}

export function pickModel(m) { state.chatCfg.model = m.trim(); state.chatCfg.picked = true; $('#model').value = ''; saveCfg(); }

export async function probeChat() {
  if (!location.protocol.startsWith('http')) return;
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [], view: { focus: null, flow: null } }) });
    if (![404, 405, 501].includes(r.status)) $('#chat').classList.add('avail');
  } catch { /* no chat server */ }
}

export function md(src) {
  const blocks = [];
  src = String(src || '').replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => `\u0000${blocks.push(c) - 1}\u0000`);
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => state.M.code?.[c] ? `<code class="ref" data-ref="${c}">${c}</code>` : `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  let html = '', list = null;
  for (const line of src.split('\n')) {
    const m = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)/.exec(line);
    if (m) { const t = m[1] ? 'ul' : 'ol'; if (list !== t) { if (list) html += `</${list}>`; html += `<${t}>`; list = t; } html += `<li>${inline(m[3])}</li>`; continue; }
    if (list) { html += `</${list}>`; list = null; }
    const h = /^#{1,4}\s+(.*)/.exec(line);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (/^\u0000\d+\u0000$/.test(line.trim())) html += `<pre>${esc(blocks[+line.trim().slice(1, -1)])}</pre>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (list) html += `</${list}>`;
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${esc(blocks[+i])}</pre>`);
}

export function addMsg(role, html) { const d = document.createElement('div'); d.className = 'msg ' + role; d.innerHTML = html; $('#chatlog').appendChild(d); $('#chatlog').scrollTop = 1e9; return d; }

export function initSettings() {
  /* ---------------- settings: appearance, chat agent + model ---------------- */
  state.agentList = [];
  state.chatCfg = { agent: 'claude', model: '' };
  try { Object.assign(state.chatCfg, JSON.parse(localStorage.getItem('ariadne.chat') || '{}')); } catch { /* storage blocked */ }
  saveCfg = () => { try { localStorage.setItem('ariadne.chat', JSON.stringify(state.chatCfg)); } catch { /* storage blocked */ } renderCfg(); };
  state.modelHits = [];
  state.modelIdx = -1;
  $('#gear').onclick = () => { $('#settings').hidden = !$('#settings').hidden; };
  $('#chatmeta').onclick = () => { $('#settings').hidden = false; $('#model').focus(); };
  $('#setdone').onclick = () => { $('#settings').hidden = true; };
  // Appearance: the world is built once per look, so switching saves the choice and reloads (the URL keeps it too).
  $(`#looks [data-look="${LOOK}"]`).classList.add('on');
  $('#looks').onclick = (e) => {
    const look = e.target.closest('[data-look]')?.dataset.look;
    if (!look || look === LOOK) return;
    try { localStorage.setItem('ariadne.theme', look); } catch { /* storage blocked: the URL still carries it */ }
    const u = new URL(location.href); u.searchParams.set('theme', look); location.replace(u);
  };
  $('#agents').onclick = (e) => { const b = e.target.closest('[data-agent]'); if (!b || b.disabled || b.dataset.agent === state.chatCfg.agent) return; state.chatCfg.agent = b.dataset.agent; state.chatCfg.model = ''; state.chatCfg.picked = false; saveCfg(); };
  $('#model').addEventListener('input', filterModels);
  $('#model').addEventListener('keydown', (e) => {
    e.stopPropagation();
    const items = $('#models').querySelectorAll('[data-i]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); state.modelIdx = clamp(state.modelIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
      items.forEach((d, i) => d.classList.toggle('on', i === state.modelIdx)); items[state.modelIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); pickModel(state.modelIdx >= 0 ? state.modelHits[state.modelIdx] : $('#model').value); }
    else if (e.key === 'Escape') { $('#settings').hidden = true; $('#model').blur(); }
  });
  $('#models').addEventListener('mousedown', (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pickModel(state.modelHits[+d.dataset.i]); } });
  addEventListener('pointerdown', (e) => { if (!$('#settings').hidden && !e.target.closest('#settings,#gear,#chatmeta')) $('#settings').hidden = true; });
}

export function initChat() {
  /* ---------------- chat ---------------- */
  history = [];
  $('#chatpill').onclick = () => { $('#chat').classList.add('open'); $('#chatin').focus(); };
  $('#chatmin').onclick = () => $('#chat').classList.remove('open');
  $('#chatlog').onclick = (e) => { const r = e.target.closest('[data-ref]'); if (r) openCode(r.dataset.ref); };
  $('#chatin').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatform').requestSubmit(); } e.stopPropagation(); });
  $('#chatform').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#chatin').value.trim(); if (!text) return;
    // Never spend someone's plan on a model they didn't choose.
    if (!state.chatCfg.picked) {
      addMsg('bot', 'Pick an agent and model first: every answer uses your plan. On a $20 plan, <b>claude · haiku</b> is quick and light; <b>sonnet</b> for harder questions.');
      $('#settings').hidden = false; $('#model').focus();
      return;
    }
    $('#chatin').value = '';
    history.push({ role: 'user', content: text }); addMsg('user', esc(text));
    const wait = addMsg('bot typing', '<i></i><i></i><i></i>');
    const lv = level();
    const view = { focus: state.selected?.owner?.id || state.selected?.id || lv.part?.id || lv.cluster?.id || null, flow: player.on ? player.id : null };
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, view, agent: state.chatCfg.agent, model: state.chatCfg.model }) });
      if (!r.ok) throw new Error(`chat server answered ${r.status}`);
      const data = await r.json();
      history.push({ role: 'assistant', content: data.reply || '' });
      wait.className = 'msg bot'; wait.innerHTML = md(data.reply || '(no answer)');
      const actions = Array.isArray(data.actions) ? data.actions : [];
      if (actions.length) wait.insertAdjacentHTML('beforeend', `<div class="acts">${actions.map((a) => `<span class="pill">${esc(a.type)}</span>`).join('')}</div>`);
      for (const a of actions) { act(a); await new Promise((res) => setTimeout(res, 350)); }
    } catch (err) { wait.className = 'msg bot err'; wait.innerHTML = `<b>Couldn’t get an answer</b><span>${esc(err.message)}</span>`; history.pop(); }
  };
}
