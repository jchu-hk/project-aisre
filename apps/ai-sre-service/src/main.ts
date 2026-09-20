import * as http from 'http';
import { loadConfig, resolveConfigPath } from './config/loader';
import { SreConfig, isOnboarding, isIntakeEnabled } from './config/types';
import { createAdapter, registeredAdapterTypes } from './adapters';
import { buildIntake, IntakeRuntime } from './intake';
import { LifecycleLedger } from './lifecycle/ledger';
import { buildQueryHandle } from './query/http';
import { IncomingMessage, ServerResponse } from 'http';
import {
  buildAudit,
  AuditRuntime,
  emitIntakeReceived,
  emitLifecycleChanged,
} from './audit';

/** 构建一个极简 HTTP 处理器（仅 /health + / 概览） */
function buildHandler(
  config: SreConfig,
  getIntake: () => IntakeRuntime,
  getAudit: () => AuditRuntime,
): http.RequestListener {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') {
      const intake = getIntake();
      const audit = getAudit();
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
        audit: {
          chain_head: audit.store.head(),
          writer: audit.writer.stats(),
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

  // —— audit 运行时（SQLite 单文件 + WAL + 有界异步队列）——
  // 可通过 env AUDIT_DB_PATH 覆盖；默认 data/audit.db。
  const audit: AuditRuntime = buildAudit({
    dbPath: process.env.AUDIT_DB_PATH || undefined,
    defaultActor: 'audit-console',
  });

  // 单一 request 监听器：intake 收报优先，audit 读次之，query 读再次，最后基础处理器
  // （避免多 listener 竞态写头）
  const intake: IntakeRuntime = buildIntake(config);
  const ledger = new LifecycleLedger(); // 进程内参照：lifecycle ledger + query audit
  const base = buildHandler(config, () => intake, () => audit);
  const query = buildQueryHandle({
    store: intake.store,
    ledger,
    // per-system ACL（AC-016b）：以受管系统为所辖集；空=待接入→空集（fail-closed 空结果）
    aclSystems: config.systems.map((s) => s.system_id),
    issueBaseUrl: null, // GitHub host/profile 注入 URL 由网关/issue-gateway 提供；此处回 issue_id
    defaultActor: 'query-console',
  });
  const server = http.createServer();
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (intake.handle(req, res)) {
      // 埋点：intake 收报成功（异步落盘，不阻塞主链路）
      emitIntakeFromResponse(req, res, audit);
      return;
    }
    if (audit.handle(req, res)) return; // audit 已处理（含 4xx/405）
    if (query(req, res)) return; // query 已处理（含 4xx）
    base(req, res);
  });

  server.listen(port, host, () => {
    console.log(`[ai-sre-service] 监听 http://${host}:${port} (GET /health)`);
    console.log(`[ai-sre-service] Audit (F-AUDIT): GET /api/v1/audit/events|events/{id}|verify`);
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

/**
 * intake 埋点：仅对收报端点（POST .../intake/...）在成功派发后记一条审计。
 * 由于本层不解析 body（body 归 intake 层），此处记录「已受理」这一主体动作级事件；
 * 更细的 incident/issue 关联由摄入流程回填（见 emitLifecycleChanged）。
 */
function emitIntakeFromResponse(
  req: IncomingMessage,
  res: ServerResponse,
  audit: AuditRuntime,
): void {
  const url = (req.url ?? '/').split('?')[0];
  if (!url.includes('/intake/')) return;
  const channel = url.slice(url.lastIndexOf('/') + 1) || 'intake';
  res.on('finish', () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    emitIntakeReceived(audit.writer, {
      incident_id: null,
      channel,
      at: new Date().toISOString(),
      ok,
      reason: ok ? null : `http_${res.statusCode}`,
    });
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

// 保证 emitLifecycleChanged 被引用（供后续 lifecycle 装配接线；避免未使用告警）
void emitLifecycleChanged;
