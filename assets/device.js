/* ESP32(샤오즈 음성 에이전트) 연결
 *
 *   직접 연결:   [이 페이지] ──wss──▶ [샤오즈 MCP 엔드포인트] ──▶ [ESP32]
 *   브리지 연결: [이 페이지] ──ws──▶ [브리지 서버 server.js] ──wss──▶ [샤오즈] ──▶ [ESP32]
 *
 * 에이전트에 도구 두 개를 노출한다.
 *   get_next_question()                 다음 질문 문장을 가져간다
 *   submit_answer(question_id, answer)  지원자 답변을 돌려준다
 *
 * 이벤트: status({connected, detail}) · phase(phase, activeId) · queue(questions) · answer(id, text)
 */
(function () {
  const PROTOCOL_VERSION = '2024-11-05';

  const TOOLS = [
    {
      name: 'get_next_question',
      description:
        '면접관이 준비한 다음 면접 질문을 가져온다. 반환된 question 문장은 요약하거나 바꾸지 말고 ' +
        '그대로 한 글자도 빠짐없이 지원자에게 소리내어 읽어야 한다. 질문을 읽은 뒤에는 지원자의 ' +
        '답변을 끝까지 듣고, 반드시 submit_answer 도구로 답변을 전달한다. ' +
        '더 이상 질문이 없으면 done 이 true 로 온다.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'submit_answer',
      description:
        '지원자가 방금 말한 답변을 면접관 콘솔에 기록한다. 답변을 요약하거나 다듬지 말고 ' +
        '들은 그대로 전달한다. question_id 는 get_next_question 이 돌려준 값을 그대로 사용한다.',
      inputSchema: {
        type: 'object',
        properties: {
          question_id: { type: 'string', description: 'get_next_question 이 준 질문 ID' },
          answer: { type: 'string', description: '지원자의 답변 전문' },
        },
        required: ['question_id', 'answer'],
      },
    },
  ];

  const handlers = {};
  function emit(ev, ...args) { (handlers[ev] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } }); }

  const st = {
    mode: 'off',          // off | direct | bridge
    url: '',
    ws: null,
    questions: [],        // {id, text, asked}
    armedId: null,
    activeId: null,
    phase: 'idle',        // idle | speaking | listening
    retryMs: 1000,
    retryTimer: null,
    wanted: false,
    status: { connected: false, detail: '연결 안 됨' },
  };

  function setStatus(connected, detail) {
    st.status = { connected, detail };
    emit('status', st.status);
  }
  function setPhase(p, activeId) {
    st.phase = p;
    if (activeId !== undefined) st.activeId = activeId;
    emit('phase', p, st.activeId);
  }

  /* ── 직접 연결: 이 페이지가 MCP 서버 역할 ── */
  function pickNext() {
    if (st.armedId) {
      const q = st.questions.find(x => x.id === st.armedId);
      if (q) return q;
    }
    return st.questions.find(x => !x.asked) || null;
  }

  function callTool(name, args) {
    if (name === 'get_next_question') {
      const q = pickNext();
      if (!q) {
        setPhase('idle', null);
        return { done: true, message: '준비된 질문이 모두 끝났습니다. 지원자에게 면접이 끝났음을 알리세요.' };
      }
      q.asked = true;
      st.armedId = null;
      setPhase('speaking', q.id);
      emit('queue', st.questions);
      // 질문을 읽고 나면 곧 답변을 듣는 단계로 넘어간다 — 대략적인 표시용
      setTimeout(() => { if (st.activeId === q.id && st.phase === 'speaking') setPhase('listening'); },
        Math.min(12000, 1500 + q.text.length * 120));
      return { done: false, question_id: q.id, question: q.text, remaining: st.questions.filter(x => !x.asked).length };
    }
    if (name === 'submit_answer') {
      const qid = String(args.question_id || st.activeId || '');
      const text = String(args.answer || '').trim();
      if (!text) return { ok: false, message: 'answer 가 비어 있습니다.' };
      emit('answer', qid, text);
      st.armedId = null;
      setPhase('idle', null);
      return { ok: true, message: '기록했습니다. 다음 질문이 필요하면 get_next_question 을 호출하세요.' };
    }
    throw new Error('알 수 없는 도구: ' + name);
  }

  function rpcSend(obj) { if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify(obj)); }
  function reply(id, result) { if (id !== undefined && id !== null) rpcSend({ jsonrpc: '2.0', id, result }); }
  function replyError(id, code, message) { if (id !== undefined && id !== null) rpcSend({ jsonrpc: '2.0', id, error: { code, message } }); }

  function onRpc(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const { id, method, params } = m;
    if (!method) return;
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'interview-console-web', version: '1.0.0' },
        });
        break;
      case 'notifications/initialized': setStatus(true, '에이전트와 연결됨'); break;
      case 'ping': reply(id, {}); break;
      case 'tools/list': reply(id, { tools: TOOLS }); break;
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const out = callTool(name, args);
          reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
        } catch (e) {
          reply(id, { content: [{ type: 'text', text: String(e.message) }], isError: true });
        }
        break;
      }
      case 'resources/list': reply(id, { resources: [] }); break;
      case 'prompts/list': reply(id, { prompts: [] }); break;
      default: replyError(id, -32601, '지원하지 않는 메서드: ' + method);
    }
  }

  /* ── 브리지 연결: 기존 server.js 와 같은 메시지 형식 ── */
  function onBridge(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.type) {
      case 'hello':
        if (m.mcp) setStatus(!!m.mcp.connected, m.mcp.connected ? '에이전트와 연결됨 (브리지)' : '브리지 연결됨 — ' + m.mcp.detail);
        setPhase(m.phase || 'idle', m.activeId || null);
        bridgeSync();
        break;
      case 'mcp':
        setStatus(!!m.connected, m.connected ? '에이전트와 연결됨 (브리지)' : '브리지 연결됨 — ' + m.detail);
        break;
      case 'state':
        setPhase(m.value === 'speaking' ? 'speaking' : m.value, m.activeId || null);
        if (m.value === 'speaking') setTimeout(() => { if (st.phase === 'speaking') setPhase('listening'); }, 6000);
        break;
      case 'queue':
        (m.questions || []).forEach(rq => { const q = st.questions.find(x => x.id === rq.id); if (q) q.asked = !!rq.asked; });
        st.armedId = m.armedId || null;
        emit('queue', st.questions);
        break;
      case 'answer':
        emit('answer', String(m.id), m.text || '');
        break;
    }
  }
  function bridgeSync() {
    rpcSend({ type: 'sync', questions: st.questions });
  }

  /* ── 소켓 관리 ── */
  function open() {
    clearTimeout(st.retryTimer);
    if (!st.wanted || st.mode === 'off') return;
    let ws;
    try { ws = new WebSocket(st.url); }
    catch (e) { setStatus(false, '주소가 올바르지 않습니다'); return; }
    st.ws = ws;
    setStatus(false, st.mode === 'direct' ? '샤오즈 서버에 연결 중…' : '브리지 서버에 연결 중…');
    ws.onopen = () => {
      st.retryMs = 1000;
      setStatus(false, st.mode === 'direct' ? '연결됨 — 에이전트 초기화 대기 중' : '브리지 연결됨 — 에이전트 확인 중');
    };
    ws.onmessage = e => (st.mode === 'direct' ? onRpc : onBridge)(typeof e.data === 'string' ? e.data : '');
    ws.onclose = e => {
      if (st.ws !== ws) return;
      st.ws = null;
      if (!st.wanted) { setStatus(false, '연결 안 됨'); return; }
      const hint = (e.code === 1008 || e.code === 4001) ? '토큰이 거부되었습니다. 엔드포인트를 재발급하세요' : '연결이 끊겼습니다';
      setStatus(false, `${hint} — ${Math.round(st.retryMs / 1000)}초 후 재시도`);
      st.retryTimer = setTimeout(open, st.retryMs);
      st.retryMs = Math.min(st.retryMs * 2, 30000);
    };
    ws.onerror = () => {};
  }

  const Device = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    get status() { return st.status; },
    get phase() { return st.phase; },
    get mode() { return st.mode; },
    get armedId() { return st.armedId; },

    connect(mode, url) {
      Device.disconnect();
      if (mode === 'off' || !url) { st.mode = 'off'; setStatus(false, '연결 안 됨'); return; }
      st.mode = mode; st.url = url; st.wanted = true; st.retryMs = 1000;
      open();
    },
    disconnect() {
      st.wanted = false;
      clearTimeout(st.retryTimer);
      if (st.ws) { const ws = st.ws; st.ws = null; try { ws.close(); } catch (e) {} }
      setStatus(false, '연결 안 됨');
    },

    // 앱의 질문 목록을 넘겨준다 (추가 · 삭제 · 수정 공통)
    setQuestions(list) {
      st.questions = list.map(q => ({ id: String(q.id), text: String(q.text || '').slice(0, 500), asked: !!q.asked }));
      if (!st.questions.some(q => q.id === st.armedId)) st.armedId = null;
      if (st.mode === 'bridge') bridgeSync();
    },
    // 이 질문을 다음에 읽도록 지정
    arm(id) {
      const q = st.questions.find(x => x.id === String(id));
      if (!q) return;
      q.asked = false;
      st.armedId = q.id;
      if (st.mode === 'bridge') { bridgeSync(); rpcSend({ type: 'arm', id: q.id }); }
      emit('queue', st.questions);
    },
    // 답변 강제 마감
    stop(text) {
      if (st.mode === 'bridge') { rpcSend({ type: 'stop', text }); return; }
      if (st.activeId) emit('answer', st.activeId, text || '(면접관이 마감함)');
      st.armedId = null;
      setPhase('idle', null);
    },
  };

  window.Device = Device;
})();

/* 브라우저 마이크 음성 인식 — 기기가 없을 때의 대체 입력 */
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Speech = {
    supported: !!SR,
    listening: false,
    _rec: null,
    start({ onText, onInterim, onEnd }) {
      if (!SR) return false;
      const rec = new SR();
      rec.lang = 'ko-KR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) onText && onText(r[0].transcript.trim());
          else interim += r[0].transcript;
        }
        onInterim && onInterim(interim);
      };
      rec.onerror = e => { if (e.error === 'not-allowed') alert('마이크 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.'); };
      rec.onend = () => {
        // 크롬은 잠시 조용하면 스스로 멈추므로, 사용자가 끄기 전까지 다시 켠다
        if (Speech.listening && Speech._rec === rec) { try { rec.start(); return; } catch (e) {} }
        Speech.listening = false;
        onEnd && onEnd();
      };
      Speech._rec = rec;
      Speech.listening = true;
      rec.start();
      return true;
    },
    stop() {
      Speech.listening = false;
      if (Speech._rec) { try { Speech._rec.stop(); } catch (e) {} }
    },
    say(text, onDone) {
      if (!('speechSynthesis' in window)) { onDone && onDone(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = 1;
      const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('ko'));
      if (v) u.voice = v;
      u.onend = () => onDone && onDone();
      u.onerror = () => onDone && onDone();
      speechSynthesis.speak(u);
    },
  };
  window.Speech = Speech;
})();
