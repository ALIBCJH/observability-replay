# Active benchmark plans

`example.json` is a template for a disposable Kubernetes test application.
It sends HTTP requests to a localhost endpoint and temporarily scales a
deployment to zero. The target URL must exercise that deployment. It requires
`kubectl`, access to the test cluster, and a reachable application endpoint.

Copy the template to an ignored local plan:

```bash
cp benchmark/plans/example.json benchmark/plans/example.local.json
export BENCH_CONTEXT=your-disposable-test-context
export BENCH_NAMESPACE=your-test-namespace
export BENCH_DEPLOYMENT=your-test-deployment
export BENCH_REPLICAS=1  # replace with its actual original replica count
```

Edit the local plan's URL, method, headers, and body for your application.
Review both shell commands and verify all four variables before running. The
commands require explicit context and namespace so they cannot silently use
your current Kubernetes context. Keep autoscaled workloads out of this example.
If using port forwarding, forward through a stable gateway that calls the
target; a forward directly to a pod that gets removed may stop working.

Build the project, configure the `OBS_*` variables for the test backend as
described in the root README, then run:

```bash
npm run build
npm run benchmark -- test --plan benchmark/plans/example.local.json
```

Verify that the original replica count is restored after the test, including
after failures or interruption. Only execute plans you trust: command fields
run with your shell permissions. Keep real credentials and private endpoints
in local files; publish only sanitized examples. Results are written to the
ignored `results/` directory.
