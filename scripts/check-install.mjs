// Pack this package, install the tarball into an empty project, and import it
// by name. That round trip is the only thing that answers the question users
// actually care about: does `npm install <this>` produce something loadable.
//
// It is deliberately not `npm pack --dry-run`. That exits 0 when a `files`
// entry resolves to nothing (measured on npm 11: a bogus entry produced an
// identical tarball, identical exit 0, no warning), and it never loads
// anything, so it cannot see a dependency that was declared in a way npm does
// not install.
//
// That second failure is the one this script was written for. The harness
// packages were declared as peers marked `optional: true` while `lib/index.js`
// imports one of them at the top level -- so npm installed none of them, and a
// clean `npm install` of this package threw ERR_MODULE_NOT_FOUND on first
// import. Every unit test passed throughout, because tests resolve the harness
// from devDependencies in the repo's own node_modules, which a consumer does
// not have.
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const staging = mkdtempSync(join(tmpdir(), 'pack-'))
const consumer = mkdtempSync(join(tmpdir(), 'consumer-'))
let failed = false

try {
  const meta = JSON.parse(
    execFileSync('npm', ['pack', '--pack-destination', staging, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )[0]
  console.log(`packed ${meta.filename}: ${meta.files.length} files, ${(meta.size / 1024).toFixed(1)} kB`)

  // Every `exports` subpath and `bin` target must be in the tarball. npm packs
  // package.json, the README, the licence, and `main` no matter what `files`
  // says, so only these need the allowlist to be right.
  const shipped = new Set(meta.files.map((f) => f.path))
  const targets = []
  const walk = (v) => {
    if (typeof v === 'string') targets.push(v.replace(/^\.\//, ''))
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(pkg.exports)
  walk(pkg.bin)
  const missing = targets.filter((t) => !shipped.has(t))
  if (missing.length) {
    console.error(`these exports/bin targets are not in the tarball: ${missing.join(', ')}`)
    failed = true
  } else {
    console.log(`all ${targets.length} exports/bin targets ship`)
  }

  execSync('npm init -y', { cwd: consumer, stdio: 'ignore' })
  execSync('npm pkg set type=module', { cwd: consumer, stdio: 'ignore' })
  execSync(`npm install --no-audit --no-fund "${join(staging, meta.filename)}"`, {
    cwd: consumer,
    stdio: 'ignore',
  })

  // Import through the package name, not a file path, so `exports` resolution
  // and peer installation are both under test.
  writeFileSync(
    join(consumer, 'check.mjs'),
    `const m = await import(${JSON.stringify(pkg.name)})\n` +
      `const keys = Object.keys(m)\n` +
      `if (!keys.includes('apply')) throw new Error('no apply() export; a profile would load nothing. got: ' + keys.join(', '))\n` +
      `console.log('imported from a clean consumer -> ' + keys.join(', '))\n`,
  )
  try {
    process.stdout.write(execSync('node check.mjs', { cwd: consumer, encoding: 'utf8' }))
  } catch (err) {
    console.error(`import from a clean consumer failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
    failed = true
  }

  for (const name of Object.keys(pkg.bin ?? {})) {
    try {
      execSync(`./node_modules/.bin/${name} --help`, { cwd: consumer, stdio: 'ignore' })
      console.log(`bin ${name}: executable and runs`)
    } catch {
      console.error(`bin ${name}: installed but did not run`)
      failed = true
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
  rmSync(consumer, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
