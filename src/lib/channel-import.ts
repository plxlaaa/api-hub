/**
 * 公益站批量聚合导入的纯解析（零外部依赖，可被 Node test runner 直接测）。
 *
 * 支持两种行格式：
 * 1. 竖线完整格式：名称 | baseUrl | apiKey | 模型列表(可选) | apiFormat(可选)
 * 2. 两段速记格式：baseUrl,key（逗号/制表符/空白分隔），名称自动取 host
 * `#` 开头的行为注释忽略；空行忽略。
 */

export interface ParsedChannelLine {
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  apiFormat: 'openai' | 'anthropic'
}

export interface ParseImportResult {
  channels: ParsedChannelLine[]
  failed: Array<{ line: number; error: string }>
}

const NAME_MAX = 30

/** 从 baseUrl 提取可读名称：host 去掉 www. 前缀（如 api.foo.com）；失败回退整串截断 */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host.slice(0, NAME_MAX)
  } catch {
    return url.replace(/^https?:\/\//, '').slice(0, NAME_MAX)
  }
}

export function parseImportLines(text: string): ParseImportResult {
  const channels: ParsedChannelLine[] = []
  const failed: ParseImportResult['failed'] = []
  const seen = new Map<string, number>() // 去重：同 baseUrl+key 只留首行

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    const lineNo = i + 1

    let parts: string[]
    let name = ''
    if (raw.includes('|')) {
      parts = raw.split('|').map((s) => s.trim())
      name = parts[0] ?? ''
      parts = parts.slice(1) // 剩余为 url / key / models / format
    } else {
      // 两段速记：url,key —— url 不含逗号/空白，key(sk-xxx) 同样，首个分隔符即边界
      parts = raw.split(/[,\t\s]+/).map((s) => s.trim()).filter(Boolean)
    }

    const [baseUrl, apiKey, modelsRaw, formatRaw] = parts
    if (!baseUrl || !apiKey) {
      failed.push({ line: lineNo, error: `需「名称 | baseUrl | apiKey」或「baseUrl, apiKey」（识别到 ${parts.length} 段）` })
      continue
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      failed.push({ line: lineNo, error: 'baseUrl 需以 http(s):// 开头' })
      continue
    }
    const dedupeKey = `${baseUrl.replace(/\/+$/, '')}::${apiKey}`
    if (seen.has(dedupeKey)) {
      failed.push({ line: lineNo, error: `与第 ${seen.get(dedupeKey)} 行重复（同地址同 Key）` })
      continue
    }
    seen.set(dedupeKey, lineNo)

    const models = (modelsRaw || '')
      .split(/[,，;；\s]+/)
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 100) // 上游可能返回超大列表，字段上限保护

    channels.push({
      name: (name || nameFromUrl(baseUrl)).slice(0, NAME_MAX),
      baseUrl,
      apiKey,
      models,
      apiFormat: formatRaw === 'anthropic' ? 'anthropic' : 'openai',
    })
  }
  return { channels, failed }
}

/** 聚合映射：模型名 → 持有该模型的渠道名列表（多站同模型合并，是聚合路由的分组依据） */
export function aggregateModelMap(channels: Array<{ name: string; models: string[] }>): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const ch of channels) {
    for (const m of ch.models) {
      const list = map.get(m)
      if (list) {
        if (!list.includes(ch.name)) list.push(ch.name)
      } else {
        map.set(m, [ch.name])
      }
    }
  }
  return map
}
