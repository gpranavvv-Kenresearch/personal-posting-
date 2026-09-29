/**
 * dashboard/client.ts — reports this automation's runs to the Automation
 * Intelligence Dashboard (see docs/team-github-onboarding.md) via its REST
 * API directly (confirmed live 2026-09-29 against GET /api/schema/ — a
 * plain Django REST Framework API, not Python-specific; the doc's "4 lines
 * of Python" SDK is just a convenience wrapper around these same endpoints).
 *
 * Auth: `Authorization: Token <AUTOMATION_DASHBOARD_TOKEN>` on every request.
 *
 * Every function here is best-effort and NEVER throws — per the onboarding
 * doc's own rule ("If the dashboard is unreachable, your automation still
 * runs normally"), a dead/misconfigured dashboard must never block or fail
 * the actual automation work.
 */

const BASE_URL = process.env.AUTOMATION_DASHBOARD_URL?.replace(/\/+$/, '');
const TOKEN = process.env.AUTOMATION_DASHBOARD_TOKEN;

type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'WARNING' | 'FAILED' | 'CANCELLED';
type ExecutionQuality = 'REAL_EXECUTION' | 'REAL_ANALYSIS_ONLY' | 'NO_EXECUTION';
type MetricValue = number | string | boolean;

let warnedMissingConfig = false;

async function apiRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: object): Promise<any> {
  if (!BASE_URL || !TOKEN) {
    if (!warnedMissingConfig) {
      console.warn('   [dashboard] AUTOMATION_DASHBOARD_URL / AUTOMATION_DASHBOARD_TOKEN not set — dashboard reporting disabled (automation itself is unaffected).');
      warnedMissingConfig = true;
    }
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Token ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`   [dashboard] ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (err: any) {
    console.warn(`   [dashboard] request failed (non-fatal, automation continues): ${err.message}`);
    return null;
  }
}

/**
 * Registers (or re-registers — POST is idempotent server-side on
 * automation_id) this automation's metadata. Safe to call on every process
 * start; failures are logged and swallowed.
 */
export async function registerAutomation(config: {
  automationId: string;
  name: string;
  category: string;
  technology: string;
  description?: string;
  environment?: string;
  schedule?: string;
}): Promise<void> {
  await apiRequest('POST', '/api/automations/', {
    automation_id: config.automationId,
    name: config.name,
    category: config.category,
    technology: config.technology,
    description: config.description,
    environment: config.environment,
    schedule: config.schedule,
  });
}

/** Starts a run and returns its run_id (or null if the dashboard is unreachable/unconfigured). */
export async function startRun(automationId: string, opts: { workerId?: string; currentStage?: string } = {}): Promise<string | null> {
  const res = await apiRequest('POST', '/api/executions/', {
    automation: automationId,
    status: 'RUNNING' as RunStatus,
    started_at: new Date().toISOString(),
    worker_id: opts.workerId,
    current_stage: opts.currentStage,
  });
  return res?.run_id ?? null;
}

/** Updates progress on an in-flight run — optional, only useful for long batches. Never throws. */
export async function reportProgress(runId: string | null, opts: { percentage?: number; currentStage?: string }): Promise<void> {
  if (!runId) return;
  await apiRequest('PATCH', `/api/executions/${runId}/`, {
    progress_percentage: opts.percentage,
    current_stage: opts.currentStage,
    heartbeat_at: new Date().toISOString(),
  });
}

/** Marks a run finished — SUCCESS/WARNING/FAILED plus whatever metrics this run produced. */
export async function finishRun(runId: string | null, params: {
  status: RunStatus;
  metrics?: Record<string, MetricValue>;
  errorMessage?: string;
  executionQuality?: ExecutionQuality;
}): Promise<void> {
  if (!runId) return;
  await apiRequest('PATCH', `/api/executions/${runId}/`, {
    status: params.status,
    completed_at: new Date().toISOString(),
    metrics: params.metrics,
    error_message: params.errorMessage,
    execution_quality: params.executionQuality,
  });
}
