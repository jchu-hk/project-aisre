/**
 * config/loader.ts
 *
 * AI SRE 配置加载器：从文件（YAML）读取运行时配置。
 *
 * 加载优先级：
 *   1. 环境变量 SRE_CONFIG_PATH 指向的文件
 *   2. 缺省路径 <workspace>/apps/ai-sre-service/config/default.yaml
 *
 * 配置结构系统无关：不含任何被纳管系统（SAS）的具体值；
 * SAS 具体拓扑/端口/路径仅存在于发行附带的示例配置
 * （config/examples/school-admin-system.yaml）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SreConfig } from './types';

/** 配置解析失败时抛出的结构化错误 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 默认配置目录（相对本服务包根目录） */
const DEFAULT_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'config',
  'default.yaml',
);

/** 解析 env 指定的配置路径，回退到默认路径 */
export function resolveConfigPath(): string {
  const envPath = process.env.SRE_CONFIG_PATH;
  if (envPath && envPath.trim().length > 0) {
    return path.resolve(envPath.trim());
  }
  return DEFAULT_CONFIG_PATH;
}

/** 校验配置结构的完整性（仅结构，不校验具体系统值） */
function validateConfig(config: unknown): asserts config is SreConfig {
  if (typeof config !== 'object' || config === null) {
    throw new ConfigError('配置必须是对象');
  }
  const c = config as Partial<SreConfig>;
  if (!c.identity || typeof c.identity.instance_id !== 'string' || typeof c.identity.listen !== 'string') {
    throw new ConfigError('配置缺少 identity.instance_id / identity.listen');
  }
  if (!Array.isArray(c.systems)) {
    throw new ConfigError('配置缺少 systems 数组（可为空 [] 表示待接入态）');
  }
}

/**
 * 从指定路径加载并解析配置（YAML）。
 * @param configPath 配置文件路径（缺省走 resolveConfigPath）
 */
export function loadConfig(configPath?: string): SreConfig {
  const resolved = configPath ?? resolveConfigPath();
  if (!fs.existsSync(resolved)) {
    throw new ConfigError(`配置文件不存在: ${resolved}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    throw new ConfigError(`读取配置失败: ${resolved} (${(e as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new ConfigError(`解析 YAML 失败: ${resolved} (${(e as Error).message})`);
  }
  validateConfig(parsed);
  return parsed;
}
