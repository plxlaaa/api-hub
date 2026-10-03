'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import type { ModelRoute } from '@/types'

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const ok = await copyToClipboard(code)
    if (!ok) return toast.error('复制失败，请手动复制')
    setCopied(true)
    toast.success('已复制到剪贴板')
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="group relative">
      <pre className="max-h-96 overflow-auto rounded-md bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-100">
        <code>{code}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md bg-zinc-800 p-2 text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white"
        aria-label="复制代码"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const emptySubscribe = () => () => {}
const getOriginSnapshot = () => window.location.origin
const getOriginServer = () => ''

export function UsageTab() {
  const origin = useSyncExternalStore(emptySubscribe, getOriginSnapshot, getOriginServer)

  const { data: routes = [] } = useQuery<ModelRoute[]>({
    queryKey: ['routes'],
    queryFn: () => api('/api/routes'),
  })
  const { data: tokens = [] } = useQuery<{ id: string; key: string }[]>({
    queryKey: ['tokens'],
    queryFn: () => api('/api/tokens'),
  })

  const modelNames = useMemo(() => routes.filter((r) => r.enabled).map((r) => r.displayName), [routes])
  const demoModel = modelNames[0] || 'my-model'
  const demoKey = tokens[0]?.key || 'sk-gw-xxxx'
  const baseUrl = `${origin}/v1`

  const curl = `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${demoKey}" \\
  -d '{
    "model": "${demoModel}",
    "messages": [
      { "role": "user", "content": "你好，介绍一下你自己" }
    ],
    "stream": true
  }'`

  const python = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${demoKey}",
)

resp = client.chat.completions.create(
    model="${demoModel}",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")`

  const node = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${demoKey}",
});

const stream = await client.chat.completions.create({
  model: "${demoModel}",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`

  const cli = `# API Hub 命令行管理工具（零依赖，Node 18+，位于项目 server/cli.mjs）
# 配置：GW_URL（网关地址）、GW_TOKEN（管理 JWT）、GW_KEY（统一调用密钥）

# 登录并保存管理令牌（之后不用再输）
node server/cli.mjs login <管理密码> --save

# 总览：渠道在线状态 / 今日调用 / 密钥配额
node server/cli.mjs status

# 渠道管理
node server/cli.mjs channel list -v
node server/cli.mjs channel add 某公益站 https://api.example.com sk-xxx --models gpt-4o-mini,claude-3-5-sonnet
node server/cli.mjs channel add Claude站 https://api.example.com sk-xxx --format anthropic --models claude-3-5-sonnet
node server/cli.mjs channel probe            # 全部探测；probe 某站 探测单个
node server/cli.mjs channel disable 某公益站

# 路由管理
node server/cli.mjs route add gpt-4o gpt-4o 某公益站,备用站 --strategy speed
node server/cli.mjs route list

# 密钥管理（--save 保存后 gw chat 自动走统一入口）
node server/cli.mjs token create 分享密钥 --quota 100 --save
node server/cli.mjs token list

# 对话测试（无 GW_KEY 走管理测试，有则走统一入口）
node server/cli.mjs chat ${demoModel || '模型名'} 你好

# 日志 / 统计 / 备份
node server/cli.mjs logs 20 --token 分享密钥
node server/cli.mjs stats
node server/cli.mjs export backup.json
node server/cli.mjs import backup.json --mode merge`

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">统一调用地址</CardTitle>
          <CardDescription>
            本网关完全兼容 OpenAI API 格式。任何支持自定义 OpenAI 接口的客户端（ChatBox、NextChat、LobeChat、沉浸式翻译等）都可以直接使用。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Base URL（OpenAI SDK 用）</p>
              <code className="mt-1 block break-all text-sm font-medium">{baseUrl}</code>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">API Key（「API 密钥」页生成）</p>
              <code className="mt-1 block text-sm font-medium">{demoKey}</code>
            </div>
          </div>
          <div className="rounded-md border border-dashed p-3">
            <p className="text-xs text-muted-foreground">可用模型名（来自「模型路由」，客户端 model 字段填这里的名字）：</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {modelNames.length === 0 ? (
                <span className="text-xs text-muted-foreground">暂无启用中的模型路由，请先到「模型路由」添加</span>
              ) : (
                modelNames.map((m) => (
                  <code key={m} className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{m}</code>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">调用示例</CardTitle>
          <CardDescription>示例使用第一个模型名与第一个密钥占位，实际替换为你自己的即可。</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="curl">
            <TabsList>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="python">Python</TabsTrigger>
              <TabsTrigger value="node">Node.js</TabsTrigger>
              <TabsTrigger value="cli">CLI 管理</TabsTrigger>
            </TabsList>
            <TabsContent value="curl"><CopyBlock code={curl} /></TabsContent>
            <TabsContent value="python"><CopyBlock code={python} /></TabsContent>
            <TabsContent value="node"><CopyBlock code={node} /></TabsContent>
            <TabsContent value="cli"><CopyBlock code={cli} /></TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">工作原理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>1️⃣ 客户端用 <b>统一 Base URL + 统一 Key</b> 请求本网关，model 填「模型显示名」。</p>
          <p>2️⃣ 网关查「模型路由」找到对应的上游真实模型名与渠道优先级顺序。</p>
          <p>3️⃣ 依次尝试各渠道：在线渠道优先，请求失败（超时 / 5xx / 限流）自动切换到下一个渠道。</p>
          <p>4️⃣ 上游响应原样透传（支持 SSE 流式、tool calls、多模态等所有字段），客户端完全无感。</p>
          <p>5️⃣ 后台每 60 秒自动探测所有启用渠道（GET /models），仪表盘实时展示在线状态与延迟。</p>
        </CardContent>
      </Card>
    </div>
  )
}
