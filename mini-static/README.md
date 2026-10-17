# 小程序独立静态数据服务

保留原生小程序、微信内置腾讯地图和 Word 下载。运行时不使用 CloudBase、网站接口、网站密码或网站轨道 JSON。

## 数据发布

GitHub Actions 的 `refresh-miniprogram-static.yml` 每天北京时间 09:15 开始：

1. 从 CelesTrak 独立下载全部七颗卫星的 OMM，并以 SGP4、真实水库边界和既有覆盖/耀光规则计算未来 30 天窗口，使用单独的 SQLite 工作库。
2. 从中央气象台独立获取全部参考站预报。复用采集算法源码，保持站间三秒间隔。网络错误或 5xx 最多重试一次，403/429不重试。
3. 使用网站保留的 Word 模板及相同生成源码，生成每座水库和全部水库共 26 份 DOCX。
4. 仅当轨道、25 座水库天气和全部文档均成功时，将完整静态版本一次发布到独立 Worker。失败时保留上一线上版本，客户端仍显示实际生成时间和过期状态。

数据只生成到被 Git 忽略的 `mini-static/dist`，不提交到公开仓库。`public/data/orbit-passes.json` 不作为本服务输入或输出。

## 免登录访问

用户已明确选择免登录。Worker直接从ASSETS读取已生成的JSON和Word，取消访问口令、会话签名和登录接口；不进行实时轨道计算或Word生成，也不依赖登录秘密。仅支持已知静态文件路径和GET/HEAD。静态数据和Word地址公开可读。

微信体验版仍需在公众平台添加体验成员；体验成员限制仅作用于小程序入口。

## 操作

需要 Node.js24、pnpm11.19 和已安装 `backend/requirements-orbit.txt` 的 Python3.12。

```powershell
pnpm mini-static:check
$env:MINI_STATIC_PYTHON = '.venv/Scripts/python.exe'
pnpm mini-static:build
pnpm mini-static:deploy
```

仅重试天气/文档生成时，可显式传入 `--reuse-independent-orbits`。只接受此任务当天独立计算且标有专属 pipeline 的轨道文件，不接受网站结果或改写日期。

生产工作流只需要 GitHub Actions Secret `MINIPROGRAM_CLOUDFLARE_API_TOKEN`，具有此账户的 Workers Scripts:Edit 权限。此令牌只供GitHub部署，不是小程序用户的登录密码，不会放入小程序。

小程序 `config.js` 仅保存公开服务地址。该地址必须在微信后台配置为 request 合法域名，需以后台保存结果及手机实际访问为准。数据与Word均通过普通 wx.request 读取，无需单独的 downloadFile 域名。若默认 workers.dev 域名不能满足微信域名要求，应接入可用的自有 HTTPS 域名后再更新配置。

此架构不受 CloudBase 六个月体验期限制，仍依赖 Cloudflare 免费套餐额度、GitHub Actions 正常运行及数据源可访问。静态文件通过Worker读取，相关请求计入Workers配额。公开 GitHub 仓库长期无活动可能停用定时工作流，应关注失败/停用通知。
