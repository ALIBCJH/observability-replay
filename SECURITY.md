# Security

## Reporting a vulnerability

Do not put credentials, private telemetry, or exploit details in public issues.
Use the repository's private vulnerability reporting option under Security if
it is enabled. If no private channel is available, open an issue asking the
maintainers for a private contact without disclosing the vulnerability itself.
Include affected versions, reproduction steps, impact, and a minimal synthetic
example in the private report. There is no guaranteed response time or support
commitment for older versions; fixes target the current development version.

## Trust boundaries

- The MCP server runs over stdio with the launching user's permissions. Its
  tools read backend data and return it to the MCP client, including service
  names, labels, queries, alerts, and deployment details. Use a client and model
  provider approved to receive that data.
- Configure Prometheus with read-only credentials and HTTPS when traffic leaves
  your machine or trusted network. Treat backend URLs and label matchers as
  trusted operator configuration, not untrusted user input.
- The benchmark CLI's `test` mode sends traffic and executes a plan's `inject`,
  `restore`, and optional `cleanup` fields as shell commands. Plans are executable
  code. Review them and use only a disposable test environment. Restoration is
  attempted but can fail; check the target manually after interrupted runs.
- JSON results and HTML reports embed backend data. They can reveal internal
  topology and operational details. Review them before sharing. Ignored files
  are still present on disk and are not protected against direct folder uploads.
- The monitoring manifest is a local development example. It includes
  unauthenticated network endpoints, a NodePort, cluster-wide read permissions,
  and a root Prometheus container with local storage. It is not a production
  deployment configuration.

Keep tokens in environment variables or your client's secret configuration.
Never commit `.env` files, kubeconfigs, private keys, or real monitoring reports.
If a credential was ever committed, revoke or rotate it and review Git history;
adding it to `.gitignore` does not remove earlier commits.
