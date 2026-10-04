# SkillDock 发布与自动更新

`https://github.com/wanghuan9/skilldock` 同时是 SkillDock 的公开源码仓库和 Release 仓库。正式安装包、版本 tag、GitHub 自动生成的源码包与 `latest.json` 必须对应同一个公开提交。

## 发布前准备

发布提交必须满足以下条件：

- 工作区干净。
- 当前分支已推送到 `origin`，本地 `HEAD` 与上游分支完全一致。
- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号一致。
- 版本 tag 为对应版本号，例如版本 `1.0.9` 使用 `v1.0.9`。
- updater endpoint 继续指向：

  ```text
  https://github.com/wanghuan9/skilldock/releases/latest/download/latest.json
  ```

推荐先把待发布 feature 分支合入 `main` 再发布。确实需要从 feature 分支发布时也可以执行，但该分支必须已经推送；发布脚本会让版本 tag 精确指向该分支的当前提交，不会错误绑定到 `main`。

`release` 和 `workflow_dispatch` 事件要求 workflow 文件已经存在于 GitHub 默认分支。因此首次启用这套公开发布流程时，必须先把 `.github/workflows/release.yml` 合入 `main`。完成首次启用后，后续构建源仍可以选择任意已推送 feature 分支。

## 版本号

发布前同步修改：

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

版本号修改完成后提交并推送，再执行发布命令。

## 推荐方式：本机一键发布

```bash
npm test
npm run release:publish
```

脚本会执行：

1. 校验当前仓库、工作区、上游分支、版本号和 updater endpoint。
2. 校验 Developer ID 签名、公证凭据和 Tauri updater 私钥。
3. 构建并验证 macOS Apple Silicon 安装包、签名和公证票据。
4. 根据公开 Git 历史生成发布日志，并等待人工确认。
5. 创建草稿 Release，上传 macOS 安装包、updater artifacts、签名和 `latest.json`。
6. 所有本地资产上传完成后发布 Release，并让版本 tag 精确指向本次构建的公开提交。
7. Release 发布事件触发公开仓库的 `release.yml`，自动补齐 Windows x64 安装包，并重建包含全部平台的 `latest.json`。

默认 updater 私钥路径：

```text
/Users/wanghuan/data/env/skilldock/skilldock-updater.key
```

也可以显式指定：

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH=/path/to/skilldock-updater.key \
npm run release:publish
```

Apple 公证账号优先读取环境变量 `APPLE_ID`。未设置时，脚本会尝试读取 macOS Keychain 中 service 为 `com.skilldock.notarization` 的账号和密码。任何私钥、证书和密码都不得提交到 git。

## GitHub Actions 发布或补发

`release.yml` 的两个 job 都带 `if: github.repository == 'wanghuan9/skilldock'` 守卫：fork 仓库上触发时 job 直接跳过，不会消耗 runner，也不会因为缺少 secrets 报错。该工作流依赖下列仓库 secrets（fork 不会获得这些 secrets），并且只读写 `wanghuan9/skilldock` 的 Release，因此 fork 仓库上不要手动触发它，改用下文的「macOS Intel 构建」。

公开仓库的 `.github/workflows/release.yml` 支持手动执行：

```bash
gh workflow run release.yml \
  --repo wanghuan9/skilldock \
  --ref feature/plugin-host-runtime-sync \
  -f release_tag=v1.0.9 \
  -f source_ref=feature/plugin-host-runtime-sync
```

`source_ref` 可以是公开分支、tag 或 commit。工作流会解析其精确提交，检查版本号与 `release_tag` 一致，并让 Release tag 指向该提交。

如果 Release 已存在，工作流只构建缺失的平台资产；已有平台不会重复构建。补传时会保留现有 Release 正文和 `latest.json` 中的历史发布说明。

`release.yml` 的构建矩阵包含两个 target：

- `aarch64-apple-darwin`（`macos-latest`，Apple Silicon）
- `x86_64-pc-windows-msvc`（`windows-latest`）

每个 target 在独立 job 中构建，`tauri-action` 只能写入自己构建的平台，因此 `release.yml` 在所有构建 job 之后运行 `updater-metadata` job：它下载 Release 上全部 `.sig` 资产，用 `scripts/updater-metadata.cjs` 保留已有平台条目、补齐缺失平台，并覆盖上传最终的 `latest.json`。缺少这一步时，最后完成的构建 job 会覆盖其他平台的条目，导致部分架构无法自动更新。

## macOS Intel 构建

`macos-intel-build.yml` 在每次 push 和手动触发时，于 `macos-15-intel` runner 上构建 `x86_64-apple-darwin` 的 `app` 与 `dmg`。该 action：

- 不依赖任何仓库 secrets，因此 fork 与 CI 环境都能运行；
- 用 ad-hoc 签名（`signingIdentity: "-"`）覆盖 `tauri.conf.json` 中的 Developer ID，使产物可在 Intel Mac 上直接安装；
- 关闭 updater artifacts，因为不产出 `latest.json`；
- 校验 `package.json`、`tauri.conf.json`、`Cargo.toml` 三处版本一致，并用 `lipo` 确认产物架构确为 `x86_64`；
- 把 `bundle/` 同时作为 workflow artifact 上传（保留 14 天），名称为 `skilldock-<version>-intel`；
- 用内置 `GITHUB_TOKEN` 把 dmg 推送到仓库内滚动更新的 **prerelease** `intel-ci`，资产名为 `SkillDock_<version>_intel.dmg` 与 `SHA256SUMS`。该 Release 始终是 prerelease，不会成为仓库的 latest release，因此不影响 updater 端点与正式版本下载。

首次安装未公证的 Intel 版本后需要执行：

```bash
sudo xattr -cr /Applications/SkillDock.app
```

正式发布的 Intel 安装包仍需在 `release.yml` 的矩阵中增加 `macos-15-intel` / `x86_64-apple-darwin`，并复用同一套 Apple 签名、公证和 updater Secrets。

Intel Mac 构建过程中遇到的 runner 选择、产物命名、secrets 缺失、workflow 变量未定义、签名公证与 macOS 12 兼容性等问题，见 [`release/intel-mac.md`](./intel-mac.md)。

## GitHub Actions Secrets

在以下页面配置：

```text
https://github.com/wanghuan9/skilldock/settings/secrets/actions
```

必需 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `KEYCHAIN_PASSWORD`

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 在私钥没有密码时可以不配置。发布 workflow 使用仓库自带的 `GITHUB_TOKEN` 写入同仓库 Release，不再需要额外的公开仓库 token。

检查配置：

```bash
npm run release:check
```

## 发布日志

预览自动生成的日志：

```bash
npm run release:notes -- \
  --tag v1.0.9 \
  --output /tmp/release-notes.md \
  --summary-output /tmp/release-summary.txt
```

需要人工维护时，在 `docs/release/notes/v<version>.md` 提交同名说明。发布时优先使用该文件，否则根据上一个公开版本 tag 到当前提交的历史自动生成。

GitHub Release 正文、`latest.json.notes` 和 `latest.json.releaseNotesHistory[0].body` 必须保持一致。

## 发布结果检查

发布完成后检查：

```bash
gh release view v1.0.9 --repo wanghuan9/skilldock
git ls-remote --tags origin refs/tags/v1.0.9
curl --fail --location \
  https://github.com/wanghuan9/skilldock/releases/latest/download/latest.json
```

确认 macOS 和 Windows 安装包、updater 签名及 `latest.json` 均已上传，并确认 tag 指向本次构建的公开提交。

## 不要做的事

- 不要提交 updater 私钥、Apple 证书或任何密码。
- 不要从未推送或包含未提交改动的工作区发布。
- 不要让 Release tag 固定指向 `main` 而构建另一条 feature 分支。
- 不要覆盖已经发布且指向其他提交的同名版本 tag。
- 不要删除已有 Release 来处理缺少平台资产的问题；使用 workflow 手动补发。
