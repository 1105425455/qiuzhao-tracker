# 秋招记录小助手

跑在自己电脑上的秋招投递台账。中文界面，数据只存本地；AI 可选，用你自己的接口。

## 功能

- 记录公司、岗位、志愿、方向、地点、投递日期、简历结果和当前步骤；同公司归为一条，下面分列各志愿。
- 状态六档，每档一色：**简历筛选中 / 笔试 / 面试 / Offer / 已结束 / 已撤回**，可按状态筛选。
- 「笔试与面试」为月/周日历，可记录多轮笔试面试。
- 从「我的投递 / 应聘记录」网址一键识别多个岗位；也可逐条或一键核对，同一网址只打开一次，后台运行不抢前台。
- 启用 AI 后由模型看页面文字和截图判断状态，本地不加规则改写。
- CSV 导入导出、排序、本地历史快照。

## 界面预览

![首页](docs/screenshots/01-home.png)
![从投递页识别](docs/screenshots/03-parse.png)
![确认保存](docs/screenshots/04-confirm.png)
![AI 设置](docs/screenshots/02-ai-settings.png)

## 需要准备

- [Node.js](https://nodejs.org/) 22 或以上（Windows / macOS / Linux）。
- Edge 浏览器（加载采集扩展）。
- 可选：一个 AI 接口。

## 快速开始

1. 下载或克隆本项目。
2. 启动本地服务：
   - macOS：双击 `start.command`
   - Windows / 任意系统：`node launch.mjs`
3. 打开 <http://127.0.0.1:4319>。
4. 加载采集扩展（一次即可）：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `extension` 文件夹；再回台账点「连接与运行日志」→「连接浏览器」。以后改扩展代码后需在这里重新加载一次。
5. 记录投递：
   - 手动：点「手动记录」逐条填写。
   - 自动：登录官网后打开投递记录页，复制网址，点「从投递页识别」→ 解析 → 核对 → 保存。

## 配置 AI（可选）

在「连接与运行日志」填 API 地址、接口格式（自动 / OpenAI / Claude）、API Key、模型名，点「测试连接」。密钥只存本机 `data/tracker/`，不回显。

## 数据与隐私

- 记录和密钥都在本机 `data/tracker/`，已被 `.gitignore` 忽略；服务只监听 `127.0.0.1`。
- 只在你点击核对/识别时读取网页；采集前会把页面上的邮箱、手机号、证件号替换为占位符。
- 每次保存生成 `data/tracker/revision-*.json` 快照，不覆盖旧数据。

## 常见问题

- **端口被占用**：`PORT=4319 node launch.mjs`。
- **提示扩展版本过旧**：到 `edge://extensions` 对本项目扩展点「重新加载」。
- **改了代码没生效**：重启服务并刷新台账页；版本见页面左下角。
- **识别不到岗位**：确认已登录且页面是投递记录页；「连接与运行日志」会显示每条读到的字数与是否疑似登录页。
- **AI 报错**：先点「测试连接」核对地址、密钥、模型、接口格式。
- **想清空数据**：删除 `data/tracker/`（先导出 CSV）。

## 目录说明

```
launch.mjs        启动脚本（校验端口并托管 server.mjs）
start.command     macOS 双击启动
server.mjs        本地服务与 API
app.js / index.html / style.css   网页界面
ai.mjs / models.mjs   AI 接入与模型预设
calendar.mjs / calendar-ui.mjs     日历与日程
extension/        Edge 采集扩展（整页文字 + 分段截图，交给 AI 判断）
vendor/           FullCalendar / Lucide / Papa Parse
test-tracker.mjs  离线测试（node --test）
```

## 许可

代码可自由使用与修改。第三方库见 `vendor/`：FullCalendar（MIT）、Lucide（ISC）、Papa Parse（MIT）。
