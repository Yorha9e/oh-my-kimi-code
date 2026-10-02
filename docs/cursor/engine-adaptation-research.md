# Engine Adaptation Research: Raw Findings (3 Explorations)

> 逐字固化 2026-09-09 三次并行 explore 的调研原文要点。这三份报告支撑了
> [engine-state-persistence](engine-state-persistence.md) 的设计结论;本文保留
> 设计文档未收录的全部代码事实、行号与备选方案细节,供实现时直接引用。
> 来源:explore agent-427(session 恢复链路)、agent-429(持久化参考)、
> agent-428(边界场景)。仓库基线:D:/vscode/kimisubagentexplore/kimi-code-community。

---

## 报告一(agent-427):session 持久化 / provider 生命周期 / 挂点候选

### 1. session 持久化机制:JSONL + state.json 双轨

| 层 | v1 路径 | v2 路径 |
|---|---|---|
| 会话目录 | `~/.kimi-code/sessions/<encodeWorkDirKey(workDir)>/<sessionId>/` | `~/.kimi-code/<scope>/sessions/<sessionId>/` |
| 会话元数据 | `state.json` | `state.json`(IAtomicDocumentStore, key=`state.json`) |
| agent 事件日志 | `agents/<agentId>/wire.jsonl`(一行一 AgentRecord) | `agents/<agentId>/wire.jsonl`(IAppendLogStore + IWireService) |
| 索引 | 全局 `session_index.jsonl` | `session_index.jsonl` + MiniDB 镜面 |

### 2. v1 关键代码

- `packages/agent-core/src/session/store/session-store.ts:67` `SessionStore`;`:79 sessionDirFor`;`:118 create`。
- wire 落盘:`packages/agent-core/src/agent/records/persistence.ts:48` `FileSystemAgentRecordPersistence`;`:60 read`(流式逐行 JSON.parse);`:99 append` + `scheduleFlush`;`:105 rewrite`(shouldClear + 全量重写);`:169 drainBatch`(`open(filePath, shouldClear?'w':'a')`)。
- 记录结构:`packages/agent-core/src/agent/records/types.ts:36` `AgentRecordEvents`——`metadata`(:37)、`turn.prompt`(:42)、`context.append_message`(:129)、`config.update`、`llm.request`(:174)、`llm.tools_snapshot` 等 ~20 种。
- state.json:`packages/agent-core/src/session/index.ts:1228` `metadataPath`;`:1232 writeMetadata`(promise 链防并发);`:1249 readMetadata`。
- 恢复入口:`session/index.ts:642 resume()` → `readMetadata` → `resumeAgent('main')` → `:1491 resumePersistedAgent`(`instantiateAgent(id, join(homedir,'agents',id))`)→ `agent.resume()`。
- Agent 重放:`packages/agent-core/src/agent/index.ts:542 resume` → `records.replay()`(`records/index.ts:283`,逐行 `restoreAgentRecord`)→ `blobStore.rehydrateParts` → `markOpened()`。
- **replay 守卫**:`records/index.ts:244 logRecord` `if(_restoring!==null) return`;`agent/index.ts:736 emitEvent` 同样抑制——**状态回灌必须避开 restoring 窗口,否则被静默丢弃**。
- `restoreAgentRecord` 注释(:22-24)明确:重放期间**不发网络/不写盘/不调 LLM**。
- 落盘保证:`Session.close():683` / `closeForReload():703` 都调 `flushMetadata()` + `records.flush()`。

### 3. v2 关键代码

- AppendLog:`packages/agent-core-v2/src/persistence/backends/node-fs/appendLogStore.ts:35` `AppendLogStore`;`:42 append`(pending + scheduleFlush);`:51 read`(先 flushLog 再 readStream);`:93 rewrite`(atomic)。
- WireService:`packages/agent-core-v2/src/wire/wireService.ts:31`;`:47 seal`;`:55 appendRecord`;`:80 readJournal`(migrations + rewrite)。`AGENT_WIRE_RECORD_KEY='wire.jsonl'` 定义于 `wire/record.ts:3`。
- 会话元数据:`packages/agent-core-v2/src/session/sessionMetadata/sessionMetadataService.ts:23` `META_KEY='state.json'`;`:177 load`;`:90 update`。
- 恢复入口:`packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts:311 resume` → `:338 doResume`(index.get → materializeSession → `agents.findAgentHandle('main')` 缺失则 `create({agentId:'main'})`)→ `:299 announceCreated({source:'resume'})`。
- materialize:`:220 materializeSession`(`createScopedChildHandle(LifecycleScope.Session, seeds: sessionContextSeed(ctx))`;`:271 await ISessionMetadata.ready`)。
- Agent 状态重建:`packages/agent-core-v2/src/state/eventDispatcherService.ts:637 restore()`——`wire.readJournal()` 逐条 `executeEvent(event, /*silent*/ true)`(不写盘不发 bus);`:679 rehydrateStates()`(blob 回填);`:680 hooks.onDidRestore.run({})`。
- 由 `packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts:195 doCreate` 末尾触发。
- 上下文恢复后:`AgentContextMemoryService.get():54` = `agentState.get(contextMemoryKey)`(`contextOps.ts:79`,replayable + undoable + blobs.dehydrate/rehydrate)。**含 tool 消息与 compaction 摘要,完整无缺**。

### 4. provider 生命周期(两引擎一致的核心事实)

- 工厂本身无缓存:`packages/kosong/src/providers/index.ts:27 createProvider` 纯 switch + new;`:20 ProviderConfig type:'cursor'`。
- **v1 缓存**:`packages/agent-core/src/agent/config/index.ts:195 providerMemo:{key,provider}`;`:197 get provider`——`memoKey=JSON.stringify(providerConfig)`,miss 则 `createProvider`;`:211 provider.withThinking(...)`。`Agent.llm:434` 每次 new KosongLLM 但共享 provider 实例。
- **withThinking 浅拷贝**:`packages/kosong/src/providers/cursor-native/index.ts:516-522` `Object.assign(Object.create(getPrototypeOf(this)), this)`——`_blobStore/_turnIds` 等**引用共享**,这就是同配置多次 generate 能连续工作的机制。
- **v2 缓存**:`packages/agent-core-v2/src/kosong/model/catalogService.ts:124 entry` 惰性建 `ModelRequesterImpl`(`:126`);`modelRequesterImpl.ts:25 cachedChatProvider` + `:32 resolveChatProvider`(首次 `protocolRegistry.createChatProvider`);`catalogService.ts:98 notifyConfigChanged(){cache.clear()}`。
- cursor 注册(v2):`packages/agent-core-v2/src/kosong/provider/bases/cursor/cursor.contrib.ts:31 registerProtocolBase({id:'cursor', createChatProvider})`;`:9 CursorProtocolAdapter` 仅转发。协议标识:`src/kosong/protocol/protocol.ts:10` ProtocolSchema 含 `'cursor'`。
- **恢复时必重建**:新 Agent 全新构造 → ConfigState 从空开始逐条 replay `config.update` → memoKey 变化 → new 空状态 provider。v2 的 `createScopedChildHandle(Session)` 也不共享 App 级缓存在**旧 session** 里的实例。
- 全库**无 `managed:cursor` 字面量**——引擎只认 `protocol:'cursor'`(v2)/`type:'cursor'`(v1);`managed:cursor` 是 config 层别名。

### 5. 挂点候选对比(报告原文)

| 候选 | 机制 | 工作量 | 优点 | 缺点 |
|---|---|---|---|---|
| A: v1 AgentRecord | `AgentRecordEvents` 新增 `cursor.blob_state`(`types.ts:36`);写:`kosong-llm.ts` generate 成功后 `records.logRecord`;读:`records/index.ts:32 restoreAgentRecord` 新分支 → `ConfigState.restoreCursorBlobs` | ~3 文件 80 行 | 与持久化同构、自动参与 replay/forkTurnSlice/wire-scan | 污染 v1 事件类型;checkpoint 全量写 Maps 体积需评估 |
| B: v2 replayable state | `defineState('cursor')` + `agentState.contributeState`(须 `restorePhase==='new'`,`eventDispatcherService.ts:188` 否则 BugIndicatingError)+ durable 事件自动落盘(`:484 executeEvent`→`appendRecord`)+ `onDidRestore` 回灌 provider | ~4 文件 120 行 | 事件+replayable 架构一等公民;自动可撤销/审计;onDidRestore 语义精确 | 时序约束;ModelRequesterImpl(per-model)与 per-agent state 需映射 |
| C: state.json 侧车 | `IAtomicDocumentStore.set(sessionScope,'cursor.json',snapshot)`;写于 runRequest usage/finish 后;读于 materializeSession 后 | 1-2 文件 | 最小侵入 | **fork 硬伤**:`sliceMainRecordsAtTurn` 精确裁 wire 但侧车全量 → 子会话 `_turnIds` 越界;多 agent 最后写者胜丢 checkpoint。仅 POC |

报告结论:**B > A > C**;v1 先落 A、v2 并行落 B 为"只改一处做 Demo"路径(我们最终定为只做 B,v1 在退化路径上)。

### 6. 报告一附注(如实告知项)

- v1 恢复完成无专用 Event(只有 `resume()` 返回 Promise + `triggerSessionStart('resume')` hook);需事件要自加 Emitter。
- wire-manifest(`packages/agent-core-v2/docs/wire-manifest.d.ts` + `scripts/gen-wire-manifest.mts`)未含 cursor——该渠道从无持久化设计。
- blob 体积风险:长会话 `_blobStore` 可达数 MB;`IAtomicDocumentStore` 文档大小与 `AppendLogStore.drain` 压力需评估,必要时走 `src/persistence/interface/blobStore.ts` 外置。

---

## 报告二(agent-429):官方持久化参考 + omkc 先例排查

### A. 官方 cursor CLI(SQLite 单文件双表)

- 实现位置:官方合包 `../agent-kv/dist/index.js` `class Y`(导出 `pH`)= AgentStore;持久后端 `../cursor-sdk-local-runtime/dist/run-store/sqlite-blob-store.js`(chunk 8176.index.js 内联),`class l`。
- **内存版仅测试用**:`InMemoryBlobStore`(混淆名 `class _`)——`blobs=new Map`,`getBlob/setBlob` 直读写。
- **持久版建表**:
  ```sql
  PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  ```
- 驱动:Node≥22.13 优先 `node:sqlite`,回退 `better-sqlite3`(官方已打包)。
- **磁盘路径**:`$HOME/.cursor/chats/<md5(cwd)>/store.db`(cwd 级)或 `chats/<uuid>/store.db`(会话级);ACP 会话同形(`acp-sessions/<id>/store.db` + 旁挂 `meta.json` 存 {schemaVersion,cwd,title})。
- **metadata 全集**(listeners 表即全集):`agentId, latestRootBlobId, name, createdAt, mode, isRunEverything, approvalMode, lastUsedModel, lastDebugServerPort, currentPlanUri, subagentInfo, blobEncryptionKey(32B 随机)`。**单一 JSON 文档整体写 meta 表 key="0"**(hex 包装),不是按字段分行。
- **恢复流程**:`tryResetFromDb`——读 `metadata.latestRootBlobId` → 单次 `SELECT data FROM blobs WHERE id=?` → `serde.deserialize` 得 ConversationStateStructure。**不是全量预加载**;历史展开时 `deserializeConversationStateStructure` 逐 turn `getBlob` 按需拉,缺失跳过(报 `BlobNotFoundError` 提示 "Start a new chat");subagentStates 并发拉({max:8})。
- 写入侧:`handleCheckpoint(e,t)`——`serde.serialize(t)` → sha256 得 blobId → `setBlob` → `setMetadata("latestRootBlobId")`。

**参考结论**:①单一 JSON 文档存全部 id/指针,与官方心智一致;②blob 内容可延迟加载(服务器缓存兜底),本地只需存 id;③omkc 不需要复刻 SQLite(已有原子写 + append log 范式;官方用 SQLite 是为了离线 cursor-agent)。

### B. omkc 先例排查

- **无 provider 私有状态持久化先例**(地毯式 grep):kosong 全部 provider 无状态——`kimi.ts:420-448` 只存 model/baseUrl/generationKwargs/client/reasoningKeyDialect;`withThinking/withMaxCompletionTokens` 浅拷贝不落盘。cursor-native 是**首个**需要跨进程 persist 的 case。
- **session 磁盘布局**(v2):
  ```
  homeDir = OMKC_HOME/KIMI_CODE_HOME 或 ~/.omkc
  homeDir/sessions/<workspaceId>/<sessionId>/      ← sessionDir
    state.json                                      ← IAtomicDocumentStore(sessionScope)
    agents/<agentId>/wire.jsonl                     ← IAppendLogStore(agentScope)
    agents/<agentId>/tasks/<taskId>.json / output.log / plans/ / cron/ / media-originals/
    logs/kimi-code.log
  session_index.jsonl(全局)
  ```
- 寻址:`packages/agent-core-v2/src/workspace/sessionLifecycle/internal/addressing.ts:1-21`(`sessionScopeOf`/`agentScopeOf`/`sessionDirOf`)。
- 恢复重建:`sessionLifecycleService.ts:338-367 doResume` → `materializeSession:220` → `ISessionMetadata.ready`(`sessionMetadataService.ts:36-210`,构造时 `states.contributeState(sessionMetadataDataKey)`);`WireService.acquire` + read 回放。
- **fork 复制策略**(`sessionLifecycleService.ts:705 copySessionDirEntries`):显式跳过 `state.json/logs/upcoming-goals.json/wire.jsonl`,其余 `agents/<id>/*` 逐文件拷——伴生文件模型是"每 agent 子目录自包含",新增一个小 JSON 与现有文件并列即可;但放 agentScope 的新文件**会被 fork 拷走**(需评估 cursor 状态是否应随 fork 复制)。
- `IProviderService` 不参与 resume;`ISessionStateService`(`src/session/state/sessionState.ts`)只是通用 IStateRegistry,无 provider 契约;`onWillCreateSession` 可 `container.provide(id,value)` 注入 session 作用域服务。

**挂点建议(报告二)**:① 推荐 `IAtomicDocumentStore` @ agentScope,key 如 `cursor-native.json`,value 一份 snapshot——与 state.json 同后端、与 wire.jsonl 同作用域隔离、materializeSession 后 `await ready` 即回灌;② 备选 `IFileSystemStorageService` 直写伴生文件(blobStore 大时走 bytes 通道);③ 不建议复刻 SQLite。

---

## 报告三(agent-428):跨模型切换与 compact 边界

### 场景 1:跨模型切换

**切换入口**:TUI `apps/kimi-code/src/tui/commands/config.ts:462 showModelPicker` / `:494 performModelSwitch` → `session.setModel(alias)` + `host.harness.setConfig` 持久化;`:263 handleModelCommand` 是 /model slash 入口。ACP:`packages/acp-adapter/src/session.ts:354`。引擎:`profileService.ts:359 setModel` → `ConfigUpdate` → `model_switch` 遥测。

**实例变化两级缓存**:
- kosong 工厂无缓存(`providers/index.ts:27` 纯 new)。
- 一级:`catalogService.ts:83 cache: Map<string,CatalogEntry>`;`:98 notifyConfigChanged(){cache.clear()}`;`:106 getRequester(id)`。A→B→A 未触发配置变更则第三次命中同一 Entry。
- 二级:`modelRequesterImpl.ts:25 cachedChatProvider` 懒单例(`:33-42` 仅首次 createChatProvider)。
- ProfileService 切换只改 modelAlias,**不销毁 entry、不清 blob 内存**。

**cursor 内存状态归属**:`cursor.contrib.ts:33 CursorProtocolAdapter` 内 `_inner: CursorNativeChatProvider`(状态在其上);`index.ts:128-160` 全部实例字段;withThinking 浅拷贝共享 Maps。

**Q1 答案**:同 alias 切走切回(未触发 notifyConfigChanged)→ 同实例,状态在;不同 alias/协议 → 不同实例,内存隔离。配置变更/进程重启/新 session → 重建。

**Q2-Q3 交叉轮次**:
- engine history 统一:`agent-core-v2/src/agent/contextMemory/contextMemoryService.ts:54 get()` 返回 `ContextMessage[]`(`kosong/contract/message.ts:50 Message{role,content:ContentPart[],toolCalls,...}`;`:31 ContentPart` 统一 text|think|image_url|audio_url|video_url)。所有 provider 共享同一 history(`llmRequesterService.ts:642 messages = overrides.messages ?? context.get()`)。
- cursor 发送时 history 作用极小:`conversation.ts:298` 只取最后一条 user 的 extractText;continuation 全靠 `_checkpoint/_turnIds/_rootPromptIds/_latestStateBlobId`(`index.ts:417` 透传仅为上条)。
- 后果:kimi/anthropic 轮次写入 engine history 但**无 cursor blob**;切回后 `rootPromptIds+promptMessageIds`(`index.ts:430`)只含旧 cursor 轮次 → 交叉轮次对 cursor **丢失**(wire 不携带)。
- 反向 fresh-cursor:首次切到 cursor 新建实例,`_lastRunId===null` 走 fresh-run 分支(`index.ts:402-415`),仅 lastUser 文本作新提问 → **完全失忆**。
- 投影边界:统一 Message 在 `requester.request` 前才投影为各协议形态(`toUiTurns`/`shapeHistory`/project),不污染共用状态。

**场景 1 现状结论**:切回后交叉轮次对 cursor 丢失;同模型实例复用使 cursor 链保留;需跨模型 summary 注入或提示用户"切换≠继承"。

### 场景 2:compact

**触发**:`fullCompaction/strategy.ts:18 DEFAULT_COMPACTION_CONFIG {triggerRatio:.85, blockRatio:.85, reservedContextSize:50_000, maxRecentMessages:4, maxRecentSizeRatio:.2}`;`:106 maxSize = max_input_tokens ?? max_context_tokens`;`:116 shouldCompact(usedSize)`;`:124 shouldBlock`。执行点:`fullCompactionService.ts:493 beforeStep` / `:500 afterStep` / `:508 checkAutoCompaction`(超 lastCompactedTokenCount 且 shouldCompact → beginAutoCompaction)。手动:`config.ts:228 handleCompactCommand → session.compact`(`fullCompactionService.ts:328 begin`,history 空抛 `compaction.unable`;`tryAcquireQuiescence`)。

**history 变更**:`fullCompactionService.ts:618 compactionRound`(`originalHistory=[...context.get()]`;summarizer 用当前 profile 模型 `:634`;`:745 context.applyCompaction`)→ `contextMemoryService.ts:119 applyCompaction` → `compactionHandoff.ts:60 buildContextCompactionShape`:新 shape = `[...head(≤2k tok), elision, ...tail, summaryMessage]`;summary 为 `role:'user', origin:{kind:'compaction_summary'}`(:125);head/tail 来自 `:159 collectCompactableUserMessages`(过滤 injection|shell_command|compaction_summary,仅真实 user);`ContextSpliced{start:0, deleteCount: history.length}` 广播;`contextMemoryService.ts:136 rebase` 重置 token 基线。

**对非 cursor**:压缩后 `context.get()` 返回短数组,下轮 openai/kimi/anthropic 自然变小。✓

**对 cursor**:
- `conversation.ts:108`/`index.ts:417` 证明 continuation 不读 history → 压缩对 wire **等效无操作**。
- 无联动:grep 无 compaction×cursor-native 命中;`onBlob`(:474)只累积;fullCompactionService 无 _blobStore hook;`ModelRequesterImpl.cachedChatProvider` 持旧状态。
- 压缩后 cursor 下轮仍发全量旧 `rootPromptMessagesJson + turns + stateAnchorId` → **上下文回胀到压缩前,完全不下降**;`tokensAfter` 只在 engine 计数侧生效。
- **能否触发**:代码无 cursor 排除 → 逻辑上可触发(summarizer 走 cursor provider);但 cursor `max_context` 可能未声明/巨大 → `strategy.maxSize` 异常导致阈值难触发(**不确定,待实测**)。
- **后果推演**:不是"双份"而是"旧份重放"——新 `compaction_summary` 未以 blob 进入 rootPromptMessagesJson,服务端看不到 summary,等价于压缩未发生;且 `shouldCompact` 基于 rebase 后的小值,**可能长期不再 auto-compact**,真实 payload 逼近窗口上限直至 `OV/YFLOW`/413。
- 若简单"修复"(把 summary 注入 cursor)→ **双份**:旧链 + summary blob + kept user blobs 同时生效,token 不降反增。必须**原子替换**:压缩时用新集合重建 rootPromptIds/turnIds 并重置 checkpoint/stateAnchor。

**未确定项(报告三)**:`/model` 切换是否连带 `notifyConfigChanged` 清 catalog(取决于 ModelService,需真机日志);cursor 的 max_input_tokens 取值分支(maxSize=0 → shouldCompact 恒 false?取决于 `catalogService.ts:320 maxInputSize`);服务端陈旧 blob GC 语义(get_blob_args 是否永远可取;若 GC 则触发 `index.ts:679 unknown blob` 警告并回空,hydrate 可能失败)。

**报告三建议**:跨模型——`performModelSwitch` 后提供"是否携带跨模型 summary"选项,或切回 cursor 时把 contextMemory 非 cursor 段落压成 `compaction_summary` 风格文本拼入 `userMessage.text`;压缩——为 cursor 加 `on(ContextApplyCompaction)` 钩子,原子重建轻量 blob 表并重置 checkpoint/latestState,或检测到 `context.apply_compaction` 记录时废弃旧 cache 迫使 fresh-run 并把 summary 作为初始上下文。

---

## 三报告交叉后的设计定案

1. **主方案**:v2 replayable state(报告一候选 B;报告二的 AtomicDocumentStore 备选保留为降级)。
2. **核心 insight**:官方"按需加载 + 服务器缓存兜底" ⇒ 本地快照只需 id,内容可以不在;fork 语义由 wire 切片天然保证(replayable > 侧车)。
3. **compact 与跨模型是独立工作项**(P1/P2),不阻塞 P0;P0 的 replayable 事件流为 P1 的"原子重建"提供了天然挂点(重放后 state 即最新快照)。
4. **遗留不确定项**已列出,实现 P0 时不阻塞;P1 前需实测:①cursor 的 max_input_tokens;②/model 切换是否清 catalog;③服务端 blob GC 语义。
