# SenML 资料包接入契约

senmlFixture 来自 src/senml-source.mjs，以 loopback HTTP 提供两个独立资料包，source.packs 给出 id 和 path。每个响应是一个独立的 SenML Pack，不能把网络 chunk 或连接复用当成基准状态边界。当前旧网关 preview 继续可用；previewPack 仅保存新来源原件，不解读观测。

## 表示与字段

支持 RFC 8428 的 application/senml+json 和 application/senml+cbor，SenML version 10。JSON 使用字段名，CBOR 使用该规范表1的整数标签；未知可选文本标签可忽略，以下划线结尾的未知必需标签、不支持的版本或冲突类型不得自动接纳。CBOR 范围为定长数组、map、UTF-8文本、字节串、有符号整数、float64和布尔；不支持的tag或不定长项明确报告，不执行任意扩展。

支持 bn/bt/bu/bv/bs/bver 和 n/u/v/vs/vb/vd/s/t/ut。基准字段从其所在记录起在当前包内生效，未再次声明时沿用，但不能泄漏到下一包；新包默认基准名称为空、数值和时间偏置为0、版本10。n与bn拼接成完整名称，不能把它们当URL进行相对解析；名称满足RFC限定字符。

v与bv相加，s与bs相加，布尔、文本及字节值不受bv影响；v/vs/vb/vd不得互相代替或同时存在，只有s时允许没有普通value。u覆盖bu，不做单位换算。JSON的vd是无padding的base64url，CBOR的vd是原始字节串，不能经UTF-8往返。数值限定为有限的JavaScript可表示值，无法精确保留的整数应拒绝而非静默舍入。保存原字段和基准来源，使正规化结果可以回溯。

bt与t相加后小于2^28表示相对时间，大于等于2^28才是Unix绝对秒；缺省为0。没有可信绝对时钟锚点时保留{kind:'relative',seconds}，不能拿本机时间替代。ut是更新周期，不是观测时刻。

## 结果与失败边界

新增 collect(source, store)，调用方负责创建和关闭来源及Inbox。records是已可靠接收的观测，至少含packId、recordIndex、name、valueType、value、unit、time和evidence；time为{kind:'absolute'|'relative',seconds}，字节值用0..255数字数组，字符串与布尔保持类型。sum-only记录valueType为sum，保留独立sum，不能伪造瞬时值。

采用整包验证后发布的现有接入约定：编码残缺、重复CBOR map键、无法证明完整消费、未知必需语义或任一记录冲突时，该包不进入正式records，原件及可解码片段作为诊断证据保留。pending含packId、reason和能证明的记录或字节边界；不得用损坏字节后的猜测边界继续发布。同一次调用的其他独立包照常接收。每包原始响应由Inbox保存一次，记录证据可追到原件与记录序号，CBOR另保留真实字节范围。

src/senml-source.mjs的samplePacks与encodePack只负责生成来源，不是采集器解析实现，不得用其参数或场景名代替读取HTTP响应。

参考：https://www.rfc-editor.org/rfc/rfc8428 、https://www.rfc-editor.org/rfc/rfc8949 。
