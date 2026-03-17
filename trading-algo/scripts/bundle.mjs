/**
 * Bundle all entry points into single CJS files with esbuild.
 * These can then be compiled into standalone binaries by pkg.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

// Bundle each script entry point
const scripts = ['backtest', 'paper-trade', 'auto-trade', 'analyze', 'evolve', 'diagnose', 'scan', 'seed-data'];
for (const script of scripts) {
  run(`npx esbuild src/scripts/${script}.ts \
    --bundle --platform=node --target=node20 --format=cjs \
    --outfile=dist/${script}.cjs \
    --external:cpu-features --external:ssh2 --external:protobufjs \
    --minify`);
}

// Create CLI dispatcher — this is the main entry point for the binary
const version = process.env.VERSION || '1.0.0';
const cliSource = `
const path = require('path');
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
  --external:cpu-features --external:ssh2 --external:protobufjs \
  --minify`);

console.log('\\n✅ Bundle complete → dist/');
