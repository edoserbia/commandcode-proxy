/**
 * 阶梯冷却 + 失败分类的端到端验证。
 *
 * 直接驱动真实 proxy 进程，用假上游注入故障，断言：
 *   - 连续失败按 5m → 1h → 12h → 24h → 1w 逐级升级，且封顶一周
 *   - 额度耗尽 / 鉴权失败直接跳到最长冷却
 *   - 权益不足（MODEL_NOT_IN_PLAN 403）不熔断账号
 *   - 一次成功即清零，下次失败重新从 5 分钟开始
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = resolve(__dirname, '..', 'proxy.mjs');

const KEY_A = 'user_a7f3k9m2q8x1z5b4n6v0';
const KEY_B = 'user_QUOTA0000000000000001';

/** 与 proxy.mjs 的 keyFingerprint 保持一致：sha256 前 16 位十六进制 */
function fingerprint(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

let upstreamPort = 0;

function createFakeUpstream() {
  const state = { rule: 'ok', calls: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.includes('/fingerprint') || req.url.includes('/lifecycle')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url.includes('/provider/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }] }));
      return;
    }
    state.calls++;
    const rule = typeof state.rule === 'function' ? state.rule(state.calls) : state.rule;
    if (rule !== 'ok') {
      res.writeHead(rule.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: rule.message } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ type: 'text-delta', text: 'ok' })}\n`);
    res.write(`${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 2 } })}\n`);
    res.end();
  });
  return { server, state };
}

function freePort() {
  return new Promise(r => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
}

async function waitForHealth(port, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited (${child.exitCode}):\n${logs.join('')}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`proxy unhealthy:\n${logs.join('')}`);
}

/** 起一个只用单个账号的代理，便于观察该账号的冷却升级 */
async function startProxy(extraConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ladder-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    apiKeys: [KEY_A],
    keyFailover: true,
    keyStateFile: join(dir, 'key-health.json'),
    maxKeyAttempts: 1,
    ...extraConfig,
  }), 'utf-8');

  const port = await freePort();
  const child = spawn(process.execPath, [PROXY_PATH], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CC_CONFIG: join(dir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));
  await waitForHealth(port, child, logs);

  return {
    port, logs, dir,
    statePath: join(dir, 'key-health.json'),
    readState() {
      if (!existsSync(this.statePath)) return null;
      return JSON.parse(readFileSync(this.statePath, 'utf-8'));
    },
    stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); }),
  };
}

function call(port) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

/** 从日志里取出最后一次冷却时长（毫秒） */
function lastCooldownMs(logs) {
  const text = logs.join('');
  const matches = [...text.matchAll(/"cooldownMs":(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

test('escalating cooldown ladder end to end', async (t) => {
  const fake = createFakeUpstream();
  upstreamPort = await new Promise(r => fake.server.listen(0, '127.0.0.1', () => r(fake.server.address().port)));
  t.after(() => fake.server.close());

  await t.test('repeated failures escalate 5m -> 1h -> 12h -> 24h -> 1w', async () => {
    fake.state.rule = { status: 503, message: 'upstream unavailable' };
    const dir = mkdtempSync(join(tmpdir(), 'cc-esc-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, 'key-health.json');

    const expected = [5 * MIN, HOUR, 12 * HOUR, 24 * HOUR, WEEK, WEEK];
    const logs = [];

    // 每一轮：写入「已连续失败 N 次、但冷却刚过期」的状态，重启进程后再触发一次失败，
    // 观察冷却是否逐级升级。这样不依赖真实时间流逝，测试稳定且快。
    for (const [i, want] of expected.entries()) {
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        breakers: {
          [fingerprint(KEY_A)]: {
            until: Date.now() - 1000,      // 已过期 → 账号可用，但失败计数保留
            kind: 'server',
            status: 503,
            failures: i,                   // 之前已连续失败 i 次
            message: 'previous',
            openedAt: Date.now() - 60_000,
          },
        },
      }), 'utf-8');

      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        host: '127.0.0.1',
        apiBase: `http://127.0.0.1:${upstreamPort}`,
        apiKeys: [KEY_A],
        keyFailover: true,
        keyStateFile: statePath,
        maxKeyAttempts: 1,
      }), 'utf-8');

      const port = await freePort();
      const child = spawn(process.execPath, [PROXY_PATH], {
        cwd: dir,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CC_CONFIG: join(dir, 'config.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', d => logs.push(d.toString()));
      child.stderr.on('data', d => logs.push(d.toString()));
      await waitForHealth(port, child, logs);

      const res = await call(port);
      assert.equal(res.status, 503, `attempt ${i + 1} should surface the upstream failure`);

      const text = logs.join('');
      const matches = [...text.matchAll(/"cooldownMs":(\d+)/g)];
      const got = matches.length ? Number(matches[matches.length - 1][1]) : null;
      assert.equal(got, want, `failure #${i + 1} (after ${i} prior) should cool ${want}ms, got ${got}`);

      await new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); });
    }

    assert.match(logs.join(''), /"failures":6/, 'the failure counter must keep accumulating');
  });

  await t.test('quota exhaustion jumps straight to the one-week cap', async () => {
    fake.state.rule = { status: 429, message: 'You have exhausted your weekly usage limit. It resets on Monday.' };
    const proxy = await startProxy();
    t.after(() => proxy.stop());

    const res = await call(proxy.port);
    assert.equal(res.status, 429);
    assert.equal(lastCooldownMs(proxy.logs), WEEK, 'first quota failure must cool for a week');
    assert.match(proxy.logs.join(''), /"kind":"quota"/);
  });

  await t.test('an out-of-plan model (403) does not trip the breaker', async () => {
    fake.state.rule = {
      status: 403,
      message: 'MODEL_NOT_IN_PLAN: Claude Sonnet 4.6 available in Pro and above plans or extra on demand usage',
    };
    const proxy = await startProxy();
    t.after(() => proxy.stop());

    const res = await call(proxy.port);
    // 上游 403 会被既有映射成客户端的 401；这里只关心熔断器不动
    assert.equal(res.status, 401);

    const text = proxy.logs.join('');
    assert.match(text, /entitlement error, not a key problem/, 'should be recognised as entitlement');
    assert.doesNotMatch(text, /Key circuit opened/, 'must not open the breaker');

    const state = proxy.readState();
    assert.ok(!state || Object.keys(state.breakers || {}).length === 0, 'no breaker should be persisted');
  });

  await t.test('a genuine 403 auth failure still trips the breaker', async () => {
    fake.state.rule = { status: 403, message: 'Forbidden' };
    const proxy = await startProxy();
    t.after(() => proxy.stop());

    await call(proxy.port);
    assert.match(proxy.logs.join(''), /Key circuit opened/);
    assert.equal(lastCooldownMs(proxy.logs), WEEK, 'auth failures are treated as non-self-healing');
  });

  await t.test('a success resets the ladder back to the first rung', async () => {
    // 已累计失败 3 次、但冷却已过期 → 这次让上游成功，计数必须清零。
    const dir = mkdtempSync(join(tmpdir(), 'cc-reset-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, 'key-health.json');

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      breakers: {
        [fingerprint(KEY_A)]: {
          until: Date.now() - 1000, kind: 'server', status: 503,
          failures: 3, message: 'previous', openedAt: Date.now() - 60_000,
        },
      },
    }), 'utf-8');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      host: '127.0.0.1',
      apiBase: `http://127.0.0.1:${upstreamPort}`,
      apiKeys: [KEY_A],
      keyFailover: true,
      keyStateFile: statePath,
      maxKeyAttempts: 1,
    }), 'utf-8');

    fake.state.rule = 'ok';
    const port = await freePort();
    const child = spawn(process.execPath, [PROXY_PATH], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CC_CONFIG: join(dir, 'config.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));
    await waitForHealth(port, child, logs);
    t.after(() => new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); }));

    const res = await call(port);
    assert.equal(res.status, 200, 'the recovered upstream should succeed');
    assert.match(logs.join(''), /Key circuit closed after success/);

    // 落盘状态里该账号的失败计数应已清除
    await new Promise(r => setTimeout(r, 600)); // 落盘有 250ms 去抖
    const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.deepEqual(saved.breakers || {}, {}, 'a success must clear the failure counter');
  });

  await t.test('config.local.json supplies the real keys, config.json stays a template', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-local-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      host: '127.0.0.1',
      apiBase: `http://127.0.0.1:${upstreamPort}`,
      apiKeys: ['user_REPLACE_WITH_REAL_KEY'],
      keyStateFile: join(dir, 'key-health.json'),
    }), 'utf-8');
    writeFileSync(join(dir, 'config.local.json'), JSON.stringify({ apiKeys: [KEY_A] }), 'utf-8');

    const port = await freePort();
    const child = spawn(process.execPath, [PROXY_PATH], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CC_CONFIG: join(dir, 'config.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));
    await waitForHealth(port, child, logs);
    t.after(() => new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); }));

    fake.state.rule = 'ok';
    const res = await call(port);
    assert.equal(res.status, 200, 'local override must provide a usable key');
  });
});
