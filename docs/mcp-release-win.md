# Windows EXE Release 工作流与监控脚本

日期：2026-09-19。项目：`E:/Code/pj/md-reader`。

## 范围

按用户确认：只构建 Windows x64 的 **NSIS 安装器 `.exe`**，上传到 **GitHub Release**。不是免安装主程序，不生成/上传 MSI、ZIP 或 macOS/Linux 包。原来的 `release.yml`、`experimental.yml`、`release.ps1` 不变。

新增文件：

- `.github/workflows/release-win.yml`：手动触发的 Windows 构建、依赖/打包重试、发布。
- `scripts/release-win.sh`：自动推送已有提交，再使用 gh 触发、定位本次运行、持续监控、桌面通知。
- `scripts/publish-win.ps1`：CI 专用发布辅助脚本；校验标签源码、上传 EXE、检查大小/可用的服务端摘要，再发布 Release。
- `scripts/test-release-win.sh`：无网络、无真实弹窗的模拟回归测试。

## 首次使用

本次只写入与验证文件，**没有提交、推送、触发线上构建或创建 Release**。当前工作区还包含上一轮极简阅读器的未提交改动，GitHub 无法构建这些本地改动。

1. 检查代码，手动提交需要打包的改动和上述全部文件；脚本会自动推送当前分支已有提交。`release-win.yml` 必须先存在于仓库默认分支，选择的构建 ref 也必须包含辅助脚本。
2. 本机安装 GitHub CLI 并完成 `gh auth login`，账号/token 需要触发 Actions 的权限。仓库需启用 Actions，组织策略需允许 workflow 的 `contents: write`。
3. Windows 使用 **Git Bash** 执行，需要 GNU `timeout`（已确认本机有）。

```bash
bash scripts/release-win.sh \
  --repo EdwardHamu/md-reader \
  --ref main \
  --tag v0.3.10-win.1
```

`--repo` 默认从 origin 推导，`--ref` 默认当前分支。默认拒绝脏工作区，只推送已有提交；自动推送完成后再次校验本地 HEAD 与远端 ref 一致，避免把旧远端代码误认为本地新版。

如确实只想构建远端已推送的代码，可显式加 `--allow-remote`。这会跳过自动推送，不会上传本地源码。

标签必须符合 `v<应用版本>` 或 `v<应用版本>-<后缀>`，三个版本文件必须一致。示例里的 `v0.3.10-win.1` 使用当前版本 0.3.10，便于避开指向旧提交的已有标签；升级正式版本时请先自行修改、提交版本文件和锁文件，脚本不自动改版本。

## 发布行为

- Windows runner 使用 Node 24、pnpm 11.21.0、Rust stable 和 x86_64 MSVC target。
- `pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis`，只上传 NSIS 目录下唯一非空 EXE。
- 构建源码固定为触发时通过 GitHub API 解析的完整提交 SHA，而不是等队列结束后再读取分支最新代码。
- 资产名称：`MD-Reader-<tag>-windows-x64-setup.exe`。
- 新 Release 先建草稿，成功上传并验证后公开；新发布使用普通 Release 默认设置。失败时可能保留草稿，便于排查。
- 已有标签（包含 annotated tag）必须指向同一源码提交；未创建标签的已有草稿也必须指向同一源码。否则失败，不移动旧标签。
- 同一标签下同名 EXE 会通过 `--clobber` 更新；不删除其他资产，不改已有 Release 标题、说明、prerelease 设置。已有公开 Release 的资产替换期间可能暂时不可下载。
- CI 可以按固定 SHA 创建远端发布标签，但本地脚本只自动 push 当前分支已有提交，不执行 git add/commit/tag，不触碰用户正在运行的应用。
- EXE 未做代码签名，Windows 可能显示 SmartScreen 警告；保留 Tauri 的 WebView2 安装策略，不宣称离线自包含。

## 持续监控与恢复

脚本使用唯一 `request_id` 对应 workflow 的 run-name，**不会简单选择最近一次运行**。找到 run ID 后一直轮询该 ID，直到 `completed`；会确认其 workflow 路径和事件类型，防止监控错误任务。

```bash
# 断线或关闭终端后，接着监控同一个运行，不重新构建
bash scripts/release-win.sh --repo EdwardHamu/md-reader --run-id 123456789

# 触发响应丢失、尚未拿到 run ID 时，按已打印的请求 ID 恢复查找
bash scripts/release-win.sh --repo EdwardHamu/md-reader --request-id 打印出的请求ID

# 单独测试通知，不触发任何构建
bash scripts/release-win.sh --notify-test
```

成功返回 0，失败返回 1，云端取消返回 2，本地监控超时返回 124，Ctrl+C 返回 130。中断/超时只停止本地监控，**不会取消 GitHub 上的任务**。运行地址和恢复命令会打印在终端。

## 请求重试

所有实际 gh 网络调用和新增的 git push 都有超时及重试：

- 自动推送使用同一重试包装器（默认最多 5 次，每次 90 秒），明确关闭 followTags 和子模块递归推送，使用固定提交 SHA 到当前分支的单一 refspec；不强推、不修改 Git 全局设置。认证失败、非快进或分支保护拒绝后停止，不触发构建。

- 普通 API/列表查询：默认最多 5 次，单请求 90 秒超时，默认 2/4/8/16 秒退避；失败响应的部分 stdout 不会污染下一次成功的 JSON。
- 触发请求：重试前按唯一请求 ID 查询，发送失败后先等待并核实是否已创建运行。若无法核实，不继续重复写入；已收到成功响应但暂未查到运行，也不重新触发。
- GitHub workflow_dispatch 不提供幂等键，因此极端列表可见性延迟下仍可能产生重复运行，不能承诺 exactly-once；同标签构建串行，发布端校验固定源码，同名资产上传可重试。
- 查询一轮重试耗尽后，监控循环会继续等待网络恢复，而不是重新触发工作流。
- CI pnpm 自带 5 次 fetch 重试，安装步骤最多 3 轮；Cargo 网络重试 5 次，NSIS 构建最多 3 轮，覆盖构建器下载失败；发布 API/资产上传最多 5 次，单次 180 秒超时。
- CI job 超时 90 分钟；本地监控默认 4 小时，允许队列等待。超时检查按轮执行，当前请求的超时和重试可能让实际结束时间略晚于设置值。

可调环境变量（正整数）：

```bash
RETRY_ATTEMPTS=5 \
RETRY_DELAY_SECONDS=2 \
REQUEST_TIMEOUT_SECONDS=90 \
POLL_INTERVAL_SECONDS=15 \
DISCOVERY_TIMEOUT_SECONDS=300 \
MONITOR_TIMEOUT_SECONDS=14400 \
bash scripts/release-win.sh --tag v0.3.10-win.1 --ref main
```

GitHub Actions 平台或托管 setup/cache action 自身的故障，仍可能导致 job 失败；脚本会如实通知，不承诺重试一定成功。

## 完成通知

Windows 使用 PowerShell + WScript.Shell Popup，完成时显示置顶通知，15 秒自动关闭，不以应用前后台状态为条件。成功、失败、取消以及本地监控异常停止均有通知。文字通过环境变量传递，不拼接进 PowerShell 可执行代码。

macOS 使用 osascript，Linux 使用 notify-send。没有桌面会话或通知工具失败时，会鸣铃并在终端明确提示未能弹窗，不伪装成通知已送达。

## 验证

- YAML 解析及单一 Windows/手动触发/NSIS 构建结构检查通过。
- Bash 语法检查通过。
- 离线模拟测试涵盖：成功、排队/运行中、临时网络失败重试及部分响应隔离、构建失败、取消、错误运行 ID、正常触发、触发响应丢失但不重复发送、按请求 ID 恢复、本地超时不取消云端任务。
- 测试替换 gh 和通知程序，不访问 GitHub、不发布、不弹出真实通知。
- Windows Git Bash 本机模拟测试通过（原 10 项；自动推送扩展为 17 项），PowerShell 发布辅助脚本语法解析通过，`git diff --check` 通过；分支名 URL 编码也有断言检查。未实际执行 GitHub Actions 的 Windows 打包与 Release 上传，不能把静态/模拟验证当作线上构建成功。

## 自动推送保护（后续补充）

用户选择“仅推送已有提交”，没有选择自动提交。正常打包命令默认先自动推送，命令行用法不变。

- 工作区（包括未跟踪文件）不干净时停止，保留所有文件与暂存状态，不调用 git add/commit。
- `--ref` 必须是当前分支；不把当前 HEAD 偷换推送到其他分支，不自动切换/合并分支。
- 校验 origin 唯一推送地址对应的 GitHub 仓库与 `--repo` 一致；多推送地址、其他主机或仓库不一致均拒绝。
- 只推送固定 HEAD 到当前分支；不推送其他分支/标签，不强推，也不自动 pull/rebase 解决分叉。
- Git 认证需预先配置。脚本禁止 Git/GCM 交互式认证提示；认证或网络失败会重试并通知。
- `--allow-remote`、`--run-id`、`--request-id`、`--notify-test` 都不推送。
- workflow 仍须存在于默认分支；在其他分支运行，不会顺带更新默认分支。

测试新增：正常推送、瞬时失败后重试、脏工作区拒绝、仓库不符拒绝、多地址拒绝、跨分支拒绝、非快进拒绝且不触发构建。本次修改没有实际提交、推送或启动线上构建。
