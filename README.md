# 字数统计 · 打回编剧重申工作台

批量上传剧本（`.docx` / `.txt` / `.md`，一次最多 10 本），逐集统计正文字数，
不在合格区间（默认 550–1000 字）内的集标红，可一键复制「打回清单」或导出 CSV。

零依赖，Node ≥ 18。

## 本地启动

```bash
cd ~/Desktop/conut_drama
npm start            # 等同 node server.js
# 打开 http://127.0.0.1:3000
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址（服务器上放在 nginx 后面也保持默认） |
| `TRUST_PROXY` | 空 | 放在 nginx 后面时设为 `1`，限流按 `X-Forwarded-For` 区分访客 |
| `AUTH` | 空 | 形如 `user:pass`，设置后需要网页登录；公网监听必须设置。兼容旧名 `BASIC_AUTH` |
| `SESSION_SECRET` | 随机 | 会话签名密钥；部署脚本自动生成，保存在服务器私有配置中 |

测试：`npm test`

## 怎么分集、怎么数字

- **正文范围**：先定位 `剧本正文` / `正文内容` / `正文` 标题，只统计该标题之后的内容。
  前面的分集大纲不计入字数；遇到后续独立的大纲章节时结束正文范围。
  检测到大纲却没有正文标题时会提示补充正文，不用大纲凑出正文集数。
- **分集**：识别独立的 `第N集`（阿拉伯数字或中文数字，可带标题），也识别场次号。
  没有 `第2集` 标题时，`2-1`、`2-2`、`2-3` 等场次及其内容仍累计为第 2 集；
  不会并入上一集，也不会把每场当成一集。正文中缺少的集不会用大纲条目代替。
  连续重复的同集标题（包括中间只有空行或分页）自动合并，不产生虚假的空集；
  分页重复标题后，同集场次编号继续递增时仍累计到该集，重复标题不计入字数。
  有正文且场次重新开始的重复段仍提示集号重复，真正没有正文的集仍提示空集。
  没有总标题、直接以集标题或场次号开始的纯正文仍可统计。
  Word 标题样式、灰底、多段文字格式及表格中的段落均按实际文本顺序识别。
- **页面判定字数**：中文剧本中的汉字、中文及半角标点、夹杂的英文单词各算 1 字；数字、空白不计。
  例如 `Jack刚刚告诉我。` 为 **7 字**，`你好，世界！` 和 `你好,世界!` 都为 **6 字**。
  `I`、`a` 各算一个词，词内部的撇号或连字符属于该词，不重复计数。
  纯英文剧本仍按原英文单词规则计数（≥2 字符，标点不计）。
  语言以已识别的分集正文判断，含汉字正文时优先中文，英文括号动作保留。
- **两种页面口径**（不用重新上传）：
  1. 整集原文：含场景头和人物行的正文统计
  2. 纯台词+动作：去掉场景头（`1-1 夜 内 …`）和 `人物：` 行
- **WPS 参考值**：CSV 另保留参考列。该口径中汉字、全角符号、中文标点各 1 字，
  英文词各 1 字；半角数字、半角标点、空白不计。上例参考值为 **6 字**。
  API 保留 `words.full/clean/pure`，页面使用 `counts.full/clean/pure` 与 `lang`。
- **合格区间**含两端，页面上可改。
- 另外会提示：缺集、集号重复、首集不是第 1 集。

## 并发

- 浏览器端同时上传 4 本，其余排队；服务繁忙（503）自动退避重试。
- 服务端解析跑在 worker 线程池里（CPU 核数，2–8 个），不阻塞主线程；排队上限 64，单 IP 同时 16 个请求，单文件 30MB，解析超时 20 秒。

## 部署（腾讯云轻量 · Ubuntu + systemd）

服务器上使用独立 Git 目录 `/opt/conut_drama`，由 systemd 托管（`deploy/count-drama.service`），
Node 直接监听 80 端口，网页登录后使用。账号密码和签名密钥放在
`/etc/count-drama.env`（root 所有、权限 600），不进入 Git。
已有旧目录 `/opt/count-drama` 时可以保留作迁移备份。

```bash
# 首次部署（服务器执行；Node >= 18，位置 /usr/local/bin/node）
sudo install -d -o "$(id -un)" -g "$(id -gn)" /opt/conut_drama
git clone https://github.com/Astron0M-art/conut_drama.git /opt/conut_drama
cd /opt/conut_drama
bash deploy/install.sh

# 后续更新（本机执行）：快进拉取 → 测试 → 重启 → 登录/健康检查
ssh my-server 'cd /opt/conut_drama && bash deploy/update.sh'

# 或者在服务器目录直接执行
git pull --ff-only origin main
bash deploy/install.sh

# 日常
ssh my-server 'systemctl status count-drama'              # 状态
ssh my-server 'sudo journalctl -u count-drama -f'         # 日志
ssh my-server 'sudo nano /etc/count-drama.env && sudo systemctl restart count-drama'   # 改密码 / 端口
```

当前部署采用公网 IP + HTTP，传输未加密。后续可配置 HTTPS 反向代理，
届时把 Node 改为本机监听并设置 `TRUST_PROXY=1`。

上传内容只在内存中解析，不保存剧本；部署脚本会先执行测试、检查私有配置，
重启后实际登录并检查 `/healthz`。只拉取代码不会让已运行的 Node 进程加载新版本，
因此更新后仍需执行安装脚本或重启服务。

## 目录

```
server.js        HTTP 服务（静态页 + POST /api/analyze + GET /healthz）
lib/wps.js       WPS 字数算法
lib/docx.js      零依赖读取 docx / txt
lib/episodes.js  分集 + 三口径统计
lib/pool.js      worker 线程池
public/          前端页面
test/            单元测试
deploy/          systemd 服务文件 + 安装脚本
```
