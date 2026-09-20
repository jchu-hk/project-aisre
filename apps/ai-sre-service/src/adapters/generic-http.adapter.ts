/**
 * adapters/generic-http.adapter.ts
 *
 * 通用 HTTP 适配器（内置降级路径，F-SRE-011 / DESIGN §3.1.3）。
 *
 * 对未提供专用适配器的被纳管系统做「最小接入」：
 *   - 通用 HTTP 健康探测（health_endpoints）
 *   - 日志源占位采集（log_sources，当前返回空/占位样本）
 *   - 资源指标占位（resource_probes，当前仅占位）
 *
 * 不依赖任何被纳管系统的具体组件；所有端点/日志源/探针经
 * systemConfig 注入。该适配器即「如何写一个 SystemAdapter」的最简参考。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import {
  SystemAdapter,
  AdapterCapability,
  AdapterContext,
  HealthSample,
  ResourceSample,
  LogEvent,
  DbSample,
  CacheSample,
} from './adapter.interface';
import {
  ComponentKind,
  ComponentModel,
  SystemTopology,
  PermissionDeclaration,
} from '../config/types';

/** 注入的健康端点描述（来自 systemConfig.health_endpoints） */
interface HealthEndpointSpec {
  name: string;
  url: string;
  /** 期望成功状态码（缺省 200-399 视作健康） */
  expect?: number[];
}

/** 注入的记录源描述（来自 systemConfig.log_sources） */
interface LogSourceSpec {
  type: string;
  match?: string;
}

/** 注入的资源探针描述（来自 systemConfig.resource_probes） */
interface ResourceProbeSpec {
  type: string;
  mount?: string;
}

const HTTP_TIMEOUT_MS = 5000;

/** 对单个 URL 发起只读 HTTP GET 探测 */
function httpProbe(rawUrl: string, timeoutMs: number = HTTP_TIMEOUT_MS): Promise<{
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  message?: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      resolve({ ok: false, latencyMs: 0, message: `invalid url: ${rawUrl}` });
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(
      parsed,
      { timeout: timeoutMs },
      (res) => {
        const latencyMs = Date.now() - started;
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400;
        res.resume(); // 丢弃 body，旁路不侵入
        resolve({ ok, statusCode: res.statusCode, latencyMs });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latencyMs: Date.now() - started, message: 'timeout' });
    });
    req.on('error', (err: Error) => {
      resolve({ ok: false, latencyMs: Date.now() - started, message: err.message });
    });
  });
}

/**
 * GenericHttpAdapter —— 内置通用 HTTP 降级适配器。
 */
export class GenericHttpAdapter implements SystemAdapter {
  private readonly sysId: string;
  private readonly sysConfig: Record<string, unknown>;

  constructor(systemId: string, systemConfig: Record<string, unknown>) {
    this.sysId = systemId;
    this.sysConfig = systemConfig;
  }

  systemId(): string {
    return this.sysId;
  }

  capabilities(): AdapterCapability[] {
    // 最低能力集：发现 + 健康 + 资源 + 日志（DB/缓存需专用适配器）
    return ['discover', 'health', 'resources', 'logs'];
  }

  minPrivilege(): PermissionDeclaration[] {
    // 通用降级路径仅声明只读 HTTP 探测权限
    return [
      { action: 'http_get', target: '*', read_only: true },
    ];
  }

  private healthEndpoints(): HealthEndpointSpec[] {
    return (this.sysConfig.health_endpoints as HealthEndpointSpec[]) ?? [];
  }

  private logSources(): LogSourceSpec[] {
    return (this.sysConfig.log_sources as LogSourceSpec[]) ?? [];
  }

  private resourceProbes(): ResourceProbeSpec[] {
    return (this.sysConfig.resource_probes as ResourceProbeSpec[]) ?? [];
  }

  async discover(ctx: AdapterContext): Promise<ComponentModel[]> {
    const components: ComponentModel[] = [];
    for (const ep of this.healthEndpoints()) {
      components.push({
        id: `${this.sysId}:healthEndpoint:${ep.name}`,
        kind: 'healthEndpoint',
        name: ep.name,
        endpoints: [ep.url],
        metrics: ['availability', 'latency'],
      });
    }
    for (const ls of this.logSources()) {
      components.push({
        id: `${this.sysId}:logSource:${ls.type}`,
        kind: 'logSource',
        name: ls.type,
        metrics: ['error_rate'],
      });
    }
    for (const rp of this.resourceProbes()) {
      components.push({
        id: `${this.sysId}:${rp.type}:${rp.mount ?? 'default'}`,
        kind: rp.type === 'disk' ? 'disk' : 'service',
        name: rp.type,
        metrics: ['usage'],
      });
    }
    return components;
  }

  async model(ctx?: AdapterContext): Promise<SystemTopology> {
    const components = await this.discover(ctx ?? { systemId: this.sysId, systemConfig: this.sysConfig });
    const metricMap: Record<string, string[]> = {};
    for (const c of components) {
      metricMap[c.id] = c.metrics ?? [];
    }
    return { systemId: this.sysId, components, metricMap };
  }

  async collectHealth(ctx: AdapterContext): Promise<HealthSample[]> {
    const samples: HealthSample[] = [];
    const eps = this.healthEndpoints();
    for (const ep of eps) {
      const r = await httpProbe(ep.url);
      const expectOk = !ep.expect || ep.expect.length === 0
        ? r.ok
        : (r.statusCode !== undefined && ep.expect.includes(r.statusCode));
      samples.push({
        componentId: `${this.sysId}:healthEndpoint:${ep.name}`,
        endpoint: ep.url,
        ok: expectOk,
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        message: r.message,
        sampledAt: (ctx.now ?? new Date()).toISOString(),
      });
    }
    return samples;
  }

  async collectResources(_ctx: AdapterContext): Promise<ResourceSample[]> {
    // 占位：通用降级路径无资源运行时探测（需 Docker/专用适配器）。
    // 仅对配置声明的资源探针返回空占位样本，保证接口契约可调用。
    const samples: ResourceSample[] = [];
    for (const rp of this.resourceProbes()) {
      samples.push({
        componentId: `${this.sysId}:${rp.type}:${rp.mount ?? 'default'}`,
        kind: rp.type === 'disk' ? 'disk' : 'service',
        metric: 'usage',
        value: -1, // -1 = 未采集（需专用适配器）
        unit: 'percent',
        sampledAt: (_ctx.now ?? new Date()).toISOString(),
      });
    }
    return samples;
  }

  async collectLogs(_ctx: AdapterContext): Promise<LogEvent[]> {
    // 占位：通用降级路径不直接订阅具体日志后端，返回空；
    // 专用适配器（如 Docker Adapter）负责真实日志订阅。
    return [];
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    // 适配器自身健康：有健康端点时以探测是否「可执行」为准；
    // 无端点配置时视为可用（待接入/占位）。
    return { ok: true, detail: `generic-http adapter for ${this.sysId}` };
  }
}
