# First public release

Local verification on 2026-11-20: type checking and all 41 tests passed;
`npm audit` reported zero known vulnerabilities; the npm package dry run
excluded local plans and reports. A common credential-pattern scan found no
matches in the visible source and data files. These checks do not cover Git
history, prove the absence of secrets, or replace a clean-checkout CI run.

Repository files have been prepared for Apache-2.0 licensing. Complete these
checks against the actual Git repository and intended hosting account before
making it public:

- Confirm ownership and permission to release all contributed code and assets.
- Inspect the staged file list and full Git history for credentials, internal
  URLs, personal paths, and telemetry. This workspace does not expose readable
  Git metadata, so history and tracked-file status have not been verified.
  `.gitignore` does not untrack files or remove historical copies. Keep
  `results/` and `benchmark/plans/*.local.json` out of the release.
- Run a secret scanner over the full history. Revoke or rotate any exposed
  credentials before removing them from history.
- Run `npm ci`, `npm run typecheck`, and `npm test` from a clean checkout.
  Confirm the CI matrix passes on the hosting service.
- Run `npm audit` with registry access and review findings and dependency
  licenses. Build output embeds dependencies in the browser views; retain
  required third-party license notices when distributing those artifacts.
- Set the public repository URL, issue tracker, and homepage in `package.json`
  once the hosting location is chosen. Do not invent an owner or contact address.
- Enable private vulnerability reporting or document a real private security
  contact in `SECURITY.md`. Configure branch protection and secret scanning on
  the hosting service where available.
- If publishing to npm, verify package-name availability, inspect `npm pack
  --dry-run`, and test the installed tarball. The package includes runtime
  JavaScript and HTML, not saved reports or personal benchmark plans.

Publishing the repository or npm package is a separate action from preparing
these files. No publication is performed by the CI workflow.
