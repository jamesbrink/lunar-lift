/* LUNAR LINT — static sanity for every /* glsl *\/ template in js/*.js.

   This exists because a plume vertex shader shipped without its closing brace for two review
   rounds. The vertex stage never compiled; three.js said so exactly once, in a console.error at
   program build, which the harness browser's page-error capture never saw — the pad blast was
   simply absent, and both prior investigations "measured" elaborate driver explanations for
   pixels a broken program could never have drawn.

   Checks, each mapped to a failure mode that actually shipped here:
     1. braces balance (comments stripped — brace counts in prose are not structure);
     2. void main( exists in every shader;
     3. any shader taking the logdepthbuf route declares #include <common> as its FIRST include
        (AGENTS.md: logdepthbuf_vertex calls isPerspectiveMatrix, which is not in the auto prefix);
     4. every #include <name> is one three r160 resolves (a typo here compiles into nothing —
        the chunk silently vanishes and depth/tonemap goes wrong with no error).

     node tools/shader-lint.mjs        # exits 1 with a line per violation
*/
import { readFileSync, readdirSync } from 'node:fs';

const KNOWN_CHUNKS = new Set([
  'common', 'logdepthbuf_pars_vertex', 'logdepthbuf_vertex',
  'logdepthbuf_pars_fragment', 'logdepthbuf_fragment',
]);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

let bad = 0;
for (const f of readdirSync('js').filter(n => n.endsWith('.js'))) {
  const s = readFileSync('js/' + f, 'utf8');
  const re = /(vertex|fragment)Shader: \/\* glsl \*\/`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(s))) {
    const kind = m[1];
    const body = m[2];
    const at = `${f} ${kind} shader (offset ${m.index})`;
    const code = stripComments(body);
    const open = (code.match(/{/g) || []).length;
    const close = (code.match(/}/g) || []).length;
    if (open !== close) { console.log(`${at}: brace mismatch open=${open} close=${close}`); bad++; }
    if (!/void\s+main\s*\(/.test(code)) { console.log(`${at}: no void main(`); bad++; }
    const includes = [...body.matchAll(/#include\s*<([^>]+)>/g)].map(x => x[1]);
    for (const c of includes) {
      if (!KNOWN_CHUNKS.has(c)) { console.log(`${at}: unknown chunk <${c}>`); bad++; }
    }
    if (includes.some(c => c.startsWith('logdepthbuf')) && includes[0] !== 'common') {
      console.log(`${at}: takes the logdepthbuf route but <common> is not the first include`); bad++;
    }
  }
}
if (bad) { console.log(`shader-lint: ${bad} violation(s)`); process.exit(1); }
console.log('shader-lint: ok');
