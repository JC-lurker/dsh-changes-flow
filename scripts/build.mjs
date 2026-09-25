import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'

execSync('bun build src/index.ts --target=node --outfile=lib/index.js', { stdio: 'inherit' })
execSync('bun build src/client/index.tsx --target=browser --format=cjs --production --external react --external react-dom --external react/jsx-runtime --outfile=lib/client.raw.js', { stdio: 'inherit' })

const raw = readFileSync('lib/client.raw.js', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-changes-flow",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${raw}
    return module.exports;
  }
});
`
writeFileSync('lib/client.js', wrapped, 'utf8')
try { unlinkSync('lib/client.raw.js') } catch {}
console.log('Build complete: lib/index.js & lib/client.js')
