'use strict';

const DIMENSIONS = [
  { id: 'reasoning', name: '推理求真', icon: 'compass', description: '区分事实与解释，寻找反证，解释因果而非只作归因。', practice: '针对一个判断，列出事实、替代解释，以及能推翻判断的观察。', rubric: ['借助提示才能区分事实和判断', '能列出理由，但较少主动寻找反证', '能独立检查来源并比较至少两种解释', '在多次实际问题中用反证或对照修正判断', '能说明适用边界，并帮助他人复现推理过程'] },
  { id: 'learning', name: '学习迁移', icon: 'book', description: '把新知识变成可回忆、可解释、能用于新场景的能力。', practice: '不看原文回忆一个概念，再用一个新场景验证自己的解释。', rubric: ['需要反复查看材料才能复述', '能复述要点，但换场景后难以使用', '能独立回忆并用于一个实际场景', '在多个不同场景中迁移并记录反馈', '能建立跨领域联系，解释迁移失败的条件'] },
  { id: 'execution', name: '执行交付', icon: 'target', description: '把承诺拆成行动，以完成证据和真实结果检验交付。', practice: '把一个目标缩成可在一段时间内完成且有验收标准的行动。', rubric: ['需要外部推动才能开始和收尾', '可以启动，但估时、跟进或收尾不稳定', '能按明确标准独立完成一次交付', '能持续交付并主动处理偏差与阻碍', '能形成可重复的交付流程并改善结果质量'] },
  { id: 'strategy', name: '战略取舍', icon: 'chess', description: '识别约束、机会成本与长期目标，决定投入和放弃什么。', practice: '比较至少两个选项，写清机会成本、不可逆风险和停止条件。', rubric: ['容易被紧急事项牵引，优先级不清', '能列出目标，但较少明确取舍', '能说明选项成本并作出有边界的选择', '能依据反馈调整资源投入并坚持停止条件', '能在不确定性下组合小实验与长期布局'] },
  { id: 'expression', name: '表达协作', icon: 'message', description: '让论点可理解、分歧可讨论、协作责任可核对。', practice: '先准确复述对方最强观点，再写出自己的依据与具体请求。', rubric: ['难以让对方理解重点或具体请求', '能表达立场，但倾听和反馈确认不足', '能清楚表达依据并核对双方理解', '能处理分歧、明确分工并获取有效反馈', '能组织建设性辩论并改进共同决策质量'] },
  { id: 'reflection', name: '自省适应', icon: 'refresh', description: '直视偏差，分清可控因素，把复盘变成下一轮可验证调整。', practice: '对照预期与实际，写出一次可观测的行为调整并约定复查时间。', rubric: ['通常只记录结果，少有具体复盘', '能发现问题，但调整多停留在愿望', '能从一次复盘形成具体行为改变', '能追踪调整效果，并承认或修正错误解释', '能持续更新自己的方法及其适用条件'] }
];

// These are theoretical reference points, not evidence about a person or a case.
const LENSES = [
  { id: 'economics', name: '经济学 · 激励与取舍', icon: 'coins', family: '社会科学', question: '资源和时间的机会成本是什么？各方激励怎样改变选择？', challenge: '如果激励解释不成立，价值承诺、信息不足或能力约束是否更能解释行为？', test: '比较至少两个真实可选方案，记录投入、放弃的机会及可观察收益。', sourceUrl: 'https://plato.stanford.edu/entries/game-theory/' },
  { id: 'military', name: '军事战略 · 约束与布局', icon: 'shield', family: '战略思维', question: '目标、资源、关键约束和退出条件是否匹配？哪里适合集中投入？', challenge: '把合作关系当作对抗是否误导了判断？推进和暂停各自造成什么损失？', test: '先做低成本侦察或小规模试验，写出继续、转向与停止的触发条件。', sourceUrl: 'https://www.gutenberg.org/ebooks/132' },
  { id: 'politics', name: '政治学 · 权责与规则', icon: 'institution', family: '社会科学', question: '谁制定规则、谁承担成本、谁能发声？权力和责任是否对称？', challenge: '个人动机之外，制度和信息分配是否塑造了同样的结果？被忽略的当事人如何看待此事？', test: '绘制利益相关者与决策权清单，核对一项规则对不同人的实际影响。', sourceUrl: 'https://plato.stanford.edu/entries/authority/' },
  { id: 'history', name: '历史学 · 路径与情境', icon: 'history', family: '人文科学', question: '哪些早期选择、偶然事件或路径依赖让局面发展至此？', challenge: '历史类比的时代、制度和资源条件是否不同？是否只挑选了支持结论的案例？', test: '列出带时间和来源的事件链，比较一个相似案例与一个失败或相反案例。', sourceUrl: 'https://plato.stanford.edu/entries/history/' },
  { id: 'systems', name: '系统思维 · 反馈与延迟', icon: 'network', family: '复杂系统', question: '行动如何通过反馈、延迟和相互依赖产生意外后果？', challenge: '眼前关联是否来自共同原因？局部改善是否把成本转移到了其他环节？', test: '明确变量与时间顺序，只改动一个可控因素，同时观察预期效果和副作用。', sourceUrl: 'https://plato.stanford.edu/entries/causation-counterfactual/' },
  { id: 'psychology', name: '心理学 · 认知与情境', icon: 'brain', family: '认知科学', question: '注意、情绪、习惯和信息呈现怎样影响判断？有哪些可观察的行为证据？', challenge: '是在解释行为，还是给人贴标签？换一个情境能否出现不同结果？', test: '提前写下预测，记录实际行为并比较环境改变前后；避免凭一次表现推断稳定人格。', sourceUrl: 'https://www.nobelprize.org/prizes/economic-sciences/2002/kahneman/lecture/' },
  { id: 'confucian', name: '儒家 · 修身与责任', icon: 'balance', family: '东方哲学', question: '此事涉及哪些角色责任、相互关切与值得长期练习的品格？', challenge: '维护和谐是否掩盖了不合理要求？履行角色责任与独立判断在哪里冲突？', test: '指出一个具体关系中的承诺，核对自己的行动是否兼顾诚实、尊重与边界。', sourceUrl: 'https://plato.stanford.edu/entries/confucius/' },
  { id: 'daoist', name: '道家 · 顺势与留白', icon: 'flow', family: '东方哲学', question: '哪些阻力来自过度控制？减少一种干预是否反而让事情更自然地运转？', challenge: '所谓顺势是否变成回避责任？哪些不可省略的行动仍然需要主动承担？', test: '在风险可控的环节减少一次不必要干预，观察结果、负担和他人反馈。', sourceUrl: 'https://plato.stanford.edu/entries/daoism/' },
  { id: 'critical', name: '批判思维 · 论证与反证', icon: 'search', family: '逻辑与哲学', question: '结论依赖哪些前提？最强反对意见是什么？什么证据会让我改变立场？', challenge: '怀疑是否同样作用于自己的观点？是否把证据不足误当成对立观点已经成立？', test: '将论证写成前提与结论，为双方设定同样的证据标准并查找能区分解释的观察。', sourceUrl: 'https://plato.stanford.edu/entries/critical-thinking/' },
  { id: 'pragmatism', name: '实用主义 · 行动与后果', icon: 'flask', family: '西方哲学', question: '不同解释会带来什么不同的行动？哪些现实后果能够帮助检验解释？', challenge: '短期有效是否掩盖长期代价？对谁有效，代价由谁承担？', test: '把争论改写为一个小实验，预先约定衡量指标、时间范围与不利后果。', sourceUrl: 'https://plato.stanford.edu/entries/pragmatism/' },
  { id: 'stoic', name: '斯多葛 · 可控与行动', icon: 'mountain', family: '西方哲学', question: '哪些属于自己的判断与行动，哪些结果受外界影响？', challenge: '接受不可控是否演变为对可改变条件的放弃？是否低估了合作改变环境的可能？', test: '分开列出可控行动、可影响条件和暂时不可控结果，只对前两类制定具体下一步。', sourceUrl: 'https://plato.stanford.edu/entries/stoicism/' },
  { id: 'science', name: '科学方法 · 模型与检验', icon: 'atom', family: '方法论', question: '判断能否转成可检验预测？变量、测量方法和失败条件是否明确？', challenge: '可测量的指标是否代表真正关心的结果？是否混淆相关、因果与价值选择？', test: '记录基线、替代假设和测试方法，预先说明何种观察会否定当前解释。', sourceUrl: 'https://plato.stanford.edu/entries/scientific-method/' }
];

const dimensionIds = new Set(DIMENSIONS.map(item => item.id));
const lensIds = new Set(LENSES.map(item => item.id));
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const excerpt = (value, maximum) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';

function field(value, label, maximum = 4000, required = false, statusCode = 400) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > maximum) throw fail(`${label}需为不超过 ${maximum} 字的文本`, statusCode);
  const result = value.trim();
  if (required && !result) throw fail(`请填写${label}`, statusCode);
  return result;
}

function ids(value, allowed, label, maximum, minimum = 0, statusCode = 400) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw fail(`${label}需包含 ${minimum}–${maximum} 项`, statusCode);
  if (value.some(item => typeof item !== 'string' || !allowed.has(item)) || new Set(value).size !== value.length) throw fail(`${label}包含无效或重复的引用`, statusCode);
  return [...value];
}

function evidenceCatalog(store = {}) {
  const groups = [
    ['task', list(store.tasks), item => [item.status ? `状态：${item.status}` : '', item.evidence ? `完成证据：${item.evidence}` : '尚无完成证据'].filter(Boolean).join('\n')],
    ['reading', list(store.reading), item => [item.author ? `作者：${item.author}` : '', item.note ? `笔记：${item.note}` : '', item.quote ? `摘录：${item.quote}` : ''].filter(Boolean).join('\n')],
    ['checkin', list(store.checkins), item => [Number.isFinite(item.energy) ? `自报精力：${item.energy}/5` : '', item.note, item.blocker ? `阻碍：${item.blocker}` : '', item.tomorrow ? `下一步：${item.tomorrow}` : ''].filter(Boolean).join('\n')],
    ['goal', list(store.goals), item => [item.status ? `状态：${item.status}` : '', item.why ? `目标依据：${item.why}` : ''].filter(Boolean).join('\n')]
  ];
  const seen = new Set();
  const result = [];
  for (const [type, records, detail] of groups) {
    for (const record of records) {
      if (!object(record) || record.isDemo || record.id === undefined || record.id === null || String(record.id).trim() === '') continue;
      const identity = `${type}:${record.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push({ id: identity, type, title: excerpt(record.title, 300) || (type === 'checkin' ? `签到 ${excerpt(record.createdAt, 10)}` : '未命名记录'), detail: excerpt(detail(record), 1000) });
    }
  }
  return result;
}

function assessmentFields(store, body) {
  if (!object(body)) throw fail('能力自评应为对象');
  if (!Array.isArray(body.ratings) || body.ratings.length < 1 || body.ratings.length > 6) throw fail('请评价 1–6 个能力维度');
  const allowed = new Set(evidenceCatalog(store).map(item => item.id));
  const seen = new Set();
  const ratings = body.ratings.map(rating => {
    if (!object(rating) || !dimensionIds.has(rating.dimension) || seen.has(rating.dimension)) throw fail('能力维度无效或重复');
    if (!Number.isInteger(rating.score) || rating.score < 1 || rating.score > 5) throw fail('能力自评分需为 1–5 的整数');
    seen.add(rating.dimension);
    return { dimension: rating.dimension, score: rating.score, note: field(rating.note, '自评依据', 4000, true), sourceIds: ids(rating.sourceIds === undefined ? [] : rating.sourceIds, allowed, '自评证据', 12) };
  });
  return { context: field(body.context, '自评场景', 4000), ratings };
}

function growthOverview(store = {}, nowISO) {
  const assessments = list(store.growthAssessments).filter(object);
  const ordered = assessments.map((record, index) => ({ record, index })).sort((a, b) => String(b.record.createdAt || '').localeCompare(String(a.record.createdAt || '')) || a.index - b.index).map(item => item.record);
  const latestAssessment = ordered[0] || null;
  const previousAssessment = ordered[1] || null;
  const evaluated = list(latestAssessment?.ratings).filter(rating => object(rating) && dimensionIds.has(rating.dimension) && Number.isInteger(rating.score) && rating.score >= 1 && rating.score <= 5).map(rating => ({ dimension: rating.dimension, name: DIMENSIONS.find(item => item.id === rating.dimension).name, score: rating.score, note: rating.note }));
  const experiments = list(store.growthExperiments).filter(object);
  const strategies = experiments.flatMap(experiment => list(experiment.reviews).filter(object).map(review => ({ experimentId: experiment.id, title: experiment.title, decision: review.decision, lesson: review.lesson, adjustment: review.adjustment, reviewedAt: review.reviewedAt || review.createdAt || experiment.updatedAt || '' }))).sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)));
  return {
    dimensions: DIMENSIONS, lenses: LENSES, evidence: evidenceCatalog(store), latestAssessment, previousAssessment,
    strengths: evaluated.filter(item => item.score >= 4).sort((a, b) => b.score - a.score),
    focus: evaluated.filter(item => item.score <= 2).sort((a, b) => a.score - b.score),
    strategies,
    counts: { assessments: assessments.length, cases: list(store.thinkingCases).length, experiments: experiments.length, reviewed: experiments.filter(item => list(item.reviews).length > 0).length }
  };
}

function caseFields(store, body, existing = null) {
  if (!object(body)) throw fail('思辨案例应为对象');
  const value = (key, fallback) => body[key] === undefined ? (existing?.[key] ?? fallback) : body[key];
  const subjectType = value('subjectType', 'decision');
  if (!['self', 'person', 'event', 'object', 'decision'].includes(subjectType)) throw fail('分析对象类型无效');
  const allowed = new Set(evidenceCatalog(store).map(item => item.id));
  return {
    title: field(value('title', ''), '案例标题', 300, true), subjectType,
    context: field(value('context', ''), '背景', 4000), facts: field(value('facts', ''), '已知事实', 4000, true),
    assumptions: field(value('assumptions', ''), '当前假设', 4000), question: field(value('question', ''), '核心问题', 4000, true),
    lensIds: ids(value('lensIds', []), lensIds, '分析视角', 8, 3),
    sourceIds: ids(value('sourceIds', []), allowed, '案例证据', 12)
  };
}

function buildLocalAnalysis(caseRecord) {
  const caseReference = caseRecord.id ? [`case:${caseRecord.id}`] : [];
  const sourceIds = [...caseReference, ...list(caseRecord.sourceIds)];
  const selected = list(caseRecord.lensIds).map(identity => LENSES.find(item => item.id === identity)).filter(Boolean);
  return {
    mode: 'guided',
    summary: `围绕“${excerpt(caseRecord.question, 300)}”建立思辨工作单。以下是本地规则生成的提问与检验提示，尚未对事实、他人动机或因果关系作出验证；需要你补充答案与观察。`,
    lenses: selected.map(lens => ({ lensId: lens.id, claim: `待回答：${lens.question}`, counterargument: `反方追问：${lens.challenge}`, test: lens.test, sourceIds: [...sourceIds] })),
    causes: [{ cause: '待确认：从已知事实中选择一个在时间上先发生的可观察因素。', effect: '待确认：写出随后发生的具体结果，并注明时间与衡量方法。', mechanism: '待验证：解释前一因素通过哪些中间环节影响结果；区分观察与猜测。', alternative: '替代解释：共同原因、反向因果、选择偏差或偶然变化是否足以解释结果？', test: '补齐事件顺序，寻找因素未出现时的对照；若无法隔离其他因素，将结论保留为假说。' }],
    disagreements: [{ thesis: '正方待写：用当前假设解释问题，列出最有力的事实和适用条件。', antithesis: '反方待写：准确表达最强竞争解释，指出正方忽略的证据或代价。', test: '共同约定一个会让双方给出不同预测的观察；看到什么结果时各自愿意改变立场？' }],
    unknowns: [
      '案例中的事实尚未被系统独立核验；记录来源、时间与可能的偏差。',
      caseRecord.assumptions ? '已有假设需要列出失效条件；被表述出来不等于已经成立。' : '尚未填写当前假设：先提出可被反驳的解释，再比较替代解释。',
      list(caseRecord.sourceIds).length ? '已关联记录可供追溯，但关联本身不能证明某个解释。' : '尚未关联资料；可以先使用自己的观察，但需区分第一手事实和转述。',
      '需要确认结果的衡量方式、时间范围，以及对其他人的影响。'
    ],
    actions: [
      { title: '补齐事实与替代解释', reason: '先将已知事实、假说和未知分开，减少把判断当事实的风险。', dimension: 'reasoning', metric: '写出至少三个可核对的观察、两个竞争解释与一个反证条件。' },
      { title: '设计一个可撤回的小实验', reason: '把观点碰撞转成可观察的差异，以结果决定保留、调整或停止策略。', dimension: 'reflection', metric: '记录基线、干预、目标、复查日期，以及支持或否定假设的判据。' }
    ],
    citations: sourceIds
  };
}

function validateDebate(answer, caseRecord) {
  const status = 502;
  const bad = message => { throw fail(`AI 思辨结果无效：${message}`, status); };
  if (!object(answer) || !object(caseRecord) || !caseRecord.id) bad('缺少案例或结构化结果');
  const selected = new Set(list(caseRecord.lensIds));
  const allowed = new Set([`case:${caseRecord.id}`, ...list(caseRecord.sourceIds)]);
  const answerText = (value, label, maximum = 4000) => field(value, `AI ${label}`, maximum, true, status);
  const rows = (value, label, minimum, maximum) => {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some(item => !object(item))) bad(`${label}需包含 ${minimum}–${maximum} 个有效对象`);
    return value;
  };
  const seen = new Set();
  const lenses = rows(answer.lenses, '视角', selected.size, selected.size).map(lens => {
    if (!selected.has(lens.lensId) || seen.has(lens.lensId)) bad('必须逐一覆盖选定视角且不能重复');
    seen.add(lens.lensId);
    return { lensId: lens.lensId, claim: answerText(lens.claim, '视角主张'), counterargument: answerText(lens.counterargument, '最强反对意见'), test: answerText(lens.test, '检验方式'), sourceIds: ids(lens.sourceIds, allowed, 'AI 视角引用', 13, 1, status) };
  });
  const causes = rows(answer.causes, '因果链', 1, 6).map(cause => ({ cause: answerText(cause.cause, '原因'), effect: answerText(cause.effect, '结果'), mechanism: answerText(cause.mechanism, '作用机制'), alternative: answerText(cause.alternative, '替代解释'), test: answerText(cause.test, '因果检验') }));
  const disagreements = rows(answer.disagreements, '观点交锋', 1, 6).map(disagreement => ({ thesis: answerText(disagreement.thesis, '正方论点'), antithesis: answerText(disagreement.antithesis, '反方论点'), test: answerText(disagreement.test, '分歧检验') }));
  if (!Array.isArray(answer.unknowns) || answer.unknowns.length > 12) bad('未知项需为最多 12 项的数组');
  const unknowns = answer.unknowns.map(value => answerText(value, '未知项', 2000));
  const actions = rows(answer.actions, '建议行动', 1, 5).map(action => {
    if (!dimensionIds.has(action.dimension)) bad('建议行动的能力维度无效');
    return { title: answerText(action.title, '行动标题', 300), reason: answerText(action.reason, '行动理由', 2000), dimension: action.dimension, metric: answerText(action.metric, '检验指标', 2000) };
  });
  const citations = answer.citations === undefined ? [...new Set(lenses.flatMap(lens => lens.sourceIds))] : ids(answer.citations, allowed, 'AI 总引用', 13, 1, status);
  if (![...citations, ...lenses.flatMap(lens => lens.sourceIds)].includes(`case:${caseRecord.id}`)) bad('缺少当前案例引用');
  return { mode: 'ai', summary: answerText(answer.summary, '总结', 12000), lenses, causes, disagreements, unknowns, actions, citations };
}

function experimentFields(store, body) {
  if (!object(body)) throw fail('成长实验应为对象');
  if (!dimensionIds.has(body.dimension)) throw fail('实验能力维度无效');
  const caseId = field(body.caseId, '关联案例', 300);
  if (caseId && !list(store.thinkingCases).some(item => String(item.id) === caseId)) throw fail('关联案例不存在');
  const minutes = body.minutes === undefined ? 25 : Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw fail('实验行动预计时间需在 1–1440 分钟之间');
  const reviewAt = field(body.reviewAt, '复查日期', 100, true);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(reviewAt) || !Number.isFinite(Date.parse(reviewAt))) throw fail('复查日期格式无效');
  const dateOnly = reviewAt.slice(0, 10);
  if (new Date(`${dateOnly}T00:00:00Z`).toISOString().slice(0, 10) !== dateOnly) throw fail('复查日期不存在');
  return {
    title: field(body.title, '实验标题', 300, true), dimension: body.dimension, caseId,
    hypothesis: field(body.hypothesis, '实验假设', 4000, true), intervention: field(body.intervention, '干预行动', 4000, true),
    metric: field(body.metric, '检验指标', 4000, true), baseline: field(body.baseline, '当前基线', 4000, true), target: field(body.target, '目标结果', 4000, true),
    reviewAt: new Date(reviewAt).toISOString(), minutes
  };
}

function reviewFields(body) {
  if (!object(body)) throw fail('实验复盘应为对象');
  if (!['supported', 'refuted', 'inconclusive'].includes(body.outcome)) throw fail('复盘结论无效');
  if (!['keep', 'adjust', 'stop'].includes(body.decision)) throw fail('策略决策无效');
  if (body.outcome !== 'supported' && body.decision === 'keep') throw fail('假设被否定或证据不足时，需选择调整或停止策略');
  return { outcome: body.outcome, observation: field(body.observation, '实际观察', 4000, true), lesson: field(body.lesson, '复盘所得', 4000, true), adjustment: field(body.adjustment, '后续调整', 4000, true), decision: body.decision };
}

module.exports = { DIMENSIONS, LENSES, evidenceCatalog, growthOverview, assessmentFields, caseFields, buildLocalAnalysis, validateDebate, experimentFields, reviewFields };
