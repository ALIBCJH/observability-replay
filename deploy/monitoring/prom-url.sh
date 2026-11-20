#!/usr/bin/env bash
# Print the URL of the Prometheus in a local k3d cluster.
#
#   export OBS_PROM_URL=$(deploy/monitoring/prom-url.sh k3d-example-server-0)
#
# The NodePort is reached on the node container's own address, which Docker
# may change when the cluster is restarted, so ask each time.
set -euo pipefail
NODE=${1:?Usage: prom-url.sh <k3d-node-container>}
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NODE")
[ -n "$ip" ] || { echo "node $NODE has no address; is the cluster running?" >&2; exit 1; }
echo "http://$ip:30090"
