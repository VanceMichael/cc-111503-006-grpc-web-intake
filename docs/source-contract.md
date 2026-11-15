# 来源接口与资料语义

遵循 grpc/grpc PROTOCOL-WEB。5字节帧头为标记+大端长度；0x00为未压缩数据，0x80为ASCII trailer块。trailer 含 grpc-status 及可选 grpc-message，status=0且流恰好结束才完整；本接口不支持压缩标记。application/grpc-web+proto 与 application/grpc-web-text+proto 均提供，text可能由多个各自base64编码且带padding的块拼接。Inspection protobuf只含字符串字段1 recordId、字段2 result、字段3 sourceRevision；未知字段可以保留或跳过，不能当新消息。请求有queryId，attemptId仅表示一次调用，不能跨调用拼帧。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- HTTP200但grpc-status非0
- 头部与UTF8载荷跨片段
- 多段带padding的base64串
- 没有trailer或trailer后继续数据
- 失败调用与成功重领保持不同attempt证据

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。
