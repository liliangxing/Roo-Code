#!/usr/bin/env bash
# roo-zhipu-java-agent.sh
# 模拟 Roo-Code 通过 OpenAI 兼容 API 调用智谱 GLM-4-Flash
# 实现: 自然语言 -> 生成 Java -> 编译 -> 自动修复 -> 运行
#
# 智谱 OpenAI 兼容端点: https://open.bigmodel.cn/api/paas/v4/chat/completions
# Roo-Code 配置方式: Provider 选 OpenAI Compatible,
#   Base URL: https://open.bigmodel.cn/api/paas/v4
#   API Key: d7640538c3f245a59b3a1d1bf9862d47.mcOUKUYV9o6OY2n4
#   Model: glm-4-flash

set -uo pipefail

ZHIPU_API_KEY="${ZHIPU_API_KEY:-d7640538c3f245a59b3a1d1bf9862d47.mcOUKUYV9o6OY2n4}"
ZHIPU_MODEL="${ZHIPU_MODEL:-glm-4-flash}"
API_URL="https://open.bigmodel.cn/api/paas/v4/chat/completions"
MAX_FIX_ROUNDS="${MAX_FIX_ROUNDS:-3}"
WORKDIR="${WORKDIR:-$(pwd)/roo_zhipu_work}"

c_red()    { printf "\033[31m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
c_blue()   { printf "\033[36m%s\033[0m\n" "$*"; }
c_dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

if [[ $# -lt 1 ]]; then
  c_red "用法: $0 \"<自然语言描述>\""
  exit 2
fi
PROMPT="$1"

mkdir -p "$WORKDIR"
: > "$WORKDIR/run.log"

call_model() {
  local sys="$1"; local user="$2"
  local payload
  payload=$(jq -n --arg s "$sys" --arg u "$user" --arg m "$ZHIPU_MODEL" \
    '{model:$m, messages:[{role:"system",content:$s},{role:"user",content:$u}], temperature:0.2, top_p:0.8}')
  local resp
  resp=$(curl -sS --max-time 90 "$API_URL" \
    -H "Authorization: Bearer $ZHIPU_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload") || { c_red "API 请求失败"; return 1; }
  local err
  err=$(echo "$resp" | jq -r '.error.message // empty' 2>/dev/null)
  if [[ -n "$err" ]]; then
    c_red "模型返回错误: $err"
    return 1
  fi
  echo "$resp" | jq -r '.choices[0].message.content // empty'
}

extract_java() {
  local text="$1"
  local code
  code=$(echo "$text" | awk '/^```(java|Java|JAVA)?[[:space:]]*$/{f=1;next}/^```[[:space:]]*$/{if(f)f=0;next}f{print}')
  if [[ -z "$code" ]]; then
    code=$(echo "$text" | sed -n '/^\s*\(public \)\{0,1\}\(abstract \)\{0,1\}\(final \)\{0,1\}class /,/^}/p')
  fi
  if [[ -z "$code" ]]; then
    code=$(echo "$text" | grep -v '^```' | grep -v '^\s*$')
  fi
  echo "$code"
}

infer_main_class() {
  local code="$1"
  local name
  name=$(echo "$code" | grep -oE 'public[[:space:]]+(abstract[[:space:]]+|final[[:space:]]+)?class[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' | head -1 | awk '{print $NF}')
  if [[ -z "$name" ]]; then
    name=$(echo "$code" | grep -oE 'class[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' | head -1 | awk '{print $NF}')
  fi
  echo "$name"
}

sanitize_imports() {
  local f="$1"
  local imports
  imports=$(grep -nE '^\s*import\s+' "$f" | awk -F: '{print $2}' | awk '!seen[$0]++')
  if [[ -z "$imports" ]]; then return 0; fi
  local tmp; tmp=$(mktemp)
  { echo "$imports"; grep -vE '^\s*import\s+' "$f"; } > "$tmp"
  mv "$tmp" "$f"
}

c_blue "==================== Roo-Code + 智谱 Java Agent ===================="
c_dim "模型: $ZHIPU_MODEL (OpenAI 兼容端点)"
c_dim "任务: $PROMPT"
echo ""

GEN_SYS="你是一名资深 Java 工程师。根据用户的自然语言需求, 输出一个完整可直接编译运行的 Java 源文件。
要求:
1. 只输出一个 public class, 含 main 方法可直接运行。
2. 代码必须用 \`\`\`java 代码块包裹。
3. 不要外部依赖, 只用 JDK 标准库。
4. 所有 import 语句必须在 class 声明之前, 绝不能出现在类体或方法体内部。
5. 不要多余解释。"

c_blue "[1/4] 生成 Java 代码..."
GEN_OUT=$(call_model "$GEN_SYS" "$PROMPT")
CODE=$(extract_java "$GEN_OUT")
MAIN_CLASS=$(infer_main_class "$CODE")
SRC_FILE="$WORKDIR/$MAIN_CLASS.java"
printf '%s\n' "$CODE" > "$SRC_FILE"
sanitize_imports "$SRC_FILE"
c_green "✓ 生成: $SRC_FILE (主类: $MAIN_CLASS)"
echo ""

OUTDIR="$WORKDIR/out"
mkdir -p "$OUTDIR"

c_blue "[2/4] 编译..."
if javac -nowarn -encoding UTF-8 -d "$OUTDIR" "$SRC_FILE" 2>"$WORKDIR/last_errors.txt"; then
  c_green "✓ 编译成功"
else
  c_yellow "✗ 编译失败, 进入自动修复..."
fi

ROUND=0
while [[ -s "$WORKDIR/last_errors.txt" ]]; do
  ROUND=$((ROUND+1))
  if [[ $ROUND -gt $MAX_FIX_ROUNDS ]]; then
    c_red "✗ 达到最大修复轮次 ($MAX_FIX_ROUNDS)"
    cat "$WORKDIR/last_errors.txt"
    exit 1
  fi
  c_blue "[3/4] 自动修复 第 $ROUND 轮..."
  ERRORS=$(cat "$WORKDIR/last_errors.txt")
  FIX_SYS="你是 Java 编译错误修复专家。输出修复后的完整源文件, 用 \`\`\`java 包裹。所有 import 在 class 前。不引入外部依赖。不要解释。"
  FIX_USER="源代码 ($MAIN_CLASS.java):
\`\`\`java
$(cat "$SRC_FILE")
\`\`\`

javac 错误:
\`\`\`
$ERRORS
\`\`\`"
  FIX_OUT=$(call_model "$FIX_SYS" "$FIX_USER")
  NEW_CODE=$(extract_java "$FIX_OUT")
  NEW_CLASS=$(infer_main_class "$NEW_CODE")
  if [[ "$NEW_CLASS" != "$MAIN_CLASS" ]]; then
    rm -f "$SRC_FILE"; SRC_FILE="$WORKDIR/$NEW_CLASS.java"; MAIN_CLASS="$NEW_CLASS"
  fi
  printf '%s\n' "$NEW_CODE" > "$SRC_FILE"
  sanitize_imports "$SRC_FILE"
  if javac -nowarn -encoding UTF-8 -d "$OUTDIR" "$SRC_FILE" 2>"$WORKDIR/last_errors.txt"; then
    c_green "✓ 第 $ROUND 轮修复成功"
    break
  fi
done

echo ""
c_blue "[4/4] 运行..."
RUN_OUT=$(cd "$OUTDIR" && java "$MAIN_CLASS" 2>&1)
echo "$RUN_OUT"
if [[ $? -eq 0 ]]; then
  c_green "==================== 完成 ✓ ===================="
else
  c_yellow "运行异常"
fi
