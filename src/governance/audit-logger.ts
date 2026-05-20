import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  timestamp: string;
  tool: string;
  isWrite: boolean;
  dryRun: boolean;
  args: Record<string, unknown>;
  status: 'success' | 'blocked' | 'error' | 'dry_run';
  durationMs: number;
  error?: string;
}

const SENSITIVE_KEYS = new Set(['token', 'password', 'secret', 'key', 'credential', 'auth']);

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class AuditLogger {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    // Ensure the directory exists
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  log(entry: AuditEntry): void {
    const sanitized: AuditEntry = {
      ...entry,
      args: sanitize(entry.args),
    };
    const line = JSON.stringify(sanitized) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}
