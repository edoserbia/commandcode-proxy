#!/usr/bin/env bash
# Sync official upstream into this fork and push the result to origin.
#
# Remotes (already configured):
#   origin   -> https://github.com/edoserbia/commandcode-proxy.git   (my fork, PUSH TARGET)
#   upstream -> https://github.com/MAXeaglet/commandcode-proxy.git   (official, fetch only)
#
# Safety model: the merge is verified on an ISOLATED port with a throwaway
# process. The live launchd service on :3050 (which the agent session itself
# depends on) is only restarted with --promote, and only after every smoke test
# passes.
#
# Usage:
#   scripts/sync-upstream.sh              # merge + test + push to fork
#   scripts/sync-upstream.sh --promote    # same, then restart the live service
#   scripts/sync-upstream.sh --promote    # with nothing to merge: just promote
#   scripts/sync-upstream.sh --dry-run    # report what upstream has, change nothing
set -uo pipefail
cd "$(dirname "$0")/.."

PROMOTE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --promote) PROMOTE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

TEST_PORT="${TEST_PORT:-3070}"
LIVE_PORT="${LIVE_PORT:-3050}"
LABEL="${LABEL:-com.cc-proxy}"
KEY_FILE="${CC_API_KEY_FILE:-$HOME/.dsh/.credentials.yaml}"
MODEL="${MODEL:-deepseek/deepseek-v4.1-flash}"
TEST_DIR="$(mktemp -d)"
TEST_PID=""
SMOKE_DONE=0

cleanup() {
  if [ -n "$TEST_PID" ] && kill -0 "$TEST_PID" 2>/dev/null; then
    kill "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

fail() { echo; echo "!! $*" >&2; exit 1; }
health() { curl -s -m 3 "http://127.0.0.1:$1/health" 2>/dev/null || true; }

# ── smoke test the working tree on an isolated port ───────────
smoke_test() {
  echo
  echo "== isolated smoke test on :${TEST_PORT} =="
  cp proxy.mjs "$TEST_DIR/proxy.mjs"
  cat > "$TEST_DIR/config.json" <<EOF
{ "port": ${TEST_PORT}, "host": "127.0.0.1", "apiKey": "", "projectSlug": "smoke",
  "logLevel": "warn", "useProviderModels": true, "zdr": false }
EOF
  ( cd "$TEST_DIR" && PORT="$TEST_PORT" HOST=127.0.0.1 CC_API_KEY_FILE="$KEY_FILE" \
      node proxy.mjs >"$TEST_DIR/out.log" 2>&1 ) &
  TEST_PID=$!

  local up=0
  for _ in $(seq 1 20); do
    sleep 1
    [ "$(health "$TEST_PORT")" = "OK" ] && { up=1; break; }
  done
  [ "$up" = "1" ] || { tail -20 "$TEST_DIR/out.log"; fail "test instance did not come up on :${TEST_PORT}"; }
  echo "  test instance up (pid ${TEST_PID})"

  local BASE="http://127.0.0.1:${TEST_PORT}"
  local pass=0 bad=0
  smoke() {
    if [ "$2" = "1" ]; then echo "  PASS  $1"; pass=$((pass+1));
    else echo "  FAIL  $1"; bad=$((bad+1)); fi
  }

  local n s
  n=$(curl -s -m 60 "$BASE/v1/models" -H 'x-api-key: PROXY_MANAGED' \
      | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0)
  smoke "GET /v1/models (dynamic, ${n} models)" "$([ "${n:-0}" -gt 0 ] && echo 1 || echo 0)"

  s=$(curl -s -m 180 -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -H 'x-api-key: PROXY_MANAGED' \
      -d "{\"model\":\"$MODEL\",\"stream\":false,\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}" \
      | python3 -c "import json,sys
try:
    print(1 if (json.load(sys.stdin).get('choices') or [{}])[0].get('message',{}).get('content') else 0)
except Exception: print(0)" 2>/dev/null || echo 0)
  smoke "POST /v1/chat/completions (non-stream)" "$s"

  s=$(curl -s -m 180 -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -H 'x-api-key: PROXY_MANAGED' \
      -d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
      | grep -c '\[DONE\]' || true)
  smoke "POST /v1/chat/completions (stream)" "$([ "${s:-0}" -gt 0 ] && echo 1 || echo 0)"

  s=$(curl -s -m 180 -N -X POST "$BASE/v1/messages" -H 'content-type: application/json' -H 'x-api-key: PROXY_MANAGED' -H 'anthropic-version: 2023-06-01' \
      -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"output_config\":{\"effort\":\"max\"}}" \
      | grep -c 'message_stop' || true)
  smoke "POST /v1/messages (stream, effort=max)" "$([ "${s:-0}" -gt 0 ] && echo 1 || echo 0)"

  s=$(curl -s -m 180 -X POST "$BASE/v1/messages" -H 'content-type: application/json' -H 'x-api-key: PROXY_MANAGED' -H 'anthropic-version: 2023-06-01' \
      -d "{\"model\":\"$MODEL\",\"max_tokens\":256,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}" \
      | python3 -c "import json,sys
try:
    b=json.load(sys.stdin).get('content',[])
    print(1 if any(x.get('type')=='text' and x.get('text') for x in b) else 0)
except Exception: print(0)" 2>/dev/null || echo 0)
  smoke "POST /v1/messages (non-stream)" "$s"

  echo "  -> ${pass} passed, ${bad} failed"

  kill "$TEST_PID" 2>/dev/null || true
  wait "$TEST_PID" 2>/dev/null || true
  TEST_PID=""
  SMOKE_DONE=1

  [ "$bad" = "0" ] || return 1
  return 0
}

# ── restart the live service and verify it end-to-end ─────────
promote_live() {
  echo
  echo "== promote to live service (:$LIVE_PORT) =="
  echo "  running code will be: $(git log --oneline -1 | cut -c1-60)"

  launchctl kickstart -k "gui/$(id -u)/${LABEL}" || fail "kickstart failed"
  local ok=0
  for _ in $(seq 1 30); do
    sleep 1
    [ "$(health "$LIVE_PORT")" = "OK" ] && { ok=1; break; }
  done
  [ "$ok" = "1" ] || fail "live service unhealthy on :${LIVE_PORT} after 30s — check logs/cc-proxy.err.log"
  echo "  live service healthy on new code (pid $(lsof -nP -iTCP:"$LIVE_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}'))"

  local reply
  reply=$(curl -s -m 120 -X POST "http://127.0.0.1:${LIVE_PORT}/v1/chat/completions" \
    -H 'content-type: application/json' -H 'x-api-key: PROXY_MANAGED' \
    -d "{\"model\":\"$MODEL\",\"stream\":false,\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}" \
    | python3 -c "import json,sys
try:
    print((json.load(sys.stdin).get('choices') or [{}])[0].get('message',{}).get('content') or '(empty)')
except Exception: print('(unparseable)')" 2>/dev/null || echo '(request failed)')
  echo "  live end-to-end reply: ${reply}"
}

echo "== 1) remotes =="
git remote get-url origin   | sed 's/^/  origin   -> /'
git remote get-url upstream | sed 's/^/  upstream -> /'
[ "$(git remote get-url origin)" = "https://github.com/edoserbia/commandcode-proxy.git" ] \
  || fail "origin is not the fork; refusing to push anywhere else"

echo
echo "== 2) fetch upstream =="
git fetch upstream --prune || fail "could not fetch upstream (network/proxy?)"

BEHIND="$(git rev-list --count HEAD..upstream/master)"
echo "  commits upstream has that we lack: ${BEHIND}"
git log --oneline -1 upstream/master | sed 's/^/  upstream head: /'

if [ "$DRY_RUN" = "1" ]; then
  [ "$BEHIND" -gt 0 ] && git log --oneline HEAD..upstream/master | sed 's/^/  + /'
  echo
  echo "(--dry-run: stopping here, nothing changed)"
  exit 0
fi

if [ "$BEHIND" -gt 0 ]; then
  git log --oneline HEAD..upstream/master | sed 's/^/  + /'

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    fail "working tree has uncommitted tracked changes; commit or stash them first"
  fi

  echo
  echo "== 3) merge upstream/master =="
  git merge upstream/master --no-edit || fail "merge hit conflicts; resolve them manually, then re-run with --promote"

  echo
  echo "== 4) syntax check =="
  node --check proxy.mjs || fail "proxy.mjs failed syntax check after merge"
  echo "  proxy.mjs OK"

  smoke_test || {
    echo "  (reverting the merge — nothing was pushed)"
    git reset --hard ORIG_HEAD >/dev/null 2>&1
    fail "smoke tests failed; merge reverted"
  }

  echo
  echo "== 5) push to fork (origin) =="
  git push origin master || fail "push failed"
  echo "  pushed to $(git remote get-url origin)"
else
  echo "  already up to date with official master"
fi

if [ "$PROMOTE" = "1" ]; then
  [ "$SMOKE_DONE" = "1" ] || smoke_test || fail "smoke tests failed; live service left untouched"
  promote_live
else
  echo
  echo "  (live service NOT restarted — re-run with --promote to apply it)"
fi

echo
echo "done."
