/**
 * Governance controls integration test.
 * Spawns the MCP server with different flag combinations and sends a write
 * tool call (update_dashboard), then asserts the expected behaviour.
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const FAKE_ENV = {
  GRAFANA_URL: 'http://localhost:19999', // nothing listening — we never want real calls
  GRAFANA_SERVICE_ACCOUNT_TOKEN: 'test-token',
};

// Minimal MCP JSON-RPC helpers
const initMsg = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
}) + '\n';

const callMsg = (id, tool, args) => JSON.stringify({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: tool, arguments: args }
}) + '\n';

function runServer(extraArgs, onData) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, ...extraArgs], { env: { ...process.env, ...FAKE_ENV } });

    let buf = '';
    const results = [];

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch {}
      }
    });

    proc.stderr.on('data', () => {}); // suppress server logs

    proc.on('error', reject);

    // Send init then write call, then close
    setTimeout(() => {
      proc.stdin.write(initMsg);
      setTimeout(() => {
        proc.stdin.write(callMsg(2, 'update_dashboard', {
          uid: 'test-uid',
          operations: [{ op: 'replace', path: '$.title', value: 'New Title' }],
        }));
        setTimeout(() => {
          proc.stdin.end();
          resolve(results);
        }, 300);
      }, 300);
    }, 200);
  });
}

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

function findToolResult(results) {
  return results.find(r => r.id === 2 && r.result);
}

function resultText(results) {
  const r = findToolResult(results);
  if (!r) throw new Error('No tool result received');
  return r.result.content?.[0]?.text ?? '';
}

console.log('\nGovernance controls test\n');

// ── 1. Read-only mode ──────────────────────────────────────────────────────
console.log('1. --read-only');
await test('blocks write tool call', async () => {
  const results = await runServer(['--read-only']);
  const text = resultText(results);
  if (!text.includes('read-only')) throw new Error(`Expected read-only message, got: ${text}`);
  if (!results.find(r => r.id === 2)?.result?.isError) throw new Error('Expected isError=true');
});

// ── 2. Dry-run mode ────────────────────────────────────────────────────────
console.log('2. --dry-run');
await test('returns preview without executing', async () => {
  const results = await runServer(['--dry-run']);
  const text = resultText(results);
  if (!text.includes('[DRY RUN]')) throw new Error(`Expected DRY RUN message, got: ${text}`);
  if (!text.includes('update_dashboard')) throw new Error('Expected tool name in preview');
  if (results.find(r => r.id === 2)?.result?.isError) throw new Error('DRY RUN should not be an error');
});

await test('dry-run output includes the supplied arguments', async () => {
  const results = await runServer(['--dry-run']);
  const text = resultText(results);
  if (!text.includes('test-uid')) throw new Error('Expected uid in dry-run preview');
});

// ── 3. Audit log ───────────────────────────────────────────────────────────
console.log('3. --audit-log');
const auditFile = join(tmpdir(), `mcp-audit-test-${Date.now()}.jsonl`);

await test('creates audit log file', async () => {
  await runServer(['--dry-run', '--audit-log', auditFile]);
  if (!existsSync(auditFile)) throw new Error('Audit log file was not created');
});

await test('audit entry has correct shape', async () => {
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('Audit log is empty');
  const entry = JSON.parse(lines[lines.length - 1]);
  if (!entry.timestamp) throw new Error('Missing timestamp');
  if (entry.tool !== 'update_dashboard') throw new Error(`Wrong tool: ${entry.tool}`);
  if (!entry.isWrite) throw new Error('isWrite should be true');
  if (entry.status !== 'dry_run') throw new Error(`Expected dry_run status, got: ${entry.status}`);
  if (typeof entry.durationMs !== 'number') throw new Error('Missing durationMs');
});

await test('read-only calls logged as blocked', async () => {
  const blockedLog = join(tmpdir(), `mcp-audit-blocked-${Date.now()}.jsonl`);
  await runServer(['--read-only', '--audit-log', blockedLog]);
  const lines = readFileSync(blockedLog, 'utf8').trim().split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);
  if (entry.status !== 'blocked') throw new Error(`Expected blocked, got: ${entry.status}`);
  unlinkSync(blockedLog);
});

// cleanup
if (existsSync(auditFile)) unlinkSync(auditFile);

// ── 4. Rate limiting ───────────────────────────────────────────────────────
console.log('4. --write-rate-limit');

async function runNWriteCalls(n) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, '--write-rate-limit', '2'], {
      env: { ...process.env, ...FAKE_ENV }
    });

    let buf = '';
    const results = [];

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);

    const msgs = [initMsg];
    for (let i = 1; i <= n; i++) {
      msgs.push(callMsg(i + 1, 'update_dashboard', {
        uid: 'test-uid',
        operations: [{ op: 'replace', path: '$.title', value: `Title ${i}` }],
      }));
    }

    setTimeout(() => {
      for (const msg of msgs) proc.stdin.write(msg);
      setTimeout(() => { proc.stdin.end(); resolve(results); }, 600);
    }, 200);
  });
}

await test('allows calls within the limit', async () => {
  const results = await runNWriteCalls(2);
  const toolResults = results.filter(r => r.id > 1 && r.result);
  if (toolResults.length !== 2) throw new Error(`Expected 2 results, got ${toolResults.length}`);
  // Both should be errors (network) but NOT rate-limit errors
  for (const r of toolResults) {
    const text = r.result.content?.[0]?.text ?? '';
    if (text.includes('rate limit')) throw new Error(`Unexpected rate limit on allowed calls: ${text}`);
  }
});

await test('blocks calls that exceed the limit', async () => {
  const results = await runNWriteCalls(4);
  const toolResults = results.filter(r => r.id > 1 && r.result);
  const blocked = toolResults.filter(r => {
    const text = r.result.content?.[0]?.text ?? '';
    return text.includes('rate limit');
  });
  if (blocked.length === 0) throw new Error('Expected at least one rate-limited response');
});

// ── 5. Issue #3 — params-key unwrapping ───────────────────────────────────
console.log('5. Issue #3: params-key unwrapping (Claude Code compat)');

async function runWithArgs(toolArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI, '--dry-run'], { env: { ...process.env, ...FAKE_ENV } });
    let buf = '';
    const results = [];
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch {}
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    setTimeout(() => {
      proc.stdin.write(initMsg);
      setTimeout(() => {
        proc.stdin.write(callMsg(2, 'update_dashboard', toolArgs));
        setTimeout(() => { proc.stdin.end(); resolve(results); }, 300);
      }, 300);
    }, 200);
  });
}

await test('unwraps params key sent by Claude Code', async () => {
  // Simulate what Claude Code sends: { params: { uid: '...', operations: [...] } }
  const results = await runWithArgs({
    params: {
      uid: 'test-uid',
      operations: [{ op: 'replace', path: '$.title', value: 'Title' }],
    }
  });
  const text = resultText(results);
  if (text.includes('invalid_type') || text.includes('Required')) {
    throw new Error(`Zod validation still failing with params wrap: ${text}`);
  }
  if (!text.includes('[DRY RUN]')) throw new Error(`Expected dry-run preview, got: ${text}`);
});

await test('still works with unwrapped args (normal clients)', async () => {
  const results = await runWithArgs({
    uid: 'test-uid',
    operations: [{ op: 'replace', path: '$.title', value: 'Title' }],
  });
  const text = resultText(results);
  if (!text.includes('[DRY RUN]')) throw new Error(`Normal args broken: ${text}`);
});

console.log('\nDone.\n');
