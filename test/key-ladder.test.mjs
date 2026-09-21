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
  const state = { rule: 'ok', calls: 0, authSeen: [] };
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
    // 记录这次生成请求实际用的是哪个账号 —— 用于断言「冷却账号有没有被偷用」
    state.authSeen.push(String(req.headers.authorization || '').replace(/^Bearer\s+/, ''));
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

/** 构造一条熔断器持久化状态（键为密钥指纹） */
function breakerState(entries) {
  const breakers = {};
  for (const [key, { kind, status, until, failures = 1, message = 'seeded' }] of entries) {
    breakers[fingerprint(key)] = {
      until, kind, status, failures,
      message, openedAt: Date.now() - 60_000,
    };
  }
  return { version: 1, savedAt: Date.now(), breakers };
}

/** 起一个可指定账号池与预置熔断状态的代理 */
async function startProxyWithKeys(keys, { state = null, dirPrefix = 'cc-pool-' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const statePath = join(dir, 'key-health.json');
  if (state) writeFileSync(statePath, JSON.stringify(state), 'utf-8');

  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    apiKeys: keys,
    keyFailover: true,
    keyStateFile: statePath,
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
    port, logs, dir, statePath,
    stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); }),
  };
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

  await t.test('weekly usage limit wording triggers failover', async () => {
    fake.state.rule = { status: 429, message: "You've reached your weekly usage limit for your plan. Your limit resets tomorrow. Please upgrade your plan to continue." };
    const dir = mkdtempSync(join(tmpdir(), 'cc-quota-wording-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      host: '127.0.0.1', apiBase: `http://127.0.0.1:${upstreamPort}`,
      apiKeys: [KEY_A, KEY_B], keyFailover: true,
      keyStateFile: join(dir, 'key-health.json'),
    }), 'utf-8');
    const port = await freePort();
    const child = spawn(process.execPath, [PROXY_PATH], {
      cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CC_CONFIG: join(dir, 'config.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', d => logs.push(d.toString()));
    child.stderr.on('data', d => logs.push(d.toString()));
    await waitForHealth(port, child, logs);
    t.after(() => new Promise(r => { child.once('exit', r); child.kill('SIGKILL'); setTimeout(r, 2000); }));
    const before = fake.state.calls;
    const res = await call(port);
    assert.equal(res.status, 429);
    assert.equal(fake.state.calls - before, 2, 'quota response must try the backup account');
  });

  await t.test('a quota-exhausted account is never used as a failover fallback', async () => {
    // 复现线上问题：主账号（KEY_A）额度已耗尽并处于一周冷却，备用账号（KEY_B）
    // 偶发抖动（这里是上游瞬时 503）。代理绝不能把备用账号的抖动转移到仍在冷却的
    // 主账号上 —— 否则用户会反复看到「额度不足」，而一周冷却形同虚设。
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const proxy = await startProxyWithKeys([KEY_A, KEY_B], {
      dirPrefix: 'cc-fallback-',
      state: breakerState([
        [KEY_A, { kind: 'quota', status: 400, until: Date.now() + WEEK_MS, failures: 40 }],
      ]),
    });
    t.after(() => proxy.stop());

    // 备用账号第一次调用成功、第二次瞬时 503 → 会触发「首字节前换账号」重试路径
    fake.state.rule = (n) => (n % 2 === 1 ? 'ok' : { status: 503, message: 'transient upstream blip' });

    const before = fake.state.calls;
    await call(proxy.port);
    await call(proxy.port);
    const used = fake.state.calls - before;

    // 关键断言：冷却中的主账号一次都不该被调用（按上游实际收到的密钥断言，不看日志文案）
    const keysUsed = fake.state.authSeen.slice(-used);
    assert.ok(
      !keysUsed.includes(KEY_A),
      `a quota-cooled account must never be tried again while cooling, saw: ${JSON.stringify(keysUsed)}`,
    );
    assert.doesNotMatch(proxy.logs.join(''), /insufficient credits/);
    assert.ok(used >= 2, `backup account should serve the requests, saw ${used} upstream call(s)`);
  });

  await t.test('legacy "other" quota state is reclassified on restart', async () => {
    // 历史状态里「积分耗尽」被记成了 kind:"other"（旧版本的 400 分类 bug）。
    // 重启后必须按留存的 status+message 重新判定为 quota，否则这个账号会重新获得
    // 兜底候选资格 —— 线上正是这样反复触发「额度不足」的。
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const proxy = await startProxyWithKeys([KEY_A, KEY_B], {
      dirPrefix: 'cc-legacy-',
      state: breakerState([
        [KEY_A, {
          kind: 'other', status: 400, until: Date.now() + WEEK_MS, failures: 40,
          message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.',
        }],
      ]),
    });
    t.after(() => proxy.stop());

    // 备用账号抖动 → 若不重新分类，请求会被丢回冷却中的主账号
    fake.state.rule = (n) => (n % 2 === 1 ? 'ok' : { status: 503, message: 'transient upstream blip' });

    const before = fake.state.calls;
    await call(proxy.port);
    await call(proxy.port);
    const keysUsed = fake.state.authSeen.slice(-(fake.state.calls - before));

    assert.match(proxy.logs.join(''), /"reclassified":1/, 'legacy quota state must be reclassified');
    assert.ok(
      !keysUsed.includes(KEY_A),
      `a reclassified quota-cooled account must not be reused, saw: ${JSON.stringify(keysUsed)}`,
    );
  });

  await t.test('400 + insufficient credits is classified as quota and fails over', async () => {
    // CC 用 400（而不是 402/429）表达积分耗尽。这种响应必须被识别为额度问题：
    // 既直接跳到最长冷却，也要能切到还有额度的账号。
    fake.state.rule = {
      status: 400,
      message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.',
    };
    const proxy = await startProxyWithKeys([KEY_A, KEY_B], { dirPrefix: 'cc-400quota-' });
    t.after(() => proxy.stop());

    const before = fake.state.calls;
    const res = await call(proxy.port);
    assert.equal(res.status, 400);
    assert.equal(fake.state.calls - before, 2, 'a credit-exhausted 400 must try the backup account');
    assert.match(proxy.logs.join(''), /"kind":"quota"/, 'the 400 must be classified as quota');
    assert.equal(lastCooldownMs(proxy.logs), WEEK, 'quota 400s must jump to the one-week cap');
  });

  await t.test('a genuine non-credit 400 still does not fail over', async () => {
    // 反向保护：普通请求类 400（不含量额文案）不该白跑一遍备用账号。
    fake.state.rule = { status: 400, message: 'messages: field required' };
    const proxy = await startProxyWithKeys([KEY_A, KEY_B], { dirPrefix: 'cc-400plain-' });
    t.after(() => proxy.stop());

    const before = fake.state.calls;
    const res = await call(proxy.port);
    assert.equal(res.status, 400);
    assert.equal(fake.state.calls - before, 1, 'an ordinary 400 must not burn the backup account');
    assert.match(proxy.logs.join(''), /not key-related/);
  });

  await t.test('when every account is quota-cooled the real error is still surfaced', async () => {
    // 全池冷却时不能退化成 401「缺少密钥」，必须把上游真实错误透传出来。
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    fake.state.rule = {
      status: 400,
      message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.',
    };
    const proxy = await startProxyWithKeys([KEY_A, KEY_B], {
      dirPrefix: 'cc-allcool-',
      state: breakerState([
        [KEY_A, { kind: 'quota', status: 400, until: Date.now() + WEEK_MS }],
        [KEY_B, { kind: 'quota', status: 400, until: Date.now() + WEEK_MS }],
      ]),
    });
    t.after(() => proxy.stop());

    const res = await call(proxy.port);
    assert.equal(res.status, 400, 'the upstream quota error must reach the client');
    assert.match(await res.text(), /insufficient credits/);
  });
});
