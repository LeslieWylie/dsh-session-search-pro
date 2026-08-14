# 🔍 dsh-session-search-pro

[English](./README.md) | **简体中文**

> **搜索你用过的每一个 DSH 会话——无论是过去的还是正在进行的——都不用离开当前会话。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](https://github.com/topics/dsh-plugin)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的三个 agent 工具,构建在 harness 自带的 **`sessionQuery`** 服务之上,而不是手工扫描会话文件。

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

Tieboyh 的 [dsh-session-search](https://github.com/Tieboyh/dsh-session-search) 走的是另一条路:它直接读会话文件、自己解压扫描 zstd 帧,因此**还能搜别的运行时的会话**——Codex、Claude Code、PI、OpenCode。如果你同时在用好几个 agent CLI,那个更合适。

这个插件则走 harness 自己的 `sessionQuery` 服务。好处是能搜到正在进行中的当前会话、不对文件格式做任何假设、不依赖外部二进制;代价是它只能继承部署方配置好的索引能力——包括「压根没开」这一种(见[在默认 profile 上搜索](#在默认-profile-上搜索))。

| 对比项 | dsh-session-search (Tieboyh) | dsh-session-search-pro |
|--------|-------------------------------|------------------------|
| 搜索方式 | 直接读取并扫描会话文件 | harness `sessionQuery`——开启时用 FTS5 索引,否则有界扫描 |
| 当前(进行中)会话 | ❌ 不可搜索 | ✅ 可搜索 |
| 会话文件格式 | 直接解析(zstd 帧扫描) | 完全不碰——只走 harness API |
| 覆盖的外部来源 | codex、claude、pi、opencode | 仅 DSH(单一运行时) |
| 工具数量 | 2 个 | 3 个(search + list + read) |
| 长文本截断 | 单条消息上限 4,000 字符 | 单个事件上限 4,000 字符 |
| 依赖 | ripgrep、node:zlib | 无(零运行时依赖) |

### 优点

- ✅ **零运行时依赖**——没有 ripgrep,没有 zstd 解析,没有本地数据库
- ✅ **默认 profile 上就能用**——部署方开了索引就用 FTS5 索引,没开就退回有界扫描,而不是把一条配置报错当成搜索结果返回
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

对所有 DSH 会话做全文搜索,每条结果都带上匹配度最高的片段。

两套引擎,自动选择——见[在默认 profile 上搜索](#在默认-profile-上搜索)。

| 参数 | 类型 | 是否必填 | 说明 |
|-----------|------|----------|--------------|
| `query` | string | ✅ | 要找的文本。不区分大小写、空白宽松,并且是**字面匹配**——正则元字符没有特殊含义。 |
| `limit` | number | — | 最多返回的会话数,1–50。默认取插件配置里的 `maxResults`(未覆盖时为 10)。 |
| `maxScan` | number | — | 退回扫描时最多打开多少个会话,1–500。默认取插件配置里的 `maxScan`(200)。走索引时忽略。 |

返回值里带 `engine: "index" | "scan"`,你可以据此判断是哪条路径给出的结果;扫描路径还会带 `scanned` 和 `truncated`。

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
| `maxScan` | `200` | `agent_session_search` 退回扫描时,最多打开多少个会话。 |

## 在默认 profile 上搜索

`agent_session_search` 有两套引擎,在调用时自动选择。

**索引。** `@deepseek-ai/dsh-session-query-sqlite` 是标准 `dsh-base` bundle 里
`sessionQuery` 的具体后端,它提供了一个基于 SQLite FTS5 的 `searchSessions()`。
可用时本插件就走它,返回 `engine: "index"`。

**但它默认是关的。** `dsh-base` 是这样接线的:

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never
```

而该引擎自己的守卫在 `openAt` 为 `never` 时会抛 `SESSION_QUERY_SEARCH_DISABLED`。
内容搜索是**选择性开启**的:部署方需要在后续 patch 层里把 `openAt` 覆盖为
`first-search` 或 `startup`,通常还要配一个持久化的 `path`。

所以在默认 profile 上,索引调用一定失败。本插件只捕获这一类错误,退回用
`listSessions()` + `filterEvents()`(每个 `sessionQuery` 后端都有的原语)按最新优先
扫描,并返回 `engine: "scan"`。如果失败**不是**「索引不可用」而是后端真的坏了,
那就如实报错——用一次更慢的扫描去回答一个已经坏掉的存储,对谁都没有帮助。

在本机一份真实的 24 会话语料上实测:

| | 索引(`openAt: first-search`) | 扫描(默认 `openAt: never`) |
|---|---|---|
| 能命中的词 | 3 条结果 | 3 条结果 |
| 命中不到的词 | 17 毫秒 | 3,042 毫秒 |

索引是值得有的——快路径就是为此存在。它只是不能是**唯一**的路径,而 0.1.0 及之前
的版本正是这么假设的。在每一个默认安装上,它们对任何查询都返回
`{"error": "session search is disabled…"}`。没有任何东西抛异常,所以它看上去就像
一个正常工作、只是从来搜不到东西的工具。

要打开索引,在你 profile 的 `cordis.patch.yml` 里覆盖那一行 bundle:

```yaml
- update:
    id: session-query-sqlite
    config:
      path: '~/.dsh/session-index.db'
      openAt: first-search
```

## 工作原理

这个插件只是 harness `sessionQuery` 服务上几个方法的一层薄封装——没有自己的解析、索引或缓存:

- **`searchSessions()`** —— FTS5 全文搜索,支撑 `agent_session_search` 的 `engine: "index"` 路径。**可选**:只存在于 SQLite 后端,且只有该后端开启了搜索时才可用,因此调用前一律先做能力检查。
- **`listSessions()`** —— 按最新优先的确定性顺序返回全部会话,支撑 `agent_session_list` 和 `engine: "scan"` 退路。
- **`filterSessions()`** —— 按 id 做安全的存在性检查(遇到未知 id 返回 `[]` 而不是抛错),`agent_session_read` 在真正读取内容之前会先用它检查。
- **`filterEvents()`** —— 拍平后的、已提取好文本的逐事件数据,支撑 `agent_session_read` 的事件内容;配合 `text` 过滤器时也支撑扫描退路的匹配。
- **`readTitle()`** / **`readTitleSnapshots()`** —— 单个和批量的标题解析。会话头本身不带标题字段,所以任何要显示标题的工具都要单独通过这两个方法之一去解析。

所有访问都是只读的。插件不会创建自己的数据库、索引或持久缓存——它读的都是 `sessionQuery` 本来就维护的数据。

## 局限

- **仅支持 DSH**——不搜索 Codex、Claude Code、PI 或 OpenCode 的会话(这点不如 dsh-session-search)。
- **依赖 `sessionQuery`**——三个工具都依赖它,没有降级模式。如果这个服务没有被注入,插件会直接不注册任何工具,而不是注册一批会失败的工具。
- **扫描退路是一个会话一个会话打开的。** `filterEvents()` 按会话工作,而且要读完那个会话的整份日志,所以一次没有命中的搜索会走遍语料。`maxScan` 用来兜底,`truncated: true` 会告诉你是否触到了上限。语料很大就把索引打开。
- **`agent_session_read` 的事件读取不支持取消**——底层服务的 `filterEvents()` 不接受 abort signal,所以就算调用被中止,读取本身依然会跑完,只是结果被丢弃。

## 开发

纯 JavaScript,没有构建步骤。源码和发布用的是同一个文件:`lib/index.js`。

```sh
git clone https://github.com/LeslieWylie/dsh-session-search-pro.git
cd dsh-session-search-pro
pnpm install
npm test
```

两套测试,都会真正执行 `lib/index.js`,都不是源码文本或正则检查:

- **`tests/tools.test.mjs`** 针对一个打桩的 `sessionQuery` 驱动 `apply()`,覆盖两套引擎、退路,以及参数校验路径。
- **`tests/boot.test.mjs`** 启动一个真实的 cordis `Context`,加载 harness 自己的会话服务,按 profile 的方式装载本包,再通过**真实的**工具注册表执行这些工具。

第二套存在的理由,就是 0.1.0 是怎么坏掉的:它的搜索工具无条件调用 `sq.searchSessions(...)`,而单元测试的桩自己定义了一个 `searchSessions`,于是测试全绿;但在默认 profile 上这个调用会抛 `SESSION_QUERY_SEARCH_DISABLED`,工具就把这条配置报错当作每一次查询的答案返回。**你自己写的桩,只会确认你自己的误解。** 所以 `boot.test.mjs` 会把源码里每一处 `sq.<method>()` 调用点跟 harness 真正发布的服务对照:无保护的调用必须存在,有保护的可以缺席,并且另外确认「有保护的方法」在某个已发布后端上确实存在,而不是一个凭空发明、会让快路径变成死代码的名字。

它需要 harness 的包,因此在纯 clone 下会以 exit 0 跳过。要真正跑起来:

```sh
cd ~/.dsh/profiles/<profile>/node_modules/dsh-session-search-pro && node tests/boot.test.mjs
```

## 协议

MIT © LeslieWylie
