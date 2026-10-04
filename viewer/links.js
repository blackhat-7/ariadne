// links.js
// Exports: STYLE, linkKind, streamKind, streamText, entryOf
// Imports: theme: extOf
import { extOf } from './theme.js';

// How a link travels, drawn the same way everywhere: call = solid, async (events, queues) = dashed, data (stores) = dotted.
export const STYLE = { call: 0, async: 1, data: 2, entry: 3 };
const ASYNC = /\b(pub ?sub|publish|subscrib|consum|kafka|rabbit|nats|sqs|sns|queue|topic|events?\b)/i;

export function linkKind(L) {
  const k = L.toExt ? extOf(L.b) : '';
  if (k === 'db' || k === 'storage') return 'data';
  return k === 'queue' || ASYNC.test(L.how || '') ? 'async' : 'call';
}

// A domain-to-domain stream's kind: what most of its links are (ties go to call).
export function streamKind(s) {
  const n = { call: 0, async: 0, data: 0 };
  for (const L of s.hows) n[L.kind]++;
  return n.async > n.call && n.async >= n.data ? 'async' : n.data > n.call ? 'data' : 'call';
}

// A 1-4 word label for a stream, from its links: "→ Kafka", "orders events", "places orders", "5 calls · gRPC".
const PROTO = ['gRPC', 'GraphQL', 'WebSocket', 'HTTP', 'REST', 'OTLP', 'SQL'];
export function streamText(s) {
  const n = s.hows.length, text = s.hows.map((L) => L.how || '').join(' ');
  if (s.toExt) { const ids = [...new Set(s.hows.map((L) => L.b.id))]; return `→ ${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}`; }
  if (s.kind === 'async') { const t = text.match(/PubSub:\s*([\w.-]+)|([\w.-]+) topic/i); return t ? `${t[1] || t[2]} events` : 'events'; }
  if (n === 1 && text) return text.split(/\s(?:via|with|for|from|and|using|by|to|in|on|of|after)\b|[,(:;]/)[0].split(' ').slice(0, 4).join(' ');
  const proto = PROTO.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(text));
  return `${n} calls${proto ? ' · ' + proto : ''}`;
}

// Where traffic enters the system: user-facing apps and pages, or HTTP/CLI parts nothing else calls. null = not an entry.
export function entryOf(p) {
  const ex = p.exposes || [], http = ex.filter((e) => e.type === 'http');
  if (/mobile|web|frontend|ui|desktop/i.test(p.kind || '') || http.some((e) => /^GET \/(\s|\(|$)/.test(e.what || ''))) return 'users';
  if (p.links.some((L) => L.b === p)) return null;
  if (http.length) return 'HTTP';
  return ex.some((e) => e.type === 'cli') || (p.kind === 'tool' && p.links.some((L) => !L.toExt)) ? 'CLI' : null;
}
