# 星地同步实验助手

面向河南省 25 座水库野外实验计划的私有网页。系统把中央气象台未来 7 天昼夜文字天气与未来 30 天卫星完整覆盖过境窗口自动匹配，并计算太阳—水面—卫星的镜面反射耀光风险。

## 当前私有版功能

- 25 座水库地图、边界、城市、中心点和参考面积。
- 丹江口水库边界同时包含主库区与本地核验的汉江补充水面区域。
- 中央气象台未来 7 天文字天气，仅显示日期、白天天气和夜间天气。
- Sentinel-2A/2B/2C、Landsat 8/9、HJ-2B、Gaofen-1 未来 30 天轨道覆盖窗口。
- 只展示几何覆盖率不低于 99.9% 的完整覆盖窗口。
- 按过境日期匹配天气，并生成“推荐 / 备选 / 不推荐 / 待预报”结果。
- 根据太阳方向、SGP4 卫星位置和水库位置计算平静水平水面的耀光夹角；中高风险窗口自动从“推荐”中排除。
- 可按当前水库和卫星筛选，在浏览器端生成并下载 Word 实验计划；文档包含推荐窗口、全部联合判断、数据时间与风险说明，不上传观测数据。
- Word“全部联合判断”按 Sentinel、HJ、Landsat、GF/Gaofen 系列分组，并在各组内按卫星型号与日期排列。
- 桌面端和手机端响应式界面。

> 轨道结果表示卫星幅宽在该时刻可以完整覆盖水库，不代表运营方已经排程或确认成像。耀光分级是几何风险估计。超出 7 天天气预报范围的窗口只标记为“待预报”。

## 部署架构

```text
浏览器（Cloudflare Access 仅允许指定邮箱登录）
  ├─ Cloudflare Pages：Vue 静态网页、25 座水库 GeoJSON、轨道 JSON
  └─ Pages Function /api/weather：按水库读取 Workers KV 缓存

Cloudflare Worker Cron（每天北京时间 09:00）
  └─ 低频读取中央气象台县市级页面 → 提取7天昼夜文字天气 → 原子写入 Workers KV

GitHub Actions（每天北京时间 02:15）
  └─ CelesTrak OMM → SGP4/幅宽完整覆盖计算 → 更新 orbit-passes.json
```

网站运行时不需要 FastAPI、SQLite、Docker、Copernicus 密钥或 USGS 密钥。仓库保留的 Python 轨道模块仅供 GitHub Actions 每日生成静态结果。

## 本地运行

需要 Node.js 22 和 pnpm 11.19。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

访问 `http://127.0.0.1:5173/`。天气只通过 `/api/weather` 读取 KV，不会从浏览器直接访问中央气象台。

按 Cloudflare Pages 方式本地联调：

```powershell
pnpm build
pnpm dlx wrangler@latest pages dev dist
```

## 验证

```powershell
pnpm test
pnpm typecheck:functions
pnpm typecheck:weather-worker
pnpm validate:static
pnpm build
```

轨道导出回归测试：

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_static_export.py -q
```

## GitHub 自动更新

- `.github/workflows/refresh-orbits.yml` 每天 UTC 18:15（北京时间次日 02:15）运行，也支持在 Actions 页面手动触发。
- 工作流从 CelesTrak 获取最新 OMM，重算未来 30 天窗口，通过静态数据校验后提交 `public/data/orbit-passes.json`。
- `.github/workflows/validate.yml` 在主分支推送和 Pull Request 时执行单元测试、类型检查、静态数据校验和生产构建。

如仓库的 Actions 默认令牌没有写权限，需要在 GitHub 仓库 `Settings → Actions → General → Workflow permissions` 选择 `Read and write permissions`。工作流本身只申请 `contents: write`。

## Cloudflare Pages 配置

在 Cloudflare 控制台连接 GitHub 仓库并创建 Pages 项目：

| 配置项 | 值 |
|---|---|
| Production branch | `main` |
| Framework preset | `Vue` 或 `None` |
| Build command | `pnpm build` |
| Build output directory | `dist` |
| Root directory | `/` |
| Node.js | `22` |
| Production variable | `VITE_TIANDITU_KEY`（天地图浏览器端 key） |
| Pages KV binding | `WEATHER_KV`（与定时 Worker 共用） |

生产页面需配置绑定站点域名的天地图浏览器端 key。地图仅调用天地图矢量与中文注记瓦片，不加载 OpenStreetMap 备用底图。Cloudflare Access 应同时保护生产域名和预览域名，仅允许 `306221976@qq.com`。部署后检查：

- `/`：地图、天气、过境与联合推荐页面。
- `/api/health`：应返回 `status: ok`。
- `/api/weather?id=HN_RSV_001`：应返回对应参考站的 7 天昼夜文字天气。

Cloudflare 的 Git 集成会在每次 `main` 分支更新后自动重新部署。GitHub Actions 每日提交新轨道 JSON 后，网站也会自动发布最新数据。

## 主要目录

```text
src/                                      Vue 页面与联合推荐算法
functions/api/                            Cloudflare 天气与健康检查函数
weather-worker/                           每天09:00运行的天气抓取 Worker
public/data/reservoirs.geojson            25 座水库主数据
public/data/orbit-passes.json             未来 30 天静态过境结果
backend/app/tasks/export_static_observations.py  静态轨道导出器
backend/requirements-orbit.txt            GitHub Actions 最小 Python 依赖
scripts/validate_static_observations.py    静态数据校验
.github/workflows/                         自动测试和每日轨道刷新
docs/                                      项目文档与原始方案归档
ops/docker/                                Docker自托管配置与说明
ops/windows/                               Windows本地维护快捷脚本
docs/开发上下文记录.md                     完整开发进度、验证和剩余事项
```

## 数据与安全

- `.env`、SQLite 数据库、备份、日志、缓存、构建结果和原始方案文档均由 `.gitignore` 排除，不会进入 GitHub。
- `public/data/reservoirs.geojson` 中的面积为水库边界的 WGS84 椭球面积参考值，不等于库容、流域面积或任意日期的实时水面面积。
- HJ-2B 和 Gaofen-1 目前只参与公开轨道参数的几何预测，不提供国产卫星实际产品下载或影像展示。
- 中央气象台县市级文字预报和卫星轨道预测均存在不确定性，水库局地天气可能与参考站不同，外业出发前应再次核验。
- 下载的 Word 方案使用 `src/assets/observation-plan-template.docx` 保存的用户模板，保留宋体 / Times New Roman、12 磅居中表格和原页面设置；日期列仅显示年月日，网页仍显示过境时分。推荐窗口从当前筛选内全部合格记录中优先选 Sentinel，再按评分补充其他卫星，最多四项。
- HJ 观测仅使用 HJ-2B CCD1–CCD4 的 16 米四相机拼接模式；800 km 为合成幅宽，不能据此判定单台 CCD 的完整覆盖或实际成像安排。
