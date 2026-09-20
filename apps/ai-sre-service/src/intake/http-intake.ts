/**
 * intake/http-intake.ts
 *
 * 内置收报 HTTP 通道（webhook / webform 统一语义，F-SRE-014 §3.11.1）。
 *
 * 为主进程提供「单一收报 CPU 处理器」——由 main.ts 把它并入同一 request
 * 监听器（与基础 /health、/ 概览串行），避免多独立 request listener 相互
 * 竞态导致 ERR_HTTP_HEADERS_SENT。
 *
 * 约定（通用，可配置 prefix）：
 *   POST {prefix}/intake/{channelName}    JSON webhook/webform 体 → RawReport
 *   内容类型：application/json → 直接映射字段；表单 → 同 key。
 *
 * intake_channels 为空或全部禁用 → 不注册任何路由、不报错（待接入态）。
 * 通道自定义字段（path/prefix/verb）缺省按上述约定；可在通道额外给出。
 */

import { IncomingMessage, ServerResponse } from 'http';
import { SreConfig, IntakeChannel } from '../config/types';
import { IntakeService } from './ingestion';
import { RawReport } from './normalize';

export interface MountedRoute {
  path: string;
  channel: string;
  method: string;
}

/**
 * 收报 CPU 处理器：精确匹配 {method} {path} 的 intake 请求。
 * @returns true=已处理（调用方必须停止后续处理，不得再写响应）；false=非 intake 路由
 */
export type IntakeHandle = (req: IncomingMessage, res: ServerResponse) => boolean;

/** 收集 body 为 UTF-8 字符串 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** 从入站报文解析为 RawReport（webhook JSON / webform form 通用 key 映射） */
function toRawReport(contentType: string, raw: string): RawReport {
  const ct = (contentType || '').toLowerCase();
  const trimmed = raw.trim();
  try {
    if (ct.includes('json') || trimmed.startsWith('{')) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        // 兼容常见封装：{payload|incident:{...}} 否则取顶层字段
        const inner = (obj.payload ?? obj.incident) || obj;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          return inner as RawReport;
        }
      }
      return obj as RawReport;
    }
    if (ct.includes('form')) {
      const o: RawReport = {};
      for (const pair of raw.split('&')) {
        const idx = pair.indexOf('=');
        if (idx < 0) continue;
        const k = decodeURIComponent(pair.slice(0, idx));
        const v = decodeURIComponent(pair.slice(idx + 1));
        (o as Record<string, unknown>)[k] = v;
      }
      return o;
    }
  } catch {
    /* 解析失败落到整段当 symptom */
  }
  // 未知 text → 整段作为现象（补缺；缺 system_id 等由校验兜底）
  return { symptom_desc: trimmed.slice(0, 4000) } as RawReport;
}

/**
 * 构建 intake 收报处理器（并入 main.ts 单一 request 监听器）。
 */
export function makeIntakeHandle(routes: MountedRoute[], service: IntakeService): IntakeHandle {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const urlNoQuery = (req.url ?? '/').split('?')[0];
    const route = routes.find((r) => r.method === req.method && r.path === urlNoQuery);
    if (!route) return false; // 非 intake：交回 base handler
    void handleIntake(req, res, route, service);
    return true;
  };
}

async function handleIntake(
  req: IncomingMessage,
  res: ServerResponse,
  route: MountedRoute,
  service: IntakeService,
): Promise<void> {
  try {
    const bodyStr = await readBody(req);
    const contentType = req.headers['content-type'] ?? '';
    const report = toRawReport(contentType, bodyStr);

    const outcome = await service.ingest(report, {
      sourceChannel: route.channel,
      receivedAt: new Date(),
    });

    if (!outcome.ok) {
      // 428 = 缺关键字段，提示补全（UC-SRE-016 异常流）
      res.writeHead(428, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            ok: false,
            code: 'missing_required_fields',
            message: outcome.error,
            required_fields_hint:
              outcome.missingFields ?? ['system_id', 'symptom_desc', 'reported_at', 'reporter_contact'],
          },
          null,
          2,
        ),
      );
      return;
    }

    const inc = outcome.incident!;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify(
        {
          ok: true,
          incident_id: inc.incident_id,
          triage: outcome.triage?.triage,
          duplicate: outcome.triage?.duplicate_of_id ?? null,
          issue_id: outcome.issueId,
          acked: outcome.acked,
          message:
            outcome.triage?.triage === 'dup'
              ? '重复报障，已归并既有 incident'
              : outcome.triage?.triage === 'known'
              ? '已知报障，已并入处理中 Issue'
              : '已受理，incident 进入排查',
          ack_message: outcome.ackMessage,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    // 单请求独立容错：不因坏请求崩进程
    if (!res.headersSent) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: 'internal', message: (e as Error).message }));
      } catch {
        /* ignore */
      }
    }
  }
}

/** 依据 config 计算路由表 */
export function planIntakeRoutes(config: SreConfig, prefix = '/api/sre/intake'): MountedRoute[] {
  const channels: IntakeChannel[] = config.intake_channels ?? [];
  const routes: MountedRoute[] = [];
  for (const c of channels) {
    if (c.enabled === false) continue;
    const name = encodeURIComponent(c.name || c.type);
    const path =
      typeof c.path === 'string' && c.path.startsWith('/')
        ? c.path
        : `${prefix}/${name}`;
    const method = typeof c.verb === 'string' && c.verb ? c.verb.toUpperCase() : 'POST';
    routes.push({ path, channel: name, method });
  }
  return routes;
}
