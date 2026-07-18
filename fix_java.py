#!/usr/bin/env python3
"""智谱 GLM 多轮自动修复 Java 编译错误"""
import json, subprocess, sys, re, urllib.request

ZHIPU_KEY = "d7640538c3f245a59b3a1d1bf9862d47.mcOUKUYV9o6OY2n4"
API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
SRC = sys.argv[1] if len(sys.argv) > 1 else "/workspace/Roo-Code/roo_zhipu_work/Broken.java"
MAX_ROUNDS = 3

def call_model(sys_msg, user_msg):
    payload = {
        "model": "glm-4-flash",
        "messages": [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": user_msg}
        ],
        "temperature": 0.2
    }
    req = urllib.request.Request(API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {ZHIPU_KEY}", "Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    return resp["choices"][0]["message"]["content"]

def extract_java(text):
    m = re.search(r"```(?:java|Java)?\s*\n(.*?)```", text, re.DOTALL)
    return m.group(1) if m else text

def compile_java(src_file, out_dir):
    r = subprocess.run(["javac", "-nowarn", "-encoding", "UTF-8", "-d", out_dir, src_file],
                       capture_output=True, text=True)
    return r.returncode == 0, r.stderr

def main():
    out_dir = "/workspace/Roo-Code/roo_zhipu_work/out"
    import os; os.makedirs(out_dir, exist_ok=True)

    SYS = "你是 Java 编译错误修复专家。输出修复后的完整源文件, 用 ```java 包裹。所有 import 在 class 前。规则: 1. 不引入外部依赖 2. 如果原代码用了不存在的类(如 JSONObject), 用 JDK 标准库等效实现(如 HashMap 拼字符串)或直接删除 3. 拼写错误修正 4. 不要解释。"

    for rnd in range(1, MAX_ROUNDS + 1):
        ok, err = compile_java(SRC, out_dir)
        if ok:
            print(f"✓ 编译成功 (第 {rnd} 轮)")
            # 运行
            import os
            cls = os.path.splitext(os.path.basename(SRC))[0]
            r = subprocess.run(["java", "-cp", out_dir, cls], capture_output=True, text=True)
            print("=== 运行输出 ===")
            print(r.stdout)
            if r.stderr:
                print("STDERR:", r.stderr[:200])
            return 0

        print(f"=== 第 {rnd} 轮修复 ===")
        with open(SRC, "r") as f:
            src = f.read()
        user = f"源代码:\n```java\n{src}\n```\n\njavac 错误:\n```\n{err}\n```\n\n请输出修复后的完整代码。"
        content = call_model(SYS, user)
        code = extract_java(content)
        with open(SRC, "w") as f:
            f.write(code)
        print(f"  已写入修复版")

    ok, err = compile_java(SRC, out_dir)
    if ok:
        print(f"✓ 第 {MAX_ROUNDS} 轮修复成功")
        import os
        cls = os.path.splitext(os.path.basename(SRC))[0]
        r = subprocess.run(["java", "-cp", out_dir, cls], capture_output=True, text=True)
        print("=== 运行输出 ===")
        print(r.stdout)
        return 0
    else:
        print(f"✗ {MAX_ROUNDS} 轮修复失败")
        print(err[:500])
        return 1

if __name__ == "__main__":
    sys.exit(main())
