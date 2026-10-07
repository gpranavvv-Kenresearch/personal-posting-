export const ACTION_POLICY = Object.freeze({
  search_knowledge: 'observe',
  read_project_file: 'observe',
  search_project: 'observe',
  inspect_runtime_status: 'observe',
  read_recent_errors: 'observe',
  ingest_observer_event: 'observe',
  record_incident: 'observe',
  write_ai_guardian_report: 'observe',
  add_memory_candidate: 'observe',
  approve_memory: 'owner_approval',
  reject_memory: 'owner_approval',
  prepare_external_context: 'owner_approval',
  edit_code: 'prohibited',
  post_content: 'prohibited',
  retry_batch: 'prohibited',
  restart_process: 'prohibited',
  clear_session: 'prohibited',
  modify_schedule: 'prohibited',
  write_operational_sheet: 'prohibited',
});

export function policyFor(action) {
  return ACTION_POLICY[action] || 'prohibited';
}

export function assertObserveAllowed(action) {
  const policy = policyFor(action);
  if (policy !== 'observe') throw new Error(`Action is not available in observe mode: ${action} (${policy})`);
}
