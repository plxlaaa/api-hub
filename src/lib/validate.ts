/**
 * 轻量参数校验（零依赖，替代散落的 typeof 判断）。
 *
 * 现状问题：各路由手写 `if (typeof name !== 'string' || !name.trim())` 这类校验，
 * 问题有三：
 * 1) 不一致 —— 有的路由校验了长度上限，有的没校验（超长 remark/模型名直接入库）；
 * 2) 错误信息不统一 —— 有的说「必填」，有的说「不能为空」，前端难以统一提示；
 * 3) 类型收窄靠重复 as 断言，易漏。
 *
 * 这里提供链式校验器，一次声明即得到「取值 + 类型收窄 + 统一错误信息」。
 * 不引入 zod 等依赖：项目定位是个人单机部署，依赖越少升级风险越低。
 *
 * 用法：
 *   const v = new Validator(body)
 *   const name = v.string('name', { min: 1, max: 80 })
 *   if (v.failed()) return v.response()   // 统一 400
 *   // 此后 name 的类型已被收窄为 string
 */

export interface FieldIssue {
  field: string
  message: string
}

export class ValidationError extends Error {
  readonly issues: FieldIssue[]
  constructor(issues: FieldIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('; '))
    this.name = 'ValidationError'
    this.issues = issues
  }
}

interface StringOptions {
  /** 去除首尾空白后再判空（默认 true，对文本类字段几乎总是想要的） */
  trim?: boolean
  min?: number
  max?: number
  /** 必填：缺失或空串即报错（默认 false） */
  required?: boolean
  /** 允许的枚举值；给出后非枚举值一律拒绝 */
  oneOf?: readonly string[]
  /** 正则约束（如模型名格式） */
  pattern?: RegExp
  /** pattern 校验失败时的提示语 */
  patternMessage?: string
}

export class Validator {
  private readonly source: Record<string, unknown>
  private readonly issues: FieldIssue[] = []

  constructor(source: unknown) {
    this.source = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>
  }

  private fail(field: string, message: string): void {
    this.issues.push({ field, message })
  }

  /** 是否存在校验失败 */
  failed(): boolean {
    return this.issues.length > 0
  }

  /** 全部问题（可读文本，直接给前端展示） */
  getIssues(): FieldIssue[] {
    return [...this.issues]
  }

  /** 拼接成单行错误信息 */
  message(): string {
    return this.issues.map((i) => `${i.field} ${i.message}`).join('；')
  }

  /**
   * 校验字符串字段。
   * @returns 校验通过返回值（已 trim）；未通过返回空串，由 failed() 统一决定是否中断。
   */
  string(field: string, opts: StringOptions = {}): string {
    const { trim = true, min, max, required = false, oneOf, pattern, patternMessage } = opts
    const raw = this.source[field]

    if (raw === undefined || raw === null) {
      if (required) this.fail(field, '为必填项')
      return ''
    }
    // 显式拒绝非字符串：避免把对象/数组悄悄 toString 成 "[object Object]" 入库
    if (typeof raw !== 'string') {
      this.fail(field, '必须为字符串')
      return ''
    }
    const v = trim ? raw.trim() : raw
    if (!v) {
      if (required) this.fail(field, '不能为空')
      return ''
    }
    if (min !== undefined && v.length < min) {
      this.fail(field, `长度至少 ${min} 个字符`)
      return ''
    }
    if (max !== undefined && v.length > max) {
      this.fail(field, `长度不能超过 ${max} 个字符`)
      return ''
    }
    if (oneOf && !oneOf.includes(v)) {
      this.fail(field, `取值必须是：${oneOf.join(' / ')}`)
      return ''
    }
    if (pattern && !pattern.test(v)) {
      this.fail(field, patternMessage || '格式不正确')
      return ''
    }
    return v
  }

  /**
   * 校验可选字符串：未提供返回 undefined（表示「不修改该字段」），
   * 与 string() 的空串语义区分开，供 PUT/PATCH 局部更新使用。
   */
  optionalString(field: string, opts: Omit<StringOptions, 'required'> = {}): string | undefined {
    const raw = this.source[field]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'string' && raw.trim() === '') return '' // 显式空串 = 清空
    return this.string(field, opts)
  }

  /**
   * 校验布尔字段。缺省返回 undefined。
   * 仅接受真正的布尔值与 'true'/'false'/'1'/'0' —— 不把任意字符串当真值
   * （'false' 转成true 是经典 bug）。
   */
  boolean(field: string): boolean | undefined {
    const raw = this.source[field]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 1 || raw === '1') return true
    if (raw === 'false' || raw === 0 || raw === '0') return false
    this.fail(field, '必须为布尔值')
    return undefined
  }

  /**
   * 校验整数。null/undefined/'' 返回 undefined（= 不限，取决于调用方语义）。
   * @param min 下界（含）；非正整数下限传 0 表示无下界
   */
  integer(field: string, opts: { min?: number; max?: number } = {}): number | undefined {
    const { min, max } = opts
    const raw = this.source[field]
    if (raw === undefined || raw === null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      this.fail(field, '必须为数字')
      return undefined
    }
    if (!Number.isInteger(n)) {
      this.fail(field, '必须为整数')
      return undefined
    }
    if (min !== undefined && min > 0 && n < min) {
      this.fail(field, `不能小于 ${min}`)
      return undefined
    }
    if (max !== undefined && n > max) {
      this.fail(field, `不能大于 ${max}`)
      return undefined
    }
    return n
  }

  /** 校验字符串数组；接受数组或换行/逗号分隔的裸字符串（与前端输入框格式一致） */
  stringArray(field: string, opts: { max?: number; itemMax?: number } = {}): string[] {
    const { max = 200, itemMax = 200 } = opts
    const raw = this.source[field]
    if (raw === undefined || raw === null || raw === '') return []
    let items: string[]
    if (Array.isArray(raw)) {
      items = raw.map((x) => String(x).trim()).filter(Boolean)
    } else if (typeof raw === 'string') {
      items = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      this.fail(field, '必须为字符串数组')
      return []
    }
    if (items.length > max) {
      this.fail(field, `条目不能超过 ${max} 个`)
      return items.slice(0, max)
    }
    const tooLong = items.find((s) => s.length > itemMax)
    if (tooLong) {
      this.fail(field, `单个条目长度不能超过 ${itemMax} 个字符`)
      return []
    }
    return items
  }

  /** 校验 JSON 对象（用于 metadata / channelConfigs 等） */
  object(field: string): Record<string, unknown> | undefined {
    const raw = this.source[field]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'string') {
      const t = raw.trim()
      if (!t) return undefined
      try {
        const parsed = JSON.parse(t)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        this.fail(field, '必须为 JSON 对象')
        return undefined
      } catch {
        this.fail(field, '不是合法 JSON')
        return undefined
      }
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    this.fail(field, '必须为对象')
    return undefined
  }

  /** 校验枚举字段（字符串） */
  enum<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const raw = this.source[field]
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
      this.fail(field, `取值必须是：${allowed.join(' / ')}`)
      return undefined
    }
    return raw as T
  }

  /** 抛出聚合异常（供服务层复用；路由层建议用 failed()+errorResponse()） */
  throwIfFailed(): void {
    if (this.failed()) throw new ValidationError(this.getIssues())
  }
}

/**
 * 由校验器直接产出统一 400 响应。
 * 一次返回全部问题，而不是「修一个报一个」——前端可以一次把表单标全。
 */
export function validationResponse(v: Validator): Response {
  const issues = v.getIssues()
  return Response.json(
    { error: v.message(), fields: Object.fromEntries(issues.map((i) => [i.field, i.message])) },
    { status: 400 }
  )
}