#!/usr/bin/env bash
# Runs inside `unshare -n` (an empty network namespace). Proves the ruleset's behaviour and prints JSON.
# Usage: unshare -n bash ops/nftables/verify-in-netns.sh <ruleset> <proxy_uid>
set -euo pipefail
RULESET="$1"; PROXY_UID="$2"
ip link set lo up
ip link add sevari0 type dummy
ip addr add 10.99.0.1/24 dev sevari0
ip link set sevari0 up
TMP=$(mktemp)
sed -e "s/^define PROXY_UID = .*/define PROXY_UID = ${PROXY_UID}/" -e "s/^define DNS_RESOLVERS = .*/define DNS_RESOLVERS = { 10.99.0.53 }/" "$RULESET" > "$TMP"
nft -f "$TMP"
attempt() { timeout 1 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null && echo ok || echo blocked; }
# 1. root (not the proxy user) to an external address on 443
app_https=$(attempt 10.99.0.2 443)
# 2. the proxy user to the same address on 443 (allowed: the packet leaves, nothing answers)
proxy_https=$(setpriv --reuid="$PROXY_UID" --regid="$PROXY_UID" --clear-groups bash -c "timeout 1 bash -c 'echo > /dev/tcp/10.99.0.2/443' 2>/dev/null; true" ; echo done)
# 3. the proxy user to a non-HTTPS port (must drop)
setpriv --reuid="$PROXY_UID" --regid="$PROXY_UID" --clear-groups bash -c "timeout 1 bash -c 'echo > /dev/tcp/10.99.0.2/25' 2>/dev/null; true"
# 4. loopback is always reachable (the app talks to the proxy here)
( exec 3<>/dev/null; python3 -c "import socket,sys;s=socket.socket();s.bind(('127.0.0.1',38128));s.listen(1);c,_=s.accept();c.close()" & sleep 0.3; attempt 127.0.0.1 38128 > /tmp/lo_result; wait ) 2>/dev/null || true
lo=$(cat /tmp/lo_result 2>/dev/null || echo blocked)
c() { nft -j list counter inet sevari_egress "$1" | python3 -c "import json,sys;d=json.load(sys.stdin)['nftables'];print([x['counter']['packets'] for x in d if 'counter' in x][0])"; }
printf '{"app_https":"%s","loopback":"%s","proxy_https_packets":%s,"dropped_packets":%s}\n' "$app_https" "$lo" "$(c proxy_https)" "$(c dropped)"
