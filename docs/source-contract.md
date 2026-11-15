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

来源生成器binaryRow和votableDocument只用于交接源，不能作为采集器读取来源参数或按场景名返回固定结果的捷径。

参考规范：https://ivoa.net/documents/VOTable/20250116/REC-VOTable-1.5.html ，本接入仅使用其中兼容1.4的范围。
