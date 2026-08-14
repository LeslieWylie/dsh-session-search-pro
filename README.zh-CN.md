# 🔍 dsh-session-search-pro

[English](./README.md) | **简体中文**

> **搜索你用过的每一个 DSH 会话——无论是过去的还是正在进行的——都不用离开当前会话。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](https://github.com/topics/dsh-plugin)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的三个 agent 工具,构建在运行时自带的索引服务 **`sessionQuery`** 之上,而不是手工扫描会话文件。

---

## 安装

目前还没有发布到 npm,所以直接从 GitHub 安装。把它加到你的 profile 的 `package.json` 里:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-session-search-pro": "github:LeslieWylie/dsh-session-search-pro"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-session-search-pro"]
    }
  }
}
```

然后重新安装依赖并重启 profile:

```sh
cd ~/.dsh/profiles/<profile> && pnpm install
dsh --profile <profile>
```

想固定到某个版本而不是跟随默认分支,可以用 `github:LeslieWylie/dsh-session-search-pro#v0.1.0`。

<details>
<summary>不想改 profile 配置?先试用一下</summary>

这个包自带 `cordis.patch.yml`,所以只要它已经装进了 profile 的 `node_modules`,就可以用启动器的 `--patch` 参数临时挂载一次,不用动 `dsh.profile.bundles`:

```sh
cd ~/.dsh/profiles/<profile> && pnpm add github:LeslieWylie/dsh-session-search-pro
dsh --profile <profile> --patch ./node_modules/dsh-session-search-pro/cordis.patch.yml
```

</details>

## 为什么又做一个会话搜索插件

Tieboyh 的 [dsh-session-search](https://github.com/Tieboyh/dsh-session-search) 做得不错,但它是**无索引**的——每次搜索都要把 zstd 会话文件从头解压扫描一遍。这个插件换了个思路:直接调用 harness 自带的 **`sessionQuery`** 服务,它本来就为每一个会话(无论是否已结束)维护着索引。

| 对比项 | dsh-session-search (Tieboyh) | dsh-session-search-pro |
|--------|-------------------------------|------------------------|
| 搜索方式 | 每次调用都全量扫描 zstd 文件 | DSH 内置的索引服务 `sessionQuery` |
| 当前(进行中)会话 | ❌ 不可搜索 | ✅ 可通过 `sessionQuery` 搜索 |
| 手工解析 zstd | ✅ 是(结构化帧扫描) | ❌ 否——只走 harness API |
| 覆盖的外部来源 | codex、claude、pi、opencode | 仅 DSH(单一运行时) |
| 工具数量 | 2 个 | 3 个(search + list + read) |
| 长文本截断 | 单条消息上限 4,000 字符 | 单个事件上限 4,000 字符 |
| 依赖 | ripgrep、node:zlib | 无(零运行时依赖) |

### 优点

- ✅ **零运行时依赖**——没有 ripgrep,没有 zstd 解析,没有本地数据库
- ✅ **索引搜索**——通过 `sessionQuery.searchSessions()` 做全文排序,不是线性扫描
- ✅ **当前会话也能搜**——不只是已经结束的会话
- ✅ **失败即关闭,而不是半开**——如果 `sessionQuery` 服务压根不可用,插件会记一条警告日志然后不注册任何工具,而不是注册了一堆一调用就报错的工具
- ✅ **只读**——从不写入会话数据,自己也不维护任何数据库或缓存
- ✅ **MIT 协议**

## 使用方式

插件一旦被打包进 profile,agent 就会自动拿到这些工具。像这样问就行:

> "帮我搜一下之前关于 session search 的会话"
> "列出我在 ~/Desktop 下的最近会话"
> "读一下 a4d75296-fc89-44b1 这个会话"

模型会自己去调 `agent_session_search`、`agent_session_list` 或 `agent_session_read`。

## 工具说明

### `agent_session_search`

对所有 DSH 会话做全文搜索,按相关度排序,每条结果都带上匹配度最高的片段。

| 参数 | 类型 | 是否必填 | 说明 |
|-----------|------|----------|--------------|
| `query` | string | ✅ | 全文搜索关键词(不区分大小写),匹配会话事件内容。 |
| `limit` | number | — | 最多返回的会话数,1–50。默认取插件配置里的 `maxResults`(未覆盖时为 10)。 |

### `agent_session_list`

列出会话——不论过去还是当前——可选按工作目录过滤,按最新或最旧排序。

| 参数 | 类型 | 是否必填 | 说明 |
|-----------|------|----------|--------------|
| `limit` | number | — | 最多返回的会话数,1–100。默认 20。 |
| `cwd` | string | — | 按会话工作目录做子串过滤。 |
| `sort` | `"newest"` \| `"oldest"` | — | 排序方式,默认 `newest`。 |

### `agent_session_read`

按 id 读取单个会话:标题、元数据,以及按顺序排列的事件。

| 参数 | 类型 | 是否必填 | 说明 |
|-----------|------|----------|--------------|
| `sessionId` | string | ✅ | 要读取的会话 id,例如 `"a4d75296-fc89-44b1"`。 |
| `maxEvents` | number | — | 最多返回的事件数(取最近的若干条),1–200。默认 50。 |

## 插件配置

在 `cordis.patch.yml`(或你自己的 patch overlay)的 bundle 行里设置:

| 键 | 默认值 | 说明 |
|-----|---------|--------------|
| `maxResults` | `10` | 调用方不传 `limit` 时,`agent_session_search` 使用的默认值。 |

## 工作原理

这个插件只是 harness `sessionQuery` 服务上五个方法的一层薄封装——没有自己的解析、索引或缓存:

- **`searchSessions()`** —— 跨所有会话的排序全文搜索,支撑 `agent_session_search`。
- **`listSessions()`** —— 按最新优先的确定性顺序返回全部会话,支撑 `agent_session_list`。
- **`filterSessions()`** —— 按 id 做安全的存在性检查(遇到未知 id 返回 `[]` 而不是抛错),`agent_session_read` 在真正读取内容之前会先用它检查。
- **`filterEvents()`** —— 拍平后的、已提取好文本的逐事件数据,支撑 `agent_session_read` 的事件内容。
- **`readTitle()`** / **`readTitleSnapshots()`** —— 单个和批量的标题解析。会话头本身不带标题字段,所以任何要显示标题的工具都要单独通过这两个方法之一去解析。

所有访问都是只读的。插件不会创建自己的数据库、索引或持久缓存——它读的都是 `sessionQuery` 本来就维护的数据。

## 局限

- **仅支持 DSH**——不搜索 Codex、Claude Code、PI 或 OpenCode 的会话(这点不如 dsh-session-search)。
- **依赖 `sessionQuery`**——三个工具都依赖它,没有降级模式。如果这个服务没有被注入,插件会直接不注册任何工具,而不是注册一批会失败的工具。
- **`agent_session_read` 的事件读取不支持取消**——底层服务的 `filterEvents()` 不接受 abort signal,所以就算调用被中止,读取本身依然会跑完,只是结果被丢弃。

## 开发

纯 JavaScript,没有构建步骤。源码和发布用的是同一个文件:`lib/index.js`。

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
cd dsh-session-search-pro
pnpm install
npm test   # 运行 tests/tools.test.mjs —— 会真正 import lib/index.js 并执行,
           # 针对一个打桩的 sessionQuery 跑断言,不是源码文本/正则检查
```

## 协议

MIT © LeslieWylie
