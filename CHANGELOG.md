# Changelog

## 1.0.0

首个版本。目标是"输出前把工具结果压到极致，同时一条信息都不丢"。

### 统计端点为什么挂不上（两次真机定位）

桌面端插件明明在压缩（留痕里有 `optimized` 记录），端点却一直 404。两个原因叠在一起：

1. **冷启动时 `webServer` 还不存在**。宿主按行装载，本插件的行可能排在 webserver 行前面，
   那一刻 `ctx.get('webServer')` 是 undefined（留痕里 `webServer: "absent"`）。判 undefined
   就放弃的话，端点永远挂不上。
2. **`apply` 会被调用多次**（多个 app 层各挂一遍，实测三次）。webserver 对重复路径直接抛
   `duplicate exact route`，未捕获的抛错会把整个 effect 回滚——最先注册成功的那条路由被
   后两次失败一起带走。

修法：`ctx.get()` 立刻试一次 + `ctx.inject(['webServer'], cb)` 事件兜底 + 有限次定时重试
（250ms × 30s，成功即停，定时器 `unref()`）；注册幂等（进程内一次性 + try/catch，重复注册
按"已经在"处理，绝不抛）。三条路汇聚到同一个 `tryMount()`，每次尝试都写留痕。

### 装载留痕

`<DSH_HOME>/context-guard.trace.jsonl` 追加 `apply` 与 `optimized` 两类记录（只记事实，不记结果内容）。
Electron 宿主吞掉插件 stderr，这是桌面端唯一能确认"插件到底有没有被装载"的证据。

### 做了什么

- **挂在 `tools/post-execute`**（宿主公开契约），根上注册一次即覆盖所有 agent 与会话：
  该事件按 `scopeTarget()` 路由，无标签监听器是全局的（标签为祖先的监听器收得到分发到
  后代键的事件）。不包模型调用、不改工具注册表、不加提示词段。
- **三级流水线**：无损规范化 → 类型感知的结构化压缩 → 预算内按信息量取舍；外加跨调用增量。
- **单位记账（`lib/units.js`）**：每个"输出行"自带"它代表几行原文"。这是整个插件的账本：
  多个压缩器叠加（diff 折上下文 → 又去折叠重复行）之后，标记里的数字仍然精确。
- **自校验与回滚**：收尾时把标记声明的行数与实际少掉的行数对账；对不上就整条回滚成原文。
  基准里专门有一条 `OVER-CLAIM` 不变量盯着这件事（声明数不得超过实际少掉的行数）。
- **净收益闸门**：省不到 `minSavingRatio`（默认 12%）或结果变大 → 回滚；比例按文本部分算，
  不把图片等富内容算进分母。
- **跨调用增量**：同一"工具名 + 参数"的输出第二次出现时，给"没变"或"变了哪几行"。
- **配置**：Standard Schema v1 校验，未知键点名报错，校验失败退回全默认。
- **诊断**：装了 `webServer` 时挂只读 `/dsh-context-guard/stats`。

### 实测（本机语料，`node tools/bench.mjs`）

39135 → 16647 估算 token（57.5%），三条不变量 0 失败。分项见 README。

### 修过的坑（都留了注释，避免回归）

1. **`Config` 的导出形状错了，插件静默不激活**（最贵的一个坑）。
   Cordis 的 `resolveConfig(runtime, config)` 读的是
   `runtime.Config['~standard'].validate(config)` —— 也就是导出的 `Config` **本身**必须
   是 Standard Schema 对象。最初把 `Config` 导成了"字段表"（`{ enabled: Field, ... }`），
   宿主读到 `Field['~standard'] === undefined` 后抛
   `TypeError: Cannot read properties of undefined (reading 'validate')`：插件整条不激活、
   统计端点 404，而界面上**什么都不显示**。定位方法是拿一个只剩 `@deepseek-ai/dsh-base`
   和 `dsh-web-app` 的干净 profile 跑 `dsh --profile web --port 0 --no-open`，
   宿主会在 stderr 上打 `dsh: warning: 1 entry did not activate` 加完整堆栈。
   现在 `test/plugin.test.js` 有两条用例直接钉这个形状。
2. **插件必须登记成 profile 的 bundle 才会被装载**。
   只往 profile 的 `package.json` 加依赖、并在 `cordis.patch.yml` 里写 `- insert:` 是**不够**的：
   只有列进 `dsh.profile.bundles` 的包，它自带的 `cordis.patch.yml`（`dsh.bundle.patch`）
   才会被合并成一层。插件自带的 patch 负责"插进树里"，profile 层按 `id` 覆盖负责"配成要的值"
   （profile 层的 `config` 是整块替换语义，每个键都要写全）。
3. **`~/.dsh` 里挂"包住模型调用"的钩子会让宿主内存暴涨**（历史教训）。本插件只用一个
   轻量的 per-result 监听器，不做任何模型路径包装。
2. **标记里的行数会虚报**。早期版本靠"标记之间的行距"倒推覆盖了多少行，遇到嵌套折叠
   （diff 折过的区域又被重复行折叠）和相邻标记时必然算错。改成每个单位自带行数。
3. **空标记会吃掉一行**。`renderUnits` 会丢弃渲染为空的标记（例如 `diff` 标记在它那一段
   已经没有上下文可省时），但"结果有多少行"必须按渲染后的实际情况数，否则总账差一行。
4. **`..` 被当成噪声删掉**：`dropNoise` 早期把 `.` 重复 3 次以上都算进度占位，结果把
   TAP 测试输出里的 `...`（"详情已省略"）也删了。现在只认 4 个以上的点，且 TAP 的
   `...` 不受影响。
5. **`ls -l` 解析列错位**：`(\d+)` 配贪婪的 `\s+\S+` 会把硬链接数 `1` 当成文件大小。
   现在按 `[ \t]+` 分段并显式捕获五个列。
6. **diff 的文件头顺序**：增删计数必须在 hunk 之前结算，否则头行会跑到 hunk 后面。
7. **`\ No newline at end of file` 折进上一行时忘了记账**：文本折了，行数也要加上，
   否则总量校验失败。
8. **`minChars` / `minSavingRatio` 传了但没人用**：两个选项当初只在增量层被读到，压缩层
   完全忽略。现在两个闸门都落在 `optimizeContent` 里（不依赖调用方），并且净收益比例按
   **文本部分**算——把图片等富内容算进分母会让"文本省了一半"看起来像"整体只省了一点"。
```

