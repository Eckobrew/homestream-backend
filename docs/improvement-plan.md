# Follow-up improvement plan — implemented in 1.1

These changes were implemented after the service split. See [the implementation and upgrade guide](follow-up-release.md) for current behavior and migration commands. The following records the original goals; real-device checks and target-hardware benchmarks remain deployment acceptance work. The priorities below come from source inspection; load limits need measurement on representative hardware.

## 1. Bound media conversion work — high priority

**Evidence:** each download-conversion request currently spawns its own FFmpeg process. Multiple clients can exhaust CPU/memory independently of API request volume.

Add a configurable backend conversion semaphore with a default limit of two concurrent conversions and no unbounded waiting queue. Return 503 with `Retry-After` when full. Give every conversion an ID, timeout and cancellation path; report active conversions, exits and duration without logging source URLs or tokens. Keep direct streams outside the conversion limit.

**Acceptance:** a third conversion is rejected cleanly; cancelling either active stream frees its slot; failed spawns and shutdown release slots and leave no child processes. Measure CPU, memory and startup time on the target LXC before adjusting the default.

## 2. Replace JSON state with SQLite — high priority before multiple writers

**Evidence:** configuration, profiles, devices and parent policies live in separate JSON files. The split now makes writes atomic and serializes profile edits, but does not provide transactions across files or processes.

Keep a single backend instance. Introduce SQLite with migrations and repositories for configuration, profiles, devices and parental policy. Provide an explicit import command that validates all four files, imports in one transaction, preserves identifiers/tokens/PIN hashes and records a migration version. Back up the source files and database. Do not add silent fallback from corrupt state to an empty installation. Hash new device credentials at rest while allowing existing credentials to migrate without re-pairing.

**Acceptance:** interrupted import is safely retryable; concurrent edits cannot lose updates; invalid or missing parental state fails closed; rollback restores the pre-migration backup. Plan multi-instance hosting separately.

## 3. Complete API schemas and compatibility automation — medium priority

**Evidence:** the native v1 catch-all dispatches many operations, and several route handlers still perform their own parsing and validation. The extracted contract covers core models but does not yet describe every native operation or query parameter.

Move remaining validation into reusable schemas and publish complete OpenAPI definitions for every web and native operation, including auth, pairing, parent PIN errors, queries, status codes and streaming headers. Replace untyped integration access (`as any`) with public Jellyfin client methods. Add a contract-diff gate against the last released OpenAPI artifact; incompatible changes require a new major API version. Generate Android/Kotlin client types without moving Android source into these repositories.

**Acceptance:** every exported operation has a validated request and documented response; generated web/Kotlin clients compile; schema tests run against fake upstreams; an intentionally breaking change fails CI.

## 4. Simplify the player and test user journeys — medium priority

**Evidence:** `BuiltinPlayer.tsx` is roughly 84 KB, `MediaModal.tsx` roughly 45 KB, and setup roughly 36 KB. Playback, Cast and UI state are difficult to change independently.

Extract player transport negotiation, progress reporting, subtitle selection and Cast session handling into dedicated hooks/services. Model loading, playing, paused, buffering, error and stopped transitions explicitly. Keep visible controls and request semantics unchanged during extraction. Add deterministic browser tests using mocked media/integrations for resume, episode transitions, seeking, subtitle selection, upstream failure and cancellation. Maintain a separate real-device Cast/Android TV checklist.

**Acceptance:** each transport can be exercised independently; progress timers stop when the player closes; switching episodes cannot report progress against the old item; existing keyboard and touch controls remain functional.

## 5. Make failures and maintenance clearer — medium priority

**Evidence:** upstream failure sometimes returns demo media; old docs refer to different Node versions and mobile behaviors; Next.js linting is skipped during builds and ESLint 8 is deprecated.

Make demo mode an explicit server setting. When configured upstreams fail, show a recoverable unavailable state rather than substituting a sample library. Add bounded upstream timeouts, correlation IDs and counters for upstream errors, active streams and API latency. Preserve credential redaction. Introduce a modern ESLint configuration gradually, starting with touched modules, and establish a tested Node/dependency update cadence. Resolve the repository's missing standalone license file with the owner before publishing reusable packages under a license assertion.

**Acceptance:** offline configured servers never display sample titles; status endpoints distinguish process health from dependency health; logs contain no credentials; release CI enforces the agreed lint baseline and compatibility checks.

## 6. Unify first-run setup and branding — high priority for usability

**Evidence:** the browser check shows the profile-setup modal layered over the server-configuration modal on an empty installation. Some inherited labels still say HomeFlix, and some demo artwork URLs are broken.

Give one onboarding controller ownership of the sequence: configure/test Jellyfin, import or create profiles, then enter the library. Do not open the global profile picker until server configuration is complete. Use the configured application name consistently and replace external demo artwork with reliable local placeholders.

**Acceptance:** a fresh install can complete setup using keyboard or touch without overlapping dialogs; a configuration error returns to the correct step; all displayed names follow configuration; demo mode has no broken images. Add a browser test that actually fills and submits the first-run form instead of merely checking that its fields are rendered.
