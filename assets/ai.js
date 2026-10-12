/* AI 분석 엔진 — Gemini API 연동 + 키가 없을 때 쓰는 규칙 기반 데모 분석 */
(function () {
  const FACTORS = [
    { key: 'O', name: '개방성', en: 'OPENNESS',
      desc: '새로운 경험과 아이디어에 대한 수용도입니다. 높을수록 추상적이고 창의적이며 변화를 선호하고, 낮을수록 익숙하고 실용적이며 안정적인 것을 선호합니다.',
      high: '창의적이고 새로운 시도를 즐기는', low: '실용적이고 안정을 중시하는' },
    { key: 'C', name: '성실성', en: 'CONSCIENTIOUSNESS',
      desc: '목표 지향성과 자기조절 능력, 책임감입니다. 높을수록 꼼꼼하고 체계적이며 책임감이 강하고, 낮을수록 즉흥적이고 유연하지만 마감이나 세부사항에 느슨할 수 있습니다.',
      high: '성실하고 꼼꼼한', low: '유연하고 즉흥적인' },
    { key: 'E', name: '외향성', en: 'EXTRAVERSION',
      desc: '에너지를 외부에서 얻는지 내부에서 얻는지입니다. 높을수록 사교적이고 활동적이며, 낮을수록 내향적이며 조용한 환경에서 혼자 사유하며 에너지를 충전합니다.',
      high: '사교적이고 활동적인', low: '차분하고 혼자 깊이 몰입하는' },
    { key: 'A', name: '우호성', en: 'AGREEABLENESS',
      desc: '타인에 대한 협조성과 공감 능력입니다. 높을수록 배려심이 많고 협력을 중시하며 갈등을 피하고, 낮을수록 경쟁적이고 비판적이며 자기주장이 강합니다.',
      high: '협력적이고 배려심 있는', low: '자기주장이 분명하고 비판적인' },
    { key: 'N', name: '신경성', en: 'NEUROTICISM',
      desc: '정서적 안정성의 정도입니다. 높을수록 불안과 걱정 등 감정 기복이 크고, 낮을수록 정서적으로 안정적이며 기복이 적습니다.',
      high: '감수성이 풍부하고 예민한', low: '정서적으로 안정된' },
  ];

  const LEVELS = [
    { v: -2, label: '매우 안 중요' },
    { v: -1, label: '안 중요' },
    { v: 0, label: '상관없음' },
    { v: 1, label: '중요' },
    { v: 2, label: '매우 중요' },
  ];

  /* ── 적합도 계산 ──
     기준값 c ∈ {-2,-1,1,2}, 지원자 점수 s ∈ [1,5] → s-3 ∈ [-2,2]
     요인 부합도 = 100 × (1 − |c − (s−3)| / 4), 상관없음(0)은 제외 */
  function factorFit(criterion, score) {
    if (!criterion) return null;
    const diff = Math.abs(criterion - (score - 3));
    return Math.round(100 * (1 - diff / 4));
  }
  function overallFit(criteria, big5) {
    const fits = FACTORS.map(f => factorFit(criteria[f.key], big5[f.key].score)).filter(v => v !== null);
    if (!fits.length) return null;
    return Math.round(fits.reduce((a, b) => a + b, 0) / fits.length);
  }

  function personaSentence(criteria) {
    const parts = FACTORS.filter(f => criteria[f.key]).map(f => {
      const c = criteria[f.key];
      return (Math.abs(c) === 2 ? '매우 ' : '') + (c > 0 ? f.high : f.low);
    });
    if (!parts.length) return '';
    return parts.join(', ') + ' 인재';
  }

  /* ── Gemini ── */
  async function gemini(cfg, prompt) {
    const model = (cfg.model || 'gemini-2.5-flash').trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      let msg = res.status + '';
      try { msg += ' ' + (await res.json()).error.message; } catch (e) {}
      throw new Error('Gemini 오류: ' + msg);
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    return parseJSON(text);
  }

  function parseJSON(text) {
    try { return JSON.parse(text); } catch (e) {}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI 응답을 해석하지 못했습니다.');
  }

  function criteriaText(criteria) {
    return FACTORS.map(f => {
      const lv = LEVELS.find(l => l.v === (criteria[f.key] || 0)).label;
      return `- ${f.name}(${f.key}): ${lv}`;
    }).join('\n');
  }

  const RULES = `규칙:
- 지원자의 이름, 출신 학교, 외모, 나이, 성별 등 역량과 무관한 정보는 절대 판단에 사용하지 않는다.
- 오직 답변 텍스트의 내용만 근거로 삼는다. 음성·표정은 판단 근거가 아니다.
- 모든 판단에는 답변 원문을 그대로 인용한 근거를 붙인다.
- 반드시 지정한 JSON 형식으로만 응답한다.`;

  async function generateQuestions(cfg, ctx) {
    if (!cfg.key) return demo.questions(ctx);
    const prompt = `너는 채용 면접관을 돕는 AI 면접 어시스턴트다.
아래 자기소개서와 직무, 면접관이 설정한 BIG5 인재상 기준을 바탕으로 한국어 면접 질문 ${ctx.count}개를 만들어라.
- 자기소개서에 적힌 경험의 진위와 구체성을 검증할 수 있는 질문을 포함한다.
- 상황(S)·과제(T)·행동(A)·결과(R)의 STAR 구조로 답하도록 유도한다.
- 면접관이 '상관없음'이 아닌 기준을 둔 성격 요인을 드러낼 수 있는 질문을 포함한다.
- 한 질문은 한두 문장, 말로 읽기 좋은 길이로 쓴다.
${RULES}

직무: ${ctx.job || '(미입력)'}
인재상 기준:
${criteriaText(ctx.criteria)}
자기소개서:
"""${ctx.resume || '(미입력)'}"""

JSON 형식: {"questions":[{"text":"질문","purpose":"이 질문으로 확인하려는 것(짧게)"}]}`;
    const out = await gemini(cfg, prompt);
    return (out.questions || []).slice(0, ctx.count);
  }

  async function followups(cfg, ctx, question, answer) {
    if (!cfg.key) return demo.followups(ctx, question, answer);
    const prompt = `너는 면접관을 돕는 AI다. 방금 지원자가 한 답변을 자기소개서와 비교해,
불일치, 빠진 STAR 요소, 논리적 근거 부족, 미응답, 사실과 다르다고 의심되는 부분을 찾아 확인용 꼬리 질문을 최대 3개 만들어라.
${RULES}

직무: ${ctx.job}
자기소개서:
"""${ctx.resume}"""
질문: ${question}
답변: """${answer}"""

JSON 형식: {"followups":["꼬리 질문"]}`;
    const out = await gemini(cfg, prompt);
    return (out.followups || []).slice(0, 3);
  }

  async function analyze(cfg, ctx, qa) {
    if (!cfg.key) return demo.analyze(ctx, qa);
    const transcript = qa.map((x, i) => `[질문 ${i + 1}] ${x.q}\n[답변 ${i + 1}] ${x.a || '(무응답)'}`).join('\n\n');
    const prompt = `너는 면접관을 돕는 AI 면접 분석기다. 지원자의 면접 답변을 BIG5 성격 모델로 분석하라.
- 각 요인 score는 1(매우 낮음)~5(매우 높음) 정수. 근거가 부족하면 3으로 두고 reason에 '근거 부족'이라고 쓴다.
- evidence에는 답변에서 그대로 복사한 짧은 구절을 넣는다(지어내지 말 것).
- star는 질문마다 상황(S)·과제(T)·행동(A)·결과(R)를 갖췄는지 판단한다.
- mismatches에는 자기소개서 내용과 답변이 어긋나는 지점을 정리한다. 없으면 빈 배열.
- followups에는 추가 확인이 필요한 꼬리 질문을 최대 4개.
- summary는 면접관에게 주는 2~3문장 요약 코멘트. 채용 여부를 단정하지 말 것.
${RULES}

직무: ${ctx.job}
자기소개서:
"""${ctx.resume}"""

면접 기록:
${transcript}

JSON 형식:
{"big5":{"O":{"score":3,"reason":"","evidence":[""]},"C":{...},"E":{...},"A":{...},"N":{...}},
 "star":[{"q":1,"S":true,"T":true,"A":true,"R":false,"note":""}],
 "mismatches":[{"resume":"자소서 내용","answer":"답변 내용","note":"어긋나는 점"}],
 "followups":[""],
 "summary":""}`;
    const out = await gemini(cfg, prompt);
    return normalize(out, qa);
  }

  function normalize(out, qa) {
    const big5 = {};
    FACTORS.forEach(f => {
      const b = (out.big5 || {})[f.key] || {};
      let s = Math.round(Number(b.score));
      if (!(s >= 1 && s <= 5)) s = 3;
      big5[f.key] = { score: s, reason: b.reason || '', evidence: (b.evidence || []).filter(Boolean) };
    });
    const star = qa.map((x, i) => {
      const s = (out.star || []).find(r => Number(r.q) === i + 1) || (out.star || [])[i] || {};
      return { q: i + 1, S: !!s.S, T: !!s.T, A: !!s.A, R: !!s.R, note: s.note || '' };
    });
    return {
      big5, star,
      mismatches: (out.mismatches || []).filter(m => m && (m.note || m.answer)),
      followups: (out.followups || []).filter(Boolean),
      summary: out.summary || '',
    };
  }

  /* ── 데모 분석 (규칙 기반) ── */
  const LEX = {
    O: { pos: ['새로운', '새롭', '창의', '아이디어', '호기심', '도전', '시도', '탐구', '상상', '다양한', '배우', '실험', '변화', '독창'],
         neg: ['익숙', '전통', '안정적인 방식', '기존 방식', '정해진', '원래대로'] },
    C: { pos: ['계획', '꼼꼼', '책임', '마감', '목표', '체계', '정리', '끝까지', '성실', '준비', '점검', '일정', '기록', '규칙'],
         neg: ['미루', '즉흥', '대충', '깜빡', '늦게', '놓쳤'] },
    E: { pos: ['사람들', '친구', '대화', '발표', '모임', '함께', '팀원', '리더', '주도', '활발', '적극', '동아리', '소통', '앞장'],
         neg: ['혼자', '조용', '내성', '집중', '차분', '혼자서'] },
    A: { pos: ['배려', '도와', '도움', '협력', '협업', '공감', '양보', '존중', '경청', '함께', '이해', '감사', '팀워크'],
         neg: ['경쟁', '비판', '주장', '설득', '이기', '반박', '따졌'] },
    N: { pos: ['걱정', '불안', '긴장', '스트레스', '두려', '초조', '속상', '힘들', '우울', '포기하고 싶'],
         neg: ['침착', '차분', '안정', '담담', '여유', '평정', '괜찮'] },
  };
  const STAR_CUE = {
    S: ['때', '당시', '상황', '프로젝트', '동아리', '수업', '대회', '학년', '처음'],
    T: ['목표', '역할', '맡', '과제', '해야', '문제', '담당', '책임'],
    A: ['했습니다', '했어요', '했고', '진행', '제안', '해결', '시도', '만들', '정리', '분석', '찾아'],
    R: ['결과', '덕분', '성과', '배웠', '느꼈', '%', '늘었', '줄었', '향상', '수상', '완성', '성공'],
  };
  const FILLERS = ['어', '음', '그', '저', '뭐', '약간', '그냥', '이제'];

  function sentences(text) {
    return (text || '').split(/(?<=[.!?。]|다\s|요\s)\s*|\n+/).map(s => s.trim()).filter(s => s.length > 3);
  }
  function count(text, words) { return words.reduce((n, w) => n + (text.split(w).length - 1), 0); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  const demo = {
    async questions(ctx) {
      await sleep(500);
      const out = [];
      const sents = sentences(ctx.resume).filter(s => /프로젝트|동아리|경험|대회|봉사|활동|인턴|개발|만들|운영|맡/.test(s));
      if (ctx.job) out.push({ text: `${ctx.job} 직무에 지원하신 이유와, 이 일을 하기 위해 지금까지 어떤 준비를 해 오셨는지 말씀해 주세요.`, purpose: '지원 동기 · 직무 이해도' });
      sents.slice(0, 2).forEach(s => {
        const quote = s.length > 46 ? s.slice(0, 46) + '…' : s;
        out.push({ text: `자기소개서에 “${quote}”라고 쓰셨는데, 그때 어떤 상황이었고 본인은 구체적으로 무엇을 했으며 결과는 어땠나요?`, purpose: '자기소개서 경험 검증 (STAR)' });
      });
      const byFactor = {
        O: '최근에 새로 배우거나 처음 시도해 본 일이 있다면, 왜 시작했고 어떻게 해 나갔는지 말씀해 주세요.',
        C: '마감이 촉박하거나 해야 할 일이 많았을 때, 일을 어떻게 계획하고 끝까지 마무리했는지 경험을 들어 말씀해 주세요.',
        E: '처음 보는 사람들과 함께 무언가를 해야 했던 경험이 있다면, 그때 본인은 어떤 역할을 했는지 말씀해 주세요.',
        A: '팀원과 의견이 크게 달랐던 경험이 있다면, 그 갈등을 어떻게 풀었는지 말씀해 주세요.',
        N: '예상하지 못한 문제로 계획이 틀어졌을 때, 어떤 기분이 들었고 어떻게 대처했는지 말씀해 주세요.',
      };
      FACTORS.filter(f => ctx.criteria[f.key]).sort((a, b) => Math.abs(ctx.criteria[b.key]) - Math.abs(ctx.criteria[a.key]))
        .forEach(f => out.push({ text: byFactor[f.key], purpose: `${f.name} 확인` }));
      const fill = [byFactor.C, byFactor.A, byFactor.N, byFactor.O, byFactor.E,
        '살면서 가장 크게 실패했던 경험과, 그 경험에서 배운 점을 말씀해 주세요.'];
      for (const t of fill) { if (out.length >= ctx.count) break; if (!out.some(q => q.text === t)) out.push({ text: t, purpose: '행동 사례 확인 (STAR)' }); }
      return out.slice(0, ctx.count);
    },

    async followups(ctx, question, answer) {
      await sleep(300);
      const a = answer || '';
      const out = [];
      if (a.trim().length < 20) out.push('답변이 짧았는데, 조금 더 구체적인 사례를 들어 다시 설명해 주실 수 있나요?');
      if (!STAR_CUE.R.some(w => a.includes(w))) out.push('그래서 결과는 어떻게 되었나요? 숫자나 변화로 말씀해 주실 수 있나요?');
      if (!STAR_CUE.A.some(w => a.includes(w))) out.push('그 상황에서 본인이 직접 한 행동은 무엇이었나요?');
      if (/우리|저희|팀이/.test(a) && !/제가|저는|나는/.test(a)) out.push('팀이 한 일 말고, 본인이 맡은 부분은 정확히 무엇이었나요?');
      const nums = a.match(/\d+/g) || [];
      if (nums.length && ctx.resume && nums.some(n => !ctx.resume.includes(n)) && /\d/.test(ctx.resume))
        out.push('방금 말씀하신 수치가 자기소개서 내용과 조금 다른데, 어느 쪽이 맞는지 확인해 주실 수 있나요?');
      if (!out.length) out.push('그 경험을 다시 한다면 어떤 점을 다르게 하시겠어요?');
      return out.slice(0, 3);
    },

    async analyze(ctx, qa) {
      await sleep(900);
      const all = qa.map(x => x.a || '').join('\n');
      const sents = sentences(all);
      const big5 = {};
      FACTORS.forEach(f => {
        const lx = LEX[f.key];
        const p = count(all, lx.pos), n = count(all, lx.neg);
        const score = Math.max(1, Math.min(5, Math.round(3 + Math.max(-2, Math.min(2, (p - n) * 0.5)))));
        const ev = sents.filter(s => lx.pos.some(w => s.includes(w)) || lx.neg.some(w => s.includes(w))).slice(0, 2);
        let reason;
        if (p + n === 0) reason = '관련 표현이 나타나지 않아 근거 부족 — 보통으로 두었습니다.';
        else reason = `${f.name}이 높음을 시사하는 표현 ${p}회, 낮음을 시사하는 표현 ${n}회가 확인되었습니다.`;
        big5[f.key] = { score, reason, evidence: ev };
      });
      const star = qa.map((x, i) => {
        const a = x.a || '';
        const r = { q: i + 1 };
        ['S', 'T', 'A', 'R'].forEach(k => { r[k] = STAR_CUE[k].some(w => a.includes(w)); });
        const miss = ['S', 'T', 'A', 'R'].filter(k => !r[k]);
        r.note = !a.trim() ? '무응답' : miss.length ? `${miss.map(k => ({ S: '상황', T: '과제', A: '행동', R: '결과' })[k]).join('·')} 요소가 부족합니다.` : '네 요소를 모두 갖췄습니다.';
        return r;
      });
      const mismatches = [];
      const rnums = (ctx.resume || '').match(/\d+/g) || [];
      qa.forEach(x => {
        const anums = (x.a || '').match(/\d+/g) || [];
        const odd = anums.filter(n => rnums.length && !rnums.includes(n));
        if (odd.length) mismatches.push({ resume: '자기소개서의 수치: ' + rnums.slice(0, 4).join(', '), answer: x.a.slice(0, 80), note: `답변의 수치(${odd.join(', ')})가 자기소개서에 없습니다. 확인이 필요합니다.` });
      });
      const followups = [];
      for (const x of qa) { (await demo.followups(ctx, x.q, x.a)).forEach(f => { if (!followups.includes(f)) followups.push(f); }); }
      const hi = FACTORS.filter(f => big5[f.key].score >= 4).map(f => f.name);
      const lo = FACTORS.filter(f => big5[f.key].score <= 2).map(f => f.name);
      const starOk = star.filter(s => s.S && s.T && s.A && s.R).length;
      let summary = '';
      if (hi.length) summary += `답변에서 ${hi.join('·')}이(가) 비교적 높게 드러났습니다. `;
      if (lo.length) summary += `${lo.join('·')}은(는) 낮게 나타났습니다. `;
      if (!hi.length && !lo.length) summary += '뚜렷하게 치우친 성격 요인은 보이지 않았습니다. ';
      summary += `${qa.length}개 답변 중 ${starOk}개가 STAR 구조를 모두 갖췄습니다.`;
      return { big5, star, mismatches, followups: followups.slice(0, 4), summary, demo: true };
    },
  };

  /* ── 발화 보조 지표 (참고용 · 성격 판정에는 반영하지 않음) ── */
  function speechMetrics(text, durationMs, latencyMs) {
    const t = (text || '').trim();
    const syll = (t.match(/[가-힣]/g) || []).length;
    const words = t.split(/\s+/).filter(Boolean);
    const fillers = words.filter(w => FILLERS.includes(w.replace(/[.,!?…]/g, ''))).length;
    let repeats = 0;
    for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) repeats++;
    const min = durationMs / 60000;
    return {
      syllables: syll,
      rate: min > 0.05 ? Math.round(syll / min) : null,
      latency: latencyMs != null ? Math.round(latencyMs / 100) / 10 : null,
      fillers, repeats,
    };
  }

  window.AI = { FACTORS, LEVELS, factorFit, overallFit, personaSentence, generateQuestions, followups, analyze, speechMetrics };
})();
