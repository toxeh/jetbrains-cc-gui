# Deferred work\n
- source_spec: "'`_bmad-output/implementation-artifacts/spec-context-bar-usage-reset.md`
  summary: Calendar-month TT currently uses fixed end−30d when period_start is missing
  evidence: Real unified billing is calendar months (28–31d); pace color near boundaries may misclassify without period_start from gateway.

- source_spec: `_bmad-output/implementation-artifacts/spec-context-bar-usage-reset.md`
  summary: No dedicated unit tests for useGrokPlanUsage bridge callback races
  evidence: Review verification-gap; pure helpers + indicator covered; hook relies on get_grok_plan_usage integration.

- source_spec: `_bmad-output/implementation-artifacts/spec-context-bar-usage-reset.md`
  summary: gatewayOrigin-only config without oauth/api base URLs does not hit capacity
  evidence: Spec requires bases as configured today; origin-only is uncommon and needs explicit product decision if remote capacity without local-agent is desired.
'"