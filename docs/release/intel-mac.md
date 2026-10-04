# Intel Mac：问题与解决方案汇总

本文汇总 SkillDock 在 Intel（`x86_64`）macOS 上构建、打包、发布过程中遇到的问题，按"现象 → 原因 → 解决"组织，供后续排查直接对照。

相关文档：[`release/updater.md`](./updater.md)（正式发布流程）。

---

## 1. 流水线拆分：为什么不把 Intel 加进 `release.yml`

### 现象

最初的做法是给 `.github/workflows/release.yml` 的矩阵加一个 `x86_64-apple-darwin` 项，和 Apple Silicon、Windows 并列构建发布。在 `moods445/skilldock` 上触发后直接失败：

```
Missing required release secret(s): TAURI_SIGNING_PRIVATE_KEY APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID KEYCHAIN_PASSWORD
```

7 个 secret 全部为空。

### 原因

两条，都不是代码问题：

1. **fork 拿不到 secrets。** 本仓库 `origin` 是 `git@github.com:moods445/skilldock.git`，而这 7 个 secret 只配置在公开仓库 `wanghuan9/skilldock`。GitHub 不会把 secrets 复制到 fork，`fork` 的 Actions 里这些变量恒为空。注意 `TAURI_SIGNING_PRIVATE_KEY` 是所有 target 的必需项，所以缺它时 Windows job 同样失败 —— 不是只有 macOS 受影响。
2. **`release.yml` 是写给公开仓库的。** 文件里有 5 处硬编码 `wanghuan9/skilldock`，加上 `tauri-apps/tauri-action` 的 `owner: wanghuan9 / repo: skilldock`。在 fork 上触发它会去读、甚至写入**原仓库**的 Release。这不是"少配一个 secret"能解决的，属于设计上就不该在 fork 跑。

### 解决

拆成两条职责清晰的流水线：

| 流水线 | runner / target | 签名 | 产物去向 | secrets |
| --- | --- | --- | --- | --- |
| `macos-intel-build.yml` | `macos-15-intel` / `x86_64-apple-darwin` | ad-hoc | workflow artifact + 滚动 prerelease `intel-ci` | 不需要 |
| `release.yml` | `macos-latest` / `aarch64-apple-darwin`、`windows-latest` / `x86_64-pc-windows-msvc` | Developer ID + 公证 | 正式 Release + `latest.json` | 需要全部 7 个 |

同时给 `release.yml` 的两个 job 加仓库守卫，fork 上直接 skipped，既不占 runner 也不会误写公开仓库：

```yaml
jobs:
  publish:
    if: github.repository == 'wanghuan9/skilldock'
```

`macos-intel-build.yml` 的触发条件是 `on: push` + `workflow_dispatch`，所以每次推送自动打包。

---

## 2. runner 选择与"是不是 Intel 原生编译"

### 结论

`macos-15-intel` runner 本身就是 Intel x86_64 机器，target `x86_64-apple-darwin` 就是它的宿主架构 —— **原生编译，零交叉编译、零转译，Intel Mac 上不需要 Rosetta**。

对比容易混淆的两点：

- 反过来，Apple Silicon 装这个 Intel 包才需要 Rosetta。
- 不用 `macos-latest`（arm64）交叉编译：那样要额外装 x86_64 的 Rust std，且 `npm ci` 装到的 esbuild/rollup 原生二进制是 arm64 版，与 Rust 侧产物架构不一致。

### `macos-13` 不可用

早期 Intel 方案会用 `macos-13`。该 runner 已下线，目前 GitHub 只提供两个 Intel macOS label：

```yaml
runs-on: macos-15-intel   # x86_64, 4 核, 14 GB
runs-on: macos-26-intel   # x86_64, 4 核, 14 GB
```

`macos-latest` / `macos-14` / `macos-15` / `macos-26` 全部是 arm64。

### 架构必须校验，不能靠约定

runner 镜像哪天被换掉、或产物被错误编译成 arm64，都会静默产出错误安装包。所以 CI 里用 `lipo` 硬断言：

```bash
binary_arch="$(lipo -archs "$app_path/Contents/MacOS/SkillDock")"
[[ "$binary_arch" == "x86_64" ]] || exit 1
```

`dist/` 里的前端产物是纯 JS/CSS，与架构无关，由各系统自带的 WKWebView 解释执行 —— 架构差异只体现在 Rust 编译出的那个二进制上，也正是 `lipo` 校验的对象。

---

## 3. 产物命名错误

### 现象

第一次成功构建后，artifact 名称是裸的 target triple：

```
skilldock-1.0.21-x86_64-apple-darwin  22658047 bytes
```

### 原因

artifact 名直接用了 `${{ env.TARGET }}`。对 CI 内部无所谓，但用户下载时看到的是一串构建三元组，看不出这是给 Intel Mac 的包；Release 资产名 `SkillDock_1.0.21_x86_64.dmg` 同理。

### 解决

- artifact → `skilldock-<version>-intel`
- Release 资产在上传前重命名 → `SkillDock_<version>_intel.dmg`，附带 `SHA256SUMS`

Tauri 生成的 dmg 名由 `productName`/`version`/target 决定，不改这些就不动源文件名，而是在 `gh release upload` 前 `cp` 一份重命名。

---

## 4. 产物没有出现在 GitHub Release

### 现象

artifact 有了，但 Release 里空的（`moods445/skilldock` 当时一个 Release 都没有）。

### 原因

上一轮明确选择了"只跑 CI 打包、不发布 Release"，所以 `macos-intel-build.yml` 只做 `actions/upload-artifact`，产物只保留 14 天。

### 解决

增加一个发布步骤，用**内置 `GITHUB_TOKEN`**（`permissions: contents: write`），不依赖任何 secret：

- 固定滚动 tag **`intel-ci`**，每次 push 用 `--clobber` 覆盖同名资产，避免每次推送都造一个 tag
- 必须带 `--prerelease`：GitHub 的 "latest release" 只取非 draft、非 prerelease 的最新一个，这样它永远不会成为 latest，`releases/latest/download/latest.json` 和正式版本下载都不受影响
- Release 不存在时 `gh release create`（带 `--target "$GITHUB_SHA"`），存在时 `gh release upload --clobber`

实测结果：

```
artifact:  skilldock-1.0.21-intel                          22658045 bytes
Release:   SkillDock 1.0.21 (Intel, CI)  tag=intel-ci  Pre-release
assets:    SkillDock_1.0.21_intel.dmg  11284289 bytes
           SHA256SUMS                        93 bytes
```

下载链接：

```text
https://github.com/moods445/skilldock/releases/download/intel-ci/SkillDock_1.0.21_intel.dmg
```

dmg 11.3 MB、artifact 22.7 MB，差值来自 artifact 还包含未压缩的 `.app`。

---

## 5. `VERSION: unbound variable`

### 现象

```
src-tauri/target/x86_64-apple-darwin/release/bundle/macos/SkillDock.app: valid on disk
... satisfies its Designated Requirement
/Users/runner/work/_temp/....sh: line 28: VERSION: unbound variable
```

### 原因

两个不同的坑，都由 `set -euo pipefail` 的 `-u` 暴露出来：

1. **`GITHUB_OUTPUT` ≠ 环境变量。** `Resolve build metadata` 把版本写进了 `$GITHUB_OUTPUT`（供后续步骤用 `${{ steps.x.outputs.y }}` 插值），但脚本里直接读了 `${VERSION}` —— 那个 shell 里根本没有这个变量。
2. **跨步骤引用 shell 局部变量。** `release_dmg_name` 和 `dmg_checksum` 是 `Verify bundle` 步骤内定义的局部变量，`Publish` 步骤却直接引用。GitHub Actions 每步是独立进程，局部变量不会传递。

### 解决

1. 需要在后续步骤的 shell 里读取，就导出到环境：

```bash
echo "VERSION=$package_version" >> "$GITHUB_ENV"
```

2. 跨步骤传值走 step output：

```yaml
      - name: Publish Intel build to GitHub Release
        env:
          RELEASE_DMG: ${{ steps.verify.outputs.dmg_name }}
          DMG_CHECKSUM: ${{ steps.verify.outputs.dmg_checksum }}
```

注意 `GITHUB_ENV` 只对**后续**步骤生效，不能在写入它的同一步骤里使用。

### 如何避免复发

构建前静态核对每个 `run` 块引用的变量是否都有来源（step env / workflow env / `$GITHUB_ENV` / 本步骤内赋值）。这次的教训是：`${{ }}` 插值和 `${}` shell 展开是两套机制，`$GITHUB_OUTPUT` 只喂前者。

---

## 6. 签名与公证

### 现象 / 原因

CI 上没有 Apple 证书，而 `tauri.conf.json` 硬编码了 Developer ID：

```json
"macOS": { "signingIdentity": "Developer ID Application: huan wang (7BMASR586D)" }
```

同时 `bundle.createUpdaterArtifacts` 为 `true`，而 `createUpdaterArtifacts` 需要 `TAURI_SIGNING_PRIVATE_KEY`，没有就会构建失败。

### 解决

CLI `--config` 覆盖（优先级高于 `tauri.conf.json`）：

```bash
npm run desktop:build -- \
  --target "$TARGET" \
  --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}'
```

- `signingIdentity: "-"` = ad-hoc 签名。x86_64 macOS 上 ad-hoc 签名的 app 可以直接运行，代价是没有 Gatekeeper 信任、没有 notarization。
- `createUpdaterArtifacts: false`：这个流水线不产出 `latest.json`，生成 updater 包没有意义。

### 用户侧安装步骤

未公证的包首次安装后需要放行：

```bash
sudo xattr -cr /Applications/SkillDock.app
```

CI 校验签名用 `codesign --verify --deep --strict --verbose=2`（ad-hoc 下不能 grep `Authority=Developer ID`，那是正式发布才有的）。

---

## 7. macOS 系统版本兼容性

### 实测数据

对 `src/` 全量扫描现代 CSS/JS 特性，结果：

| 特性 | 位置 | Safari/WebKit 最低版本 | macOS 对应 |
| --- | --- | --- | --- |
| `color-mix()` | `src/styles/tokens.css`，**292 处** | 16.2 | 13.0 |
| `structuredClone()` | `src/features/skills/state/skill-fixtures.ts`，4 处 | 15.4 | 12.3 |
| `backdrop-filter` | `src/styles/tokens.css`，10 处 | 18（无前缀） / 9（`-webkit-` 前缀） | — |
| `navigator.clipboard` | 3 处 | 13.1 | 10.15 |
| `ResizeObserver` | 4 处 | 13.1 | 10.15 |

未使用：`:has()`、`@container`、`subgrid`、`oklch`、`view-transition`、`dialog`、CSS 嵌套 —— 这些都是 Safari 16~18 才支持的。Vite 未配置 `build.target`，默认 `['es2020', ..., 'safari14']`，语法层面对 Safari 14 以上都没问题。

### 结论

| 系统 | WebKit | 结果 |
| --- | --- | --- |
| macOS 13+ | Safari 16.2+ | 完好 |
| macOS 12 | Safari 15.6 | **可运行，但视觉明显降级** |
| macOS 11 及以下 | Safari 15 以下 | 不支持（Tauri 2 要求 macOS ≥ 10.15） |

### 为什么 12 上只是降级而不是白屏

292 处 `color-mix()` 全部用在具体选择器的属性值上，**没有**写在 `:root` 的变量定义里：

```css
.app-select__trigger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line) 66%);
}
```

在不支持的 WebKit 上整条声明被丢弃、属性回退到继承值 —— 不会引起 CSS 变量连锁失效。实际表现是：按钮 hover 描边、focus ring、tag 淡背景、`box-shadow` 光晕、分隔线消失或变成默认色。功能逻辑完全正常。

### 安装可行性

- 产物是 `x86_64`，macOS 12 的 Intel 架构匹配，可正常安装启动
- Tauri 2 官方要求 macOS 10.15+，12 满足
- `tauri.conf.json` 里的 `minimumSystemVersion: "10.13"` 只是 bundle 元数据（实际影响旧系统的安装拦截），**不代表渲染能力**，别拿它当兼容性依据

### 要支持 macOS 12 的方案（未实施）

推荐在**构建期**把 `color-mix()` 展开成静态颜色，而不是手写 292 处 `@supports` fallback：

```bash
npm i -D postcss postcss-color-mix-function
```

```ts
// vite.config.ts
css: { postcss: { plugins: [postcssColorMix()] } }
```

产物里不再有 `color-mix()`，Safari 15.6 也能正确渲染，对 Apple Silicon 产物是零成本收益。

顺带可做：给 10 处 `backdrop-filter` 补齐 `-webkit-` 前缀（目前只有 1 处有），macOS 12~15 上才能有毛玻璃；把 `minimumSystemVersion` 改成实际值。

---

## 8. updater `latest.json` 平台被覆盖

### 现象

`release.yml` 有多个矩阵 job，每个都用 `tauri-apps/tauri-action` 上传 `latest.json`，而 tauri-action 只知道自己构建的那个平台。原先的"保留已有元数据"步骤用的是浅合并：

```bash
jq -s '.[1] * .[0]' updated_updater/latest.json existing_updater/latest.json
```

`platforms` 是嵌套对象，`*` 不会深合并 —— 整个 `platforms` 被新写入的那份替换，最后完成的 job 决定内容。并发构建时另一个架构的条目直接丢失，表现为该架构的自动更新失败。

### 解决

新增 `updater-metadata` job（`needs: publish`），在所有构建 job 之后统一重建 manifest：下载 Release 上全部 `.sig` 资产，用 `scripts/updater-metadata.cjs` 保留已有平台条目、补齐缺失平台，再覆盖上传。`notes` 取自 Release 正文以满足"GitHub Release 正文与 `latest.json.notes` 一致"的既有约束；没有签名资产时不动 `latest.json`。

---

## 9. 验证手段

```bash
# workflow 与运行记录
gh run list --repo moods445/skilldock --workflow "macOS Intel Build" --limit 5
gh run view <run-id> --repo moods445/skilldock --log | grep -E 'binary arch|SHA-256'

# artifact 与 Release
gh api repos/moods445/skilldock/actions/runs/<run-id>/artifacts \
  --jq '.artifacts[] | "\(.name)  \(.size_in_bytes) bytes"'
gh release view intel-ci --repo moods445/skilldock \
  --json name,tagName,isPrerelease,isDraft,assets

# 本地校验 workflow 与脚本（不触发构建）
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/macos-intel-build.yml'))"
node --check scripts/updater-metadata.cjs
```

CI 里已内置的硬校验：

- 三处版本号一致（`package.json` / `tauri.conf.json` / `Cargo.toml`）
- `lipo -archs` 必须等于 `x86_64`
- `codesign --verify --deep --strict`
- dmg 产物数量恰好为 1

---

## 10. 已知遗留问题

- **README 平台表与实际渠道不符。** `README.md` / `README.zh-CN.md` 的下载表格里标着 `macOS Intel (x86_64) | Released`，但正式 Release 里目前没有 Intel 安装包，Intel 包只存在于 `intel-ci` 这个 prerelease。措辞需要与发布策略对齐。
- **Intel 包是 ad-hoc 签名、未公证。** 用户必须执行 `sudo xattr -cr /Applications/SkillDock.app`。若要让 Intel 用户免这一步，需在 `wanghuan9/skilldock` 配齐 Apple 证书并把 Intel target 加回 `release.yml` 矩阵（同时把 5 处硬编码的 `wanghuan9/skilldock` 与 tauri-action 的 `owner/repo` 一起参数化，否则在 fork 上会往原仓库写 Release）。
- **macOS 12 的 `color-mix()` 降级未修复**，方案见第 7 节。
- **`macos-intel-build.yml` 在每次 push 都跑完整 Rust release 构建**（约 11 分钟）。若 CI 配额紧张，可在 `on.push` 下加 `paths-ignore` 跳过纯文档改动。
