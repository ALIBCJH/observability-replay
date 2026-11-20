# Contributing

Use Node.js 22 (`nvm use`) and npm. From a fresh checkout:

```bash
npm ci
npm run typecheck
npm test
```

The tests build the project and exercise the demo, scoring, replay, MCP server,
and Prometheus adapter. They need local sockets but no Kubernetes cluster,
credentials, or live Prometheus. Open `dist/apps-preview.html`,
`dist/preview.html`, and `dist/benchmark-preview.html` to review visual changes.

## How changes land

Every change reaches `main` through a pull request; nobody pushes to `main`
directly, maintainers included.

```bash
git switch main && git pull
git switch -c short-description-of-change
# edit, then
npm run typecheck && npm test
git commit -am "Say what changed and why"
git push -u origin short-description-of-change
gh pr create --fill        # or open the pull request on the web
```

CI runs the type check, the tests and a pack check on Node 20, 22 and 24. A
pull request is merged, by squash, once CI is green and review comments are
resolved. Outside contributors work the same way from a fork.

Keep pull requests focused. Explain the problem, resulting behavior, and how
you checked the change. Include a regression test when fixing behavior, and
update the README when changing configuration or tool outputs. Use synthetic
data in fixtures and screenshots; do not submit production telemetry or tokens.

Adapters implement `src/adapters/types.ts` and register in
`src/adapters/index.ts`. Preserve missing data as missing, expose source queries,
and report capability flags accurately. Changes to benchmark thresholds or
scoring require a benchmark standard version change.

Active benchmark tests execute shell commands and disrupt their target. They
are not part of the automated test suite. See [plan setup](benchmark/plans/README.md).

Report ordinary bugs with reproduction steps, Node version, backend type, and
sanitized expected/actual output. For vulnerabilities, follow
[SECURITY.md](SECURITY.md). Be respectful and constructive in discussions.

Contributions are made under the repository's Apache-2.0 license. Submit only
work you have the right to contribute.

When updating browser dependencies, refresh `THIRD_PARTY_NOTICES.txt` from their
license and notice files, including bundled code. The build embeds these notices
in each standalone HTML page so they remain with shared reports.
