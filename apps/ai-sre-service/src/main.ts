/**
 * main.ts
 *
 * ai-sre-service 引导入口（M1 骨架）。
 *
 * 职责：
 *   1. 从 env（SRE_CONFIG_PATH）或默认 config/default.yaml 加载配置
 *   2. 启动一个最小 HTTP 服务，暴露 GET /health 健康端点
 *   3. 打印「待接入/已接入」状态，并列出已纳管系统采用的适配器
 *
 * 本骨架不承载采集/检测/自愈等核心逻辑（M2+ 交付），
 * 仅验证「配置与代码分离 + 系统无关启动」这一 M1 目标。
 */

import * as http from 'http';
import { loadConfig, resolveConfigPath } from './config/loader';
import { SreConfig, isOnboarding, isIntakeEnabled } from './config/types';
import { createAdapter, registeredAdapterTypes } from './adapters';
import { buildIntake, IntakeRuntime } from './intake';
import { LifecycleLedger } from './lifecycle/ledger';
import { buildQueryHandle } from './query/http';

/** 构建一个极简 HTTP 处理器（仅 /health + / 概览） */
function buildHandler(
  config: SreConfig,
  getIntake: () => IntakeRuntime,
): http.RequestListener {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') {
      const intake = getIntake();
      const body = {
        status: 'ok',
        service: 'ai-sre-service',
        instance_id: config.identity.instance_id,
        onboarding: isOnboarding(config),
        intake: {
          enabled: isIntakeEnabled(config),
          disabled: intake.disabled,
          channels: intake.routes.map((r) => ({
            channel: r.channel,
            path: r.path,
            method: r.method,
          })),
        },
        systems: config.systems.map((s) => ({
          system_id: s.system_id,
          adapter: s.adapter,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    if (url === '/api/sre/intake/status') {
      const intake = getIntake();
      const body = {
        enabled: !intake.disabled,
        disabled: intake.disabled,
        routes: intake.routes,
        states: intake.store.all().length,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    if (url === '/') {
      const intake = getIntake();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `ai-sre-service (${config.identity.instance_id})\n` +
          `状态: ${isOnboarding(config) ? '待接入(onboarding)' : '已接入'}\n` +
          `Intake 报障接入: ${intake.disabled ? '未启用(待接入态)' : `启用 (${intake.routes.length} 通道)`}\n` +
          `已注册适配器: ${registeredAdapterTypes().join(', ')}\n`,
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}

async function bootstrap(): Promise<void> {
  const configPath = resolveConfigPath();
  console.log(`[ai-sre-service] 加载配置: ${configPath}`);

  const config: SreConfig = loadConfig(configPath);
  console.log(`[ai-sre-service] 实例: ${config.identity.instance_id}`);
  console.log(`[ai-sre-service] 已注册适配器类型: ${registeredAdapterTypes().join(', ')}`);

  if (isOnboarding(config)) {
    console.log('[ai-sre-service] 状态: 待接入（systems 为空）');
  } else {
    console.log(`[ai-sre-service] 状态: 已接入 ${config.systems.length} 个系统`);
    for (const s of config.systems) {
      const adapter = createAdapter(s.adapter, s.system_id, s);
      console.log(
        `  - system_id=${s.system_id} adapter=${s.adapter} capabilities=[${adapter
          .capabilities()
          .join(', ')}]`,
      );
    }
  }

  const [host, portStr] = parseListen(config.identity.listen);
  const port = Number(portStr);

  // 单一 request 监听器：intake 收报优先，query 读次之，最后基础处理器（避免多 listener 竞态写头）
  const intake: IntakeRuntime = buildIntake(config);
  const ledger = new LifecycleLedger(); // 进程内参照：lifecycle ledger + query audit
  const base = buildHandler(config, () => intake);
  const query = buildQueryHandle({
    store: intake.store,
    ledger,
    // per-system ACL（AC-016b）：以受管系统为所辖集；空=待接入→空集（fail-closed 空结果）
    aclSystems: config.systems.map((s) => s.system_id),
    issueBaseUrl: null, // GitHub host/profile 注入 URL 由网关/issue-gateway 提供；此处回 issue_id
    defaultActor: 'query-console',
  });
  const server = http.createServer();
  server.on('request', (req, res) => {
    if (intake.handle(req, res)) return; // intake 已处理
    if (query(req, res)) return; // query 已处理（含 4xx）
    base(req, res);
  });

  server.listen(port, host, () => {
    console.log(`[ai-sre-service] 监听 http://${host}:${port} (GET /health)`);
    if (intake.disabled) {
      console.log('[ai-sre-service] User Intake (F-SRE-014): 未启用（intake_channels 为空 = 待接入态）');
    } else {
      console.log(`[ai-sre-service] User Intake (F-SRE-014): 启用 ${intake.routes.length} 通道`);
      for (const r of intake.routes) {
        console.log(`  - ${r.method} ${r.path} (channel=${r.channel})`);
      }
    }
  });
}

/** 解析 "host:port" 监听地址 */
function parseListen(listen: string): [string, string] {
  const idx = listen.lastIndexOf(':');
  if (idx < 0) return ['0.0.0.0', listen];
  const host = listen.slice(0, idx);
  const port = listen.slice(idx + 1);
  return [host || '0.0.0.0', port];
}

bootstrap().catch((err) => {
  console.error('[ai-sre-service] 启动失败:', err);
  process.exit(1);
});
