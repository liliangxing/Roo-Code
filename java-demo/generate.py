#!/usr/bin/env python3
"""智谱 GLM 驱动的「自然语言写 Java / 编译 / 自动修复」闭环演示。
Key 仅从环境变量 ZHIPU_API_KEY 读取，不写死在文件里。
"""
import os, re, subprocess, sys, json

API_KEY = os.environ.get("ZHIPU_API_KEY")
if not API_KEY:
    sys.exit("缺少环境变量 ZHIPU_API_KEY")
BASE = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
MODEL = "glm-4-flash-250414"

SYS = ("你是一个资深的 Java 工程师。用户会要求你用 Java 写一个小程序。"
       "请只输出完整的 Java 源代码（可用 ```java 代码块包裹），不要输出解释性文字。"
       "确保代码可以独立用 javac 编译、用 java 运行，仅用标准库，不依赖第三方库。")

TASK = ("用 Java 写一个程序：读取当前目录下的 input.txt（每行一个英文单词），"
        "统计每个单词出现的次数，按出现次数降序输出前 10 个单词及其次数；"
        "如果 input.txt 不存在，则程序应先自动创建一个含示例单词的 input.txt 再统计。"
        "要求：单个 .java 文件，包含 main 方法，使用标准库。")


def call_zhipu(user: str) -> str:
    import requests
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    r = requests.post(
        BASE,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json=body,
        timeout=180,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def extract_java(text: str) -> str:
    m = re.search(r"```java\s*(.*?)```", text, re.S)
    if m:
        return m.group(1).strip()
    m = re.search(r"```\s*(.*?)```", text, re.S)
    if m:
        return m.group(1).strip()
    return text.strip()


print(">> [1/3] 用自然语言请求智谱生成 Java 代码 ...")
resp = call_zhipu(TASK)
code = extract_java(resp)
print(f">> 生成代码长度: {len(code)} 字符")
with open("WordCount.java", "w", encoding="utf-8") as f:
    f.write(code)

MAX = 5
for i in range(1, MAX + 1):
    print(f">> [2/3] 第 {i} 次 javac 编译 ...")
    proc = subprocess.run(["javac", "WordCount.java"], capture_output=True, text=True)
    if proc.returncode == 0:
        print(">> 编译成功 ✓")
        break
    err = proc.stderr
    print(">> 编译错误:\n" + err)
    print(">> 请求智谱自动修复 ...")
    fix = (f"下面这段 Java 代码用 javac 编译失败，请修复后只输出完整修正后的 Java 源代码。\n\n"
           f"编译错误:\n{err}\n\n原代码:\n{code}")
    code = extract_java(call_zhipu(fix))
    with open("WordCount.java", "w", encoding="utf-8") as f:
        f.write(code)
else:
    print(">> 达到最大重试次数仍未通过编译，停止。")
    sys.exit(1)

if not os.path.exists("input.txt"):
    with open("input.txt", "w", encoding="utf-8") as f:
        f.write("hello world hello java world java java code agent agent java world openai cline\n")

print(">> [3/3] 运行程序验证 ...")
run = subprocess.run(["java", "WordCount"], capture_output=True, text=True)
print(run.stdout)
if run.stderr:
    print("stderr:\n" + run.stderr)
print(">> 演示完成。")
