/* 화면 흐름 · 상태 관리 */
(function () {
  const { FACTORS, LEVELS } = AI;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ── 저장소 (실패해도 동작하도록) ── */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const blank = () => ({
    step: 1, maxStep: 1,
    job: '', name: '', resume: '', count: 3,
    criteria: { O: 0, C: 0, E: 0, A: 0, N: 0 },
    questions: [], cur: 0, followups: [],
    genKey: '', analysis: null, final: null,
  });
  let S = Object.assign(blank(), store.get('tmd.state', {}));
  const cfg = Object.assign({ key: '', model: 'gemini-2.5-flash', devMode: 'off', urlDirect: '', urlBridge: 'ws://localhost:8080/ws' }, store.get('tmd.cfg', {}));

  let saveTimer;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('tmd.state', S), 200); }
  function saveCfg() { store.set('tmd.cfg', cfg); }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ── 단계 이동 ── */
  function go(step) {
    S.step = step;
    S.maxStep = Math.max(S.maxStep, step);
    $$('.screen').forEach((el, i) => { el.hidden = i + 1 !== step; });
    $$('#steps button').forEach(b => {
      const n = +b.dataset.step;
      b.classList.toggle('active', n === step);
      b.classList.toggle('done', n < step);
      b.disabled = n > S.maxStep;
    });
    if (step === 2) renderBig5();
    if (step === 3) renderLive();
    if (step === 4) renderReport();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    save();
  }
  $('#steps').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) go(+b.dataset.step);
  });
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => go(+b.dataset.goto)));

  /* ── 화면 1 ── */
  const inJob = $('#inJob'), inName = $('#inName'), inResume = $('#inResume');
  inJob.value = S.job; inName.value = S.name; inResume.value = S.resume;
  function resumeMeta() { $('#resumeMeta').textContent = inResume.value.length.toLocaleString() + '자'; }
  resumeMeta();
  inJob.addEventListener('input', () => { S.job = inJob.value; save(); });
  inName.addEventListener('input', () => { S.name = inName.value; save(); });
  inResume.addEventListener('input', () => { S.resume = inResume.value; resumeMeta(); save(); });

  function renderCount() { $$('#inCount button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.count)); }
  renderCount();
  $('#inCount').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.count = +b.dataset.v; renderCount(); save(); } });

  $('#inFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      let text;
      if (/\.docx$/i.test(f.name)) {
        if (!window.JSZip) throw new Error('docx 읽기 도구를 불러오지 못했습니다');
        const zip = await JSZip.loadAsync(f);
        const xml = await zip.file('word/document.xml').async('string');
        text = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
          .map(p => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))
          .filter(Boolean).join('\n')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      } else {
        text = await f.text();
      }
      inResume.value = text.trim();
      S.resume = inResume.value; resumeMeta(); save();
      toast(`${f.name}을(를) 불러왔습니다`);
    } catch (err) {
      toast('파일을 읽지 못했습니다. 내용을 직접 붙여넣어 주세요.');
    }
    e.target.value = '';
  });

  $('#go2').addEventListener('click', () => {
    if (!S.job.trim()) { inJob.focus(); toast('직무 · 포지션을 입력해 주세요'); return; }
    if (S.resume.trim().length < 30) toast('자기소개서가 짧으면 질문이 덜 구체적일 수 있습니다');
    go(2);
  });

  /* ── 화면 2: BIG5 기준 ── */
  function renderBig5() {
    const box = $('#big5Rows');
    if (!box.children.length) {
      box.innerHTML = FACTORS.map(f => `
        <div class="b5-row" data-k="${f.key}">
          <div class="b5-name">
            <strong>${f.name}</strong><small>${f.en}</small>
            <button class="qmark" aria-expanded="false" aria-label="${f.name} 설명">?</button>
          </div>
          <div class="seg">${LEVELS.map(l => `<button data-v="${l.v}">${l.label}</button>`).join('')}</div>
          <div class="b5-dir"></div>
          <p class="b5-help" hidden>${esc(f.desc)}</p>
        </div>`).join('');
      box.addEventListener('click', e => {
        const row = e.target.closest('.b5-row');
        if (!row) return;
        if (e.target.closest('.qmark')) {
          const q = e.target.closest('.qmark'), help = row.querySelector('.b5-help');
          help.hidden = !help.hidden;
          q.setAttribute('aria-expanded', String(!help.hidden));
          return;
        }
        const b = e.target.closest('.seg button');
        if (b) { S.criteria[row.dataset.k] = +b.dataset.v; renderBig5(); save(); }
      });
    }
    FACTORS.forEach(f => {
      const row = box.querySelector(`[data-k="${f.key}"]`);
      const v = S.criteria[f.key] || 0;
      row.querySelectorAll('.seg button').forEach(b => {
        const bv = +b.dataset.v;
        b.classList.toggle('on', bv === v);
        b.classList.toggle('neg', bv < 0);
        b.classList.toggle('pos', bv > 0);
      });
      row.querySelector('.b5-dir').textContent = v === 0 ? '적합도 계산에서 제외합니다'
        : `${f.name}이(가) ${Math.abs(v) === 2 ? '매우 ' : '다소 '}${v > 0 ? '높은' : '낮은'} 지원자를 선호합니다`;
    });
    $('#personaSummary').textContent = AI.personaSentence(S.criteria) || '아직 설정한 기준이 없습니다. 모든 요인이 ‘상관없음’이면 적합도를 계산하지 않습니다.';
  }

  const genKeyNow = () => JSON.stringify([S.job, S.resume, S.count, S.criteria]);

  $('#go3').addEventListener('click', async () => {
    const answered = S.questions.some(q => q.answer);
    if (S.questions.length && S.genKey === genKeyNow()) { go(3); return; }
    if (answered && !confirm('입력 내용이 바뀌어 질문을 새로 만듭니다. 지금까지의 답변 기록은 지워집니다. 계속할까요?')) { go(3); return; }
    const btn = $('#go3');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 질문 만드는 중…';
    try {
      const qs = await AI.generateQuestions(cfg, { job: S.job, resume: S.resume, criteria: S.criteria, count: S.count });
      if (!qs.length) throw new Error('질문이 비어 있습니다');
      S.questions = qs.map(q => ({ id: uid(), text: q.text, purpose: q.purpose || '', answer: '', asked: false, metrics: null, source: 'ai' }));
      S.cur = 0; S.followups = []; S.analysis = null; S.final = null; S.genKey = genKeyNow();
      syncDevice();
      go(3);
    } catch (err) {
      alert(err.message + '\n\n설정에서 API 키와 모델 이름을 확인해 주세요. 키를 비우면 데모 분석으로 동작합니다.');
    } finally {
      btn.disabled = false; btn.textContent = '질문 만들기';
    }
  });

  /* ── 화면 3: 면접 진행 ── */
  const answerBox = $('#answerBox');
  let rec = null;           // 브라우저 녹음 중인 질문 기록
  let speakingSince = null; // 기기가 질문을 가져간 시각

  const curQ = () => S.questions[S.cur];

  function syncDevice() { Device.setQuestions(S.questions); }

  function renderLive() {
    const q = curQ();
    const n = S.questions.length;
    $('#liveMeta').textContent = n ? `질문 ${S.cur + 1} / ${n}` : '질문 없음';
    $('#qText').textContent = q ? q.text : '질문 목록에서 질문을 추가해 주세요.';
    $('#qPurpose').textContent = q ? (q.source === 'follow' ? '꼬리 질문' : q.source === 'manual' ? '직접 추가한 질문' : (q.purpose || '질문')) : '질문';
    if (document.activeElement !== answerBox) answerBox.value = q ? q.answer : '';
    $('#btnPrev').disabled = S.cur <= 0;
    $('#btnNext').disabled = S.cur >= n - 1;
    renderMetric();
    renderQList();
    renderFollow();
    renderDeviceControls();
  }

  function renderMetric() {
    const m = curQ() && curQ().metrics;
    $('#metricLine').textContent = m ? [m.rate && `${m.rate}음절/분`, m.latency != null && `지연 ${m.latency}초`, `간투사 ${m.fillers}`].filter(Boolean).join(' · ') : '';
  }

  function renderQList() {
    const armed = Device.armedId;
    $('#qList').innerHTML = S.questions.map((q, i) => `
      <li data-i="${i}" class="${i === S.cur ? 'cur' : ''} ${q.answer ? 'answered' : ''} ${q.id === armed ? 'armed' : ''} ${q.id === liveActiveId ? 'asking' : ''}">
        <span class="q-txt">${esc(q.text)}</span>
        <span class="q-act">
          <button data-act="up" title="위로">↑</button>
          <button data-act="edit" title="고치기">✎</button>
          <button data-act="del" title="삭제">✕</button>
        </span>
      </li>`).join('');
  }

  $('#qList').addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = +li.dataset.i;
    const act = e.target.closest('[data-act]');
    if (!act) { if (!li.querySelector('[contenteditable="true"]')) { S.cur = i; renderLive(); save(); } return; }
    const a = act.dataset.act;
    if (a === 'del') {
      if (S.questions[i].answer && !confirm('답변 기록이 있는 질문입니다. 삭제할까요?')) return;
      S.questions.splice(i, 1);
      if (S.cur >= S.questions.length) S.cur = Math.max(0, S.questions.length - 1);
    } else if (a === 'up' && i > 0) {
      [S.questions[i - 1], S.questions[i]] = [S.questions[i], S.questions[i - 1]];
      if (S.cur === i) S.cur--; else if (S.cur === i - 1) S.cur++;
    } else if (a === 'edit') {
      const t = li.querySelector('.q-txt');
      t.contentEditable = 'true'; t.focus();
      document.getSelection().selectAllChildren(t);
      const done = () => {
        t.contentEditable = 'false';
        const v = t.textContent.trim();
        if (v) S.questions[i].text = v;
        syncDevice(); renderLive(); save();
      };
      t.addEventListener('blur', done, { once: true });
      t.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); t.blur(); } });
      return;
    }
    syncDevice(); renderLive(); save();
  });

  $('#btnAddQ').addEventListener('click', () => {
    const t = prompt('추가할 질문을 입력하세요');
    if (!t || !t.trim()) return;
    S.questions.push({ id: uid(), text: t.trim(), purpose: '', answer: '', asked: false, metrics: null, source: 'manual' });
    syncDevice(); renderLive(); save();
  });

  $('#btnPrev').addEventListener('click', () => { if (S.cur > 0) { S.cur--; renderLive(); save(); } });
  $('#btnNext').addEventListener('click', () => { if (S.cur < S.questions.length - 1) { S.cur++; renderLive(); save(); } });

  answerBox.addEventListener('input', () => { const q = curQ(); if (q) { q.answer = answerBox.value; save(); } });

  /* 진행 상태 표시 */
  let liveActiveId = null;
  function setLive(kind, text) {
    const el = $('#liveState');
    el.className = 'live-state ' + (kind || '');
    el.querySelector('span').textContent = text;
  }
  function refreshLiveState() {
    if (Speech.listening) return setLive('rec', '음성 입력 중 · 브라우저 마이크');
    if (Device.phase === 'speaking') return setLive('speak', '기기가 질문을 읽는 중');
    if (Device.phase === 'listening') return setLive('rec', '음성 입력 중 · 기기');
    setLive('', Device.status.connected ? '대기 중 · 기기 연결됨' : '대기 중');
  }

  /* 기기 제어 */
  function renderDeviceControls() {
    const on = Device.status.connected;
    const q = curQ();
    const armBtn = $('#btnArm');
    armBtn.hidden = !on;
    const armed = q && Device.armedId === q.id;
    armBtn.classList.toggle('armed', !!armed);
    armBtn.querySelector('span').textContent = armed ? '다음 차례로 지정됨' : '기기로 보내기';
    $('#btnStop').hidden = !(on && Device.phase !== 'idle');
    $('#qHint').textContent = on
      ? (armed ? '기기에 대고 “면접 시작해줘” 또는 “다음 질문”이라고 말하면 이 질문을 그대로 읽습니다.'
               : '‘기기로 보내기’를 누르면 이 질문이 다음 차례가 됩니다. 지정하지 않으면 아직 묻지 않은 질문을 순서대로 읽습니다.')
      : (Device.mode !== 'off' ? '기기 연결을 기다리는 중입니다. 상단 ⚙ 설정에서 상태를 확인하세요.' : '');
  }

  $('#btnArm').addEventListener('click', () => {
    const q = curQ(); if (!q) return;
    Device.arm(q.id);
    toast('다음 차례로 지정했습니다');
    renderLive();
  });
  $('#btnStop').addEventListener('click', () => {
    Device.stop(answerBox.value.trim() || '(면접관이 마감함)');
  });

  Device.on('status', st => {
    renderLamps();
    $('#devInfo').textContent = st.detail;
    if (S.step === 3) { renderDeviceControls(); refreshLiveState(); }
  });
  Device.on('phase', (p, activeId) => {
    liveActiveId = p === 'idle' ? null : activeId;
    if (p === 'speaking') speakingSince = Date.now();
    if (activeId) {
      const i = S.questions.findIndex(q => q.id === activeId);
      if (i >= 0 && i !== S.cur) { S.cur = i; save(); }
    }
    if (S.step === 3) { renderLive(); refreshLiveState(); }
  });
  Device.on('queue', list => {
    list.forEach(dq => { const q = S.questions.find(x => x.id === dq.id); if (q) q.asked = dq.asked; });
    if (S.step === 3) renderQList();
    save();
  });
  Device.on('answer', (id, text) => {
    const q = S.questions.find(x => x.id === id) || curQ();
    if (!q) return;
    q.answer = q.answer ? q.answer + '\n' + text : text;
    q.asked = true;
    const dur = speakingSince ? Date.now() - speakingSince - Math.min(12000, 1500 + q.text.length * 120) : 0;
    q.metrics = AI.speechMetrics(q.answer, Math.max(dur, 0), null);
    speakingSince = null;
    save();
    if (S.step === 3) renderLive();
    toast('답변이 도착했습니다');
    makeFollowups(q);
  });

  /* 브라우저 낭독 · 녹음 */
  let readEndAt = null;
  $('#btnSpeak').addEventListener('click', () => {
    const q = curQ(); if (!q) return;
    setLive('speak', '질문을 읽는 중');
    Speech.say(q.text, () => { readEndAt = Date.now(); refreshLiveState(); });
  });

  $('#btnRec').addEventListener('click', () => {
    if (Speech.listening) { stopRec(); return; }
    if (!Speech.supported) { toast('이 브라우저는 음성 인식을 지원하지 않습니다. 크롬이나 엣지를 써 주세요.'); return; }
    const q = curQ(); if (!q) return;
    rec = { q, start: Date.now(), first: null, base: readEndAt && Date.now() - readEndAt < 30000 ? readEndAt : null };
    Speech.start({
      onText: t => {
        if (!rec.first) rec.first = Date.now();
        rec.q.answer = (rec.q.answer ? rec.q.answer + ' ' : '') + t;
        if (curQ() === rec.q) answerBox.value = rec.q.answer;
        save();
      },
      onInterim: t => { $('#interim').textContent = t; },
      onEnd: () => { if (rec) stopRec(); },
    });
    const b = $('#btnRec');
    b.classList.add('recording', 'btn-primary'); b.classList.remove('btn-ghost');
    b.querySelector('span').textContent = '녹음 끝내기';
    refreshLiveState();
  });

  function stopRec() {
    Speech.stop();
    const b = $('#btnRec');
    b.classList.remove('recording', 'btn-primary'); b.classList.add('btn-ghost');
    b.querySelector('span').textContent = '마이크 녹음';
    $('#interim').textContent = '';
    if (rec) {
      const r = rec; rec = null;
      const lat = r.first ? r.first - (r.base || r.start) : null;
      r.q.metrics = AI.speechMetrics(r.q.answer, Date.now() - (r.first || r.start), r.base ? lat : null);
      r.q.asked = true;
      save();
      renderLive();
      if (r.q.answer.trim()) makeFollowups(r.q);
    }
    refreshLiveState();
  }

  /* 꼬리 질문 */
  async function makeFollowups(q) {
    if (!q || !q.answer.trim()) { toast('먼저 답변을 기록해 주세요'); return; }
    const list = $('#followList');
    list.innerHTML = '<li class="empty"><span class="spinner" style="display:inline-block;vertical-align:middle"></span> 꼬리 질문을 만드는 중…</li>';
    try {
      const out = await AI.followups(cfg, { job: S.job, resume: S.resume }, q.text, q.answer);
      S.followups = out.map(t => ({ text: t, after: q.id }));
      save();
    } catch (err) {
      toast(err.message);
    }
    renderFollow();
  }
  function renderFollow() {
    const list = $('#followList');
    if (!S.followups.length) {
      list.innerHTML = '<li class="empty">답변을 마치면 확인이 필요한 부분에 대한 꼬리 질문이 여기에 나타납니다. 누르면 다음 질문으로 추가됩니다.</li>';
      return;
    }
    list.innerHTML = S.followups.map((f, i) => `<li class="item" data-i="${i}">${esc(f.text)}</li>`).join('');
  }
  $('#followList').addEventListener('click', e => {
    const li = e.target.closest('li.item'); if (!li) return;
    const f = S.followups[+li.dataset.i];
    let at = S.questions.findIndex(q => q.id === f.after);
    if (at < 0) at = S.cur;
    const nq = { id: uid(), text: f.text, purpose: '', answer: '', asked: false, metrics: null, source: 'follow' };
    S.questions.splice(at + 1, 0, nq);
    S.followups.splice(+li.dataset.i, 1);
    S.cur = at + 1;
    syncDevice();
    if (Device.status.connected) Device.arm(nq.id);
    renderLive(); save();
    toast(Device.status.connected ? '꼬리 질문을 추가하고 다음 차례로 지정했습니다' : '꼬리 질문을 다음 질문으로 추가했습니다');
  });
  $('#btnFollow').addEventListener('click', () => makeFollowups(curQ()));

  $('#go4').addEventListener('click', async () => {
    if (Speech.listening) stopRec();
    const qa = S.questions.filter(q => q.answer.trim());
    if (!qa.length) { toast('기록된 답변이 없습니다'); return; }
    const unanswered = S.questions.length - qa.length;
    if (unanswered && !confirm(`답변이 없는 질문 ${unanswered}개는 빼고 분석합니다. 계속할까요?`)) return;
    S.analysis = null;
    $('#report').innerHTML = '';
    go(4); // 분석 결과가 없으면 renderReport가 분석을 시작한다
  });

  /* ── 화면 4: 보고서 ── */
  async function runAnalysis() {
    const box = $('#report');
    box.innerHTML = '<div class="loading"><span class="spinner"></span> 답변을 BIG5 기준으로 분석하고 있습니다…</div>';
    const qa = S.questions.filter(q => q.answer.trim()).map(q => ({ q: q.text, a: q.answer, metrics: q.metrics }));
    try {
      const out = await AI.analyze(cfg, { job: S.job, resume: S.resume }, qa);
      S.analysis = Object.assign(out, { qa, at: new Date().toISOString(), engine: out.demo ? '데모 분석' : 'Gemini · ' + cfg.model });
      save();
      renderReport();
    } catch (err) {
      box.innerHTML = `<div class="note"><b>분석하지 못했습니다.</b> ${esc(err.message)}</div>
        <div class="actions"><button class="btn btn-ghost" data-goto3>면접으로 돌아가기</button><button class="btn btn-primary" data-retry>다시 시도</button></div>`;
      box.querySelector('[data-retry]').onclick = runAnalysis;
      box.querySelector('[data-goto3]').onclick = () => go(3);
    }
  }

  function levelText(s) { return s >= 5 ? '매우 높음' : s === 4 ? '높음' : s === 3 ? '보통' : s === 2 ? '낮음' : '매우 낮음'; }

  function renderReport() {
    const A = S.analysis;
    const box = $('#report');
    if (!A) { if (!box.querySelector('.loading')) runAnalysis(); return; }
    const fit = AI.overallFit(S.criteria, A.big5);
    const C = 2 * Math.PI * 56;
    const persona = AI.personaSentence(S.criteria);
    const date = new Date(A.at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

    const rows = FACTORS.map(f => {
      const b = A.big5[f.key], c = S.criteria[f.key] || 0;
      const ff = AI.factorFit(c, b.score);
      const target = c ? `<span class="target" style="left:${(c + 2) / 4 * 100}%" data-label="기준"></span>` : '';
      return `
      <div class="bar-row" data-k="${f.key}">
        <button class="bar-btn" aria-expanded="false">
          <span class="bar-name">${f.name}<small>${levelText(b.score)} · ${b.score}/5</small></span>
          <span class="track"><span class="rail"></span><span class="ticks"><span></span><span></span><span></span><span></span><span></span></span>
            <span class="fill" style="width:${Math.max(4, (b.score - 1) / 4 * 100)}%"></span>${target}</span>
          <span class="bar-fit">${ff == null ? '<small>상관없음</small>제외' : ff + '%<small>부합도</small>'}</span>
          <span class="chev">▾</span>
        </button>
        <div class="bar-detail" hidden>
          <p><b>설정한 기준</b> — ${LEVELS.find(l => l.v === c).label}${c ? ` (${f.name}이(가) ${c > 0 ? '높은' : '낮은'} 지원자 선호)` : ''}</p>
          <p><b>판단 이유</b> — ${esc(b.reason || '설명 없음')}</p>
          ${b.evidence.length ? b.evidence.map(e => `<blockquote>“${esc(e)}”</blockquote>`).join('') : '<p class="hint">인용할 수 있는 답변 구절이 없습니다.</p>'}
        </div>
      </div>`;
    }).join('');

    const starRows = A.star.map((s, i) => `
      <tr><td>${i + 1}. ${esc(A.qa[i] ? A.qa[i].q : '')}</td>
      ${['S', 'T', 'A', 'R'].map(k => `<td class="c"><span class="chk ${s[k] ? 'y' : 'n'}">${s[k] ? '○' : '✕'}</span></td>`).join('')}
      <td>${esc(s.note)}</td></tr>`).join('');
    const starFull = A.star.filter(s => s.S && s.T && s.A && s.R).length;

    const mm = A.mismatches.length
      ? A.mismatches.map(m => `<div class="card">
          ${m.resume ? `<p><span class="k">자기소개서</span>${esc(m.resume)}</p>` : ''}
          ${m.answer ? `<p><span class="k">답변</span>${esc(m.answer)}</p>` : ''}
          <p><span class="k">확인할 점</span>${esc(m.note)}</p></div>`).join('')
      : '<div class="card">자기소개서와 답변 사이에서 뚜렷하게 어긋나는 지점을 찾지 못했습니다.</div>';

    const ms = A.qa.map(x => x.metrics).filter(Boolean);
    const avg = k => { const v = ms.map(m => m[k]).filter(x => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    const sum = k => ms.reduce((a, m) => a + (m[k] || 0), 0);

    box.innerHTML = `
      <div class="report-head">
        <div class="fit-ring">
          <svg width="132" height="132" viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="56" fill="none" stroke="var(--soft)" stroke-width="12"/>
            <circle cx="66" cy="66" r="56" fill="none" stroke="var(--ink)" stroke-width="12" stroke-linecap="round"
              stroke-dasharray="${C}" stroke-dashoffset="${fit == null ? C : C * (1 - fit / 100)}"/>
          </svg>
          <div class="num"><div><b>${fit == null ? '—' : fit + '%'}</b><small>인재상 적합도</small></div></div>
        </div>
        <div>
          <p class="report-meta">${esc(S.job)} · ${esc(S.name || '지원자')} · ${date}<span class="tag">${esc(A.engine)}</span></p>
          <h2>${persona ? '목표 인재상 · ' + esc(persona) : '설정한 인재상 기준이 없습니다'}</h2>
          <p>${esc(A.summary)}</p>
        </div>
      </div>

      <h3 class="sec-title">BIG5 성격 유형 프로필</h3>
      <p class="sec-desc">막대는 답변에서 판별한 지원자의 성향, 파란 선은 면접관이 설정한 기준입니다. 요인을 누르면 판단 근거가 된 답변 원문이 펼쳐집니다.</p>
      <div class="chart">${rows}</div>
      <div class="legend"><span>지원자 성향 (1~5)</span><span class="t">면접관 기준</span></div>

      <h3 class="sec-title">STAR 구조 충족도</h3>
      <p class="sec-desc">${A.star.length}개 답변 중 ${starFull}개가 상황(S)·과제(T)·행동(A)·결과(R)를 모두 갖췄습니다.</p>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>질문</th><th class="c">S</th><th class="c">T</th><th class="c">A</th><th class="c">R</th><th>메모</th></tr></thead>
        <tbody>${starRows}</tbody></table></div>

      <h3 class="sec-title">자기소개서 대조 결과</h3>
      <p class="sec-desc">자기소개서 내용과 실제 답변이 어긋나 확인이 필요한 지점입니다.</p>
      <div class="cards">${mm}</div>

      <h3 class="sec-title">추천 꼬리 질문</h3>
      <div class="cards">${A.followups.length ? A.followups.map(f => `<div class="card">${esc(f)}</div>`).join('') : '<div class="card">추가로 확인할 질문이 없습니다.</div>'}</div>

      <h3 class="sec-title">발화 보조 지표</h3>
      <p class="sec-desc">긴장도를 참고하는 보조 자료일 뿐이며, 성격 유형 판정에는 반영하지 않습니다.</p>
      <div class="metrics">
        <div class="metric"><b>${avg('rate') ?? '—'}</b><span>평균 발화 속도 (음절/분)</span></div>
        <div class="metric"><b>${avg('latency') ?? '—'}</b><span>평균 응답 지연 (초)</span></div>
        <div class="metric"><b>${ms.length ? sum('fillers') : '—'}</b><span>간투사 (어, 음 …)</span></div>
        <div class="metric"><b>${ms.length ? sum('repeats') : '—'}</b><span>같은 말 반복</span></div>
      </div>

      <h3 class="sec-title">면접 기록 원문</h3>
      <div class="cards">${A.qa.map((x, i) => `<details class="card"><summary><b>질문 ${i + 1}.</b> ${esc(x.q)}</summary><p style="white-space:pre-wrap;margin-top:10px">${esc(x.a)}</p></details>`).join('')}</div>

      ${S.final ? `<div class="note final-done"><b>최종 평가 제출됨.</b> ${esc(S.final.decision)} · 면접관 점수 ${esc(S.final.score)}/5${S.final.memo ? ' — ' + esc(S.final.memo) : ''}</div>` : ''}

      <aside class="note" style="margin-top:28px">본 보고서는 면접관의 판단을 돕기 위한 참고 자료이며, 최종 합격 여부는 면접관이 직접 결정합니다. AI는 답변의 텍스트 내용만 분석했으며 외모·출신 학교 등은 평가하지 않았습니다.</aside>

      <div class="actions">
        <div class="actions-right">
          <button class="btn btn-ghost" id="btnBack3">면접으로</button>
          <button class="btn btn-ghost" id="btnReanalyze">다시 분석</button>
        </div>
        <div class="actions-right">
          <button class="btn btn-ghost" id="btnDownload">보고서 내려받기</button>
          <button class="btn btn-ghost" id="btnPrint">인쇄 · PDF</button>
          <button class="btn btn-primary" id="btnFinal">${S.final ? '최종 평가 수정' : '최종 평가 입력'}</button>
        </div>
      </div>`;

    box.querySelectorAll('.bar-btn').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.bar-row'), d = row.querySelector('.bar-detail');
      d.hidden = !d.hidden; row.classList.toggle('open', !d.hidden); b.setAttribute('aria-expanded', String(!d.hidden));
    }));
    $('#btnBack3').onclick = () => go(3);
    $('#btnReanalyze').onclick = runAnalysis;
    $('#btnDownload').onclick = download;
    $('#btnPrint').onclick = () => window.print();
    $('#btnFinal').onclick = openFinal;
  }

  /* 최종 평가 — 제출 전 재확인 */
  const dlgFinal = $('#dlgFinal');
  let finalDraft = {};
  function segPick(sel, key) {
    $(sel).onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      finalDraft[key] = b.dataset.v;
      $$(sel + ' button').forEach(x => x.classList.toggle('on', x === b));
      $('#finalConfirm').hidden = true; $('#btnFinalNext').textContent = '제출 전 확인';
    };
  }
  segPick('#finalDecision', 'decision');
  segPick('#finalScore', 'score');
  function openFinal() {
    finalDraft = Object.assign({}, S.final || {});
    $$('#finalDecision button').forEach(b => b.classList.toggle('on', b.dataset.v === finalDraft.decision));
    $$('#finalScore button').forEach(b => b.classList.toggle('on', b.dataset.v === finalDraft.score));
    $('#finalMemo').value = finalDraft.memo || '';
    $('#finalConfirm').hidden = true;
    $('#btnFinalNext').textContent = '제출 전 확인';
    dlgFinal.showModal();
  }
  $('#btnFinalCancel').onclick = () => dlgFinal.close();
  $('#btnFinalNext').onclick = () => {
    finalDraft.memo = $('#finalMemo').value.trim();
    if (!finalDraft.decision || !finalDraft.score) { toast('판단과 점수를 모두 골라 주세요'); return; }
    const conf = $('#finalConfirm');
    if (conf.hidden) {
      const fit = AI.overallFit(S.criteria, S.analysis.big5);
      const gap = FACTORS.filter(f => { const ff = AI.factorFit(S.criteria[f.key], S.analysis.big5[f.key].score); return ff != null && ff < 50; }).map(f => f.name);
      conf.innerHTML = `<p><b>제출하기 전에 한 번 더 확인해 주세요.</b></p>
        <p>AI 적합도 ${fit == null ? '—' : fit + '%'} · 내 판단 <b>${esc(finalDraft.decision)}</b> · 점수 <b>${esc(finalDraft.score)}/5</b></p>
        <ul>
          ${gap.length ? `<li>기준과 크게 어긋난 요인: ${gap.join(', ')} — 근거 원문을 확인하셨나요?</li>` : ''}
          <li>지원자의 외모 · 출신 학교 같은 역량 외 요소가 판단에 들어가지 않았나요?</li>
          <li>AI 분석은 참고 자료입니다. 최종 판단은 면접관의 몫입니다.</li>
        </ul>`;
      conf.hidden = false;
      $('#btnFinalNext').textContent = '확인했습니다 · 제출';
      return;
    }
    S.final = Object.assign({}, finalDraft, { at: new Date().toISOString() });
    save();
    dlgFinal.close();
    renderReport();
    toast('최종 평가를 저장했습니다');
  };

  /* 보고서 파일 */
  function download() {
    const A = S.analysis;
    const fit = AI.overallFit(S.criteria, A.big5);
    const L = [];
    L.push(`# 면접 평가 보고서 — ${S.name || '지원자'}`, '');
    L.push(`- 직무: ${S.job}`, `- 일시: ${new Date(A.at).toLocaleString('ko-KR')}`, `- 분석: ${A.engine}`);
    L.push(`- 설정한 인재상: ${AI.personaSentence(S.criteria) || '(기준 없음)'}`, `- 인재상 적합도: ${fit == null ? '—' : fit + '%'}`, '');
    L.push('## 요약', A.summary, '');
    L.push('## BIG5 프로필', '| 요인 | 지원자 | 기준 | 부합도 |', '|---|---|---|---|');
    FACTORS.forEach(f => {
      const b = A.big5[f.key], c = S.criteria[f.key] || 0, ff = AI.factorFit(c, b.score);
      L.push(`| ${f.name} | ${b.score}/5 (${levelText(b.score)}) | ${LEVELS.find(l => l.v === c).label} | ${ff == null ? '제외' : ff + '%'} |`);
    });
    L.push('', '### 판단 근거');
    FACTORS.forEach(f => {
      const b = A.big5[f.key];
      L.push(`- **${f.name}**: ${b.reason}`);
      b.evidence.forEach(e => L.push(`  > “${e}”`));
    });
    L.push('', '## STAR 구조', '| # | S | T | A | R | 메모 |', '|---|---|---|---|---|---|');
    A.star.forEach((s, i) => L.push(`| ${i + 1} | ${['S', 'T', 'A', 'R'].map(k => s[k] ? '○' : '✕').join(' | ')} | ${s.note} |`));
    L.push('', '## 자기소개서 대조');
    if (A.mismatches.length) A.mismatches.forEach(m => L.push(`- ${m.note}${m.resume ? ` (자소서: ${m.resume})` : ''}${m.answer ? ` (답변: ${m.answer})` : ''}`));
    else L.push('- 뚜렷한 불일치 없음');
    L.push('', '## 추천 꼬리 질문');
    A.followups.forEach(f => L.push(`- ${f}`));
    L.push('', '## 면접 기록');
    A.qa.forEach((x, i) => { L.push(`### 질문 ${i + 1}. ${x.q}`, x.a, ''); });
    if (S.final) L.push('## 면접관 최종 평가', `- 판단: ${S.final.decision}`, `- 점수: ${S.final.score}/5`, `- 메모: ${S.final.memo || ''}`, '');
    L.push('---', '본 보고서는 면접관의 판단을 돕기 위한 참고 자료이며, 최종 합격 여부는 면접관이 직접 결정합니다.');
    const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `면접보고서_${(S.name || '지원자').replace(/[\\/:*?"<>|]/g, '')}_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ── 설정 · 표시등 ── */
  function renderLamps() {
    const ai = $('#lampAi');
    ai.className = 'lamp ' + (cfg.key ? 'on' : 'demo');
    ai.title = cfg.key ? 'Gemini 연결 설정됨' : 'API 키 없음 — 데모 분석으로 동작';
    const dev = $('#lampDev');
    dev.className = 'lamp ' + (Device.status.connected ? 'on' : Device.mode !== 'off' ? 'wait' : '');
    dev.title = '기기: ' + Device.status.detail;
  }

  const dlg = $('#dlgSettings');
  let modeDraft = cfg.devMode;
  const MODE_HINT = {
    off: '기기 없이 진행합니다. 질문은 ‘브라우저로 읽기’, 답변은 ‘마이크 녹음’이나 직접 입력으로 받습니다.',
    direct: '샤오즈 콘솔에서 발급받은 MCP 엔드포인트 주소를 넣으세요. 이 페이지가 서버 없이 에이전트와 바로 연결되며, 주소는 이 브라우저에만 저장됩니다. 같은 주소로 브리지 서버를 동시에 켜 두지 마세요.',
    bridge: '노트북에서 브리지 서버(npm start)를 먼저 켠 뒤 연결합니다. 같은 노트북이면 ws://localhost:8080/ws 그대로 두면 됩니다.',
  };
  function renderMode() {
    $$('#setMode button').forEach(b => b.classList.toggle('on', b.dataset.v === modeDraft));
    const url = $('#setUrl');
    url.hidden = modeDraft === 'off';
    url.type = modeDraft === 'direct' ? 'password' : 'text';
    url.placeholder = modeDraft === 'direct' ? 'wss://api.xiaozhi.me/mcp/?token=…' : 'ws://localhost:8080/ws';
    url.value = modeDraft === 'direct' ? cfg.urlDirect : modeDraft === 'bridge' ? cfg.urlBridge : '';
    $('#modeHint').textContent = MODE_HINT[modeDraft];
    $('#btnConnect').textContent = modeDraft === 'off' ? '연결 끊기' : '연결';
  }
  $('#setMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { modeDraft = b.dataset.v; renderMode(); } });
  $('#setUrl').addEventListener('input', e => {
    if (modeDraft === 'direct') cfg.urlDirect = e.target.value.trim();
    if (modeDraft === 'bridge') cfg.urlBridge = e.target.value.trim();
  });

  function connectFromCfg() {
    const url = cfg.devMode === 'direct' ? cfg.urlDirect : cfg.devMode === 'bridge' ? cfg.urlBridge : '';
    Device.connect(cfg.devMode, url);
    syncDevice();
    renderLamps();
  }
  $('#btnConnect').addEventListener('click', () => {
    if (modeDraft === 'direct' && !/^wss?:\/\//.test(cfg.urlDirect)) { toast('wss:// 로 시작하는 주소를 넣어 주세요'); return; }
    if (modeDraft === 'bridge' && location.protocol === 'https:' && /^ws:\/\/(?!localhost|127\.0\.0\.1)/.test(cfg.urlBridge))
      toast('https 페이지에서는 다른 기기의 ws:// 주소에 연결할 수 없습니다. 같은 노트북의 localhost를 쓰세요.');
    cfg.devMode = modeDraft; saveCfg(); connectFromCfg();
  });

  $('#btnSettings').addEventListener('click', () => {
    $('#setKey').value = cfg.key;
    $('#setModel').value = cfg.model;
    modeDraft = cfg.devMode; renderMode();
    $('#devInfo').textContent = Device.status.detail;
    $('#sttInfo').innerHTML = Speech.supported
      ? '이 브라우저에서 마이크 음성 인식을 쓸 수 있습니다.'
      : '이 브라우저는 음성 인식을 지원하지 않습니다. <b>크롬</b>이나 <b>엣지</b>를 쓰거나, 기기를 연결하세요.';
    dlg.showModal();
  });
  $('#btnSaveSettings').addEventListener('click', () => {
    cfg.key = $('#setKey').value.trim();
    cfg.model = $('#setModel').value.trim() || 'gemini-2.5-flash';
    saveCfg(); renderLamps();
    toast('설정을 저장했습니다');
  });
  $('#btnCopyPrompt').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#agentPrompt').textContent); toast('프롬프트를 복사했습니다'); }
    catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요'); }
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('입력한 면접 정보와 기록을 모두 지우고 처음부터 시작할까요? (설정은 유지됩니다)')) return;
    store.del('tmd.state');
    location.reload();
  });

  window.addEventListener('beforeunload', () => store.set('tmd.state', S));

  /* 시작 */
  renderLamps();
  if (cfg.devMode !== 'off') connectFromCfg();
  else syncDevice();
  go(Math.min(S.step || 1, S.maxStep || 1));
})();
