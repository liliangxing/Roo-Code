# 智谱 GLM — OpenAI 兼容端点使用说明

> 适用范围：本 fork 分支 `debug-zhipu-java-demo` 对 Roo CLI 新增的 `openai-compatible` provider。

## 正确的 base URL

```
https://open.bigmodel.cn/api/paas/v4
```

这是智谱开放平台**官方且唯一**的 OpenAI 兼容端点，见
<https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>。
官方文档全篇示例（对话 / 流式 / 多轮 / 函数调用 / 图像理解）均基于此端点。

## 不要使用 `api/compat`

早期版本曾误写为 `https://open.bigmodel.cn/api/compat`，该路径**不可用**，实测依据：

| 请求                                                 | HTTP | 返回体                                                                            | `x-log-id` 响应头 |
| ---------------------------------------------------- | ---- | --------------------------------------------------------------------------------- | ----------------- |
| `api/paas/v4/chat/completions`（无鉴权）             | 401  | 智谱原生 `{"error":{"code":"1001","message":"Header中未收到Authorization参数…"}}` | ✅ 有             |
| `api/compat/chat/completions`                        | 200  | `{"code":500,"msg":"404 NOT_FOUND","success":false}`                              | ❌ 无             |
| `api/totally-bogus-xyz/chat/completions`（胡编对照） | 200  | **与上一行字节级相同**                                                            | ❌ 无             |

结论：`api/compat` 并非智谱后端暴露的路由，它和任意胡编路径一样命中前置网关的通用 404 兜底，从未到达模型服务（无 `x-log-id`）。`api/compat` 不在官方文档中，应为历史误传或已下线路径。

## CLI 调用示例

```bash
export OPENAI_API_KEY="<智谱 API Key>"
roo --print "用 Java 写一个打印 Hello 的程序并编译运行" \
    -w ./work \
    --provider openai-compatible \
    --base-url https://open.bigmodel.cn/api/paas/v4 \
    --model glm-4-flash
```

## 官方点名的兼容性差异

- `temperature` 取值区间为 `(0, 1)`；**`temperature = 0`（`do_sample = false`）在 OpenAI 调用方式下不适用**。
  若 Agent 默认把 temperature 设为 0，需改为 > 0 的小值（如 0.1）。

## 本次修复与端点无关

`MODEL_NO_TOOLS_USED` 死循环的根因是模型侧行为，与端点无关：
智谱 `glm-4-flash` 拒绝 `content` 为文本块数组，且拒绝未归一化的 `strict:true` 工具 schema。
本分支已在 `OpenAiHandler` 中对 `apiProvider === "openai-compatible"` 做了「content 拍平 + strict 降级 + schema 归一化」，对任意可达的智谱端点均生效。
