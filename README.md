# 智能刷课助手

> Tampermonkey 油猴脚本 — 超星学习通 / U校园 自动刷课刷题

## 支持平台

| 平台 | 刷课 | 刷题 | 状态 |
|------|:---:|:---:|:---:|
| 超星学习通 | ✅ | ✅ | 已适配 |
| U校园 AI | 🚧 挂时长 | ✅ | 挂时长开发中 |
| 智慧树/知到 | — | — | 预留接口 |

## 功能

- **自动播放**：自动播放视频，完成后跳转下一节
- **倍速播放**：1x ~ 16x 滑块实时调节
- **自动静音**：播放时自动静音
- **智能防卡顿**：监控缓冲区，动态调节倍速
- **AI 搜题**：DeepSeek API 自动答题（单选/多选/判断/填空）
- **网页搜索兜底**：AI 不自信时自动百度搜索
- **可视化面板**：拖拽移动、最小化、进度条、日志
- **配置持久化**：API Key 等配置刷新不丢失
- **SPA 支持**：单页应用路由切换自动重连

## 安装

### 1. 安装 Tampermonkey

Edge 浏览器：访问 `edge://extensions/`，搜索安装 **Tampermonkey（篡改猴）**

> ⚠️ Edge 需额外开启"开发人员模式"开关

### 2. 安装脚本

点击下方链接一键安装：

🔗 **[点击安装脚本](https://github.com/hztl123/smart-course-assistant/raw/main/smart-course-assistant.user.js)**

或手动安装：
1. 打开 Tampermonkey 管理面板（浏览器右上角图标 → 管理面板）
2. 点击 **"+"** 新建脚本
3. 清空所有内容
4. 复制 `smart-course-assistant.user.js` 全部代码粘贴进去
5. 按 `Ctrl+S` 保存

### 3. 配置 AI 搜题

1. 打开超星学习通或 U校园网页
2. 页面右侧出现控制面板
3. 展开 **⚙ 设置**
4. 填入你的 DeepSeek API Key（从 [platform.deepseek.com](https://platform.deepseek.com) 获取）
5. 勾选"AI 搜题"开启

### 4. 自动更新

安装脚本后，Tampermonkey 会定期自动检查更新。也可手动：Tampermonkey 图标 → "检查用户脚本更新"。

## 使用

1. 打开目标平台课程页面
2. 点击面板上的 **▶ 开始刷课** 按钮
3. 脚本自动播放视频、答题

## 搜题策略

```
题目 → DeepSeek AI → 置信度 ≥ 70%? → 填入答案
                    ↓ 否
                 百度搜索 → 命中? → 填入答案
                           ↓ 否
                        跳过，手动处理
```

## 项目结构

```
smart-course-assistant/
├── smart-course-assistant.user.js   ← 主脚本（复制到 Tampermonkey）
└── README.md
```

## 扩展新平台

在脚本中搜索 `【扩展点】`，按已有适配器的格式注册即可：

```javascript
PlatformRegistry.register('myplatform', {
    label: '我的平台',
    name: 'myplatform',
    match() { return /myplatform\.com/.test(HOST); },
    detectVideo() { /* ... */ },
    detectQuestions() { /* ... */ },
    fillAnswer(q, a) { /* ... */ },
    getNextButton() { /* ... */ },
    getCurrentTitle() { /* ... */ },
});
```

## 免责声明

本脚本仅供学习交流使用。使用产生的任何后果由用户自行承担。
