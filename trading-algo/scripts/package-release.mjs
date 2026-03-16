/**
 * Package release binaries for all platforms using @yao-pkg/pkg.
 * Produces standalone executables (Node.js bundled in), archives, and checksums.
 *
 * Run after bundle.mjs:
 *   node scripts/bundle.mjs && node scripts/package-release.mjs
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RELEASE = join(ROOT, 'release');
const VERSION = process.env.VERSION || '1.0.0';
const NAME = 'trading-algo';

// Platform targets for @yao-pkg/pkg
const TARGETS = [
  { pkg: 'node20-linux-x64',   name: `${NAME}-${VERSION}-linux-amd64`,   archive: 'tar.gz' },
  { pkg: 'node20-linux-arm64', name: `${NAME}-${VERSION}-linux-arm64`,   archive: 'tar.gz' },
  { pkg: 'node20-macos-x64',   name: `${NAME}-${VERSION}-macos-amd64`,   archive: 'tar.gz' },
  { pkg: 'node20-macos-arm64', name: `${NAME}-${VERSION}-macos-arm64`,   archive: 'tar.gz' },
  { pkg: 'node20-win-x64',     name: `${NAME}-${VERSION}-windows-amd64`, archive: 'zip',  ext: '.exe' },
];

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// ── Clean ────────────────────────────────────────────────────
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });

// ── Compile binaries ─────────────────────────────────────────
console.log('\n=== Compiling standalone binaries ===\n');

for (const target of TARGETS) {
  const ext = target.ext || '';
  const binName = target.name + ext;
  console.log(`\n→ ${binName}`);
  try {
    run(`npx @yao-pkg/pkg dist/cli.cjs --target ${target.pkg} --output release/${binName} --compress GZip`);
  } catch {
    console.warn(`  ⚠ Skipped ${binName} (cross-compile unavailable on this runner)`);
  }
}

// ── Create archives ──────────────────────────────────────────
console.log('\n=== Creating archives ===\n');

for (const target of TARGETS) {
  const ext = target.ext || '';
  const binName = target.name + ext;
  const binPath = join(RELEASE, binName);

  if (!existsSync(binPath)) continue;

  if (target.archive === 'zip') {
    run(`cd release && zip ${target.name}.zip ${binName}`);
  } else {
    run(`cd release && tar -czf ${target.name}.tar.gz ${binName}`);
  }
  console.log(`  ✓ ${target.name}.${target.archive}`);
}

// ── Checksums ────────────────────────────────────────────────
console.log('\n=== Generating checksums ===\n');

const checksumFile = `${NAME}-${VERSION}-checksums.txt`;
const lines = [];

for (const file of readdirSync(RELEASE).sort()) {
  // Only checksum archives and raw binaries, not the checksum file itself
  if (file === checksumFile) continue;
  const hash = sha256(join(RELEASE, file));
  lines.push(`sha256:${hash}  ${file}`);
  console.log(`sha256:${hash.slice(0, 20)}...  ${file}`);
}

writeFileSync(join(RELEASE, checksumFile), lines.join('\n') + '\n');

console.log(`\n✅ Release built → ${readdirSync(RELEASE).length} assets in release/\n`);
