# dsh-smart-proxy

A smart loopback HTTP relay for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Windows:

> **Use the local proxy when it works; fall back to a direct connection when it does not.**
> Scoped to DSH only — no system proxy, no virtual adapter.

English | [中文](README.md)

---

## Why

DSH sends model requests through Node's `fetch` (undici), and Node **ignores the Windows system proxy**. Enabling Clash/Bluelayer's "system proxy" helps browsers, not DSH; only TUN mode makes DSH use the proxy. Hard-coding `HTTPS_PROXY` to a local port fixes that but breaks *everything* (including domestic models) as soon as the proxy is off.

`dsh-smart-proxy` sits in between:

```
DSH ──► 127.0.0.1:7900 (relay) ──► 127.0.0.1:7897 (Clash/Bluelayer) ──► proxy node
                              └──► upstream unreachable: connect directly
```

DSH always points at `7900`; the relay decides per connection.

## Features

- **Automatic fallback** — probes the upstream with `CONNECT`; forwards when it works, connects directly otherwise.
- **DSH only** — proxy variables live in `~/.dsh/.env`; other applications never see them.
- **No system changes** — no system proxy, registry, hosts, DNS, routes, drivers.
- **Durable** — scheduled task at logon, restart on failure, one-minute watchdog.
- **Observable** — status endpoint and log show proxied vs direct traffic.
- **Single file, zero dependencies** — `src/smart-proxy.js` uses only Node built-ins.

## How it works

1. Listens on `127.0.0.1:7900` (loopback only).
2. DSH reads `~/.dsh/.env` at startup and sends all Node `fetch` traffic to 7900.
3. For each connection the relay probes the upstream (`127.0.0.1:7897` by default) with `CONNECT <probe target>` (`www.google.com:443` by default). Reachable → forward; unreachable → direct.
4. Probe results are cached for 12 seconds; a failed forward immediately marks the upstream down and falls back to direct.

The decision is based on real reachability, not on the system-proxy/TUN switch. Quit the proxy client to force direct connections.

## Requirements

- Windows 10/11
- DeepSeek Harness (its bundled Node runtime) **or** Node.js 18+
- An **HTTP** proxy port from Clash, Bluelayer, mihomo, etc. (7897 / 7890 / 10809 are common). SOCKS and PAC are not supported.

## Install

```powershell
git clone https://github.com/pluto20005/dsh-smart-proxy.git
cd dsh-smart-proxy
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

No administrator rights required. The installer:

1. Locates DeepSeek Harness (or use `-DshExe`);
2. Installs to `%USERPROFILE%\.dsh\tools\`;
3. Generates machine-specific `smart-proxy.vbs`, `smart-proxy-run.vbs`, `smart-proxy.cmd`;
4. Writes the two proxy variables into `~/.dsh/.env` (other lines preserved);
5. Registers `DSH-SmartProxy` (logon, restart on failure) and `DSH-SmartProxy-Watchdog` (every minute);
6. Starts the relay and prints its status.

**Fully quit DSH from the tray and start it again** — it reads `.env` only at startup.

### Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `-ListenPort` | `7900` | Relay listen port |
| `-UpstreamPort` | `7897` | Upstream HTTP proxy port |
| `-Probe` | `www.google.com:443` | Probe target `host:port` |
| `-DshExe` | auto-detect | Path to `DeepSeek Harness.exe` |

## Verify

```powershell
curl http://127.0.0.1:7900/__smart_proxy/status
```

`upstreamAvailable` shows the current route; `proxied` and `direct` count requests.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
# also delete installed files
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveFiles
```

Unregisters both tasks, stops the relay, removes the legacy startup shortcut, and strips the proxy lines from `~/.dsh/.env`. Restart DSH afterwards.

## Security

- Binds `127.0.0.1` only; LAN cannot reach it. There is no authentication, so any local process could use it.
- Runs with the normal user token (`RunLevel=Limited`), not admin or SYSTEM.
- Does not touch the system proxy, adapters, drivers, or registry.
- `~/.dsh/tools/smart-proxy.log` stays local and records only state changes and errors.

## Compared with TUN mode

| | dsh-smart-proxy | TUN mode |
|---|---|---|
| Scope | DSH only | Whole system |
| Admin required | No | Yes |
| Extra process | One ~90 MB Node process | None |
| UDP / QUIC | No | Yes |
| LAN / virtualization | Unaffected | May conflict with Hyper-V, WSL, Docker, corporate VPN |
| Failure blast radius | DSH only | Entire machine |
| Setup | One-time install | Toggle |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No model works after a restart | Relay is down: `schtasks /run /tn DSH-SmartProxy`; check the status page and log |
| `upstreamAvailable` stays false | Wrong upstream port, client closed, or dead node; make sure it is `http://`, not SOCKS |
| Port 7900 already in use | Reinstall with `-ListenPort` |
| `.env` changes have no effect | Restart DSH completely |
| Scheduled tasks disabled | `Enable-ScheduledTask -TaskName DSH-SmartProxy` |
| Still offline after uninstall | `.env` still has `HTTPS_PROXY`, or DSH was not restarted |
| Antivirus blocks the VBS | Allow `~/.dsh/tools/`; run `Unblock-File` on copied files |

## Layout

```
dsh-smart-proxy/
├─ src/smart-proxy.js
├─ scripts/{install.ps1, uninstall.ps1, smart-proxy-watchdog.vbs}
├─ tests/e2e.js
├─ .github/workflows/ci.yml
├─ README.md
├─ README.en.md
└─ LICENSE
```

Installed runtime files live in `%USERPROFILE%\.dsh\tools\`.

## Development

```bash
node tests/e2e.js
```

The test is hermetic: local echo server, HTTP origin, and a mock upstream proxy on loopback; no internet required.

## Limitations

- Windows only.
- HTTP/HTTPS (CONNECT) only; no UDP/QUIC.
- Relies on DSH reading `~/.dsh/.env` (unofficial behavior that may change).
- The reachability probe is heuristic.

## Disclaimer

Unofficial community project, not affiliated with DeepSeek.

## License

[MIT](LICENSE)
