# 小程序独立静态数据服务

保留原生小程序、微信内置腾讯地图和 Word 下载。运行时不使用 CloudBase、网站接口、网站密码或网站轨道 JSON。

## 数据发布

GitHub Actions 的 `refresh-miniprogram-static.yml` 每天北京时间 09:15 开始：

1. 从 CelesTrak 独立下载全部七颗卫星的 OMM，并以 SGP4、真实水库边界和既有覆盖/耀光规则计算未来 30 天窗口，使用单独的 SQLite 工作库。
2. 从中央气象台独立获取全部参考站预报。复用采集算法源码，保持站间三秒间隔。网络错误或 5xx 最多重试一次，403/429不重试。
3. 使用网站保留的 Word 模板及相同生成源码，生成每座水库和全部水库共 26 份 DOCX。
4. 仅当轨道、25 座水库天气和全部文档均成功时，将完整静态版本通过官方Pages Actions发布到GitHub Pages。失败时保留上一线上版本，客户端仍显示实际生成时间和过期状态。

数据只生成到被 Git 忽略的 `mini-static/dist`，不提交到公开仓库。`public/data/orbit-passes.json` 不作为本服务输入或输出。

## 免登录访问

用户已明确选择免登录。GitHub Pages直接提供已生成的JSON和Word，不进行实时轨道计算或Word生成，不依赖口令、会话或部署秘密。静态数据和Word地址公开可读。

微信体验版仍需在公众平台添加体验成员；体验成员限制仅作用于小程序入口。

## 操作

需要 Node.js24、pnpm11.19 和已安装 `backend/requirements-orbit.txt` 的 Python3.12。

```powershell
pnpm mini-static:check
$env:MINI_STATIC_PYTHON = '.venv/Scripts/python.exe'
pnpm mini-static:build
```

发布：在仓库Actions中运行`Refresh independent mini-program static service`，或者等待每天的定时任务。仓库Settings → Pages的Source设为GitHub Actions；工作流仅上传`mini-static/dist`，不发布网站源码、登录文件或CloudBase配置。

仅重试天气/文档生成时，可显式传入 `--reuse-independent-orbits`。只接受此任务当天独立计算且标有专属 pipeline 的轨道文件，不接受网站结果或改写日期。

生产工作流使用GitHub自动签发的任务令牌及Pages OIDC部署，不需要手工配置新Secret。原`MINIPROGRAM_CLOUDFLARE_API_TOKEN`仅供历史Worker流程使用；新流程不读取它。

小程序`config.js`保存完整项目地址`https://sss-gc.github.io/henan-reservoir-observation-assistant`；微信request合法域名仅添加`https://sss-gc.github.io`。数据与Word均通过普通wx.request读取，无需单独的downloadFile域名。`workers.dev`已实测直连超时，不再作为客户端入口。历史Worker及其手工部署脚本保留；手工运行旧`mini-static:deploy`会重新写入Worker地址，当前Pages流程不应调用该命令。

此架构使用公开仓库的免费GitHub Pages及Actions，无需购买域名，不受CloudBase六个月体验期限制。Pages目前有每月100GB软带宽限制；生成产物远低于1GB站点限制。依赖GitHub及数据源可访问，仍需各手机网络验收；不是永久可用或全国网络可达的保证。Pages可能缓存约数分钟。公开GitHub仓库长期无活动可能停用定时工作流，应关注失败/停用通知。
