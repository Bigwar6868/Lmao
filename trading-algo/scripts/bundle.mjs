/**
 * Bundle all entry points into single CJS files with esbuild.
 * These can then be compiled into standalone binaries by pkg.
 *
 * Strategy:
 * - ccxt is BUNDLED by esbuild (it handles conditional exports correctly)
 * - pino/thread-stream are EXTERNAL (they spawn Worker threads that need
 *   real filesystem paths, which break inside pkg's virtual filesystem)
 * - pino's node_modules are copied to dist/ and included as pkg assets
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

// Modules that must remain external (not bundled by esbuild)
// pino family: Worker thread spawning breaks inside pkg virtual filesystem
// Native addons: can't be bundled
const externals = [
  'pino',               // Worker thread spawning via thread-stream
  'pino-pretty',
  'thread-stream',      // Worker thread spawning
  'real-require',       // pino/thread-stream dependency
  'sonic-boom',         // pino dependency
  'on-exit-leak-free',  // pino dependency
  'pino-std-serializers',
  'pino-abstract-transport',
  'atomic-sleep',       // thread-stream dependency
  '@pinojs/redact',     // pino dependency
  'cpu-features',       // native addon
  'ssh2',               // native addon
  'protobufjs',         // native addon
].map(m => `--external:${m}`).join(' ');

// Bundle each script entry point
// ccxt is bundled inline by esbuild (handles ESM exports maps correctly)
const scripts = ['backtest', 'paper-trade', 'auto-trade', 'analyze', 'evolve', 'diagnose', 'scan', 'seed-data'];
for (const script of scripts) {
  run(`npx esbuild src/scripts/${script}.ts \
    --bundle --platform=node --target=node20 --format=cjs \
    --outfile=dist/${script}.cjs \
    ${externals} \
    --minify`);
}

// Create CLI dispatcher — this is the main entry point for the binary
// Sets __bundlerPathsOverrides so thread-stream can find its worker inside pkg
const version = process.env.VERSION || '1.0.0';
const cliSource = `
// Fix thread-stream worker resolution inside pkg binary
const path = require('path');
const tsWorker = path.join(__dirname, 'node_modules', 'thread-stream', 'lib', 'worker.js');
const pinoWorker = path.join(__dirname, 'node_modules', 'pino', 'lib', 'worker.js');
globalThis.__bundlerPathsOverrides = {
  'thread-stream-worker': tsWorker,
  'pino-worker': pinoWorker,
};

const cmd = process.argv[2] || 'help';

const commands = {
  'backtest':    () => require('./backtest.cjs'),
  'paper-trade': () => require('./paper-trade.cjs'),
  'auto-trade':  () => require('./auto-trade.cjs'),
  'analyze':     () => require('./analyze.cjs'),
  'evolve':      () => require('./evolve.cjs'),
  'diagnose':    () => require('./diagnose.cjs'),
  'scan':        () => require('./scan.cjs'),
  'seed-data':   () => require('./seed-data.cjs'),
  'help':        () => {
    console.log([
      '',
      '  Trading Algorithm System v${version}',
      '',
      '  Usage: trading-algo <command> [options]',
      '',
      '  Commands:',
      '    auto-trade    Run 24/7 autonomous trading (all agents)',
      '    paper-trade   Run a paper trading cycle',
      '    backtest      Backtest all strategies',
      '    analyze       Market analysis',
      '    evolve        Evolve strategy parameters (genetic algorithm)',
      '    diagnose      System diagnostics',
      '    scan          Scan for opportunities',
      '    seed-data     Seed cache with market data',
      '    help          Show this help',
      '',
      '  Examples:',
      '    trading-algo auto-trade           # 24/7 mode',
      '    trading-algo paper-trade 1h 60    # paper trade, 1h candles, 60min cycles',
      '    trading-algo backtest 1h crypto   # backtest crypto only',
      '    trading-algo scan',
      '',
    ].join('\\n'));
  }
};

const handler = commands[cmd];
if (handler) {
  handler();
} else {
  console.error('  Unknown command: ' + cmd + '\\n');
  commands.help();
  process.exit(1);
}
`;

writeFileSync(join(DIST, 'cli.cjs'), cliSource);

// Bundle the main orchestrator too (for direct import)
run(`npx esbuild src/index.ts \
  --bundle --platform=node --target=node20 --format=cjs \
  --outfile=dist/index.cjs \
  ${externals} \
  --minify`);

// ── Copy external node_modules into dist/ ────────────────────
// pkg includes these as assets (readable via fs + require) in the virtual filesystem
console.log('\n=== Copying external node_modules into dist/ ===\n');

const modulesToCopy = [
  'pino',
  'thread-stream',
  'real-require',
  'sonic-boom',
  'on-exit-leak-free',
  'pino-std-serializers',
  'pino-abstract-transport',
  'atomic-sleep',
  'safe-stable-stringify',
  'process-warning',
  'quick-format-unescaped',
  '@pinojs/redact',
];

const distNodeModules = join(DIST, 'node_modules');
mkdirSync(distNodeModules, { recursive: true });

for (const mod of modulesToCopy) {
  const src = join(ROOT, 'node_modules', mod);
  const dest = join(distNodeModules, mod);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    console.log(`  ✓ ${mod}`);
  } else {
    console.warn(`  ⚠ ${mod} not found in node_modules (may be optional)`);
  }
}

console.log('\n✅ Bundle complete → dist/');
