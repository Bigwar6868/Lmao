/**
 * whats-new.ts — Show changelog after pulling a new version.
 * Usage: npm run whats-new
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../../');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const PKG_PATH = join(ROOT, 'trading-algo/package.json');

function currentVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return pkg.version as string;
}

function lastGitTag(): string | null {
  try {
    return execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
      .replace(/^v/, '');
  } catch {
    return null;
  }
}

function recentGitLog(lines = 20): string {
  try {
    return execSync(
      `git log --oneline --no-merges -${lines}`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
  } catch {
    return '(git log unavailable)';
  }
}

function extractVersionBlock(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex(l => l.startsWith(`## [${version}]`));
  if (start === -1) return null;

  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  const block = end === -1 ? lines.slice(start) : lines.slice(start, end);
  return block.join('\n').trim();
}

function printBanner(version: string) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  Trading Algorithm System — v${version}`);
  console.log('═'.repeat(60));
}

function printSection(title: string, content: string) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
  console.log(content);
}

// ── Main ────────────────────────────────────────────────────────────────────

const version = currentVersion();
printBanner(version);

if (existsSync(CHANGELOG_PATH)) {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const block = extractVersionBlock(changelog, version);

  if (block) {
    printSection(`What's new in v${version}`, block);
  } else {
    console.log(`\nNo changelog entry found for v${version}.`);
  }
} else {
  console.log('\nNo CHANGELOG.md found — showing recent git commits:\n');
  console.log(recentGitLog());
}

const tag = lastGitTag();
if (tag && tag !== version) {
  printSection('Recent commits (since last tag)', recentGitLog(15));
}

console.log('\n' + '═'.repeat(60) + '\n');
