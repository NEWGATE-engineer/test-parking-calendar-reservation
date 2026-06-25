export const meta = {
  name: 'design-judge-panel',
  description: '設計判断を「N案を別観点で生成 → 審査パネルで採点 → 統合して推奨」する判定パネル。難しい設計トレードオフ（並行制御・スキーマ・API契約など）を、単一視点に偏らず決めるために使う。',
  whenToUse: 'アーキ/設計の分岐点で複数案を比較したいとき。args に { question, context?, refs?, numCandidates? } を渡す。',
  phases: [
    { title: 'Candidates', detail: '異なる観点で設計案を並列生成' },
    { title: 'Judge', detail: '各案を複数レンズの審査員が採点' },
    { title: 'Synthesize', detail: '全案＋採点から推奨案を統合' },
  ],
}

// ---- 入力の正規化 ----------------------------------------------------------
// args は文字列（設計テーマだけ）でもオブジェクトでも受ける。
const input = typeof args === 'string' ? { question: args } : (args || {})
const question = input.question || 'この設計判断を行う'
const context = input.context || ''
const refs = Array.isArray(input.refs) ? input.refs : []
const numCandidates = Math.max(2, Math.min(4, input.numCandidates || 3))

// 案を生成する「観点」。numCandidates 個だけ使う。各案は別の価値基準で設計する。
const ANGLES = [
  { key: 'simple', label: 'シンプルさ・実装/保守容易性を最優先' },
  { key: 'robust', label: '競合/障害に対する堅牢性・正確性を最優先' },
  { key: 'scalable', label: '将来拡張性・変更耐性を最優先' },
  { key: 'perf', label: 'パフォーマンス・Azure コスト効率を最優先' },
].slice(0, numCandidates)

// 審査の「レンズ」。各案をこの3観点で別々に採点する。
const LENSES = [
  { key: 'correctness', label: '正確性・競合安全（条件付きUPDATE/トランザクション境界/冪等）' },
  { key: 'maintainability', label: 'シンプルさ・保守性・テスト容易性' },
  { key: 'risk', label: 'リスク・失敗モード・運用/コストの落とし穴' },
]

const refsBlock = refs.length
  ? `\n\n## 参照すべきファイル（Read で必ず読むこと）\n${refs.map((r) => `- ${r}`).join('\n')}`
  : ''
const contextBlock = context ? `\n\n## 追加コンテキスト\n${context}` : ''
const baseBrief = `## 設計テーマ\n${question}${contextBlock}${refsBlock}\n\n本リポジトリの CLAUDE.md のドメイン規約（状態遷移は条件付きUPDATE/0件=競合、UTC保存、パラメータ化クエリ、冪等性 等）を必ず踏まえること。`

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approachName', 'summary', 'keySteps', 'pros', 'cons', 'risks'],
  properties: {
    approachName: { type: 'string', description: '案の短い名称' },
    summary: { type: 'string', description: '設計の要約（数文）' },
    keySteps: { type: 'array', items: { type: 'string' }, description: '実装の主要ステップ（順序）' },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' }, description: '競合/障害/運用の懸念' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'rationale'],
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5, description: 'このレンズでの評価（5が最良）' },
    rationale: { type: 'string', description: '点数の根拠（具体的に）' },
    killer: { type: 'string', description: 'この案を不採用にすべき致命的欠陥があれば記述。無ければ空文字' },
  },
}

// ---- Phase 1: 案を並列生成（synthesis で全案を突き合わせるためバリアが妥当）----
phase('Candidates')
const candidates = (
  await parallel(
    ANGLES.map((a) => () =>
      agent(
        `あなたは設計者です。次のテーマについて「${a.label}」の観点から、ひとつの設計案を具体的に提案してください。${'\n\n'}${baseBrief}${'\n\n'}実装の主要ステップ・利点・欠点・リスクを、このリポジトリの実コードに即して具体的に書くこと。`,
        { label: `candidate:${a.key}`, phase: 'Candidates', schema: CANDIDATE_SCHEMA },
      ),
    ),
  )
)
  .map((c, i) => (c ? { ...c, angle: ANGLES[i].label } : null))
  .filter(Boolean)

if (candidates.length === 0) {
  return { error: '案を1つも生成できませんでした', question }
}
log(`生成された案: ${candidates.map((c) => c.approachName).join(' / ')}`)

// ---- Phase 2: 各案を複数レンズで採点（全採点を synthesis に渡すためバリア）----
phase('Judge')
const judged = await parallel(
  candidates.map((c) => () =>
    parallel(
      LENSES.map((lens) => () =>
        agent(
          `あなたは審査員です。「${lens.label}」のレンズだけで次の設計案を1〜5で採点し、根拠を述べてください。甘くせず、致命的欠陥があれば killer に明記。${'\n\n'}## 設計テーマ\n${question}${contextBlock}${refsBlock}${'\n\n'}## 評価対象の案: ${c.approachName}\n要約: ${c.summary}\n主要ステップ:\n${(c.keySteps || []).map((s) => `- ${s}`).join('\n')}\n利点: ${(c.pros || []).join('; ')}\n欠点: ${(c.cons || []).join('; ')}\nリスク: ${(c.risks || []).join('; ')}`,
          { label: `judge:${c.approachName}:${lens.key}`, phase: 'Judge', schema: VERDICT_SCHEMA },
        ).then((v) => (v ? { lens: lens.key, ...v } : null)),
      ),
    ).then((verdicts) => {
      const vs = verdicts.filter(Boolean)
      const total = vs.reduce((s, v) => s + (v.score || 0), 0)
      const killers = vs.map((v) => v.killer).filter((k) => k && k.trim())
      return { candidate: c, verdicts: vs, total, killers }
    }),
  ),
)

// 合計点が高い順に整列。同点なら致命的欠陥(killer)が少ない案を上位にする。
// （単一の比較子で表現。2段 sort だと1段目の意図が2段目に上書きされ誤順になりやすい）
const ranked = judged
  .filter(Boolean)
  .sort((a, b) => b.total - a.total || a.killers.length - b.killers.length)

// ---- Phase 3: 全案＋採点を1エージェントが統合して推奨 ----------------------
phase('Synthesize')
const dossier = ranked
  .map(
    (r) =>
      `### 案: ${r.candidate.approachName}（観点: ${r.candidate.angle}）合計${r.total}/${LENSES.length * 5}\n要約: ${r.candidate.summary}\n採点:\n${r.verdicts
        .map((v) => `- ${v.lens}: ${v.score}/5 — ${v.rationale}${v.killer ? ` ⚠致命: ${v.killer}` : ''}`)
        .join('\n')}`,
  )
  .join('\n\n')

const recommendation = await agent(
  `あなたは技術リードです。以下は同じ設計テーマに対する複数案と審査員の採点です。${'\n\n'}## 設計テーマ\n${question}${contextBlock}${refsBlock}${'\n\n'}## 候補と採点\n${dossier}${'\n\n'}最も妥当な案を1つ推奨し、その理由を述べてください。さらに、他案の優れた要素で取り込むべきものがあれば「グラフトすべき点」として挙げてください。最後に、実装に進む際の具体的な注意点（このリポジトリの規約・競合制御・テスト観点）を箇条書きで示してください。`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return {
  question,
  candidates: ranked.map((r) => ({
    approachName: r.candidate.approachName,
    angle: r.candidate.angle,
    total: r.total,
    killers: r.killers,
  })),
  recommendation,
}
