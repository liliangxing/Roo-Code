# 智谱 GLM 驱动的自然语言 Java 开发闭环演示

本目录演示：用自然语言 + 智谱 GLM（`glm-4-flash-250414`，OpenAI 兼容 API）完成
「写 Java 文件 → javac 编译 → 编译报错自动修复 → 运行验证」的完整闭环。

## 运行

```bash
# 需要 JDK（已验证 javac 20）
export ZHIPU_API_KEY="你的智谱 API Key"
python3 generate.py
```

## 发生了什么

1. `generate.py` 用自然语言任务（"写一个统计词频的 Java 程序"）请求智谱生成代码；
2. 将生成内容写入 `WordCount.java`；
3. 调用 `javac` 编译：
    - 首次编译报错：`class WordFrequency is public, should be declared in a file named WordFrequency.java`
      （生成代码把 public 类命名为 `WordFrequency`，但文件名是 `WordCount.java`）；
    - 将编译错误回传给智谱，请求其修正；经过 2 次修复尝试后，第 3 次智谱把类名改为 `WordCount`，编译通过；
4. 运行 `java WordCount`，程序自建示例 `input.txt` 并输出词频统计结果。

## 验证结果（示例输出）

```
banana: 3
apple: 3
kiwi: 3
orange: 2
```

## 结论

在未使用 Docker、仅本机运行的前提下，智谱 GLM（经 OpenAI 兼容接口）能够：

- 理解自然语言并生成可编译的 Java 代码；
- 在 `javac` 报错后，根据错误信息自动修正代码并重新编译（自主修复循环）；
- 配合 Cline / Roo Code 这类开源 VS Code 扩展（本仓库 fork 自 RooCodeInc/Roo-Code），
  即可在编辑器内以智谱为模型后端完成"拉取代码 → 写/改 → 编译 → 修错 → 提交/发布"的工作流。
