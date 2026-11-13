// The page loads site/*.js as classic scripts, which share one global scope: fail if two declare the same top-level
// name, since the later one silently replaces the earlier (a function) or stops the page (a const, let or class).
// Run from the repo root: node test/globals_test.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'site');
const seen = new Map();
let bad = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
  for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) { console.log(`${m[1]}: declared in site/${seen.get(m[1])} and site/${f}`); bad++; } else seen.set(m[1], f);
  }
}
console.log(`${seen.size} top-level names, ${bad} declared twice`);
process.exit(bad ? 1 : 0);
