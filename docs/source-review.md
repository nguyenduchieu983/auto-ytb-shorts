# Source review — 08/10/2026

Reviewed application source, providers, migrations, operational scripts, prompts,
configuration and the test suite. This is a code and local validation review;
live OpenAI generation, Telegram delivery and YouTube upload were not exercised.

## Fixes

- Manual retry now requeues parallel RUNNING branches and invalidates their old
  lease tokens. Previously, a sibling could finish after the run became FAILED,
  discard its output, complete its queue job and leave the resumed run stuck.
- Upload reconciliation now requires a failed upload step and an existing,
  non-rejected upload attempt. Previously, any FAILED run, including a discovery
  failure, could be marked uploaded by supplying a channel-owned video ID.
- Reconciliation locks the run against retry/regenerate and commits the upload
  attempt, step and run status in one transaction. Ownership checks precede writes.
- Updated sharp to ^0.35.5; npm audit returned zero vulnerabilities.

## Validation

- Node.js v24.12.0; dependencies installed with npm ci.
- npm run check: build passed, 60/60 tests passed outside the socket-restricted
  sandbox. Includes regression tests for parallel retry and reconciliation.
- npm run test:redis: passed against real Redis/BullMQ, with an isolated namespace.
- npm run demo: full mock flow passed with real FFmpeg; 55-second
  1080x1920/30fps H.264/AAC video, all hard QC gates passed. Report is
  storage/demo-latest.json. This does not verify live narration or external APIs.
- PostgreSQL service is running, but both configured application and admin
  connections returned 28P01 (authentication failure).
- Redis installed natively in Ubuntu WSL. Dedicated project instance at port 6380
  is running with authentication and AOF; local REDIS_URL was refreshed.
- Native full-pipeline PostgreSQL/Redis test and application startup require valid
  PostgreSQL credentials. No database authentication rules or existing passwords
  were changed.

## Logic and operational limits

- Pipeline dependencies join voice/subtitles and visuals before render; metadata
  joins render before QC. Manual approval checks current revision, verification,
  QC and the 24-hour approval window. Regeneration invalidates dependent steps.
- Upload persists the resumable session and checks its byte offset on retry;
  uncertain initiation/session expiry requires reconciliation rather than a fresh
  automatic upload. Mock content is blocked from live uploads.
- Discovery uses article snapshots, expands 24/48/72 hours, supports RSS fallback,
  retains unknown dates and checks event novelty against current historical ranks.
  AI fact/novelty classification still requires human editorial review.
- selectTopNews limits tools during its first pass, but three higher-ranked news
  can fill all slots before a tool is considered. Its comment/docs describe a
  preference for two news plus one tool more strongly than the current algorithm.
- /health only checks PostgreSQL. Redis/worker readiness needs separate checks.
- Unit database tests use pg-mem; transaction locking and process recovery still
  require native PostgreSQL tests. External provider fixtures are mock verification.
- Existing local configuration selects live providers with scheduling and
  auto-publish disabled. Credentials and generated assets remain outside Git.
