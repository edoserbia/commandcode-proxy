#!/usr/bin/env bash
# One-shot, idempotent configurator:
#   - DSH default model reasoning effort -> max
#   - OpenCode default model reasoning effort -> max
#   - Claude Code: model + effort max + capability override
#   - cc-haha: active provider -> local CommandCode proxy + DeepSeek V4.1 Flash, effort max
#   - commandcode-proxy: honor Anthropic output_config.effort (max/xhigh)
#   - Register a launchd-managed OpenCode web service (stable port 4096)
#   - Register a launchd-managed DSH web service (stable port 3080)
# Idempotent: safe to re-run. Never bounces live services that are already
# healthy (a running dsh web session would be dropped by a restart).
set -uo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
HOME_DIR="${HOME}"
DSH_SETTINGS="${HOME_DIR}/.dsh/settings.yaml"
OC_CONFIG="${HOME_DIR}/.config/opencode/opencode.jsonc"
CLAUDE_SETTINGS="${HOME_DIR}/.claude/settings.json"
HAHA_PROVIDERS="${HOME_DIR}/.claude/cc-haha/providers.json"
HAHA_SETTINGS="${HOME_DIR}/.claude/cc-haha/settings.json"
PROXY="/Users/mac/work/su/commandcode-proxy/proxy.mjs"
OC_PLIST="${HOME_DIR}/Library/LaunchAgents/com.opencode.web.plist"
DSH_PLIST="${HOME_DIR}/Library/LaunchAgents/com.deepseek.dsh.web.plist"
DSH_BIN="/Users/mac/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE_BIN="/Users/mac/.nvm/versions/node/v22.22.3/bin/node"

MODEL_ID="deepseek/deepseek-v4.1-flash"
CAPS="thinking,effort,adaptive_thinking,xhigh_effort,max_effort"

backup() {
  local f="$1"
  if [ -f "$f" ]; then
    if cp -p "$f" "${f}.bak-${TS}" 2>/dev/null; then
      echo "  backed up -> ${f}.bak-${TS}"
    else
      echo "  !! backup failed for $f (continuing)"
    fi
  fi
}

echo "== 1) DSH settings.yaml =="
# DSH must not forward a stale upstream account key. The proxy selects from
# config.local.json and needs a marker value so loopback requests use that pool.
for profile in "$HOME_DIR/.dsh/profiles/web/cordis.patch.yml" "$HOME_DIR/.dsh/profiles/sdk/cordis.patch.yml" "$HOME_DIR/.dsh/profiles/headless/cordis.patch.yml" "$HOME_DIR/.dsh/profiles/desktop/cordis.patch.yml"; do
  [ -f "$profile" ] && sed -i '' 's/apiKeyEnv: CC_DEEPSEEK_API_KEY/apiKeyEnv: PROXY_MANAGED/' "$profile"
done
backup "$DSH_SETTINGS"
python3 - "$DSH_SETTINGS" <<'PY'
import sys
p = sys.argv[1]
lines = open(p, encoding='utf-8').read().splitlines()
try:
    start = lines.index('agent-default-model:')
except ValueError:
    print('  !! agent-default-model section not found'); sys.exit(0)
# Scan the WHOLE section first: reasoningEffort usually sits *after* model, so a
# naive stop-at-'model:' check would insert a duplicate YAML key.
end = start + 1
while end < len(lines) and (lines[end].startswith(' ') or lines[end].strip() == ''):
    end += 1
if any(l.startswith('  reasoningEffort:') for l in lines[start:end]):
    print('  already set'); sys.exit(0)
model_at = next((i for i in range(start, end) if lines[i].startswith('  model:')), None)
if model_at is None:
    print('  !! model: not found under agent-default-model'); sys.exit(0)
lines.insert(model_at + 1, '  reasoningEffort: max')
open(p, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('  inserted reasoningEffort: max')
PY
grep -n -A3 '^agent-default-model:' "$DSH_SETTINGS"

echo "== 2) OpenCode opencode.jsonc =="
backup "$OC_CONFIG"
python3 - "$OC_CONFIG" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = '"deepseek/deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash", "reasoning": true }'
new = '"deepseek/deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash", "reasoning": true, "options": { "reasoningEffort": "max" } }'
if new in s:
    print('  already set')
elif old in s:
    open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
    print('  added options.reasoningEffort=max')
else:
    print('  !! model line pattern not found')
PY
grep -n 'deepseek-v4.1-flash' "$OC_CONFIG"
python3 -c "import json,sys;json.load(open(sys.argv[1]));print('  JSON valid')" "$OC_CONFIG"

echo "== 3) Claude Code ~/.claude/settings.json =="
backup "$CLAUDE_SETTINGS"
python3 - "$CLAUDE_SETTINGS" "$MODEL_ID" "$CAPS" <<'PY'
import json, sys
p, model, caps = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p, encoding='utf-8'))
d['model'] = model
env = d.setdefault('env', {})
env['CLAUDE_CODE_EFFORT_LEVEL'] = 'max'
env['ANTHROPIC_MODEL'] = model
for slot in ('FABLE', 'HAIKU', 'SONNET', 'OPUS'):
    env[f'ANTHROPIC_DEFAULT_{slot}_MODEL'] = model
    env[f'ANTHROPIC_DEFAULT_{slot}_MODEL_NAME'] = model
    env[f'ANTHROPIC_DEFAULT_{slot}_MODEL_SUPPORTED_CAPABILITIES'] = caps
if 'effortLevel' in d and d['effortLevel'] not in ('low', 'medium', 'high', 'xhigh', 'max'):
    print('  !! invalid effortLevel=%r replaced' % d['effortLevel'])
# Pin the settings-level ladder too, not just the env var.
d['effortLevel'] = 'max'
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print('  updated: model=%s, effort=max, capability override set' % model)
PY
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('  model=',d.get('model'));print('  effort=',d.get('env',{}).get('CLAUDE_CODE_EFFORT_LEVEL'));print('  caps=',d.get('env',{}).get('ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES'))" "$CLAUDE_SETTINGS"

echo "== 4) cc-haha providers.json =="
backup "$HAHA_PROVIDERS"
python3 - "$HAHA_PROVIDERS" "$MODEL_ID" <<'PY'
import json, sys, uuid
p, model = sys.argv[1], sys.argv[2]
d = json.load(open(p, encoding='utf-8'))
provs = d.setdefault('providers', [])
existing = next((x for x in provs if x.get('name') == 'DeepSeek V4.1 Flash (Local Proxy)'), None)
if existing is None:
    existing = {
        'id': str(uuid.uuid4()),
        'presetId': 'custom',
        'name': 'DeepSeek V4.1 Flash (Local Proxy)',
        'apiKey': 'PROXY_MANAGED',
        'authStrategy': 'auth_token',
        'baseUrl': 'http://127.0.0.1:3050',
        'apiFormat': 'anthropic',
        'runtimeKind': 'anthropic_compatible',
        'models': {'main': model, 'haiku': model, 'sonnet': model, 'opus': model},
        'modelContextWindows': {model: 1000000},
        'toolSearchEnabled': True,
    }
    provs.append(existing)
    print('  added provider', existing['id'])
else:
    existing.update({
        'apiKey': 'PROXY_MANAGED', 'authStrategy': 'auth_token',
        'baseUrl': 'http://127.0.0.1:3050', 'apiFormat': 'anthropic',
        'runtimeKind': 'anthropic_compatible',
        'models': {'main': model, 'haiku': model, 'sonnet': model, 'opus': model},
        'modelContextWindows': {model: 1000000},
    })
    print('  updated provider', existing['id'])
d['activeId'] = existing['id']
order = d.get('providerOrder')
if isinstance(order, list) and existing['id'] not in order:
    order.append(existing['id'])
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print('  activeId=', d['activeId'])
PY
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));p=[x for x in d['providers'] if x['id']==d['activeId']][0];print('  active provider:',p['name'],p['baseUrl'],p['models'])" "$HAHA_PROVIDERS"

echo "== 5) cc-haha settings.json =="
backup "$HAHA_SETTINGS"
python3 - "$HAHA_SETTINGS" "$MODEL_ID" <<'PY'
import json, sys
p, model = sys.argv[1], sys.argv[2]
d = json.load(open(p, encoding='utf-8'))
d['model'] = model
env = d.setdefault('env', {})
env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:3050'
env['ANTHROPIC_AUTH_TOKEN'] = 'PROXY_MANAGED'
env.pop('ANTHROPIC_API_KEY', None)
env['ANTHROPIC_MODEL'] = model
for slot in ('HAIKU', 'SONNET', 'OPUS'):
    env[f'ANTHROPIC_DEFAULT_{slot}_MODEL'] = model
env['CLAUDE_CODE_EFFORT_LEVEL'] = 'max'
env['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print('  model=%s, effort=max' % model)
PY
cat "$HAHA_SETTINGS"

echo "== 6) proxy.mjs: honor output_config.effort =="
backup "$PROXY"
# Detect whether this run actually introduces new proxy code, so step 7 knows
# whether a restart is genuinely required.
NEED_PROXY_RESTART=0
grep -q 'effortFromOutputConfig' "$PROXY" || NEED_PROXY_RESTART=1
python3 - "$PROXY" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'output_config.effort' in s and 'effortFromOutputConfig' in s:
    print('  already patched'); sys.exit(0)
anchor = """    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;"""
addition = """    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  // 7b. Claude Code 把思考强度放在 output_config.effort（与 thinking 相互独立）。
  // 它优先于上面的 thinking 推导，才能把 max/xhigh 完整透传（Claude Code、cc-haha）。
  const effortFromOutputConfig = anthropicReq.output_config && anthropicReq.output_config.effort;
  if (typeof effortFromOutputConfig === 'string') {
    const eff = effortFromOutputConfig.toLowerCase();
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(eff)) {
      openaiReq.reasoning_effort = eff;
    }
  }

  return openaiReq;"""
if anchor not in s:
    print('  !! anchor not found; refusing to patch'); sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(anchor, addition, 1))
print('  patch applied')
PY
node --check "$PROXY" && echo "  proxy.mjs syntax OK"

echo "== 7) commandcode-proxy =="
code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3050/health || true)"
if [ "$code" = "200" ] && [ "$NEED_PROXY_RESTART" = "0" ]; then
  # Already patched and alive: never bounce a proxy that live agent sessions
  # (including a running DSH web session) may be streaming through.
  echo "  already patched + healthy -> leaving the running proxy untouched"
else
  launchctl kickstart -k "gui/$(id -u)/com.cc-proxy" 2>/dev/null || echo "  (kickstart skipped/failed)"
  sleep 2
  for i in 1 2 3 4 5; do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3050/health || true)"
    [ "$code" = "200" ] && break
    sleep 1
  done
fi
echo "  proxy /health -> ${code:-no-response}"

echo "== 8) OpenCode web launchd service (port 4096) =="
mkdir -p "${HOME_DIR}/.config/opencode"
OC_PLIST_NEW="$(mktemp)"
cat > "$OC_PLIST_NEW" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/opencode</string>
    <string>web</string>
    <string>--hostname</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>4096</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/mac/work/su/commandcode-proxy</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/Users/mac/.nvm/versions/node/v22.22.3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/mac</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/mac/.config/opencode/web.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mac/.config/opencode/web-error.log</string>
</dict>
</plist>
EOF
# Only bounce the service when something actually changed; a needless restart
# would drop any OpenCode web session the user has open in a browser.
code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/ || true)"
if [ "$code" = "200" ] \
   && launchctl print "gui/$(id -u)/com.opencode.web" >/dev/null 2>&1 \
   && cmp -s "$OC_PLIST_NEW" "$OC_PLIST"; then
  rm -f "$OC_PLIST_NEW"
  echo "  loaded + healthy + plist unchanged -> leaving it running"
else
  mv "$OC_PLIST_NEW" "$OC_PLIST"
  launchctl bootout "gui/$(id -u)/com.opencode.web" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$OC_PLIST" 2>/dev/null || launchctl load -w "$OC_PLIST" 2>/dev/null || echo "  (bootstrap failed)"
  sleep 5
  for i in 1 2 3 4 5 6; do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/ || true)"
    [ "$code" = "200" ] && break
    sleep 1
  done
fi
echo "  opencode web 4096 -> ${code:-no-response}"

echo "== 9) DSH web launchd service (port 3080) =="
# DSH web is already managed by an existing LaunchAgent (com.deepseek.harness.web,
# KeepAlive + RunAtLoad). Creating a second plist for the same port would make the
# two fight over 3080 at login, so this step only verifies the existing service.
EXISTING_DSH_PLIST="${HOME_DIR}/Library/LaunchAgents/com.deepseek.harness.web.plist"
DUPLICATE_DSH_PLIST="${HOME_DIR}/Library/LaunchAgents/com.deepseek.dsh.web.plist"
if [ -f "$DUPLICATE_DSH_PLIST" ]; then
  launchctl bootout "gui/$(id -u)/com.deepseek.dsh.web" 2>/dev/null || true
  rm -f "$DUPLICATE_DSH_PLIST"
  echo "  removed duplicate plist com.deepseek.dsh.web.plist (superseded)"
fi
if [ -f "$EXISTING_DSH_PLIST" ]; then
  launchctl print "gui/$(id -u)/com.deepseek.harness.web" >/dev/null 2>&1 \
    && echo "  com.deepseek.harness.web: loaded + KeepAlive" \
    || echo "  !! com.deepseek.harness.web present but not loaded"
else
  echo "  !! no DSH web LaunchAgent found; start it manually with: dsh web --no-open --host 127.0.0.1 --port 3080"
fi
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || true)"
echo "  port 3080 responds -> ${code:-no-response} (401 = up; it needs the ?token= URL)"
echo "  browser URL: $(tail -1 "${HOME_DIR}/.dsh/web.log" 2>/dev/null | tr -d '\r' || echo '(none yet)')"

echo
echo "== summary =="
echo "DSH web  : http://127.0.0.1:3080/  (needs the ?token=... from ~/.dsh/web.log)"
echo "OpenCode : http://127.0.0.1:4096/"
echo "Proxy    : http://127.0.0.1:3050/  (health: $(curl -s -m 3 http://127.0.0.1:3050/health || echo '?'))"
echo "done"
