// 生成 releases/index.html 发布归档页（版本表格 + 更新日志折叠区）
// 用法：node gen_releases.js   （在 xhs-assistant-prototype 根目录运行）
import fs from 'node:fs';
import path from 'node:path';

const RELEASES = path.resolve('releases');

// 版本历史（新 -> 旧）。size/download 若 releases/ 下存在对应 exe 则自动填充。
const CHANGELOG = [
  { v: '0.2.45', date: '2026-07-26', note: '用户截图（创建服务平台的「添加商品」弹窗）揭露三个此前一直靠猜的关键事实：①搜索框 placeholder 实为「搜索商品ID 或 商品名称」——itemId 不仅可搜，卡片上也明文显示「商品ID: xxx」可精确校验；②商品卡前有 checkbox，是「多选 + 保存」模式，没有「关联」按钮；③保存按钮在 0 选中时 disabled，所以面板一直没关、发布一直被卡。根因（组合拳）：picker.querySelectorAll(\'input\') 会把商品卡的 checkbox 也收进来，旧逻辑 e.tagName===\'INPUT\' 找搜索框时 checkbox 排第一（无 placeholder），itemId 写进了 checkbox（.value 不触发 onChange）→ 搜索永远不触发 → 候选停在默认店铺商品 → 强选/不选都拿不到正确商品 → 保存按钮 disabled → 面板不关 → 发布卡住。修复：A. 引入 isRealTextInput/realTextInputs 过滤 checkbox/radio/hidden/submit/button/file，面板内输入框查找与探测全用它，并在首轮打印「面板内输入框总数= N 其中checkbox= M 文本类= K」便于直观定位污染。B. 恢复 hitById（卡上显示商品ID），scoreItem 给 itemId 命中 200 分最高权重；检索词把 itemId 放第一（搜索框支持按 ID 检索，最精确），其次商品名片段，主轮询里 term===itemId 走 hitById 强校验。C. 选中方式彻底改为「勾 checkbox（用 checked native setter + change/input + click 三重派发）+ 点整行兜底 + 点保存」；确认按钮优先 /^保存$|^确定$|^完成$|^确认$|^选好了$/ 精确匹配（截图就是「保存」），并兜底 disabled 时再勾一次再点。D. 选中后解析卡片「商品ID: xxx」打印校验。E. 标题/正文/话题维持不变。' },
  { v: '0.2.44', date: '2026-07-25', note: '按用户最新实测（企业生产成本管理ppt 任务）与「需滚动到底部」反馈重写关联商品检索。v0.2.43 日志关键证据：检索词写入后候选列表「纹丝不动」（始终默认 世界杯聊个球/我的手作小物），且「未探测到随写随变的搜索框」。根因澄清：①小红书关联商品面板按「商品名/标题」检索，商品卡里并不显示内部 itemId，所以「拿 itemId 去搜 + 在卡片里按 id 验证命中」这条路本就走不通；②候选不动 = 搜索框根本没被触发（要么选错输入框，要么值没进受控组件）。修复：①触发「关联商品」前先把整页滚到底部（win.scrollTo + trigger.scrollIntoView），再点入口，避免面板/按钮错位。②检索词改为只用「商品名片段」（从长到短：前10/8/6/4字 + 全名），彻底丢弃内部 itemId 检索。③每个面板内输入框都做「写入后候选是否随写随变」探测，命中随写随变的才是真搜索框（单输入框也探测）；日志打印「探测候选输入框数」「探测输入框 … 候选变化=」便于定位。④选品改为「卡片文本包含检索词」的名称匹配（不再依赖 id）；基线对比判断搜索是否真的触发，触发后无匹配才换更短词，全程不强选默认项。⑤closeGoodsPicker 关闭按钮优先级：确认类(完成/确定/确认) > × > 选好了/保存 > 取消/关闭/返回/收起。标题/正文/话题维持不变。' },
  { v: '0.2.43', date: '2026-07-25', note: '按用户 v0.2.42 实测日志再修「商品仍选错 + 面板仍不关」。v0.2.42 日志关键证据：检索词分别用 itemId(686673aae6b4…) 与商品名(美妆化妆品护肤品) 写入后，候选列表始终不变（仍是默认 世界杯聊个球/我的手作小物），说明「写值没有触发搜索」——要么写进了错误的输入框，要么值没被受控组件接受；随后旧逻辑在 name 检索词下退化成「带图第一个」→ 错选 世界杯聊个球，且面板一直没关 → 发布被卡。修复：①新增「搜索框探测」——面板内每个候选输入框依次写入 itemId，看候选列表是否随写随变，命中随写随变的那个才是真正的商品搜索框（日志「命中搜索框(写入itemId后候选变化)」/「未探测到…」）。②选择策略收紧——itemId 检索词只在「候选真正含该 itemId」时才选；商品名检索词只在「候选文本含 nameHint」时才选；彻底去掉「带图第一个」退化，避免把默认列表里的无关商品误选；若仍无匹配，新增「店内商品名匹配」兜底（仅当名称强重叠），否则不强选、关闭面板继续发布。③选中后优先点商品行内的「关联/选择」按钮（而非卡片本体），再点「完成/确定/确认/选好了/保存」确认并关面板；closeGoodsPicker 关闭按钮正则补充 完成|确定|确认|选好了|保存。④server.js 图片根目录默认改为「软件根目录（exe 同级）下的 images/」（绿色免安装版即 win-unpacked/images），设置里填了绝对路径仍优先。标题/正文/话题维持不变。' },
  { v: '0.2.42', date: '2026-07-25', note: '按用户 v0.2.41 实测日志再修「关联商品选错 + 面板不关导致发布被卡」。v0.2.41 日志显示：商品面板已正确识别、itemId 也写进了搜索框，但「候选数=4 样本=世界杯聊个球…我的手作小物…」是面板默认商品列表（检索词 686673aec36ec 还没返回就被旧逻辑 if(items.length)break 拿去选了），于是回退选中了错误商品；随后点「确认」竟然点了「添加组件」按钮（把组件塞进笔记而非确认关联），且 closeGoodsPicker 没能关掉面板 → 面板浮层一直挡着 → 点发布时 findPrimaryConfirm 误匹配到面板里的「普通商品」tab 而非真正的「确认发布」→ published=false。修复：①候选轮询改为「等真正命中 itemId 的结果」——最多 16×500ms 轮询，命中 itemId（或 term≠itemId 时命中 nameHint）才选，看到「没有找到/无相关商品/暂无商品」等空结果文案也停；绝不在默认列表上乱选。②确认按钮过滤增加反向黑名单（添加组件|添加模块|插入|插入组件），只认 确定|完成|确认|选好了|保存。③closeGoodsPicker 重写——先对 activeElement 发 Esc，再用 取消/关闭/返回/收起/×/X 与 class 含 close/cancel 的按钮，最后点遮罩四角；每次都 isOpen() 校验，未关才继续，最终打「商品面板已关闭/仍未关闭」。标题/正文/话题经用户确认已 OK，本版不再改动。' },
  { v: '0.2.41', date: '2026-07-25', note: '按用户反馈再修两项（实测 v0.2.40 仍：①正文没分段 ②商品 id 输进了「添加地点」框而非商品搜索框、且候选是 64 个导航项）。根因：findGoodsPickerRoot 会返回整页 body（因 body 文本含「添加商品」字样且面积最大），导致站内搜索框被判成「添加地点」、候选把左侧导航（首页/笔记管理…）也卷进来。修复：findGoodsPickerRoot 只认「真正浮层」——排除 body/html 与近整页容器，要求 role=dialog/modal/mask/overlay/popup/panel 或 fixed/absolute 定位或覆盖大半屏，优先返回含搜索框的浮层；所有后续检索（搜索框、候选商品）都限定在该面板容器内，不再污染全页。候选收集改为「真实商品卡」过滤（必须带图或含 ¥价格/销量、排除标签/页头/导航与列表容器本身），并在面板内轮询等待结果出现；日志新增「商品面板容器」诊断（tag/class/coversMost）。②正文分段用更可靠的回炉——合成 Enter 在用户环境常常不生效，改为打字完成后若「实际段落数<期望」则用 document.execCommand(\'insertHTML\') 把整段重排为多个 <p>（ProseMirror 经 mutation observer 解析为真实分段），新增「正文回炉(insertHTML)」日志；blockCount 也支持统计 <br>。' },
  { v: '0.2.40', date: '2026-07-25', note: '按用户截图+反馈再修两项：①关联商品搜索框真正写值——v0.2.39 找到 input 后用 setNativeValue+input 事件直接写，但用户截图显示搜索框依旧空白。改为先 click+focus、清空旧值、setNativeValue/insertText 写值、再 dispatch input+change，最后读取 input.value 打日志确认（新增「关联商品检索框已写入: …」诊断）。搜索框匹配也升级：优先 placeholder 含「搜索商品ID/搜索商品名称/搜索…商品」或 aria-label 同模式的 input；面板内退化到非已知页面字段的 INPUT；再退化到全文档找。②正文分段兜底回炉——typeText 的 newlineIsParagraph 增加 Enter 后 220ms 等待；打字完成后若检测到「实际段落数 < 期望（按 \\n 切分）」，自动触发回炉：清空 → 写第一段 → 循环「真 Enter（完整事件序列）+280ms 等待+写下一段」，确保 ProseMirror 真的产生分段。新增「正文段落不足」/「正文回炉完成」日志。' },
  { v: '0.2.39', date: '2026-07-25', note: '按用户实测日志再修「关联商品选错」：v0.2.38 搜索 itemId 后返回 20 个候选，旧逻辑直接取 items[0]=「首页」(实为标签/页头)，导致选了错误的商铺商品。现 rewrite 候选打分：scoreItem 给「命中 itemId(属性/文本)」最高分、「命中商品名片段」高分、「含 img/¥价格」更像商品卡加分、「命中标签/页头正则」重扣分清零；选择顺序为 先找 outerHTML 含 itemId 的候选 → 再找文本含 itemId → 再按分数最高且>0 → 最后带图的第一个；任一命中且 score>-100 才点。检索词改为 [itemId, 商品名片段, 商品名] 依次试。增加「候选样本」诊断日志(打印前 6 个候选文本+是否带图)，选不中时可直接看出面板结构。其余(v0.2.38 的面板关闭/换行/弹窗去伪)不变。' },
  { v: '0.2.38', date: '2026-07-25', note: '按用户实测 F12 日志+截图再修三项：①关联商品面板关闭——v0.2.37 点击「添加商品」后找不到搜索框，商品选择面板一直开着，导致后续点发布按钮被面板遮挡/拦截，published 永远 false。现 rewrite associateGoods：先点入口 → 通过 findGoodsPickerRoot 按「选择商品/添加商品/我店铺内的商品」等文本定位面板根 → 在面板内找搜索输入框（找不到时尝试点搜索图标唤醒输入框）→ 用 itemId 搜索并选首项 → 无论成功失败都通过 closeGoodsPicker 关闭面板（Esc/点遮罩/点取消），绝不让面板阻塞发布。②正文分段更稳——typeText 的 newlineIsParagraph 现在派发完整键盘事件序列（keydown/keypress/beforeinput insertParagraph/input insertParagraph/keyup），insertBlankParagraph 也同步用该序列，ProseMirror 断段落更可靠。③弹窗识别去伪——新增 isRealModal，只有尺寸够大/居中/覆盖视口较大面积/高 z-index 的元素才视为真正模态弹窗；findPrimaryConfirm、logDialog、dismissModal 都改用 isRealModal，避免把侧边栏「编辑」、页面小标签等误判为弹窗。日志新增「关联商品搜索框」和「已关闭商品选择面板」等诊断信息。' },
  { v: '0.2.37', date: '2026-07-25', note: '按用户实测 F12 日志再修五项：①头条 bug——injectTopics 的 isFirstTopic 标志从未置 false，导致每个话题前都插空行（日志里正文块数 5→7→9→11→13 一路涨）。改为「仅在首个有效话题前插一次空行」，正文与话题间留一个可见间隔即可，后续话题紧接其后。②正文分段——typeText 把 \\n 当普通字符 insertText，ProseMirror 不吃 → 正文失去段落换行。新增 newlineIsParagraph 选项：正文逐字输入时把 \\n 转成真实 Enter keydown，正文恢复段落/空行结构。③自动发布真正的元凶——小红书「发布」「确认发布」按钮都是 <div>（不是 <button>），而 findPrimaryConfirm 只扫 button/[role=button] → 确认弹窗永远点不到 → published 永远 false。改为同时扫描 div/span/a 且按短文本匹配，确认框终于能被点；success 正则拓宽（发布成功/已发布/笔记已发布/作品已发布…），并在发布循环里每轮打印「弹窗」内容+按钮供排查。dismissModal 也改成扫 div、且绝不含取消/关闭类，彻底杜绝误点取消。④关联商品按 id——按用户要求：点「添加商品」按钮后，在搜索框输入商品 itemId（而非商品名）去精确匹配对应店铺商品，无 id 才退回商品名；搜索框检测放宽（排除标题/正文/话题框、命中商品/搜索/关联等），选完再点面板里的「确定/完成/添加」确认按钮；找不到搜索框时打印可见输入框清单便于排查。⑤倒计时兜底——content 侧在真正发布成功时主动写 nextPublishAt（后台 scheduleNext 未激活的手动拉取模式也能看到倒计时），且只有 published=true 才前进队列，避免「点了发布但没确认」被误判已发。' },
  { v: '0.2.36', date: '2026-07-25', note: '按用户实测 F12 日志再修四项（实测仍 clicked:true 但 published:false、话题没空行、没选商品）：①致命根因——dismissModal() 每 500ms 自动关弹窗时，其正则含「取消」，会把发布确认弹窗（确认发布/取消）里的「取消」误点 → 发布被取消，所以永远 published:false。加 hasAction 守卫：含「确认发布/发布笔记/确认提交」等正向动作的弹窗绝不自动关，只关纯提示弹窗（知道了/我已知晓/好的/确定…），确认框交给 findPrimaryConfirm 处理。②话题空行真正生效——旧 injectTopics 用 qAny(SEL.body) 取正文，但 ProseMirror 正文 class 是 tiptap ProseMirror，匹配不上任何 SEL.body 选择器 → bodyEl 为 null → 空行分支不执行；改为 fillTask 把已定位的真实 body 传给 injectTopics，且 insertBlankParagraph 连按两次 Enter（上方空一段、话题落在下方第二段），保证正文与话题间有可见空行。③自动发布前先 waitForUploadDone——轮询「上传中/处理中/审核中」直到图片上传完再点发布，避免点击被忽略；并把成功判定窗口从 25s 延到 40s、补点延到 4s 后、成功正则增加「笔记已发布」。④关联商品更稳——点击「添加商品」后轮询搜索框最多 ~3.6s 再输入；检索词先用完整商品名、无果再取核心片段兜底；任一结果就点首项（best-effort）。实测日志关键定位点：出现「正文块数(空行前后):」= 空行已插；出现「已点击确认按钮」= 确认框已点；出现「已选择关联商品」= 商品已选。' },
  { v: '0.2.35', date: '2026-07-25', note: '按用户实测反馈再修四项（实测仍失败的排查方向见文末）：①自动发布真正定位并点击——发布控件定位器从仅查 button/a/[role=button] 扩为全文档扫描精确匹配「发布」文本的元素、再向上找最近可点击祖先（兼容小红书把发布做成 div[role=button] 或包了 span 的按钮的情况）；isDisabledEl 增强，能识别 pointer-events:none / cursor:not-allowed / 极低透明度等灰态；点击前先 scrollIntoView 确保可见；按钮因图片审核置灰时最长等待 90s 放开；新增 [XHS] 诊断日志（发布控件 / 可视点击元素 / 点击确认按钮 / 检测到发布成功），下一轮若仍失败可直接贴这些日志精准定位。②话题与正文空行——去掉在 ProseMirror 里不可靠的 execCommand(insertParagraph)，改为「光标移到正文末尾 → 派发真实 Enter（ProseMirror 靠 keydown 处理换行）→ 若 blockCount 未增加再退用 execCommand 兜底」，并用块数校验空行是否真插入。③自动关联商品——小红书「关联商品」是按钮而非直出输入框，旧逻辑只找 placeholder 含商品的 input 永远找不到；改为先点「关联商品/添加商品」入口按钮打开选择面板，再在出现的搜索框输入商品名并选中第一项。④倒计时——倒计时读后台写入 storage 的 nextPublishAt，本就在每篇发布成功后由调度器写入；本次①修复后自动发布能成功，倒计时即会在刚发布的标签页读秒显示「⏳ 下一篇：N分N秒」（若队列只有一篇则无需倒计时）。排查提示：若自动发布仍 clicked:false，请把 Toast 里新增的「可视点击元素」那行日志发我，能直接看出发布按钮的真实标签/类名/是否灰态。' },
  { v: '0.2.34', date: '2026-07-25', note: '按用户实测反馈再修四项：①话题相关性——deriveTopics 兜底不再用通用种草词（好物分享/种草…），改为从商品名/标题抽取 CJK 核心词组合派生相关话题（如医院文化墙→医院文化墙/文化墙设计/文化墙素材…）；后端 DEFAULT_TOPICS_PROMPT 强化「必须紧扣内容、禁止套通用种草词」，解析时先去编号/项目符号再按换行逗号切分。②话题与正文空行——去掉在 ProseMirror 里不可靠的合成 Enter，改为「光标移到正文末尾 → insertParagraph 插入一个空段落」再点「话题」按钮，仅首话题前插一次。③自动发布真正生效——修复 findConfirmInModal 在找不到正向按钮时回退点「最后一个按钮（可能是取消）」导致发布被取消的致命 bug；改为 findPrimaryConfirm 只点正向确认按钮（确认发布/确认/发布/确定…）且排除取消/关闭类；autoPublish 加二次补点（首次可能被吞）+ 详细 [XHS] 日志（已点击发布按钮/点击确认按钮/检测到发布成功）。④Toast 倒计时——创作者页顶部 Toast 新增「⏳ 下一篇：N分N秒」读秒行，后台在排下一篇时把 nextPublishAt 写入 storage，Toast 每秒读秒；并保留刚发布的标签页用于显示倒计时（开下一篇时再关），stopNow 也会清掉倒计时与旧页。' },
  { v: '0.2.33', date: '2026-07-25', note: '按用户实测反馈再修三项：①话题默认 6 个 + 空行——后端 DEFAULT_TOPICS_PROMPT 改为一次生成 6 个话题（原提示只让 AI 生成 1 个且只调一次，导致只有 1 个）；扩展端 injectTopics 兜底：不足 6 个时由商品名+通用种草词派生补齐到 6 个；话题与正文之间自动插入一个空行。②自动点发布不生效——根因是发布按钮在小红书 fixed 顶栏，旧 locate 用 offsetParent!==null 过滤会把它排除（fixed 元素 offsetParent 为 null）；改用 getBoundingClientRect+computedStyle 的 isVisibleEl 判断并扩宽到 button/a/[role=button]/含 publish 类名的元素，同时支持 aria-disabled；修正后 clicked 应�� true。③新增顶部居中悬浮 Toast——content-creator.js 注入固定顶中浮条，实时显示发布状态（与侧栏状态同步）���点「日志」展开最近 30 条 [XHS] 日志，便于在浏览器里直接看当前发布窗口状态与排错信息。' },
  { v: '0.2.32', date: '2026-07-25', note: '修复用户实测三项：①标题超长——新增 fitTitle() 按「显示宽度」截断（中文/全角=2、半角=1，上限 40 ≈ 20 中文字），填标题前先截断，既合规又修复了「标题超长导致发布按钮被禁用 → 日志里 clicked:false 没点发布」的连锁问题。②没有模拟真人打字——重写 typeText：写入前先清空旧内容，再逐字符输入，contenteditable 逐字 execCommand(\'insertText\')、input/textarea 逐字原生 setter+input 事件，每字随机 28–68ms 延时 + 每 18 字来一次 130–380ms「思考停顿」，不再瞬间整段填充（并放宽 fillTask 总时长 90s→150s、正文超时 45s→60s 给逐字打字留足时间）。③话题没加——新平台话题是「话题」按钮、不能直接键盘输入 #；重写 injectTopics：聚焦正文→点「话题」按钮（平台插入 # 并弹搜索下拉）→逐字打关键词→等下拉→点第一个建议变蓝 chip，并为每次点击/输入框/下拉都打 [XHS] 调试日志便于后续定位；找不到按钮时兜底往正文 insertText(\'#\') 触发话题模式。' },
  { v: '0.2.31', date: '2026-07-25', note: '重写发布队列调度（按用户要求）：①默认自动发布（autoSubmit 已默认 true，不再进入人工待发布 waiting_submit）。②队列串行、并发=1——同时只允许「一个账号的一篇笔记」在发布，杜绝多标签/多任务并发现象。③每篇笔记都「重新打开一个新标签」去填表+发布（不再复用同一个标签页），发布完成后关闭旧标签、按配置的 publishIntervalSeconds+随机 publishIntervalRandomDelaySeconds 延时后再开下一篇；新标签=全新页面，从根上避免「两篇笔记混进同一编辑器」的叠加/乱码。④完成信号改以「服务端任务状态」为准：后台对当前任务轮询 /api/ext/task?id=，不依赖可能失效的消息通道（content script 直连后端回报时后台也能可靠推进，SW 回收也不丢）。⑤验证挑战走 manual_hold 并暂停队列，content-creator 挂接「人工发布成功」监听，用户解决验证并点发布后自动恢复继续下一篇。⑥popup 新增「开始批量发布 / 暂停 / 继续 / 停止」控制与队列状态；server.js 新增 /api/ext/task 单任务查询接口，/api/ext/next 下发发布间隔。' },
  { v: '0.2.30', date: '2026-07-25', note: '修复「正文乱码 + 两篇笔记混进同一编辑器 + 没生成话题」：①根因是正文（ProseMirror contenteditable）旧版逐字 execCommand 插入，手动点「拉取下一篇」把第二篇填进同一页时，第一篇旧内容未被清空 → 两篇叠加既乱码又混排；改为写入前先 selectAll 清空旧内容再整段插入（writeEditable 同样先清空），彻底杜绝叠加/乱码。②runFill 开头先撤销上一条可能仍在监听「人工发布成功」的 watch，避免提早手动拉下一篇把新任务误报成上一条已发布。③话题重写 injectTopics：小红书话题=输入关键词→下拉→选中变蓝 chip；旧逻辑直接塞「#医疗」再回车且不等待下拉，故没生效。新逻辑：先尝试点「话题/添加话题/参与话题」按钮揭示输入框，关键词剥掉「#」后输入→等下拉→ArrowDown 高亮首项→Enter 确认变蓝，每个话题重新定位输入框（选择后 DOM 可能重渲染），并在 publish 前完成话题写入。' },
  { v: '0.2.29', date: '2026-07-25', note: '修复「验证挑战误判 + 标题/正文找不到」：①detectChallenge() 改为「可见弹窗 + 文案含验证关键词」双条件——旧逻辑用 [class*="verify"],[class*="slider"] 等宽泛 class 碎片匹配，小红书发布页随便一个带 slider/verify 字样的普通组件就被误判成验证挑战，导致批量提前停（日志顶部「检测到验证挑战，已停下」即此误判）；CDP 端的 cdp-config.json challengeIndicator 与 cdp-publisher.js _detectChallenge 同步收窄为真实验证码容器类名 + 可见 + 验证文案。②fillTask 改为「先传图 → 再等标题/正文」——小红书图文页是传图后标题/正文表单才渲染出现，旧版在传图前就等标题/正文永远等不到；并用更稳的 locateField（placeholder 关键词 + 排除正文后的首个单行输入框 / 最大 contenteditable），解决标题框 placeholder 为「填个好标题会有更多赞哦」这类不含「标题」二字而漏检的问题；找不到时打印可见编辑字段便于定位。' },
  { v: '0.2.28', date: '2026-07-25', note: '修复「重复传图 + 标题没填」：①根因是 MV3 重复注入 content-creator.js 导致 onMessage 监听器注册两遍，一次 fillTask 触发两次 runFill，图片被注入两次（日志里收到 fillTask 两次、正文框 .tiptap.ProseMirror 出现但标题/正文首次未找到，因页面未渲染完就被下发）。②onMessage 监听器加 window.__xhsBound 仅注册一次；③runFill 加 per-task 锁（同一任务 30s 内重复下发直接跳过）；④fillTask 开头加 waitForPageReady 等发布页核心输入区渲染就绪再填，不再抢跑；⑤injectImages 按 taskId 去重，已注入则跳过；⑥waitForEditable 兜底扩大到可见 input/textarea（按 placeholder 关键词定位标题/正文），SEL.topicInput 增加添加话题/参与话题等。' },
  { v: '0.2.27', date: '2026-07-25', note: '修复图文发布卡在「上传图文」：①新增 dismissModal()——进图文页时若弹出「风险提示/发布须知/规范提醒」等阻塞弹窗会自动关掉（验证挑战类弹窗除外，仍转人工），避免弹窗盖住上传控件导致卡死；②新增 ensureUploadReady()——填图前先确保处于「图文」上传模式并展开上传区，必要时点「上传图片/添加图片」按钮（临时屏蔽 <input type=file>.click 防止弹出系统文件框），再轮询等待 file input 出现；③injectImages 找不到控件时改为轮询等待 10s 而非立即失败；④autoPublish 在点击发布前后持续 dismissModal。配套：server.js 早已在解析文件夹名时剥离 _1（productId=name.split("_")[0]），图片<id>_1 与商品 id 的匹配链路无误，上一版 0.2.26 修的才是真根因（采集 itemId 为空）。' },
  { v: '0.2.26', date: '2026-07-25', note: '修复「本地图片一直匹配不上采集的商品」：根因是浏览器插件在千帆页采集时没把商品 id 抓下来（itemId 提取失败），落库的 itemId 为空；而本地图片匹配完全靠 itemId 做键（文件夹名 <id>_1 解析出 id，去商品库按 itemId 索引匹配），空 id 自然匹配不上。①重写 content-ark.js 的 itemIdIn()：依次从「卡片内所有链接 href 的 ?id=/itemId= 参数」「data-* 属性（覆盖 data-item-id/data-itemId/data-product-id/data-productId/data-id 等多种命名）」「卡片 outerHTML 里 key=value 形式的 id」「24 位 hex（千帆 ObjectId 风格）兜底」提取，对齐 scrapeQianfanProducts 的稳健逻辑；②后端 /api/ext/products 增加「空 id 旧记录 + 新带 id 记录」自动合并，避免重新采集产生重复商品；③采集提示显示「新增/更新」条数。正确流程：先采集商品（现在会带上 id）→ 再扫描本地图片，卡片会显示「🔗 已匹配千帆商品」，导入即按真实商品标题生成笔记。' },
  { v: '0.2.25', date: '2026-07-25', note: '修复「推送失败：Extension context invalidated」：根因是 MV3 的 service worker 空闲约 30s 会被 Chrome 回收，千帆采集脚本把商品经 service worker 中转给后端、以及创作者页回报结果经 service worker 时，通道在回收瞬间失效就报该错。①新增 common.js：content script 改为直连本地后端（fetch http://127.0.0.1:5199，server 已放开 CORS *），彻底绕开 service worker；②加保活端口——内容脚本持常驻端口让 service worker 在页面打开期间不被杀（保证 popup / 背景下发 fillTask 稳定）；③content-ark.js 的采集/手动添加/批量推送、content-creator.js 的 reportDone 与「手动拉取」按钮全部改为直连；④background 把 Extension context invalidated 也纳入「重新注入并重试」逻辑。现在千帆采集与创作者页回报不再依赖 service worker，不会因 SW 回收而失败。' },
  { v: '0.2.24', date: '2026-07-25', note: '修复「等待发布没反应、不自动输入标题/正文、卡住」：根因是小红书标题/正文是 React 受控组件，扩展用 execCommand 逐字写入只改了 DOM、没触发 React 的 onChange，于是 React state 仍是空，页面一旦因传图/失焦重渲染就把框内文字清空，看起来像「没输入、卡住」。①扩展写入后在末尾强制派发 input/change 事件把 React state 同步上（contenteditable 专用 syncContentEditable）；②input/textarea 走 setNativeValue、contenteditable 走 textContent+同步，统一为 writeEditable；③元素查找只看可见节点（offsetParent!==null），避免命中隐藏 contenteditable 导致填错/填空；④加了大量 console 日志（[XHS] 前缀）与侧栏状态，注入成功也会打印，便于一眼定位是否加载/是否填到了正确元素。' },
  { v: '0.2.23', date: '2026-07-25', note: '按你的用法打通「千帆采集 → 对应 images/<id>_1 文件夹」：①采集端稳健取商品 id——依次尝试 配置选择器 / 卡片内链接 ?id= 或路径段 / data-* 属性 / 标签文本 / 整段 HTML 里的长 hex id（如 686673d41ea4cb001553c6da），不再只认「商品ID:」文本，彻底解决采集到标题却拿不到 id 的问题；②落库去重并回填——从千帆抓取时按 itemId 或商品名去重，更新已有商品并补全缺失的 itemId；③匹配优先真实标题——当同一个 id 既有「千帆采集的真实商品」又有「旧版导入自动建的文件夹名垃圾商品」时，扫描/导入一律选真实标题那条；④自修复——抓取后自动删除「images-folder 来源、商品名疑似文件夹名、且已有同 id 真实商品」的垃圾记录。现在流程：先「从千帆抓取」（拿到 id+标题）→ 再「扫描图片文件夹」（卡片直接显示真实标题预览）→ 导入，标题即真实商品标题。' },
  { v: '0.2.22', date: '2026-07-25', note: '自检增强：扫描卡片直接显示「将生成标题」预览 + 诊断提示，让问题在导入前就可见。①若图片文件夹匹配到千帆商品但商品名疑似就是文件夹名（如 686673d41ea4cb001553c6da_1），标红提示「请到选品页改成真实标题」；②若未匹配到任何商品，明确告诉用户「标题将是文件夹名，可在文件夹内放 title.txt 指定，或选品页添加 itemId=xxx 的商品」；③导入后任务状态显示对应原因。根因说明：标题没改通常是商品库没有与文件夹 productId 对应的商品、或商品名被填成了文件夹名，并非代码未生效。' },
  { v: '0.2.21', date: '2026-07-25', note: '修复 v0.2.20 两个问题：①商品匹配失败导致标题仍是文件夹名——导入时同时按 itemId / id / productName 三种字段做不区分大小写匹配，并在 AI 返回标题仍含原文件夹名时强制替换为商品名；扫描卡片显示「未匹配到千帆商品」或「已匹配（按xxx）」，方便一眼定位；②扩展报「Could not establish connection / Receiving end does not exist」——background 在 content script 未响应时自动 executeScript 重新注入并重试，避免安装后未刷新创作者页就失败。' },
  { v: '0.2.20', date: '2026-07-25', note: '本地图片文件夹导入结合商品库：文件夹名支持 <商品ID>_<序号> 格式（如 686673d41ea4cb001553c6da_1），扫描时自动解析出商品ID并在商品库中匹配，匹配成功则用商品名替换文件夹名作为笔记标题和 AI 文案种子；扫描结果卡片显示「🔗 已匹配千帆商品」标记与商品名；未匹配到则回退到文件夹名/name.txt 作为种子。' },
  { v: '0.2.19', date: '2026-07-25', note: '修复「拉取下一篇后只注入图片，不填标题/正文/话题」：①扩展选择器大幅放宽——标题匹配包含「标题」「赞」的 input/textarea/contenteditable；正文匹配包含「正文」「描述」「分享」的多种输入形态；话题匹配「话题」「搜索」；②重写 input/textarea 的 typeText：由于小红书输入框是 React 受控组件，逐字 setter 会被 React 重渲染覆盖，改为一次性 setNativeValue 整段写入并补齐 focus/input/change/keydown/keyup 事件，确保值真正进入组件；contenteditable 仍保留 execCommand 逐字模拟真人输入；③fillTask 加写入后验证：标题/正文写入后未检测到实际内容立即抛出错误，未找到输入框时侧栏明确提示，避免静默跳过；④若标题/正文/话题全部未填，整体任务失败并回写后端，便于重试。' },
  { v: '0.2.17', date: '2026-07-24', note: '修复「拉取下一篇后停在人工复核、之后没反应」：①「自动提交」默认值由 false 改为 true，开箱即自动填表 + 自动点发布 + 自动连发（无需手动开开关，已安装版本同样生效）；②修自动连发逻辑——旧逻辑在「填好待人工(waiting_submit)」时也 800ms 后填下一篇，会覆盖你还没发布的表单，现已改为仅在「已发布」时才连发；③半自动模式（手动关掉自动提交）新增「人工发布成功后自动拉下一篇」监听，避免手动发布后卡住。popup/设置页的「自动提交」开关仍可随时切换。' },
  { v: '0.2.16', date: '2026-07-24', note: '新增「本地图片文件夹」导入（对齐参考软件：按 images/<id>/ 读取图片再发布笔记）。在软件数据目录的 images/ 下，每个子文件夹=一篇笔记，文件夹名即 id；点「扫描图片文件夹」列出，勾选后「导入并生成笔记」——图片以本地文件服务进入发布队列，标题/正文/话题由 AI 按文件夹名（或文件夹内可选 name.txt/caption.txt/title.txt）生成。已导入 id 自动跳过防重复；「清除发布数据」会一并重置已导入记录。设置页新增「图片根目录」可改成任意本地图库路径。' },
  { v: '0.2.15', date: '2026-07-24', note: '修复自动发布「到审核就不动」：重写 autoPublish 流程——①先定位发布按钮（即使 disabled 也定位），图片审核中按钮置灰时最多等待 ~40s 让其放开；②点击「发布」后，自动识别并点击「确认发布」二次确认弹窗（内容将进入审核）；③轮询识别「发布成功」提示。移除旧的 findPublishButton（只找未禁用按钮，导致审核中直接放弃）。' },
  { v: '0.2.14', date: '2026-07-24', note: '新增「模拟真人打字」：自动/手动发布时，标题、正文、话题改为逐字符输入（随机延迟 + 偶发长停顿），不再是瞬间整段填充；「发布设置（对齐原软件）」新增「模拟真人打字」开关（默认开，可关闭以提速）。后端 /api/ext/next 下发 humanTyping，插件 fillTask 据此逐字输入。' },
  { v: '0.2.13', date: '2026-07-24', note: '新增「数据管理」：设置页增加「清除发布数据」按钮，一键删除已采集商品、发布任务队列、发布历史与已上传图片；保留 AI 配置与账号设置。后端新增 POST /api/data/clear 接口（仅清发布数据，不碰设置/账号）。' },
  { v: '0.2.12', date: '2026-07-24', note: '修复插件「拉取下一篇」形同虚设：①background 的 tick() 现在把真实结果（无任务/后端未连接/已下发）透传给面板与弹窗，不再写死「已请求」；②内容面板与弹窗均如实回显状态；③autoSubmit 时可靠定位并点击「发布」按钮（多策略匹配），点击前再检测验证挑战，未点到按钮则回报失败待重试；④弹窗新增「待发任务数 + 后端连接状态 + 自动提交开关」，可自助诊断与一键开启自动发布。' },
  { v: '0.2.11', date: '2026-07-24', note: '「发布设置（对齐原软件）」改为单向纵向布局：4 个复选项（生成标题/生成正文/生成话题/自动提交）每个独占一行，话题数量内联于生成话题行右侧，数字项两列网格置于下方，彻底消除两列并排带来的凌乱感。' },
  { v: '0.2.10', date: '2026-07-24', note: '重构「发布设置（对齐原软件）」卡片布局：取消混乱的 grid2 混排，改为统一的 .settings-form 行式布局；复选框与数字输入按功能分组排列，视觉更整齐。' },
  { v: '0.2.9', date: '2026-07-24', note: '再次修复「发布设置（对齐原软件）」卡片文字错位：复选框标签强制单行（white-space: nowrap），复选框与文字垂直居中，顶部与数字输入标签对齐。' },
  { v: '0.2.8', date: '2026-07-24', note: '修复「发布设置（对齐原软件）」卡片中复选框与数字输入混排导致的文字错位（复选框改用 align-self:start 顶部对齐）；发布归档页新增「更新日志」折叠区与版本历史表格。' },
  { v: '0.2.7', date: '2026-07-24', note: '插件采集成功 Toast 通知；重新识别支持自动轮询（检测到新商品显示红点角标）；releases 发布归档页。' },
  { v: '0.2.6', date: '2026-07-24', note: '清理历史 dist 备份释放磁盘空间；插件识别进度 / 计数实时反馈（扫描动画、重新识别按钮、状态栏计数）；正式品牌图标。' },
  { v: '0.2.5', date: '2026-07-24', note: '修复自动识别每次多出 2 条垃圾数据（按卡片分组去重 + 商家后台 UI 词精确匹配 + 忽略按钮）。' },
  { v: '0.2.4', date: '2026-07-24', note: '修复 CDP 9222 连接失败（启动器自动探测 Edge、补齐 --remote-allow-origins=* 与 --user-data-dir、报错更清晰）。' },
  { v: '0.2.3', date: '2026-07-24', note: '图片管线修复（server 代理绕过防盗链 + 本地预下载给 CDP）；失败任务重试接口 POST /api/batch/retry。' },
];

function filesPresent() {
  if (!fs.existsSync(RELEASES)) return [];
  return fs.readdirSync(RELEASES).filter((f) => f.endsWith('.zip'));
}
function findZip(v, suffix) {
  return filesPresent().find((x) => x.includes(v) && x.includes(suffix)) || null;
}
function sizeOfZip(f) {
  if (!f) return '—';
  const s = fs.statSync(path.join(RELEASES, f)).size;
  return (s / 1048576).toFixed(1) + ' MB';
}

const files = filesPresent();

const rows = CHANGELOG.map((c, i) => {
  const latest = i === 0 ? 'latest' : '';
  const tag = i === 0 ? '<span class="tag">最新</span>' : '';
  const green = findZip(c.v, '绿色免安装版');
  const plugin = findZip(c.v, '浏览器插件');
  const size = [green && sizeOfZip(green), plugin && sizeOfZip(plugin)].filter(Boolean).join(' + ') || '—';
  const dl = (green ? `<a href="./${encodeURIComponent(green)}">绿色版</a>` : '') + (green && plugin ? ' · ' : '') + (plugin ? `<a href="./${encodeURIComponent(plugin)}">插件</a>` : '') || '<span class="date">归档待补充</span>';
  return `<tr class="${latest}">
    <td class="ver">v${c.v}${tag}</td>
    <td class="date">${c.date}</td>
    <td class="size">${size}</td>
    <td class="note">${c.note}</td>
    <td class="dl">${dl}</td>
  </tr>`;
}).join('\n');

const logItems = CHANGELOG.map((c) =>
  `<li><b>v${c.v}</b> <span class="date">${c.date}</span> — ${c.note}</li>`
).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>黑猫智记AI · 发布归档</title>
<style>
  :root { --red:#ff2e4d; --bg:#0f1115; --card:#171a21; --line:#2a2f37; --text:#e6e8eb; --sub:#9aa3b2; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 40px 20px 64px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
  .logo { width:44px; height:44px; border-radius:11px; background:linear-gradient(135deg,#ff5b73,#ff2e4d); display:flex; align-items:center; justify-content:center; font-size:22px; box-shadow:0 6px 18px #ff2e4d55; }
  h1 { font-size:22px; margin:0; }
  .sub { color:var(--sub); font-size:13px; margin: 2px 0 24px; }
  table { width:100%; border-collapse: collapse; background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  th, td { text-align:left; padding:13px 14px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13px; }
  th { background:#1b1f27; color:var(--sub); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  tr.latest { background: #1d1417; }
  .ver { font-weight:700; white-space:nowrap; }
  .tag { display:inline-block; margin-left:6px; padding:1px 8px; border-radius:999px; background:var(--red); color:#fff; font-size:11px; font-weight:600; }
  .date, .size { color:var(--sub); white-space:nowrap; }
  .note { color:#cdd2da; }
  .dl a { color:#4f8cff; text-decoration:none; font-weight:600; white-space:nowrap; }
  .dl a:hover { text-decoration:underline; }
  .foot { margin-top:26px; color:var(--sub); font-size:12px; }
  code { background:#1b1f27; padding:1px 6px; border-radius:5px; color:#e6e8eb; }
  details.changelog { margin: 22px 0 6px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding: 4px 16px; }
  details.changelog > summary { cursor:pointer; color:var(--red); font-weight:700; font-size:15px; padding:12px 0; user-select:none; }
  details.changelog > summary:hover { color:#ff5b73; }
  .changelog ul { margin: 0 0 14px; padding-left: 20px; }
  .changelog li { margin: 7px 0; font-size:13px; color:#cdd2da; }
  .changelog li b { color:var(--text); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">📕</div>
      <div>
        <h1>黑猫智记AI · 发布归档</h1>
      </div>
    </header>
    <div class="sub">本地安装包版本历史。下载后：绿色版解压到纯英文路径双击 exe 即用；插件在 <code>chrome://extensions</code> 重新加载。数据目录（商品库/发布队列）绿色版与安装版共享。</div>

    <details class="changelog" open>
      <summary>📜 更新日志</summary>
      <ul>
        ${logItems}
      </ul>
    </details>

    <table style="margin-top:18px">
      <thead>
        <tr><th>版本</th><th>日期</th><th>体积</th><th>关键更新</th><th>下载</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="foot">
      <p>说明：每个版本提供两种交付物——<b>绿色免安装版（.zip）</b>解压到纯英文路径双击 exe 即用；<b>浏览器插件（.zip）</b>在 <code>chrome://extensions</code> 开启开发者模式后「加载已解压的扩展程序」选择解压出的文件夹。两者独立更新。</p>
      <p>更新插件的必要步骤：每次升级务必在浏览器扩展页点「重新加载」（或移除后重加载），否则浏览器仍运行旧版 content script，修复不生效。</p>
    </div>
  </div>
</body>
</html>
`;

fs.writeFileSync(path.join(RELEASES, 'index.html'), html, 'utf8');
console.log('releases/index.html generated; exes present:', files.length);
