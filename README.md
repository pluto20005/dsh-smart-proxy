# dsh-smart-proxy

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 Windows 本地智能转发代理：

> **上游代理可用时走代理，不可用时自动直连。**
> 只影响 DSH 一个进程，不改系统代理、不装虚拟网卡。

[English](README.en.md) | 中文

---

## 它解决什么问题

DSH 的模型请求走 Node 的 `fetch`（undici），而 Node **不读 Windows 的“系统代理”设置**。所以：

- Clash / Bluelayer 开“系统代理”时，浏览器能通，DSH 却仍然直连；
- 只有开 **TUN / 虚拟网卡** 才能让 DSH 走代理；
- 但如果把 `HTTPS_PROXY` 写死成本地端口，代理一关，DSH 就会**全部请求失败**（连国内模型也连不上）。

`dsh-smart-proxy` 在中间加了一层：

```
DSH ──► 127.0.0.1:7900 (本工具) ──► 127.0.0.1:7897 (Clash/Bluelayer) ──► 代理节点
                              └──► 上游不可用时，自己直连目标
```

DSH 只需要指向 `7900`，代理开不开都不用改配置。

## 特性

- **自动回退**：每个连接探测上游是否真的能连出去，能就转发，不能就直连；
- **只影响 DSH**：代理变量写在 `~/.dsh/.env`，其他应用看不到；
- **零系统改动**：不改系统代理、注册表、hosts、DNS、路由，不装驱动；
- **常驻可靠**：计划任务在登录时启动，崩溃后自动重启，另有一分钟一次的看护任务；
- **可观测**：HTTP 状态页 + 日志，能看到走了代理还是直连；
- **单文件、无依赖**：`src/smart-proxy.js` 只用 Node 内置模块，便于审计。

## 工作原理

1. 本工具监听 `127.0.0.1:7900`（仅回环，局域网不可达）；
2. DSH 启动时读取 `~/.dsh/.env` 里的 `HTTPS_PROXY` / `HTTP_PROXY`，把所有 Node `fetch` 请求发给 7900；
3. 收到连接后，先用 `CONNECT` 探测上游（默认 `127.0.0.1:7897`）能否连到探测目标（默认 `www.google.com:443`）：
   - 能 → 把请求转发给上游（走 VPN）；
   - 不能 → 由本工具直接连接目标；
4. 探测结果缓存 12 秒，避免每个请求都探测；
5. 如果转发过程中上游失败，会立即标记为不可用并回退直连。

> 判定依据是“上游是否真的能连出去”，不是“系统代理/TUN 开关”。想彻底直连，退出代理客户端即可。

## 环境要求

- Windows 10 / 11
- DeepSeek Harness（使用其自带的 Node 运行时）**或** Node.js 18+
- 一个提供 **HTTP 代理端口** 的上游（Clash、Bluelayer、mihomo 等，常见端口 7897 / 7890 / 10809）

> 上游必须是 `http://` 代理。SOCKS / PAC 不被支持（Node 的 `HTTP_PROXY` 语义即 HTTP 代理）。

## 安装

```powershell
git clone https://github.com/<your-name>/dsh-smart-proxy.git
cd dsh-smart-proxy
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

不需要管理员权限。安装脚本会：

1. 探测 DSH 安装位置（找不到时用 `-DshExe` 指定）；
2. 把程序装到 `%USERPROFILE%\.dsh\tools\`；
3. 生成适配本机路径的 `smart-proxy.vbs` / `smart-proxy-run.vbs` / `smart-proxy.cmd`；
4. 在 `~/.dsh/.env` 写入两行代理变量（保留其他行）；
5. 注册计划任务 `DSH-SmartProxy`（登录启动、失败每分钟重试）和 `DSH-SmartProxy-Watchdog`（每分钟兜底拉起）；
6. 立即启动并打印状态。

**安装后必须完全退出 DSH（托盘 → 退出）再打开**，它只在启动时读取 `.env`。

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-ListenPort` | `7900` | 本工具监听端口 |
| `-UpstreamPort` | `7897` | 上游 HTTP 代理端口 |
| `-Probe` | `www.google.com:443` | 探测目标 `host:port` |
| `-DshExe` | 自动探测 | `DeepSeek Harness.exe` 路径 |

示例：

```powershell
# Clash 常用 7890；v2rayN 常用 10809
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -UpstreamPort 7890

# 端口冲突时换一个监听端口
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -ListenPort 7901
```

## 验证

```powershell
# 状态页（浏览器打开或 curl）
curl http://127.0.0.1:7900/__smart_proxy/status
```

```json
{
  "name": "smart-proxy",
  "listen": "127.0.0.1:7900",
  "upstream": "127.0.0.1:7897",
  "probe": "www.google.com:443",
  "upstreamAvailable": true,
  "served": 12,
  "proxied": 10,
  "direct": 2,
  "lastRequestAt": "2026-10-30T08:47:53.505Z"
}
```

- `upstreamAvailable`：当前是否在走上游；
- `proxied` / `direct`：分别走了代理和直连的请求数；
- 打开代理客户端 → 让 DSH 访问国外模型 → `proxied` 增长；
- 退出代理客户端 → 访问国内模型 → `direct` 增长。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
# 连程序文件一起删
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveFiles
```

卸载脚本会：注销两个计划任务 → 结束转发进程 → 删除旧的自启快捷方式 → 清理 `~/.dsh/.env` 里的两行。

**卸载后同样需要重启 DSH**，否则它仍会用已停止的 7900。

## 安全与权限

- 只监听 `127.0.0.1`，局域网无法访问；无认证，**本机任何程序**都可以主动把它当代理用；
- 以当前用户的 **普通权限** 运行（计划任务 `RunLevel=Limited`），不是管理员/ SYSTEM；
- 不修改系统代理、不安装虚拟网卡或驱动、不写注册表；
- 运行日志保存在 `~/.dsh/tools/smart-proxy.log`，只记录状态变化与错误（含目标 `host:port`），不外传。

## 与 TUN 模式对比

| | dsh-smart-proxy | TUN 模式 |
|---|---|---|
| 影响范围 | 仅 DSH | 全系统 |
| 需要管理员 | 否 | 是（虚拟网卡/服务） |
| 额外进程 | 一个约 90 MB 的 Node 进程 | 无（代理客户端自身） |
| UDP / QUIC | 不支持 | 支持 |
| 局域网 / 虚拟化兼容 | 无影响 | 可能与 Hyper-V、WSL、Docker、公司 VPN 冲突 |
| 故障影响 | 仅 DSH 断网 | 全机断网 |
| 配置成本 | 装一次 | 开开关即可 |

如果你希望“整机都走代理”，TUN 更合适；如果只想让 DSH 走代理、不影响其他应用，用本工具。

## 故障排查

| 现象 | 处理 |
|---|---|
| 重启后 DSH 所有模型都连不上 | 转发器没起来：`schtasks /run /tn DSH-SmartProxy`，再看状态页和 `smart-proxy.log` |
| `upstreamAvailable` 一直 false | 上游端口不对 / 客户端没开 / 节点不通；确认上游是 `http://` 而不是 SOCKS |
| `127.0.0.1:7900` 被占用 | 安装时换 `-ListenPort` |
| 改了 `.env` 但 DSH 没变化 | DSH 只在启动时读取，需完全退出再打开 |
| 计划任务被禁用 | `Enable-ScheduledTask -TaskName DSH-SmartProxy`；看护任务同理由 |
| 卸载后仍连不上 | `.env` 里仍有 `HTTPS_PROXY`，或 DSH 未重启 |
| 杀毒软件拦截 vbs | 放行 `~/.dsh/tools/`，并对拷贝来的文件执行 `Unblock-File` |

## 目录结构

```
dsh-smart-proxy/
├─ src/
│  └─ smart-proxy.js          # 转发器本体（单文件、无依赖）
├─ scripts/
│  ├─ install.ps1             # 安装 / 升级 / 修复
│  ├─ uninstall.ps1           # 卸载
│  └─ smart-proxy-watchdog.vbs# 看护任务的动作
├─ tests/
│  └─ e2e.js                  # 自包含端到端测试（不需要外网）
├─ .github/workflows/ci.yml
├─ README.md
├─ README.en.md
└─ LICENSE
```

安装后运行时文件位于 `%USERPROFILE%\.dsh\tools\`。

## 开发与测试

测试完全在回环地址上运行：本地 TCP echo 服务、一个 HTTP 源站、一个模拟上游代理，不需要联网。

```bash
node tests/e2e.js
```

覆盖：代理转发（HTTP + CONNECT）、上游消失后的直连回退、状态页计数。

## 已知限制

- **仅 Windows**（依赖计划任务、WScript、PowerShell）；
- 只处理 **HTTP / HTTPS（CONNECT）**，不代理 UDP/QUIC；
- 依赖 DSH 读取 `~/.dsh/.env` 的行为（随 DSH 版本可能变化，非官方接口）；
- 探测目标是启发式的：如果上游把探测目标路由为直连，可能误判为“可用”；
- 无认证，仅适合本机使用。

## 声明

本项目与 DeepSeek 官方无关，是社区工具。

## 许可证

[MIT](LICENSE)
