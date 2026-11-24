// Fast pure-JavaScript drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Assembled from four verified modules: shared text helpers, a hand-written Markdown
// renderer, a codegen-compiled template engine, and the build pipeline. No dependencies,
// no WebAssembly, no native addon, no prebuilt binary, no network, no clock/randomness.
// All caches live inside a single run() call; nothing is shared between cases.
// Fast text helpers for makefun-site: same semantics as the reference lib/text.js.
// escapeHtml batch-escapes (regex scan finds the next special char; runs between
// specials are copied whole, never per-character replace). slugify takes an ASCII
// fast path (NFKD + combining-mark drop are identity on pure ASCII) and falls back
// to the exact reference algorithm for non-ASCII input.

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  ESCAPE_RE.lastIndex = 0;
  let m = ESCAPE_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let last = 0;
  do {
    if (m.index > last) out += text.slice(last, m.index);
    out += ESCAPES[m[0]];
    last = m.index + 1;
  } while ((m = ESCAPE_RE.exec(text)) !== null);
  if (last < text.length) out += text.slice(last);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug body of `plain` (already NFKD, combining marks dropped): the reference loop. */
function slugBody(plain) {
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** ASCII fast path: NFKD is identity and there are no combining marks, so the
 *  loop runs straight over the code units. */
function slugAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = null;
    if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = text[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 */
function slugify(text) {
  if (!NON_ASCII.test(text)) return slugAscii(text);
  return slugBody(text.normalize('NFKD').replace(/\p{M}/gu, ''));
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// md.js — fast Markdown renderer for makefun-site's dialect.
//
// Semantics match baselines/makefun-site/vendor/makefun-site/lib/markdown.js
// exactly (the code is the law; the README is advisory). Blocks: ATX headings,
// fenced code, thematic breaks, blockquotes, flat lists, paragraphs. Inline:
// escapes, code spans, **strong**, *em*, [text](target) links. No raw HTML,
// no setext headings, no indented code, no tables, no reference links, no
// underscore emphasis.
//
// Speed: hand-written charCodeAt scanner, no regex in hot paths; the lexer
// classifies a line from its first characters, and inline() batch-escapes runs
// of plain text (one escapeHtml call per run, and the run is copied verbatim
// when it holds no escapable character). No dependencies, no clock, no
// randomness; output depends on the input alone.


// --- lookup tables -------------------------------------------------------

// Characters a backslash escapes (reference ESCAPABLE).
const ESC_TAB = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESC_TAB[ch.charCodeAt(0)] = 1;

/** Whether char code `c` is one a backslash escapes. */
function isEscapable(c) {
  return c < 128 && ESC_TAB[c] === 1;
}

/** Whether char code `c` is ECMAScript whitespace (the \s set). */
function isWs(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Whether `str` holds any whitespace character. */
function hasWs(str) {
  for (let i = 0; i < str.length; i++) if (isWs(str.charCodeAt(i))) return true;
  return false;
}

// --- line classifiers (each mirrors one reference regex) -----------------

/** Whether `line` is blank: /^[ \t]*$/. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null: /^```([A-Za-z0-9_+-]*)[ \t]*$/. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45
    ) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: /^```[ \t]*$/. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (a heading's text is never empty). */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  let i = depth;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) break;
    i++;
  }
  let end = line.length;
  while (end > i) {
    const d = line.charCodeAt(end - 1);
    if (d !== 32 && d !== 9) break;
    end--;
  }
  if (end === i) return null;
  return { depth, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break: /^(?:---|\*\*\*)[ \t]*$/. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` opens a bullet item: /^[-*] (.*)$/. */
function isBullet(line) {
  const c0 = line.charCodeAt(0);
  return (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
}

/** An ordered-item line's { num, text }, or null: /^(\d{1,9})\. (.*)$/. */
function orderedOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: /^ {2,}\S/. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWs(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// --- inline --------------------------------------------------------------

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  const w1 = wlen === 1 ? -1 : what.charCodeAt(1);
  for (let j = from; j <= n - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && (wlen === 1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const n = s.length;
  // Fast path: no inline opener at all — the whole string is plain text.
  if (s.indexOf('\\') === -1 && s.indexOf('`') === -1 && s.indexOf('*') === -1 && s.indexOf('[') === -1) {
    return escapeHtml(s);
  }
  let out = '';
  let i = 0;
  while (i < n) {
    // A run of plain text: no \ ` * [ opener. Track whether it holds an
    // escapable character so the run can be copied verbatim when it does not.
    let j = i;
    let needsEsc = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91) break;
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) needsEsc = true;
      j++;
    }
    if (j > i) {
      const run = s.slice(i, j);
      out += needsEsc ? escapeHtml(run) : run;
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWs(target)) {
      out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

// --- render --------------------------------------------------------------

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      let code = '<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>';
      while (i < n && !isFenceClose(lines[i])) {
        code += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      code += '</code></pre>';
      blocks.push(code);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // Blockquote: lines opening on '>', '>' and one space dropped, trimmed, empties dropped.
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') qlines.push(t);
        i++;
      }
      blocks.push(
        qlines.length === 0
          ? '<blockquote>\n</blockquote>'
          : '<blockquote>\n<p>' + inline(qlines.join('\n'), env) + '</p>\n</blockquote>',
      );
      continue;
    }
    const bullet = isBullet(line);
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push(trimLine(m.text));
            i++;
            continue;
          }
        } else if (isBullet(l)) {
          items.push(trimLine(l.slice(2)));
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1] += '\n' + trimLine(l);
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let out = open + '\n';
      for (let k = 0; k < items.length; k++) out += '<li>' + inline(items[k], env) + '</li>\n';
      out += '</' + tag + '>';
      blocks.push(out);
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.map((b) => b + '\n').join(''), toc, excerpt: excerpt ?? '' };
}

// Compiled version of makefun-site's template dialect (see the reference
// baselines/makefun-site/vendor/makefun-site/lib/template.js, which is the law
// here). Same parse errors, same tokenize standalone-line stripping, same
// lookup / textOf / truthy / for-scope / include semantics — but parseTemplate
// compiles each template ONCE into a JS function (via `new Function`), so
// renderNodes is a fast function call, not a node-tree walk.
//
// The compiled function takes (S, C, D, E, H, T): scope, ctx, include depth,
// ctx.escape, the render dispatcher (for includes, which may resolve to a
// compiled function or, for interop, a reference-style node array), and textOf.
// Only template-controlled literals are interpolated into the generated code:
// text via JSON.stringify, path segments / loop names / include names are all
// validated by the reference regexes first, so no user input ever becomes code.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTree(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---- codegen: node tree -> JS function source ----
//
// Compiled function params: (S, C, D, E, H, T) = scope, ctx, depth, escape,
// dispatcher, textOf. Generated code builds `o` and returns it. Lookups are
// inlined (scope walk + own-property walk, exactly as `lookup` above) so a
// render does no helper call for path resolution; textOf is called only for
// non-string values (strings are the common case and pass through).

function compile(nodes) {
  let uid = 0;
  const out = ['let o="";'];
  const v = () => `_v${uid++}`;

  // Emit code resolving `path` from scope variable `scopeVar` into a fresh temp; returns the temp name.
  function emitLookup(path, scopeVar) {
    const t = v();
    const s = v();
    const first = JSON.stringify(path[0]);
    out.push(`let ${t};{let ${s}=${scopeVar};while(${s}!==null&&!Object.hasOwn(${s}.vars,${first}))${s}=${s}.parent;${t}=${s}?${s}.vars[${first}]:undefined;}`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      out.push(`if(${t}!==null&&typeof ${t}==="object"&&Object.hasOwn(${t},${seg}))${t}=${t}[${seg}];else ${t}=undefined;`);
    }
    return t;
  }

  function emit(nodes, scopeVar) {
    for (const n of nodes) {
      switch (n.kind) {
        case 'text':
          out.push(`o+=${JSON.stringify(n.text)};`);
          break;
        case 'var': {
          const t = emitLookup(n.path, scopeVar);
          out.push(`o+=E(typeof ${t}==="string"?${t}:T(${t}));`);
          break;
        }
        case 'raw': {
          const t = emitLookup(n.path, scopeVar);
          out.push(`o+=(typeof ${t}==="string"?${t}:T(${t}));`);
          break;
        }
        case 'if': {
          const t = emitLookup(n.path, scopeVar);
          const cond = `(Array.isArray(${t})?${t}.length>0:${t}!==undefined&&${t}!==null&&${t}!==false&&${t}!==""&&${t}!==0)`;
          out.push(n.not ? `if(!${cond}){` : `if(${cond}){`);
          emit(n.then, scopeVar);
          out.push('}');
          if (n.else !== null) {
            out.push('else{');
            emit(n.else, scopeVar);
            out.push('}');
          }
          break;
        }
        case 'for': {
          const xs = emitLookup(n.path, scopeVar);
          const k = v();
          const x = v();
          const s = v();
          // Plain for loop, but skip holes exactly like Array.prototype.forEach does.
          out.push(`if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){if(!(${k} in ${xs}))continue;const ${x}=${xs}[${k}];const ${s}={vars:{[${JSON.stringify(n.name)}]:${x},loop:{index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length}},parent:${scopeVar}};`);
          emit(n.body, s);
          out.push('}}');
          break;
        }
        case 'include': {
          const t = v();
          // Fast path: a compiled include is called directly; anything else
          // (a reference-style node array) goes through the dispatcher.
          out.push(`const ${t}=C.templates.get(${JSON.stringify(n.name)});if(${t}!==undefined&&D<${INCLUDE_DEPTH})o+=typeof ${t}==="function"?${t}(${scopeVar},C,D+1,E,H,T):H(${t},${scopeVar},C,D+1);`);
          break;
        }
      }
    }
  }

  emit(nodes, 'S');
  out.push('return o;');
  return new Function('S', 'C', 'D', 'E', 'H', 'T', out.join(''));
}

// ---- slow tree walk, only for interop when a ctx.templates value (or the
// nodes passed to renderNodes) is a reference-style node array, not a
// compiled function. Semantics identical to the reference renderNodes. ----

function renderTree(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const vv = truthy(lookup(scope, n.path));
        const branch = vv !== n.not ? n.then : n.else;
        if (branch !== null) out += renderTree(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderTree(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += dispatch(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

/** Render `nodes` (a compiled function from parseTemplate, or a node array) in scope, via ctx, at include depth. */
function dispatch(nodes, scope, ctx, depth) {
  if (typeof nodes === 'function') return nodes(scope, ctx, depth, ctx.escape, dispatch, textOf);
  return renderTree(nodes, scope, ctx, depth);
}

/** `src` compiled once into a render function (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  return compile(parseTree(name, src));
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates (`templates`, a Map of name to
 * nodes, a template that did not parse absent), the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  return dispatch(nodes, scope, ctx, depth);
}

// makefun-site build pipeline (fast reimplementation of the reference index.js).
// build(input, deps) with deps = { renderMarkdown, parseTemplate, renderNodes, TemplateError }.
// No imports: the small text/front-matter helpers it needs are defined here (same
// semantics as the reference lib/text.js and lib/frontmatter.js, fast paths included).
// No dependencies, no network, no clock/randomness. Deterministic. The only state
// that persists within a call is the slug cache, created fresh inside build().

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------- the build

/** One site's output tree: path -> text. */
function build(input, deps) {
  const { renderMarkdown, parseTemplate, renderNodes, TemplateError } = deps;

  // Slug cache, scoped to this one build() call only; nothing persists across calls.
  const slugCache = new Map();
  const slugOf = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const s = slugify(text);
    slugCache.set(text, s);
    return s;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  //    a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  //    Checks in order: parse error, reserved tags//page/ dirs, post needs date,
  //    layout exists, draft.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) {
        report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order,
  //    ordered by count and then slug. A source's tags, each slug once, in its own order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it. Built once per source and reused for the
  // recent/index/tag lists and for the page's own layout (same values as building fresh).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) cards.set(s, cardOf(s));

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  {
    const site = { title: input.site.title, base_url: base };
    const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
    const ctx = { templates, escape: escapeHtml };
    const render = (name, vars) => {
      const nodes = templates.get(name);
      return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
    };
    for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pages = sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}

/** makefun-site 1.0.0's answer for one case's input, computed fast. */
export function run(input) {
  return build(input, { renderMarkdown, parseTemplate, renderNodes, TemplateError });
}
