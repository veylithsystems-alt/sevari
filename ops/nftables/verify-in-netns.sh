#!/usr/bin/env bash
# Proves the egress ruleset's behaviour inside throwaway network namespaces and prints JSON.
# Usage (as root): bash ops/nftables/verify-in-netns.sh <ruleset.nft> <proxy_uid>
# Topology: namespace "app" (ruleset loaded) <-veth-> namespace "net" (listeners on :443 and :25).
set -euo pipefail
RULESET="$(realpath "$1")"; PROXY_UID="$2"
ID="sv$$"; APP="${ID}a"; NET="${ID}n"
cleanup() { ip netns pids "$NET" 2>/dev/null | xargs -r kill 2>/dev/null || true; ip netns del "$APP" 2>/dev/null || true; ip netns del "$NET" 2>/dev/null || true; }
trap cleanup EXIT
ip netns add "$APP"; ip netns add "$NET"
ip link add "${ID}0" type veth peer name "${ID}1"
ip link set "${ID}0" netns "$APP"; ip link set "${ID}1" netns "$NET"
ip -n "$APP" addr add 10.99.0.1/24 dev "${ID}0"; ip -n "$APP" link set "${ID}0" up; ip -n "$APP" link set lo up
ip -n "$NET" addr add 10.99.0.2/24 dev "${ID}1"; ip -n "$NET" link set "${ID}1" up; ip -n "$NET" link set lo up
for port in 443 25; do
  ip netns exec "$NET" python3 -c "
import socket
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('10.99.0.2',$port)); s.listen(16)
while True:
    c,_=s.accept(); c.close()" &
done
sleep 0.5
TMP=$(mktemp)
sed -e "s/^define PROXY_UID = .*/define PROXY_UID = ${PROXY_UID}/" -e "s/^define DNS_RESOLVERS = .*/define DNS_RESOLVERS = { 10.99.0.53 }/" "$RULESET" > "$TMP"
ip netns exec "$APP" nft -f "$TMP"
probe() { # uid host port -> ok|blocked
  local cmd="timeout 2 bash -c 'echo > /dev/tcp/$2/$3' 2>/dev/null && echo ok || echo blocked"
  if [ "$1" = "0" ]; then ip netns exec "$APP" bash -c "$cmd"
  else ip netns exec "$APP" setpriv --reuid="$1" --regid="$1" --clear-groups bash -c "$cmd"; fi
}
app_https=$(probe 0 10.99.0.2 443)
proxy_https=$(probe "$PROXY_UID" 10.99.0.2 443)
proxy_smtp=$(probe "$PROXY_UID" 10.99.0.2 25)
ip netns exec "$APP" python3 -c "
import socket,threading
s=socket.socket(); s.bind(('127.0.0.1',38128)); s.listen(1)
threading.Thread(target=lambda: s.accept(), daemon=True).start()
c=socket.create_connection(('127.0.0.1',38128),timeout=2); print('ok')" > /tmp/${ID}_lo 2>/dev/null || echo blocked > /tmp/${ID}_lo
loopback=$(cat /tmp/${ID}_lo); rm -f /tmp/${ID}_lo
dropped=$(ip netns exec "$APP" nft -j list counter inet sevari_egress dropped | python3 -c "import json,sys;d=json.load(sys.stdin)['nftables'];print([x['counter']['packets'] for x in d if 'counter' in x][0])")
printf '{"app_https":"%s","proxy_https":"%s","proxy_smtp":"%s","loopback":"%s","dropped_packets":%s}\n' "$app_https" "$proxy_https" "$proxy_smtp" "$loopback" "$dropped"
