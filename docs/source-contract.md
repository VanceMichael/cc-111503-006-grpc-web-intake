# VOTable 星表接入契约

src/votable-source.mjs的votableFixture以loopback HTTP提供交接原件。source.path是当前文件，deliveryId是来源登记号。describeTables与previewTable只读取字段描述并保存原件，不解码单元格。旧网关与包预览入口继续兼容，不属于本次新增采集范围。

## 支持范围与身份

支持VOTable 1.4、命名空间http://www.ivoa.net/xml/VOTable/v1.3，采用XML解析器，不执行DTD和外部实体。RESOURCE可嵌套，每个TABLE由其ID及RESOURCE路径确定身份；name只用于展示，两个表或字段可以同名。FIELD的ID是单元格键，datatype、arraysize、unit、ucd、utype等描述原样关联；GROUP中的FIELDref必须解析到本表字段，不能跨表碰巧命中同名字段。ID缺失则使用本原件内的可追溯定位，不许拿显示名覆盖。

本交接站的上下文规则：RESOURCE中的PARAM是该资源及后代的上下文，同名PARAM由更近RESOURCE覆盖，兄弟资源互不继承覆盖。PARAM保留datatype、value和原始来源，不将元数据单位或坐标语义用于天体计算。

## 数据表示

支持TABLEDATA和内嵌base64 STREAM的BINARY2，不支持外部href、FITS或旧BINARY表示，需明确待核对而不是悄悄请求外链。类型范围为int、long、float、double、char、unicodeChar、boolean；数组支持固定维和最后一维可变的arraysize，不能把数组元数当字节数。BINARY2以大端序编码，每行先有ceil(字段数/8)字节的空值位图，高位对应前列，然后仍为每个字段消费完整物理表示，即使该单元格被标为null。变长值有4字节非负元素数前缀，前缀与声明维度共同决定载荷。长整数统一输出十进制字符串；浮点零、空数组、空文本与null保持区分。TABLEDATA标量空TD表示缺测，变长char空TD为空文本，变长数值空TD本交接站记为空数组；原TD文本仍保留。

二进制截断、负长度、超过声明的维度或整数可表示范围、重复字段ID和无法解析的FIELDref不能通过丢列、截短或补零纠正。资源预算须在分配前根据声明核对，可给出受限状态，不按不可信前缀直接申请巨大内存。

## 接收接口与证据

新增collect(source,store)，调用方创建和关闭来源及Inbox。返回tables和pending；有效表含tableId、resourcePath、fields、groups、context、rows。groups元素至少含fieldRefs。每行含rowIndex、evidence、cells，cells按字段ID区分；单元格含value、isNull、fieldId及原表示证据。BINARY2的byteRange是解码后STREAM内的[start,end)真实字节区间，另保留包含它的XML STREAM定位；TABLEDATA保留TR/TD定位及原文本。未知或不完整表只进pending，含tableId、reason及能确认的边界；其他独立TABLE可以交付。原XML由Inbox保存一次，不能仅保存解码后的重建对象。

## 采集结果（collect）

`collect` 从同一 URL 读取一次原件并存入 Inbox（kind `votable`），再用这些字节解释表；不重复请求，也不把解码结果当作原件留存。`mode` 为 `votable-collection`，`version` 为原件 `VOTABLE` 根上声明的版本。HTTP 非 2xx 时报错且不写入证据；原件不是合法 UTF-8 时留存原件并整体进 `pending`。

逐表交付与逐表隔离：

- 每张 TABLE 独立解释。表结构、字段声明、FIELDref 或行数据任一不成立时，该表进入 `pending`，含 `tableId`、`resourcePath`、`reason`、`boundary`；同文档其他 TABLE 照常交付。
- XML 整体不良构（或 DTD/外部实体声明）时不交付任何表，所有已发现表及文档本身进入 `pending`；同一资源路径下重复的 TABLE ID 不合并，全部进 `pending`。
- 不支持的编码（外部 href、旧 BINARY、FITS、非 base64 STREAM）进 `pending`，不发起外链请求。

字段身份与上下文：

- `fields[]` 含 `fieldId`、`declaredId`、`name`、`datatype`、`arraysize`、`unit`、`ucd`、`utype`、`source`（原 XML 行列与字节偏移）、`referencedBy`。`unit`/`ucd`/`utype` 只是随字段保留的声明语义，不据此做天体计算。
- FIELD 无 ID 时 `fieldId` 取 `FIELD@<字节偏移>`，同一原件内可追溯；显示名从不作键。
- `groups[].fieldRefs` 是本表内的字段键。ref 先按 ID、再按本表声明 ID 解析；跨表同名不命中，解析不到即整表进 `pending`。
- `context` 是按 RESOURCE 嵌套累积的 PARAM 名值；子资源覆盖父值，兄弟资源互不继承。`contextEvidence[]` 给出每个值的 PARAM 来源与 `resourcePath`。TABLE 内直接声明的 PARAM 单列于 `params[]`。
- `resourcePath` 用 `RESOURCE:<ID>`，无 ID 时为 `RESOURCE[<序号>]`。

单元格：

- `cells` 以字段键索引；每格含 `fieldId`、`value`、`isNull`、`evidence`，TABLEDATA 另含 `raw` 原文本，BINARY2 另含 `byteRange`。
- BINARY2 的 `byteRange` 是解码后 STREAM 内的 `[start,end)` 字节区间；`evidence.stream` 给出该 STREAM 在 XML 中的定位。空值单元格照样按声明消耗完整物理表示，因此后续字段与目标编号不串位。
- `long` 一律输出十进制字符串；浮点零、`-0`、`Infinity`/`NaN`（以字符串表示）、空数组、空文本、`null` 互相区分。
- 变长列的边界只由本表 FIELD 的 `arraysize` 与长度前缀决定，不从样本值推断。长度前缀为负、超出声明维度或元素/字节预算时整表进 `pending`，不做截短、补零或丢列。
- TABLEDATA 标量空 TD 为缺测（`isNull: true`）；变长 char 空 TD 为空文本；变长数值空 TD 记为空数组，`raw` 仍保留为空串。

来源生成器binaryRow和votableDocument只用于交接源，不能作为采集器读取来源参数或按场景名返回固定结果的捷径。

参考规范：https://ivoa.net/documents/VOTable/20250116/REC-VOTable-1.5.html ，本接入仅使用其中兼容1.4的范围。
