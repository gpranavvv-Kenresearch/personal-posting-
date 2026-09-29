/**
 * dashboard/config.ts — this automation's registration metadata for the
 * Automation Intelligence Dashboard (see docs/team-github-onboarding.md).
 *
 * The onboarding doc describes an `automation.yml` manifest read by a Python
 * SDK — this project has no YAML parser dependency and isn't Python, so this
 * plain typed object is the source of truth instead. Same information, same
 * REST payload shape, no new dependency.
 *
 * Field values are constrained by the dashboard's own OpenAPI schema
 * (confirmed live 2026-09-29 against GET /api/schema/):
 *   category:   INTERLINKING | VIDEO | MUSIC_METADATA | SOCIAL_DISTRIBUTION | BENCHMARKING | SEO | OTHER
 *   technology: PYTHON | N8N | PLAYWRIGHT | NEXTJS | DJANGO | OTHER
 *   environment: DEVELOPMENT | PRODUCTION
 *   schedule:   HOURLY | DAILY | WEEKLY | MANUAL
 */
export const AUTOMATION_CONFIG = {
  automationId: 'SOCIAL-VPS-001',
  name: 'Ken Research Content Distribution Agent',
  description: 'Multi-platform content generation and distribution (blog articles + social posts) across 12+ platforms via Playwright-driven browser automation, running as a long-lived VPS process.',
  category: 'SOCIAL_DISTRIBUTION',
  technology: 'PLAYWRIGHT',
  environment: 'PRODUCTION',
  schedule: 'DAILY',
} as const;
