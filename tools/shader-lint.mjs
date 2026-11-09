/* LUNAR LINT — static sanity for every /* glsl *\/ template in js/*.js.

   This exists because a plume vertex shader shipped without its closing brace for two review
   rounds. The vertex stage never compiled; three.js said so exactly once, in a console.error at
   program build, which the harness browser's page-error capture never saw — the pad blast was
   simply absent, and both prior investigations "measured" elaborate driver explanations for
   pixels a broken program could never have drawn.

   Two forms are checked, because shaders here are written both ways:

     A. a STAGE shader — anything reached from a `vertexShader:` / `fragmentShader:` property,
        whether written inline or composed by concatenating named `/* glsl *\/` constants
        (js/clouds.js builds its shell from a shared march helper, and the old regex that only
        matched an inline template after the property looked straight through it).
     B. a HELPER — any other `/* glsl *\/` template, e.g. the injected ground-shade body that is
        spliced into three's own template by onBeforeCompile. It has no main() of its own, so it
        gets the structural rules and not the stage rules.

   Checks, each mapped to a failure mode that actually shipped here:
     1. braces balance (comments stripped — brace counts in prose are not structure);
     2. void main( exists in every STAGE shader;
     3. any stage shader taking the logdepthbuf route declares #include <common> as its FIRST
        include (AGENTS.md: logdepthbuf_vertex calls isPerspectiveMatrix, which is not in the auto
        prefix);
     4. every #include <name> is one three r160 resolves (a typo here compiles into nothing — the
        chunk silently vanishes and depth/tonemap goes wrong with no error);
     5. every `.replace('#include <name>', …)` anchor is present in the three ShaderLib template it
        is meant to splice into. This is the same failure as 4 with the volume turned up: a renamed
        chunk makes onBeforeCompile a no-op that silently renders the old look.

     node tools/shader-lint.mjs        # exits 1 with a line per violation
*/
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';

const KNOWN_CHUNKS = new Set([
  'common', 'logdepthbuf_pars_vertex', 'logdepthbuf_vertex',
  'logdepthbuf_pars_fragment', 'logdepthbuf_fragment',
]);

/* Every chunk name three's own shaders actually include — the union over ShaderLib, so an
   injection anchor that no longer exists in the template it splices into is a hard error. */
const AVAILABLE = new Set();
for (const shader of Object.values(THREE.ShaderLib)) {
  for (const stage of ['vertexShader', 'fragmentShader']) {
    const src = shader[stage];
    if (typeof src !== 'string') continue;
    for (const m of src.matchAll(/#include\s*<([^>]+)>/g)) AVAILABLE.add(m[1]);
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/* Read the `/* glsl *\/` expression that starts at `i`: a `+`-chain of template literals and
   identifiers already collected in `consts`. Returns the assembled GLSL text. */
function readExpr(src, i, consts) {
  let out = '';
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const piece = () => {
    ws();
    if (src.startsWith('/* glsl */', i)) { i += 10; ws(); }
    if (src[i] === '`') { const e = src.indexOf('`', i + 1); if (e < 0) return false; out += src.slice(i + 1, e); i = e + 1; return true; }
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (m && consts.has(m[0])) { out += consts.get(m[0]); i += m[0].length; return true; }
    /* NAME(...) in the chain is a JS helper that builds a preamble (js/clouds.js's DEFINES). Its
       text is not readable statically; step over the call so the rest of the chain — where main()
       lives — still is. */
    if (m && src[i + m[0].length] === '(') {
      let j = i + m[0].length, depth = 0;
      do { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; } while (depth > 0 && j < src.length);
      i = j; return true;
    }
    return false;
  };
  if (!piece()) return null;
  for (;;) { ws(); if (src[i] !== '+') break; i++; if (!piece()) break; }
  return out;
}

const MARKER = '/* glsl */';
let bad = 0;
const fail = (at, why) => { console.log(`${at}: ${why}`); bad++; };

/* Does this template look like GLSL? Named consts are collected without requiring the marker
   (js/ribbon.js keeps bare templates), and a file like js/hud.js holds HTML templates that are not
   shaders and must not be judged by shader rules. */
const looksGlsl = (t) => /#include\s*<|void\s+main\s*\(|gl_Position|gl_FragColor/.test(t);

function checkStructural(at, body, stage) {
  const code = stripComments(body);
  const open = (code.match(/{/g) || []).length;
  const close = (code.match(/}/g) || []).length;
  if (open !== close) fail(at, `brace mismatch open=${open} close=${close}`);
  if (stage && !/void\s+main\s*\(/.test(code)) fail(at, 'no void main(');
  /* JS muscle memory in a GLSL body. `atan2` is the one that shipped here: it does not exist in
     GLSL ES (two-argument `atan` is the call), and the mistake costs the whole program — three
     materials rendered nothing and the only trace was one console.error at link time. */
  if (/\bMath\.|[^.\w]atan2\s*\(/.test(code)) fail(at, 'JS-ism in GLSL (Math.* / atan2)');
  /* GLSL ES function parameters are IN unless declared otherwise, so an array parameter written to
     inside the function is a local copy and the caller never sees it — no error, no warning, just a
     silently empty result. Use out scalars. This cost the whole weather shell its pixels. */
  for (const fn of code.matchAll(/\b(?:void|float|int|vec2|vec3|vec4|mat3|mat4)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
    if (/\w+\s+[A-Za-z_]\w*\s*\[/.test(fn[2])) fail(at, `function ${fn[1]} takes an array parameter (in by value; use out scalars)`);
  }
  /* A for-loop whose third clause is a bare name never advances. On a GPU that is not a slow frame,
     it is a hung context: the tab froze and could not even be closed. */
  if (/for\s*\([^;()]*;[^;()]*;\s*[A-Za-z_]\w*\s*\)/.test(code)) fail(at, 'for-loop without an increment');
  const includes = [...body.matchAll(/#include\s*<([^>\n]+)>/g)].map((x) => x[1]);
  for (const c of includes) {
    if (!KNOWN_CHUNKS.has(c)) fail(at, `unknown chunk <${c}>`);
  }
  /* VERTEX only, and that is the documented rule: logdepthbuf_vertex calls isPerspectiveMatrix,
     which lives in <common> and is not in ShaderMaterial's auto prefix. The fragment chunks need
     nothing of the kind — the limb shell and the sky dome ship without <common> and compile clean
     (AGENTS.md: a clean boot reports ZERO shader errors). */
  if (stage === 'vertex' && includes.some((c) => c.startsWith('logdepthbuf')) && includes[0] !== 'common') {
    fail(at, 'takes the logdepthbuf route but <common> is not the first include');
  }
}

for (const f of readdirSync('js').filter((n) => n.endsWith('.js'))) {
  const s = readFileSync('js/' + f, 'utf8');

  /* pass 1: named glsl constants, marked or bare, read as WHOLE `+`-chains (a shader built from a
     shared helper has its main() in the last piece, so a piecewise read would report a shader with
     no entry point). Two sweeps so a helper declared after its user still resolves. */
  const consts = new Map();
  for (let sweep = 0; sweep < 2; sweep++) {
    const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    let m;
    while ((m = re.exec(s))) {
      let i = m.index + m[0].length;
      const marked = s.startsWith(MARKER, i);
      if (marked) i += MARKER.length;
      const body = readExpr(s, i, consts);
      /* A marked template is GLSL by declaration even when it has no main() and no include of its
         own (js/clouds.js's march helper is exactly that); a bare one has to look like GLSL, so
         the HTML and canvas templates elsewhere in js/ stay out of the shader rules. */
      if (body && (marked || looksGlsl(body)) && !consts.has(m[1])) consts.set(m[1], body);
    }
  }
  for (const [name, body] of consts) {
    checkStructural(`${f} ${name} (helper)`, body, false);
  }

  /* pass 2: stage shaders, inline or composed. An expression we cannot read (a function call, a
     ternary) is not a violation — it is simply outside what static lint can reach. */
  for (const kind of ['vertex', 'fragment']) {
    const re = new RegExp(kind + 'Shader:\\s*', 'g');
    let m;
    while ((m = re.exec(s))) {
      let i = m.index + m[0].length;
      if (s.startsWith(MARKER, i)) i += MARKER.length;
      const body = readExpr(s, i, consts);
      if (body === null) continue;
      checkStructural(`${f} ${kind} shader (offset ${m.index})`, body, kind);
    }
  }

  /* pass 3: onBeforeCompile anchors must exist in the template they splice into */
  for (const m of s.matchAll(/\.replace\(\s*'#include\s*<([^>]+)>/g)) {
    if (!AVAILABLE.has(m[1])) fail(`${f} line ${s.slice(0, m.index).split('\n').length}`, `injection anchor <${m[1]}> is not in any three ShaderLib template`);
  }
}
if (bad) { console.log(`shader-lint: ${bad} violation(s)`); process.exit(1); }
console.log('shader-lint: ok');
