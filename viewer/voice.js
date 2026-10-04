// voice.js
// Exports: voice, speak, speakFlow, stepSpeech, pauseSpeech, resumeSpeech, cancelSpeech, renderVoiceButton, initVoice
// Imports: hud: I | util: $, clamp, esc
// Flow narration with the browser's Web Speech API (speechSynthesis): speaking primitives plus the Voice settings section.
import { I } from './hud.js';
import { $, clamp, esc } from './util.js';

const synth = window.speechSynthesis;
// ok: the browser can speak. on: narration toggle on the flow bar (starts from cfg.on). cfg: saved settings.
export const voice = { ok: !!(synth && window.SpeechSynthesisUtterance), on: false, cfg: { on: true, uri: '', rate: 1, detail: false } };
let current = null, ended = null;   // the utterance whose end we report, and its callback

// Speak text at the settings rate times `speed`. Calls onEnd once when it finishes, fails, or another speak() replaces it.
// cancelSpeech() drops it silently. Returns false (and says nothing) when speech is unavailable
// or the user has not interacted with the page yet.
export function speak(text, speed, onEnd) {
  if (!voice.ok || navigator.userActivation?.hasBeenActive === false) return false;
  const prev = ended;
  cancelSpeech(); prev?.();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = synth.getVoices().find((v) => v.voiceURI === voice.cfg.uri) || null;
  u.rate = clamp(voice.cfg.rate * speed, 0.1, 10);
  u.onend = u.onerror = () => { if (current === u) { current = ended = null; onEnd?.(); } };
  current = u; ended = onEnd;
  if (synth.paused) synth.resume();   // a paused synth would otherwise hold the new utterance
  synth.speak(u);
  return true;
}

// Read the rest of a flow as ONE utterance: macOS pops each time speech starts, so steps must never be
// separate utterances. onReach(i) fires as the voice reaches step i: from boundary events when the
// voice sends them, else from elapsed speaking time (many system voices send none). onDone() at the end.
const CHARS_PER_SEC = 15;   // typical speech pace at rate 1
export function speakFlow(texts, from, speed, onReach, onDone) {
  if (!voice.ok || navigator.userActivation?.hasBeenActive === false) return false;
  const prev = ended;
  cancelSpeech(); prev?.();
  const starts = [];
  let text = '';
  for (const t of texts.slice(from)) { starts.push(text.length); text += t.replace(/[\s.!?]*$/, '. '); }
  const u = new SpeechSynthesisUtterance(text);
  u.voice = synth.getVoices().find((v) => v.voiceURI === voice.cfg.uri) || null;
  u.rate = clamp(voice.cfg.rate * speed, 0.1, 10);
  let reached = 0, heard = false, spoken = 0, last = performance.now();
  const advance = (pos) => {
    let k = reached;
    while (k + 1 < starts.length && starts[k + 1] <= pos) k++;
    if (k > reached) { reached = k; onReach(from + k); }
  };
  const clock = setInterval(() => {
    if (current !== u) return clearInterval(clock);
    const now = performance.now(), dt = (now - last) / 1000;   // real time: ticks run late on a busy page
    last = now;
    if (heard || synth.paused) return;
    spoken += dt;
    if (spoken > 1) advance(spoken * CHARS_PER_SEC * u.rate);   // no progress events after 1s: estimate
  }, 100);
  u.onboundary = (e) => { heard = true; advance(e.charIndex); };
  u.onend = u.onerror = () => { clearInterval(clock); if (current === u) { current = ended = null; onDone?.(); } };
  current = u; ended = null;
  if (synth.paused) synth.resume();
  synth.speak(u);
  return true;
}

export function stepSpeech(s) {
  const file = s.ref && s.ref.split('/').pop().replace(/:\d+$/, '');
  const where = voice.cfg.detail ? [s.fn, file].filter(Boolean).join(', ') : '';
  return where ? `${s.text}, in ${where}` : s.text;
}

export function pauseSpeech() { if (current) synth.pause(); }
export function resumeSpeech() { if (current && synth.paused) synth.resume(); }
// Only reset the engine when it is busy: cancel()/resume() on an idle synth restarts the audio device,
// which macOS plays as a loud click between steps.
export function cancelSpeech() {
  if (!voice.ok) return;
  current = ended = null;
  if (synth.speaking || synth.pending) synth.cancel();
}

const save = () => { try { localStorage.setItem('ariadne.voice', JSON.stringify(voice.cfg)); } catch { /* storage blocked */ } };

// High-quality voices: Apple's Premium/Enhanced and Siri voices, plus the natural/neural ones other platforms ship.
const recommended = (v) => /premium|enhanced|siri|natural|neural/i.test(v.name + ' ' + v.voiceURI);

function renderVoices() {
  const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
  const mine = (v) => v.lang.toLowerCase().startsWith(lang);
  const rank = (v) => (mine(v) ? 0 : 2) + (recommended(v) ? 0 : 1);
  const all = synth.getVoices().slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const opt = (v) => `<option value="${esc(v.voiceURI)}"${v.voiceURI === voice.cfg.uri ? ' selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${recommended(v) ? ' ★ Recommended' : ''}</option>`;
  const group = (label, list) => list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '';
  let langName = lang;
  try { langName = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(lang) || lang; } catch { /* keep code */ }
  $('#vpick').innerHTML = `<option value="">System default</option>` + group(langName, all.filter(mine)) + group('Other languages', all.filter((v) => !mine(v)));
}

function renderRate() { $('#vrateval').textContent = `${voice.cfg.rate.toFixed(2).replace(/0$/, '')}×`; }

// Flow bar speaker button: hidden without speech, icon follows voice.on.
export function renderVoiceButton() {
  const b = $('#fbvoice');
  b.hidden = !voice.ok;
  b.innerHTML = voice.on ? I.speaker : I.speakerOff;
  b.classList.toggle('on', voice.on);
  b.title = voice.on ? 'Narration on' : 'Narration off';
}

export function initVoice() {
  try { Object.assign(voice.cfg, JSON.parse(localStorage.getItem('ariadne.voice') || '{}')); } catch { /* storage blocked */ }
  voice.on = voice.ok && voice.cfg.on;
  renderVoiceButton();
  if (!voice.ok) return;
  $('#gear').hidden = false; $('#voiceset').hidden = false;
  $('#vdefault').checked = voice.cfg.on;
  $('#vdetail').checked = voice.cfg.detail;
  $('#vrate').value = voice.cfg.rate; renderRate();
  renderVoices();
  synth.addEventListener('voiceschanged', renderVoices);
  $('#vdefault').onchange = (e) => { voice.cfg.on = e.target.checked; save(); };
  $('#vdetail').onchange = (e) => { voice.cfg.detail = e.target.checked; save(); };
  $('#vpick').onchange = (e) => { voice.cfg.uri = e.target.value; save(); };
  $('#vrate').oninput = (e) => { voice.cfg.rate = +e.target.value; renderRate(); save(); };
  $('#vpreview').onclick = () => speak(stepSpeech({ text: 'The order request arrives', fn: 'Create', ref: 'routes.go:31' }), 1);
}
