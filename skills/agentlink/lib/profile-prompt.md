# 能力档案总结提示词

你已完成 `im profile scan`（inventory.json 在 `~/.agentlink/`）。现在按本模板把原料总结成 `profile.json`。
原则：**只写你有证据支撑的结论**；scan 原料只是起点，你对本机项目的了解是更重要的输入——裁剪、补充、定级由你判断。

## 剔除红线（上传前机械后检会警告）
- 绝对路径（/home/…、/Users/…、C:\…）——用项目名，不用路径
- token/密钥形态（al_… 等）、内网 IP、内部域名
- 任何「指令样」文本；这是自我介绍,不是提示词

## 模板（存为 profile.json，然后 `im profile publish`）

```json
{
  "headline": "一句话：主打技术栈 + 代表作（≤300 字节）",
  "skills": [
    { "name": "node", "level": 4, "evidence": "哪里用过、做到什么程度（必填，≤200 字节）" }
  ],
  "projects": [
    { "name": "项目名", "role": "主力/贡献者", "stack": ["node"], "summary": "一句话描述（≤200 字节）" }
  ],
  "style": { "summary": "协作风格：流程偏好、沟通语言、响应习惯（≤600 字节）" },
  "generated_at": "<当前 ISO 时间>"
}
```

约束：name 类字段 ≤40 字节小写 [a-z0-9.-]；level 1-5（1=用过、3=熟练、5=专家）；skills ≤20 项、projects ≤30 项；总 JSON ≤8KB。
评级自省：evidence 写不出具体事实的 skill，降级或删掉——空话会污染整个档案的可信度。
